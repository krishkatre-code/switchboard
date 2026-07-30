import { loadConfig } from "./config/env";
import { setLogLevel, log } from "./util/logger";
import { BigQueryClient } from "./clients/bigquery";
import { LlmClient } from "./clients/llm";
import { buildStore } from "./clients/store";
import { SharedDataCache } from "./cache/sharedData";
import { ShareCache } from "./slack/shareCache";
import { buildApp } from "./slack/app";
import { registerCommand } from "./slack/command";
import { registerActions } from "./slack/actions";
import type { Deps } from "./deps";

async function main(): Promise<void> {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);

  const store = buildStore(cfg.store);
  const deps: Deps = {
    cfg,
    bq: new BigQueryClient(cfg.bigquery),
    llm: new LlmClient(cfg.llm),
    store,
    shared: new SharedDataCache(store, cfg.sharedCacheTtlMs),
    shareCache: new ShareCache(),
  };

  const { app } = buildApp(cfg);
  registerCommand(app, deps);
  registerActions(app, deps);

  if (cfg.slack.socketMode) {
    await app.start();
    log.info(`⚡ Switchboard running (Socket Mode) — command ${cfg.slack.command}`);
  } else {
    await app.start(cfg.slack.port);
    log.info(
      `⚡ Switchboard listening on :${cfg.slack.port} — POST /slack/events, GET /health, command ${cfg.slack.command}`
    );
  }

  if (cfg.store.backend === "quick") {
    log.warn("STORE_BACKEND=quick uses a stub (IAP-protected) — overrides/feedback won't persist.");
  }
}

main().catch((err) => {
  log.error("Fatal startup error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
