import type { BigQueryClient } from "../clients/bigquery";
import type { OwnerRow } from "../orchestrator/types";
import { GENERIC, repoName } from "./text";

// ── ownership SQL (infra_central services + vault teams) (L278-303) ──────────
export function ownSql(tokens: string[]): string {
  const svc = tokens
    .map(
      (t) =>
        `LOWER(s.service_name) LIKE '%${t}%' OR LOWER(IFNULL(s.repository,'')) LIKE '%${t}%'`
    )
    .join(" OR ");
  const tm = tokens
    .map(
      (t) =>
        `LOWER(t2.team_name) LIKE '%${t}%' OR LOWER(IFNULL(t2.slug,'')) LIKE '%${t}%' OR LOWER(IFNULL(t2.github_repo,'')) LIKE '%${t}%'`
    )
    .join(" OR ");
  return `
        WITH ch AS (
          SELECT LOWER(channel_name) AS cname, ANY_VALUE(channel_id) AS cid
          FROM \`shopify-dw.people.slack_channels\` WHERE is_archived=FALSE AND is_deleted=FALSE GROUP BY 1
        ),
        svc AS (
          SELECT 'service' AS kind, s.service_name AS entity, s.repository AS repository, s.vault_team_id AS team_id
          FROM \`shopify-dw.base.base__infra_central__services\` s WHERE ${svc} LIMIT 15
        ),
        tmatch AS (
          SELECT 'team' AS kind, t2.team_name AS entity, t2.github_repo AS repository, t2.team_id AS team_id
          FROM \`shopify-dw.base.base__infra_central__org_vault_teams\` t2 WHERE ${tm} LIMIT 15
        ),
        hits AS (SELECT * FROM svc UNION ALL SELECT * FROM tmatch)
        SELECT h.kind, h.entity, h.repository, t.team_name, t.name_with_hierarchy, t.vault_id,
               t.group_name, t.general_slack_channel_name AS gen, t.support_slack_channel_name AS sup,
               cg.cid AS gen_id, cs.cid AS sup_id
        FROM hits h
        LEFT JOIN \`shopify-dw.base.base__infra_central__org_vault_teams\` t ON t.team_id = h.team_id
        LEFT JOIN ch cg ON cg.cname = LOWER(t.general_slack_channel_name)
        LEFT JOIN ch cs ON cs.cname = LOWER(t.support_slack_channel_name)
        LIMIT 20`;
}

export async function findOwnership(
  bq: BigQueryClient,
  tokens: string[]
): Promise<OwnerRow[]> {
  if (!tokens.length) return [];
  const { results } = await bq.querySync(ownSql(tokens), {}, { timeoutMs: 60000, maxResults: 20 });
  return (results || []) as OwnerRow[];
}

// ── rank ownership rows (L309-322) ───────────────────────────────────────────
export function rankOwnership(rows: OwnerRow[], tokens: string[]): OwnerRow[] {
  const score = (r: OwnerRow): number => {
    const e = (r.entity || "").toLowerCase();
    const rep = (r.repository || "").toLowerCase();
    let s = 0;
    for (const t of tokens) {
      if (e === t) s += 100;
      else if (e.startsWith(t)) s += 40;
      else if (e.includes(t)) s += 15;
      if (rep === t) s += 60;
      else if (rep.includes(t)) s += 20;
    }
    if (r.team_name) s += 3;
    if (r.kind === "service") s += 4;
    return s;
  };
  const seen = new Set<string>();
  return rows
    .map((r) => ({ r, s: score(r) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .filter(({ r }) => {
      const k = r.kind + "|" + (r.entity || "") + "|" + (r.team_name || "");
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 4)
    .map(({ r }) => r);
}

// ── owner match helpers (L195, L199-208) ─────────────────────────────────────
// Actionable = something to click beyond a bare Vault link (a channel or a repo).
export function ownerActionable(r: OwnerRow): boolean {
  return !!(r.gen || r.sup || r.repository);
}

// 'exact' = a specific token IS the entity/repo name; 'word' = it's a whole word
// inside it. Generic/short tokens never match.
export function ownerMatch(r: OwnerRow, toks: string[]): "exact" | "word" | null {
  const e = (r.entity || "").toLowerCase();
  const rn = repoName(r.repository);
  const words = new Set((e + " " + rn).split(/[^a-z0-9]+/).filter(Boolean));
  let best: "exact" | "word" | null = null;
  for (const t of toks) {
    if (GENERIC.has(t) || t.length < 3) continue;
    if (e === t || rn === t) return "exact";
    if (words.has(t)) best = "word";
  }
  return best;
}

// ── reverse lookup: which team OWNS a given channel (L327-339) ───────────────
export async function findChannelOwner(
  bq: BigQueryClient,
  names: Array<string | null | undefined>
): Promise<OwnerRow[]> {
  const list = [
    ...new Set(names.map((n) => String(n || "").toLowerCase().replace(/[^a-z0-9._-]/g, ""))),
  ].filter(Boolean);
  if (!list.length) return [];
  const inl = list.map((n) => `'${n}'`).join(",");
  const sql = `
        SELECT LOWER(support_slack_channel_name) AS sup, LOWER(general_slack_channel_name) AS gen,
               team_name, name_with_hierarchy, group_name, vault_id
        FROM \`shopify-dw.base.base__infra_central__org_vault_teams\`
        WHERE LOWER(support_slack_channel_name) IN (${inl}) OR LOWER(general_slack_channel_name) IN (${inl})
        LIMIT 25`;
  try {
    const { results } = await bq.querySync(sql, {}, { timeoutMs: 30000, maxResults: 25 });
    return (results || []) as OwnerRow[];
  } catch {
    return [];
  }
}
