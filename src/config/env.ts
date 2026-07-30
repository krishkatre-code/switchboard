import "dotenv/config";
import { z } from "zod";

/**
 * All environment/config lives here, validated once at startup. The rest of the
 * app imports the typed `Config` — no `process.env` reads scattered around.
 *
 * Secrets required for the pipeline (BigQuery / LLM) are validated lazily via
 * `assertPipelineReady()` so the echo skeleton (Phase 1) can run with only Slack
 * creds, and the service fails fast with a clear message the moment a real query
 * needs a credential that is missing.
 */

const boolish = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null ? def : /^(1|true|yes|on)$/i.test(v.trim())));

const intWithDefault = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v.trim() === "" ? def : Number(v)))
    .pipe(z.number().int().nonnegative());

const EnvSchema = z.object({
  // Slack
  SLACK_BOT_TOKEN: z.string().min(1, "SLACK_BOT_TOKEN is required"),
  SLACK_SIGNING_SECRET: z.string().optional().default(""),
  SLACK_APP_TOKEN: z.string().optional().default(""),
  SWITCHBOARD_SOCKET_MODE: boolish(false),
  SLACK_COMMAND: z
    .string()
    .optional()
    .default("/switchboard")
    .transform((v) => (v.startsWith("/") ? v : `/${v}`)),
  PORT: intWithDefault(3000),

  // LLM gateway
  LLM_BASE_URL: z.string().optional().default(""),
  LLM_API_KEY: z.string().optional().default(""),
  LLM_MODEL: z.string().optional().default("gpt-5.4"),
  LLM_TIMEOUT_MS: intWithDefault(20_000),

  // BigQuery
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional().default(""),
  BIGQUERY_PROJECT_ID: z.string().optional().default(""),
  BIGQUERY_LOCATION: z.string().optional().default("US"),
  BIGQUERY_MAX_BYTES_BILLED: intWithDefault(50_000_000_000),

  // Store
  STORE_BACKEND: z.enum(["file", "quick"]).optional().default("file"),
  STORE_FILE_PATH: z.string().optional().default("./data"),
  QUICK_API_BASE_URL: z
    .string()
    .optional()
    .default("https://switchboard-hq.quick.shopify.io/api/db"),

  // Misc
  SHARED_CACHE_TTL_MS: intWithDefault(60_000),
  LOG_LEVEL: z
    .enum(["debug", "info", "warn", "error"])
    .optional()
    .default("info"),
});

export type Config = {
  slack: {
    botToken: string;
    signingSecret: string;
    appToken: string;
    socketMode: boolean;
    command: string;
    port: number;
  };
  llm: {
    baseUrl: string;
    apiKey: string;
    model: string;
    timeoutMs: number;
  };
  bigquery: {
    keyFile: string;
    projectId: string;
    location: string;
    maxBytesBilled: number;
  };
  store: {
    backend: "file" | "quick";
    filePath: string;
    quickApiBaseUrl: string;
  };
  sharedCacheTtlMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const e = parsed.data;

  const cfg: Config = {
    slack: {
      botToken: e.SLACK_BOT_TOKEN,
      signingSecret: e.SLACK_SIGNING_SECRET,
      appToken: e.SLACK_APP_TOKEN,
      socketMode: e.SWITCHBOARD_SOCKET_MODE,
      command: e.SLACK_COMMAND,
      port: e.PORT,
    },
    llm: {
      baseUrl: e.LLM_BASE_URL,
      apiKey: e.LLM_API_KEY,
      model: e.LLM_MODEL,
      timeoutMs: e.LLM_TIMEOUT_MS,
    },
    bigquery: {
      keyFile: e.GOOGLE_APPLICATION_CREDENTIALS,
      projectId: e.BIGQUERY_PROJECT_ID,
      location: e.BIGQUERY_LOCATION,
      maxBytesBilled: e.BIGQUERY_MAX_BYTES_BILLED,
    },
    store: {
      backend: e.STORE_BACKEND,
      filePath: e.STORE_FILE_PATH,
      quickApiBaseUrl: e.QUICK_API_BASE_URL,
    },
    sharedCacheTtlMs: e.SHARED_CACHE_TTL_MS,
    logLevel: e.LOG_LEVEL,
  };

  // Socket Mode needs an app-level token; HTTP mode needs a signing secret.
  if (cfg.slack.socketMode && !cfg.slack.appToken) {
    throw new Error(
      "SWITCHBOARD_SOCKET_MODE=true requires SLACK_APP_TOKEN (xapp-…)."
    );
  }
  if (!cfg.slack.socketMode && !cfg.slack.signingSecret) {
    throw new Error(
      "HTTP mode requires SLACK_SIGNING_SECRET (or set SWITCHBOARD_SOCKET_MODE=true)."
    );
  }

  return cfg;
}

/**
 * Fail fast (with an actionable message) if a live query is attempted before the
 * pipeline credentials are configured. Called from the command handler, not at boot,
 * so the echo skeleton runs with Slack creds alone.
 */
export function assertPipelineReady(cfg: Config): void {
  const missing: string[] = [];
  if (!cfg.llm.baseUrl) missing.push("LLM_BASE_URL");
  if (!cfg.llm.apiKey) missing.push("LLM_API_KEY");
  if (!cfg.bigquery.projectId) missing.push("BIGQUERY_PROJECT_ID");
  if (missing.length) {
    throw new Error(
      `Pipeline is not configured — set: ${missing.join(", ")}. ` +
        `See .env.example. (BigQuery also needs GOOGLE_APPLICATION_CREDENTIALS or ADC.)`
    );
  }
}
