import type { Config } from "./config/env";
import type { BigQueryClient } from "./clients/bigquery";
import type { LlmClient } from "./clients/llm";
import type { Store } from "./clients/store";
import type { SharedDataCache } from "./cache/sharedData";
import type { ShareCache } from "./slack/shareCache";

/** Everything the Slack handlers need, built once at startup and injected. */
export interface Deps {
  cfg: Config;
  bq: BigQueryClient;
  llm: LlmClient;
  store: Store;
  shared: SharedDataCache;
  shareCache: ShareCache;
}
