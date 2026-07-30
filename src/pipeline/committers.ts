import type { BigQueryClient } from "../clients/bigquery";
import type { Committer } from "../orchestrator/types";

/**
 * Real code owners: top committers to a repo over the last 180d, resolved to GitHub
 * logins (port of findCommitters, L377-398). Returns Committer[] instead of a global.
 */
export async function findCommitters(
  bq: BigQueryClient,
  repoFull: string
): Promise<Committer[]> {
  const s = String(repoFull || "").toLowerCase().replace(/[^a-z0-9._\/-]/g, "");
  let org: string | null = null;
  let rn = s;
  if (s.includes("/")) {
    const parts = s.split("/").filter(Boolean);
    rn = parts.pop() || "";
    org = parts.pop() || null;
  }
  rn = rn.replace(/[^a-z0-9._-]/g, "");
  if (!rn || rn.length < 2) return [];
  const orgFilter = org ? ` AND LOWER(organization_name)='${org.replace(/[^a-z0-9._-]/g, "")}'` : "";
  const sql = `
        WITH c AS (
          SELECT github_author_id
          FROM \`shopify-dw.base.base__github__default_branch_commits\`
          WHERE committed_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 180 DAY)
            AND github_author_type='User' AND LOWER(repository_name)='${rn}'${orgFilter}
        )
        SELECT u.username AS username, COUNT(*) AS commits
        FROM c JOIN \`shopify-dw.infrastructure.github_users\` u ON u.user_id=c.github_author_id
        GROUP BY 1 ORDER BY commits DESC LIMIT 5`;
  try {
    const { results } = await bq.querySync(sql, {}, { timeoutMs: 60000, maxResults: 5 });
    return (results || [])
      .filter((r: any) => r.username)
      .map((r: any) => ({ username: r.username as string, commits: Number(r.commits) || 0 }));
  } catch {
    return [];
  }
}
