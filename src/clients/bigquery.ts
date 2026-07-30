import { BigQuery } from "@google-cloud/bigquery";
import type { Config } from "../config/env";

export interface QuerySyncOpts {
  /** Maps to BigQuery jobTimeoutMs (the browser client's timeoutMs). */
  timeoutMs?: number;
  /** Cap on returned rows, matching the browser client's maxResults. */
  maxResults?: number;
}

/**
 * Drop-in replacement for the browser's `quick.dw.querySync(sql, {}, {timeoutMs, maxResults})`.
 * Returns the SAME `{ results }` shape so ported pipeline code is unchanged.
 *
 * The SQL strings are copied VERBATIM from the web app (they hardcode `shopify-dw.*`
 * tables). User-derived values are sanitized upstream (quotes stripped by `toTerms` /
 * `entityTokens` / IN-list re-sanitizers), so string interpolation carries no quote-breakout
 * surface; the `params` arg is kept for future parameterization without touching call sites.
 *
 * Every job carries `maximumBytesBilled` so a runaway query fails fast instead of draining
 * the shared service-account's quota (the web app documents a prior byte-scan blowup).
 */
export class BigQueryClient {
  private readonly bq: BigQuery;
  private readonly location: string;
  private readonly maxBytesBilled: string;

  constructor(cfg: Config["bigquery"]) {
    this.bq = new BigQuery({
      projectId: cfg.projectId || undefined,
      // If keyFile is empty, the client falls back to Application Default Credentials.
      keyFilename: cfg.keyFile || undefined,
    });
    this.location = cfg.location;
    this.maxBytesBilled = String(cfg.maxBytesBilled);
  }

  async querySync(
    sql: string,
    params: Record<string, unknown> = {},
    opts: QuerySyncOpts = {}
  ): Promise<{ results: any[] }> {
    const [rows] = await this.bq.query({
      query: sql,
      params,
      location: this.location,
      maximumBytesBilled: this.maxBytesBilled,
      ...(opts.timeoutMs ? { jobTimeoutMs: opts.timeoutMs } : {}),
    });
    const results = opts.maxResults ? rows.slice(0, opts.maxResults) : rows;
    return { results };
  }
}
