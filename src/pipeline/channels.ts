import type { BigQueryClient } from "../clients/bigquery";
import type { LlmClient } from "../clients/llm";
import type { ChannelCandidate, ChannelCard, VoteMap } from "../orchestrator/types";
import { isNoiseChannel, tokenHit } from "./text";
import { voteNet } from "./feedback";

/** Verbatim system prompt from reference/index.html L525. */
const RANK_SYSTEM_PROMPT =
  'You route Shopify employees to the RIGHT public Slack channel to ASK a question. From the candidates, pick the 2-5 best places to ask. Rules: SPECIFICITY BEATS VOLUME — a channel whose name/purpose closely matches the topic is better than a busier but more general one; ALWAYS include the most specific #help-* channel that matches the topic (e.g. prefer #help-admin-extensibility over a generic #admin or #help-admin-home for an admin-extensibility question) as long as it has real activity; strongly prefer #help-* channels; NEVER suggest incident channels (e.g. incident-1234) or automated alert / notification / deploy / oncall / bot feeds; a high msgs_90d with very few members is usually an automated feed, so skip it; DROP anything not clearly relevant; never pick a channel with near-zero msgs_90d unless its name is an exact topic match. For each, one short reason (max 14 words) tied to the question. Reply ONLY with JSON {"picks":[{"id":"...","reason":"..."}]}.';

// ── channel search: smart (IDF/name_score + #help) with plain fallback (L401-453) ──
export async function findChannels(
  bq: BigQueryClient,
  terms: string[]
): Promise<{ rows: ChannelCandidate[]; dwError: string | null }> {
  if (!terms.length) return { rows: [], dwError: null };
  const likes = terms
    .map(
      (t) =>
        `LOWER(channel_name) LIKE '%${t}%' OR LOWER(IFNULL(purpose,'')) LIKE '%${t}%' OR LOWER(IFNULL(topic,'')) LIKE '%${t}%'`
    )
    .join(" OR ");
  const escRe = (s: string) => String(s).toLowerCase().replace(/[\\^$.*+?()[\]{}|]/g, "");
  const stems = [
    ...new Set(
      terms
        .map((t) => {
          const x = escRe(t);
          return x.length >= 7 ? x.slice(0, 6) : x.length >= 6 ? x.slice(0, 5) : x;
        })
        .filter((s) => s.length >= 2)
    ),
  ];
  // Token-boundary NAME score: '%api%' can't match "capital", and a channel matching
  // more query stems outranks an incidental single-token hit.
  const nameScore =
    stems
      .map((s) => `CAST(REGEXP_CONTAINS(LOWER(channel_name), r'(^|[-_])${s}') AS INT64)`)
      .join(" + ") || "0";
  const NOISE =
    "NOT (NOT STARTS_WITH(LOWER(channel_name),'help') AND REGEXP_CONTAINS(LOWER(channel_name),\n              r'(^(incident|inc|sev|pd|pager|page|alert|alerts|tmp|temp|zzz)[-_]?[0-9])|((^|[-_])(incident|incidents|alerting|alerts|notifications|notification|firehose|deploys|pr-reviews|oncall)([-_]|$))|(bot$)|(^bot[-_])'))";
  // Keep the candidate set SMALL: a tight channel_name IN-list preserves cluster pruning on
  // the 90d slack_messages scan. A large/unbounded list blew the byte-scan quota, so
  // findChannels threw and channels came back empty.
  const build = (scoreCol: string, candOrder: string) => `
        WITH cand AS (
          SELECT channel_id, channel_name, purpose, topic${scoreCol}
          FROM \`shopify-dw.people.slack_channels\`
          WHERE is_archived=FALSE AND is_deleted=FALSE AND (${likes}) AND ${NOISE}
          ${candOrder} LIMIT 150
        ),
        mem AS (
          SELECT channel_id, COUNT(DISTINCT user_id) AS members
          FROM \`shopify-dw.people.slack_channel_members_daily\`
          WHERE valid_on=(SELECT MAX(valid_on) FROM \`shopify-dw.people.slack_channel_members_daily\`)
            AND channel_id IN (SELECT channel_id FROM cand) GROUP BY 1
        ),
        msg AS (
          SELECT channel_name, COUNT(DISTINCT archive_message_id) AS msgs_90d
          FROM \`shopify-dw.people.slack_messages\`
          WHERE message_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 90 DAY)
            AND is_bot_user=FALSE AND channel_name IN (SELECT channel_name FROM cand) GROUP BY 1
        )
        SELECT c.channel_id, c.channel_name, c.purpose, c.topic,
               IFNULL(mem.members,0) AS members, IFNULL(msg.msgs_90d,0) AS msgs_90d
        FROM cand c
        LEFT JOIN mem ON mem.channel_id=c.channel_id
        LEFT JOIN msg ON msg.channel_name=c.channel_name
        ORDER BY (LOG10(IFNULL(msg.msgs_90d,0)+1)*10 + LOG10(IFNULL(mem.members,0)+1)*5) DESC LIMIT 150`;
  // Preferred: rank the small candidate cut by name-specificity + #help so the right
  // channel survives the cut; if BigQuery rejects it, fall back to the plain query.
  const smart = build(
    ",\n                 (" +
      nameScore +
      ") AS name_score,\n                 CAST(STARTS_WITH(LOWER(channel_name),'help') AS INT64) AS help_hit",
    "ORDER BY name_score DESC, help_hit DESC"
  );
  try {
    const { results } = await bq.querySync(smart, {}, { timeoutMs: 90000, maxResults: 150 });
    return { rows: (results || []) as ChannelCandidate[], dwError: null };
  } catch (e) {
    // fall through to the simplest known-good shape (no computed columns / candidate ordering)
    try {
      const { results } = await bq.querySync(build("", ""), {}, { timeoutMs: 90000, maxResults: 150 });
      return { rows: (results || []) as ChannelCandidate[], dwError: null };
    } catch (e2) {
      return { rows: [], dwError: errMsg(e2) };
    }
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── prescore: blend IDF relevance with real activity + votes (L475-513) ──────
export function prescoreChannels(
  cands: ChannelCandidate[],
  terms: string[],
  voteMap: VoteMap
): ChannelCandidate[] {
  const t = terms.map((x) => x.toLowerCase()).filter((x) => x.length >= 3);
  // IDF over the candidate set: a term matching most candidates is low-signal; a rare term
  // is high-signal. Stops a generic token from letting a busy, unrelated channel win.
  const N = cands.length || 1;
  const idf: Record<string, number> = {};
  t.forEach((x) => {
    let dfc = 0;
    for (const c of cands) {
      if (tokenHit(((c.channel_name || "") + " " + (c.purpose || "") + " " + (c.topic || "")).toLowerCase(), x))
        dfc++;
    }
    idf[x] = Math.log((N + 1) / (dfc + 1));
  });
  const wsum = (text: string) => t.reduce((a, x) => a + (tokenHit(text, x) ? idf[x]! : 0), 0);
  const scored = cands.map((c) => {
    const name = (c.channel_name || "").toLowerCase();
    const ptext = ((c.purpose || "") + " " + (c.topic || "")).toLowerCase();
    const isHelp = /^help[-_]/.test(name) || name.includes("help");
    const nameHits = t.filter((x) => tokenHit(name, x)).length;
    const purpHits = t.filter((x) => tokenHit(ptext, x)).length;
    const nameW = wsum(name);
    const purpW = wsum(ptext);
    const nameMatch = nameHits > 0;
    const textMatch = nameHits > 0 || purpHits > 0;
    const msgs = Number(c.msgs_90d) || 0;
    const mem = Number(c.members) || 0;
    // Cap activity so a huge off-topic channel can't outweigh a specific on-topic one.
    let s = Math.min(Math.log10(msgs + 1) * 10, 24) + Math.min(Math.log10(mem + 1) * 6, 14);
    s += nameW * 10; // IDF-weighted name relevance (rare terms dominate)
    s += Math.max(-15, Math.min(15, voteNet(voteMap, c.channel_name) * 4)); // thumbs up/down nudge
    s += Math.min(purpW * 4, 16); // lighter IDF-weighted purpose relevance
    if (isHelp) s += 16; // #help-* is where you go to ASK
    if (isHelp && nameMatch) s += 14; // a specific help channel is the strongest signal
    if (mem >= 200 && msgs >= 50) s += 5;
    if (!textMatch) s -= 25;
    if (msgs > 200 && mem < 8) s -= 12; // automated/bot feed, not a place to ask
    if (msgs < 10 && mem < 25 && !nameMatch) s -= 15; // ghost town
    const strongHelp = isHelp && nameMatch && nameW >= 1.0 && (msgs >= 20 || mem >= 30);
    return { c, s, nameMatch, msgs, strongHelp };
  });
  const kept = scored
    .filter((x) => !isNoiseChannel(x.c.channel_name) && (x.msgs >= 5 || x.nameMatch))
    .sort((a, b) => b.s - a.s)
    .slice(0, 18);
  kept.forEach((x) => {
    x.c._strongHelp = x.strongHelp;
  });
  return kept.map((x) => x.c);
}

// ── rank: prescore → LLM pick 2-5 → fold in pinned strong-help (L514-539) ────
export async function rankChannels(
  llm: LlmClient,
  query: string,
  terms: string[],
  cands: ChannelCandidate[],
  voteMap: VoteMap
): Promise<ChannelCard[]> {
  const top = prescoreChannels(cands, terms, voteMap);
  if (!top.length) return [];
  const toCard = (c: ChannelCandidate, reason?: string): ChannelCard => ({
    id: c.channel_id,
    name: c.channel_name,
    reason: reason || "",
    purpose: c.purpose || "",
    msgs: Number(c.msgs_90d) || 0,
    members: Number(c.members) || 0,
  });
  // Deterministic safety net: on-topic, active #help-* channels we ALWAYS keep.
  const pinned = top.filter((c) => c._strongHelp).slice(0, 2);
  const slim = top.map((c) => ({
    id: c.channel_id,
    name: c.channel_name,
    purpose: (c.purpose || "").slice(0, 180),
    msgs_90d: Number(c.msgs_90d) || 0,
    members: Number(c.members) || 0,
  }));
  let picks: ChannelCard[] = [];
  try {
    const content = await llm.chat([
      { role: "system", content: RANK_SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify({ question: query, channels: slim }) },
    ]);
    const txt = content.trim().replace(/^```(json)?/i, "").replace(/```$/, "");
    const parsed = JSON.parse(txt);
    const byId: Record<string, ChannelCandidate> = Object.fromEntries(
      top.map((c) => [c.channel_id, c])
    );
    picks = ((parsed.picks || []) as Array<{ id: string; reason?: string }>)
      .map((p) => {
        const c = byId[p.id];
        return c ? toCard(c, p.reason) : null;
      })
      .filter((x): x is ChannelCard => x != null);
  } catch {
    /* fall through to prescore top */
  }
  if (!picks.length) picks = top.slice(0, 4).map((c) => toCard(c));
  // Fold in any pinned strong-help channel the model left out, keeping it near the top.
  const have = new Set(picks.map((p) => p.id));
  const extra = pinned
    .filter((c) => !have.has(c.channel_id))
    .map((c) => toCard(c, "Dedicated #help channel for this exact topic"));
  const seen = new Set<string>();
  const out: ChannelCard[] = [];
  for (const p of [...extra, ...picks]) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
    if (out.length >= 5) break;
  }
  return out;
}

// ── teach-time validation: which of these names are LIVE channels? ───────────
// Unlike resolveNamedChannels, this does NOT swallow errors — callers distinguish
// "channel not found" (empty set) from "BigQuery unavailable" (throws).
export async function channelsExist(
  bq: BigQueryClient,
  names: Array<string | null | undefined>
): Promise<Set<string>> {
  const list = [
    ...new Set(
      (names || []).map((n) =>
        String(n || "").toLowerCase().replace(/^#/, "").replace(/[^a-z0-9._-]/g, "")
      )
    ),
  ]
    .filter(Boolean)
    .slice(0, 20);
  const found = new Set<string>();
  if (!list.length) return found;
  const inl = list.map((n) => `'${n}'`).join(",");
  const sql = `
        SELECT DISTINCT LOWER(channel_name) AS channel_name
        FROM \`shopify-dw.people.slack_channels\`
        WHERE is_archived=FALSE AND is_deleted=FALSE AND LOWER(channel_name) IN (${inl})`;
  const { results } = await bq.querySync(sql, {}, { timeoutMs: 30000, maxResults: 50 });
  for (const r of results || []) if (r.channel_name) found.add(String(r.channel_name));
  return found;
}

// ── teach-time helper: suggest live #help channels near a mistyped name ──────
export async function suggestChannels(
  bq: BigQueryClient,
  names: Array<string | null | undefined>,
  limit = 6
): Promise<string[]> {
  const toks = [
    ...new Set(
      (names || [])
        .flatMap((n) => String(n || "").toLowerCase().split(/[-_/\s]+/))
        .map((t) => t.replace(/[^a-z0-9]/g, ""))
        .filter((t) => t.length >= 3 && t !== "help")
    ),
  ].slice(0, 6);
  if (!toks.length) return [];
  const likes = toks.map((t) => `LOWER(channel_name) LIKE '%${t}%'`).join(" OR ");
  const cap = Math.max(1, Math.min(limit, 20));
  const sql = `
        SELECT channel_name
        FROM \`shopify-dw.people.slack_channels\`
        WHERE is_archived=FALSE AND is_deleted=FALSE AND STARTS_WITH(LOWER(channel_name),'help') AND (${likes})
        ORDER BY channel_name LIMIT ${cap}`;
  try {
    const { results } = await bq.querySync(sql, {}, { timeoutMs: 30000, maxResults: cap });
    return (results || []).map((r: any) => r.channel_name).filter(Boolean);
  } catch {
    return [];
  }
}

// ── resolve exact channel names → id + purpose + activity (L661-675) ─────────
export async function resolveNamedChannels(
  bq: BigQueryClient,
  names: Array<string | null | undefined>
): Promise<ChannelCandidate[]> {
  const list = [
    ...new Set(
      (names || []).map((n) =>
        String(n || "").toLowerCase().replace(/^#/, "").replace(/[^a-z0-9._-]/g, "")
      )
    ),
  ]
    .filter(Boolean)
    .slice(0, 8);
  if (!list.length) return [];
  const inl = list.map((n) => `'${n}'`).join(",");
  const sql = `
        WITH c AS (SELECT channel_id, channel_name, purpose FROM \`shopify-dw.people.slack_channels\`
                   WHERE is_archived=FALSE AND is_deleted=FALSE AND LOWER(channel_name) IN (${inl})),
        mem AS (SELECT channel_id, COUNT(DISTINCT user_id) members FROM \`shopify-dw.people.slack_channel_members_daily\`
                WHERE valid_on=(SELECT MAX(valid_on) FROM \`shopify-dw.people.slack_channel_members_daily\`) AND channel_id IN (SELECT channel_id FROM c) GROUP BY 1),
        msg AS (SELECT channel_name, COUNT(DISTINCT archive_message_id) msgs_90d FROM \`shopify-dw.people.slack_messages\`
                WHERE message_at>=TIMESTAMP_SUB(CURRENT_TIMESTAMP(),INTERVAL 90 DAY) AND is_bot_user=FALSE AND channel_name IN (SELECT channel_name FROM c) GROUP BY 1)
        SELECT c.channel_id, c.channel_name, c.purpose, IFNULL(mem.members,0) AS members, IFNULL(msg.msgs_90d,0) AS msgs_90d
        FROM c LEFT JOIN mem ON mem.channel_id=c.channel_id LEFT JOIN msg ON msg.channel_name=c.channel_name`;
  try {
    const { results } = await bq.querySync(sql, {}, { timeoutMs: 60000, maxResults: 8 });
    return (results || []) as ChannelCandidate[];
  } catch {
    return [];
  }
}
