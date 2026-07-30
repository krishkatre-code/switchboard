import type { App } from "@slack/bolt";
import type { Deps } from "../deps";
import { assertPipelineReady } from "../config/env";
import { route } from "../orchestrator/route";
import { channelsExist, suggestChannels } from "../pipeline/channels";
import { buildBlocks, fallbackText } from "./blocks";
import { renderRoutes, renderRecent, renderFeedback, findByTrigger } from "./admin";
import { mrkdwnEscape } from "../pipeline/text";
import { log } from "../util/logger";

/** Split a `teach` subcommand into a trigger phrase + channel list (mirrors addOverride L676). */
function parseTeach(rest: string): { trigger: string; channels: string[] } | null {
  const m = rest.split(/\s*(?:=>|->|=|:)\s*/);
  if (m.length < 2) return null;
  const trigger = (m[0] || "").trim().toLowerCase();
  const channels = (m.slice(1).join(" ") || "")
    .split(/[,\s]+/)
    .map((s) => s.toLowerCase().replace(/^#/, "").replace(/[^a-z0-9._-]/g, ""))
    .filter(Boolean);
  if (!trigger || !channels.length) return null;
  return { trigger, channels };
}

const USAGE =
  "Usage: `/switchboard <repo, service, team, or a question>`\n" +
  "• `/switchboard checkout-experience` — who owns it + where to ask\n" +
  "• `/switchboard how do I request a prod data export` — routes you to the right channel\n" +
  "• `/switchboard teach shop pay => help-payments-account-capabilities` — pin a curated route\n" +
  "• `/switchboard routes` — list taught routes · `forget <trigger>` — remove one\n" +
  "• `/switchboard recent` — recent lookups · `/switchboard feedback` — what's flagged wrong";

/**
 * The `/switchboard` handler. Acks within Slack's 3s window with a "Routing…" ephemeral,
 * then runs the (slow) BigQuery+LLM pipeline and replaces it via response_url. Awaiting
 * after ack() is safe on a long-lived ExpressReceiver/Socket process (not FaaS).
 */
export function registerCommand(app: App, deps: Deps): void {
  app.command(deps.cfg.slack.command, async ({ command, ack, respond }) => {
    const text = (command.text || "").trim();

    // "teach" writes an override and is not on the routing path — ack plainly.
    if (/^teach\b/i.test(text)) {
      await ack();
      const parsed = parseTeach(text.replace(/^teach\b/i, "").trim());
      if (!parsed) {
        await respond({
          response_type: "ephemeral",
          text: "Teach a route like: `/switchboard teach shop pay installments => help-payments help-billing`",
        });
        return;
      }
      // Validate the target channels against live Slack so we never save a dead route
      // (the #help-payments footgun). Only possible when BigQuery is configured.
      let channelsToStore = parsed.channels;
      const notes: string[] = [];
      if (deps.cfg.bigquery.projectId) {
        try {
          const known = await channelsExist(deps.bq, parsed.channels);
          const good = parsed.channels.filter((c) => known.has(c));
          const bad = parsed.channels.filter((c) => !known.has(c));
          if (bad.length) {
            notes.push(`⚠️ Not live channels: ${bad.map((c) => "#" + c).join(", ")}.`);
            const sugg = await suggestChannels(deps.bq, bad, 6);
            if (sugg.length) notes.push(`Did you mean: ${sugg.map((c) => "#" + c).join("   ")}?`);
          }
          if (!good.length) {
            // Nothing valid → don't save a route that can never pin anything.
            await respond({
              response_type: "ephemeral",
              text: [`Didn't save *${parsed.trigger}* — none of those are live channels.`, ...notes].join("\n"),
            });
            return;
          }
          channelsToStore = good; // keep only the channels that exist
        } catch (e) {
          // BigQuery hiccup — don't block teaching; store as typed (unvalidated).
          log.debug("teach validation skipped (BigQuery error)", e);
        }
      }

      try {
        await deps.store.overrides.create({
          trigger: parsed.trigger,
          channels: channelsToStore,
          by: command.user_id,
        });
        deps.shared.invalidate();
        await respond({
          response_type: "ephemeral",
          text: [
            `✅ Taught: *${parsed.trigger}* → ${channelsToStore.map((c) => "#" + c).join(" ")}`,
            ...notes,
          ].join("\n"),
        });
      } catch (e) {
        log.error("teach/override create failed", e);
        await respond({ response_type: "ephemeral", text: "Couldn't save that route — try again." });
      }
      return;
    }

    // ── Maintenance subcommands: fast Store reads/writes, off the routing path.
    // Ack plainly (no "Routing…") then reply ephemerally.
    const sub = text.split(/\s+/)[0]?.toLowerCase() ?? "";

    if (sub === "routes" || sub === "list") {
      await ack();
      try {
        const rows = await deps.store.overrides.list(200);
        await respond({ response_type: "ephemeral", text: renderRoutes(rows) });
      } catch (e) {
        log.error("routes list failed", e);
        await respond({ response_type: "ephemeral", text: "Couldn't read taught routes — try again." });
      }
      return;
    }

    if (sub === "forget" || sub === "unteach") {
      await ack();
      const trigger = text.replace(/^\S+\s*/, "").trim();
      if (!trigger) {
        await respond({
          response_type: "ephemeral",
          text: "Which route? `/switchboard forget <trigger>` — see `/switchboard routes`.",
        });
        return;
      }
      try {
        const rows = await deps.store.overrides.list(200);
        const matches = findByTrigger(rows, trigger);
        if (!matches.length) {
          await respond({
            response_type: "ephemeral",
            text: `No taught route matches *${mrkdwnEscape(trigger)}*. See \`/switchboard routes\`.`,
          });
          return;
        }
        for (const m of matches) if (m.id) await deps.store.overrides.delete(m.id);
        deps.shared.invalidate(); // drop the deleted route from the next route()
        await respond({
          response_type: "ephemeral",
          text: `🗑️ Forgot ${matches.length} route${matches.length === 1 ? "" : "s"} for *${mrkdwnEscape(trigger)}*.`,
        });
      } catch (e) {
        log.error("forget/override delete failed", e);
        await respond({ response_type: "ephemeral", text: "Couldn't remove that route — try again." });
      }
      return;
    }

    if (sub === "recent") {
      await ack();
      try {
        const rows = await deps.store.recent.recent(50);
        await respond({ response_type: "ephemeral", text: renderRecent(rows) });
      } catch (e) {
        log.error("recent list failed", e);
        await respond({ response_type: "ephemeral", text: "Couldn't read recent lookups — try again." });
      }
      return;
    }

    if (sub === "feedback" || sub === "votes") {
      await ack();
      try {
        const rows = await deps.store.feedback.recent(2000);
        await respond({ response_type: "ephemeral", text: renderFeedback(rows) });
      } catch (e) {
        log.error("feedback list failed", e);
        await respond({ response_type: "ephemeral", text: "Couldn't read feedback — try again." });
      }
      return;
    }

    // Ack immediately (flushes HTTP 200) with a placeholder we'll replace.
    await ack({ response_type: "ephemeral", text: ":electric_plug: Routing…" });

    if (!text) {
      await respond({ response_type: "ephemeral", replace_original: true, text: USAGE });
      return;
    }

    // Pipeline needs BigQuery + LLM creds; without them, degrade to an honest message.
    try {
      assertPipelineReady(deps.cfg);
    } catch (e) {
      await respond({
        response_type: "ephemeral",
        replace_original: true,
        text: `You said: “${text}”. Routing is not configured yet — ${(e as Error).message}`,
      });
      return;
    }

    try {
      const snap = await deps.shared.get();
      const result = await route(text, {
        bq: deps.bq,
        llm: deps.llm,
        voteMap: snap.voteMap,
        overrides: snap.overrides,
        userId: command.user_id,
      });

      const shareId = deps.shareCache.put(result);
      await respond({
        response_type: "ephemeral",
        replace_original: true,
        blocks: buildBlocks(result, shareId) as any,
        text: fallbackText(result),
      });

      // Fire-and-forget: record the search (best-effort, never blocks the reply).
      deps.store.recent
        .create({ query: text, by: command.user_id })
        .catch((e) => log.debug("recent search write failed", e));
    } catch (e) {
      log.error("routing failed", e);
      await respond({
        response_type: "ephemeral",
        replace_original: true,
        text: "Something went wrong while routing that. Try again in a moment.",
      });
    }
  });
}
