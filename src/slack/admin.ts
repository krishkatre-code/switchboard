import type { Override, Vote, RecentSearch } from "../orchestrator/types";
import { summarizeFeedback } from "../pipeline/feedback";
import { mrkdwnEscape } from "../pipeline/text";

/**
 * Pure renderers + matchers for the maintenance subcommands (`routes`, `forget`,
 * `recent`, `feedback`). Kept out of the command handler so they stay testable and
 * so the handler only wires Store I/O to these strings. All output is Slack mrkdwn.
 */

const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Normalize a trigger for equality (lowercase, trim, collapse internal whitespace). */
export function normTrigger(s: string): string {
  return (s || "").toLowerCase().trim().replace(/\s+/g, " ");
}

/** Overrides whose trigger equals `input` after normalization (usually 0 or 1). */
export function findByTrigger(overrides: Override[], input: string): Override[] {
  const want = normTrigger(input);
  if (!want) return [];
  return overrides.filter((o) => o && o.trigger && normTrigger(String(o.trigger)) === want);
}

/** Newest-first, case-insensitively de-duplicated query list, capped. */
export function dedupeQueries(rows: RecentSearch[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    const q = (r.query || "").trim();
    if (!q) continue;
    const k = q.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(q);
    if (out.length >= limit) break;
  }
  return out;
}

/** `<@U123>` if it looks like a Slack user id, else escaped text (or "" if empty). */
function byLabel(by: string | undefined): string {
  const v = (by || "").trim();
  if (!v) return "";
  if (/^[UW][A-Z0-9]{6,}$/.test(v)) return `<@${v}>`;
  return mrkdwnEscape(v);
}

function shortDate(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function renderRoutes(overrides: Override[]): string {
  if (!overrides.length) {
    return (
      "No routes taught yet. Pin one with:\n" +
      "`/switchboard teach shop pay => help-payments-account-capabilities`"
    );
  }
  const lines = overrides.slice(0, 40).map((o) => {
    const chans = (o.channels || []).map((c) => "#" + mrkdwnEscape(c)).join(" ") || "_(none)_";
    const who = byLabel(o.by);
    const when = shortDate(o.created_at);
    const meta = who || when ? ` _(${[who, when].filter(Boolean).join(" · ")})_` : "";
    return `• *${mrkdwnEscape(o.trigger)}* → ${chans}${meta}`;
  });
  const extra = overrides.length > 40 ? `\n_…and ${overrides.length - 40} more._` : "";
  return (
    `*Taught routes (${overrides.length})*\n` +
    lines.join("\n") +
    extra +
    "\n\n_Remove one:_ `/switchboard forget <trigger>`"
  );
}

export function renderRecent(rows: RecentSearch[]): string {
  const qs = dedupeQueries(rows, 12);
  if (!qs.length) return "No recent lookups yet.";
  return `*Recent lookups*\n` + qs.map((q) => `• ${mrkdwnEscape(trunc(q, 160))}`).join("\n");
}

export function renderFeedback(votes: Vote[]): string {
  const rep = summarizeFeedback(votes);
  if (!rep.total) return "No feedback yet — 👍/👎 on results to build the signal.";

  const lines: string[] = [`*Feedback* — ${rep.total} vote${rep.total === 1 ? "" : "s"} recorded`];

  const badPairs = rep.pairs.filter((p) => p.net < 0).slice(0, 10);
  if (badPairs.length) {
    lines.push("", "🔻 *Flagged wrong* (fix ranking or re-`teach`):");
    for (const p of badPairs) {
      const q = p.query ? `_${mrkdwnEscape(trunc(p.query, 120))}_` : "_(no query captured)_";
      lines.push(`• \`${p.net}\`  #${mrkdwnEscape(p.channel)} — ${q}  (${p.down}👎)`);
    }
  } else {
    lines.push("", "No thumbs-down yet — nothing flagged wrong. 🎉");
  }

  const badChans = rep.channels.filter((c) => c.net < 0).slice(0, 5);
  if (badChans.length) {
    lines.push("", "👎 *Most-downvoted channels:*");
    for (const c of badChans) lines.push(`• #${mrkdwnEscape(c.channel)} (${c.net})`);
  }
  return lines.join("\n");
}
