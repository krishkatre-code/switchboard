import { App, ExpressReceiver, LogLevel } from "@slack/bolt";
import type { Config } from "../config/env";

export interface BuiltApp {
  app: App;
  /** Present only in HTTP mode; used to mount /health and start the server. */
  receiver?: ExpressReceiver;
}

const boltLogLevel = (level: Config["logLevel"]): LogLevel =>
  level === "debug"
    ? LogLevel.DEBUG
    : level === "warn"
      ? LogLevel.WARN
      : level === "error"
        ? LogLevel.ERROR
        : LogLevel.INFO;

/**
 * Build the Bolt App with the right receiver:
 *  - Socket Mode (SWITCHBOARD_SOCKET_MODE=true): fastest local demo — no public URL,
 *    tunnel, or signature setup. Needs SLACK_APP_TOKEN.
 *  - HTTP mode (default): ExpressReceiver so we own the router (health + interactivity
 *    share the signature-verified /slack/events endpoint). Slack Request URLs point here.
 */
export function buildApp(cfg: Config): BuiltApp {
  const logLevel = boltLogLevel(cfg.logLevel);

  if (cfg.slack.socketMode) {
    const app = new App({
      token: cfg.slack.botToken,
      appToken: cfg.slack.appToken,
      socketMode: true,
      logLevel,
    });
    return { app };
  }

  const receiver = new ExpressReceiver({
    signingSecret: cfg.slack.signingSecret,
    // default endpoints: POST /slack/events (commands + interactivity + actions)
  });

  // Health check for load balancers / uptime probes. Not signature-verified (no Slack payload).
  receiver.router.get("/health", (_req, res) => {
    res.status(200).json({ ok: true, service: "switchboard" });
  });

  const app = new App({
    token: cfg.slack.botToken,
    receiver,
    logLevel,
  });

  return { app, receiver };
}
