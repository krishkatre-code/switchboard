import type { BigQueryClient } from "../clients/bigquery";
import type { RespMap } from "../orchestrator/types";

/**
 * Responsiveness signal: median time to the FIRST reply in a thread (port of
 * findResponsiveness, L347-372). Scoped to the shown channels so the 90d slack_messages
 * scan stays cheap. Returns a RespMap (channel_name→median_sec) instead of a global.
 */
export async function findResponsiveness(
  bq: BigQueryClient,
  names: Array<string | null | undefined>
): Promise<RespMap> {
  const respMap: RespMap = {};
  const list = [
    ...new Set((names || []).map((n) => String(n || "").toLowerCase().replace(/[^a-z0-9._-]/g, ""))),
  ]
    .filter(Boolean)
    .slice(0, 6);
  if (!list.length) return respMap;
  const inl = list.map((n) => `'${n}'`).join(",");
  const sql = `
        WITH m AS (
          SELECT channel_name, thread_ts, message_at
          FROM \`shopify-dw.people.slack_messages\`
          WHERE message_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 90 DAY)
            AND is_bot_user=FALSE AND thread_ts IS NOT NULL
            AND thread_ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 90 DAY)
            AND channel_name IN (${inl})
        ),
        t AS (
          SELECT channel_name, thread_ts, ARRAY_AGG(message_at ORDER BY message_at) AS ats, COUNT(*) AS n
          FROM m GROUP BY channel_name, thread_ts HAVING n>=2
        )
        SELECT channel_name, COUNT(*) AS threads,
               APPROX_QUANTILES(TIMESTAMP_DIFF(ats[OFFSET(1)], ats[OFFSET(0)], SECOND), 2)[OFFSET(1)] AS median_sec
        FROM t GROUP BY channel_name`;
  try {
    const { results } = await bq.querySync(sql, {}, { timeoutMs: 60000, maxResults: 20 });
    (results || []).forEach((r: any) => {
      if (Number(r.threads) >= 8) respMap[(r.channel_name || "").toLowerCase()] = Number(r.median_sec);
    });
  } catch {
    /* responsiveness is best-effort */
  }
  return respMap;
}
