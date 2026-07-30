/**
 * Local routing harness — run the full pipeline against a query WITHOUT Slack.
 *
 *   pnpm route "who owns checkout-web"
 *   pnpm route "how do I request a prod data export"
 *   pnpm route --json "shop pay payments"      # machine-readable dump
 *
 * Uses the exact same config + clients as the server, then prints every decision
 * point (intent, expanded terms, raw candidates, ranking, override hits, derived
 * owner, responsiveness, committers) so you can see *why* it routed the way it did.
 * This is the fast tuning loop: no Slack round-trip, full visibility.
 */
import { loadConfig, assertPipelineReady } from "../src/config/env";
import { setLogLevel } from "../src/util/logger";
import { BigQueryClient } from "../src/clients/bigquery";
import { LlmClient } from "../src/clients/llm";
import { buildStore } from "../src/clients/store";
import { SharedDataCache } from "../src/cache/sharedData";
import { route } from "../src/orchestrator/route";
import type { RouteResult } from "../src/orchestrator/types";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

/** Collapse a trace value to a compact one-line summary for the human view. */
function oneLine(label: string, data: any): string {
  switch (label) {
    case "intent":
      return `mode=${data.mode}  entity=${JSON.stringify(data.entity)}  type=${data.entity_type}`;
    case "entityTokens":
    case "expandedTerms":
      return `[${(data as string[]).join(", ")}]`;
    case "ownership.raw":
      return `${(data as any[]).length} rows`;
    case "ownership.actionable":
    case "ownership.final":
      return (data as any[]).length
        ? (data as any[])
            .map((o) => `${o.team_name || o.entity}${o.repository ? ` (${o.repository})` : ""}${o.gen ? ` → #${o.gen}` : ""}`)
            .join("  |  ")
        : "(none)";
    case "channels.candidates":
      return `${data.count} candidates${data.dwError ? ` ${YELLOW}[dwError: ${data.dwError}]${RESET}` : ""}\n${DIM}       ${(data.names as string[]).join(", ") || "—"}${RESET}`;
    case "channels.ranked":
      return (data as any[]).length
        ? (data as any[]).map((c) => `#${c.name} ${DIM}(${c.reason})${RESET}`).join("\n       ")
        : "(none)";
    case "overrides":
      return data.hits
        ? `${data.hits} hit(s): ${(data.triggers as string[]).join(", ")}  pinned=${data.pinned}`
        : "(no hits)";
    case "committers":
      return data.repoHint
        ? `repo=${data.repoHint}  ${(data.committers as any[]).map((c) => `${c.username}(${c.commits})`).join(", ") || "—"}`
        : "(no repo hint)";
    default:
      return JSON.stringify(data);
  }
}

function printResult(r: RouteResult): void {
  console.log(`\n${BOLD}RESULT${RESET}`);
  const owner = r.ownership[0];
  console.log(
    `  owner:    ${owner ? `${owner.team_name || owner.entity}${owner.gen ? `  →  #${owner.gen}` : ""}` : `${DIM}(none — channels carry the answer)${RESET}`}`
  );
  console.log(
    `  channels: ${r.channels.length ? r.channels.map((c) => "#" + c.name).join(", ") : `${DIM}(none)${RESET}`}`
  );
  if (r.overrode) console.log(`  ${YELLOW}⚡ a curated override pinned the top channel(s)${RESET}`);
  if (r.dwError) console.log(`  ${YELLOW}⚠️ BigQuery: ${r.dwError}${RESET}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const jsonOut = argv[0] === "--json";
  const query = (jsonOut ? argv.slice(1) : argv).join(" ").trim();
  if (!query) {
    console.error('Usage: pnpm route [--json] "<query>"');
    process.exit(2);
  }

  const cfg = loadConfig();
  setLogLevel(jsonOut ? "error" : cfg.logLevel);
  try {
    assertPipelineReady(cfg);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }

  const store = buildStore(cfg.store);
  const bq = new BigQueryClient(cfg.bigquery);
  const llm = new LlmClient(cfg.llm);
  const shared = new SharedDataCache(store, cfg.sharedCacheTtlMs);
  const snap = await shared.get();

  const trace: Array<{ label: string; data: unknown }> = [];
  const started = Date.now();
  const result = await route(query, {
    bq,
    llm,
    voteMap: snap.voteMap,
    overrides: snap.overrides,
    trace: (label, data) => trace.push({ label, data }),
  });
  const ms = Date.now() - started;

  if (jsonOut) {
    console.log(JSON.stringify({ query, ms, trace, result }, null, 2));
    return;
  }

  console.log(`\n${BOLD}QUERY${RESET}  ${CYAN}"${query}"${RESET}  ${DIM}(${ms}ms, ${snap.overrides.length} overrides loaded)${RESET}\n`);
  for (const { label, data } of trace) {
    console.log(`${label.padEnd(22)} ${oneLine(label, data)}`);
  }
  printResult(result);
  console.log("");
}

main().catch((err) => {
  console.error("route harness failed:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
