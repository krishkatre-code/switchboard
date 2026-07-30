import type { App } from "@slack/bolt";
import type { Deps } from "../deps";
import { ACTION_FB_UP, ACTION_FB_DOWN, ACTION_SHARE, buildBlocks, fallbackText } from "./blocks";
import { log } from "../util/logger";

interface FbValue {
  c: string;
  q: string;
}

function parseFb(raw: unknown): FbValue | null {
  try {
    const v = JSON.parse(String(raw || "{}"));
    if (v && typeof v.c === "string" && v.c) return { c: v.c, q: typeof v.q === "string" ? v.q : "" };
  } catch {
    /* fallthrough */
  }
  return null;
}

/** Register 👍/👎 feedback and the "Share to channel" button handlers. */
export function registerActions(app: App, deps: Deps): void {
  const vote = async (
    raw: unknown,
    delta: number,
    userId: string | undefined,
    respond: (msg: any) => Promise<unknown>
  ) => {
    const fb = parseFb(raw);
    if (!fb) return;
    try {
      await deps.store.feedback.create({
        channel: fb.c.toLowerCase(),
        vote: delta,
        query: fb.q,
        by: userId,
      });
      deps.shared.invalidate(); // next route() picks up the new vote after TTL/refresh
    } catch (e) {
      log.error("feedback write failed", e);
    }
    // A new ephemeral note (replace_original:false) so the results card stays intact.
    await respond({
      response_type: "ephemeral",
      replace_original: false,
      text: delta > 0 ? `👍 Thanks — noted for #${fb.c}.` : `👎 Thanks — noted for #${fb.c}.`,
    });
  };

  app.action(ACTION_FB_UP, async ({ ack, action, body, respond }) => {
    await ack();
    await vote((action as any).value, +1, (body as any).user?.id, respond);
  });

  app.action(ACTION_FB_DOWN, async ({ ack, action, body, respond }) => {
    await ack();
    await vote((action as any).value, -1, (body as any).user?.id, respond);
  });

  app.action(ACTION_SHARE, async ({ ack, action, respond }) => {
    await ack();
    const id = String((action as any).value || "");
    const result = deps.shareCache.get(id);
    if (!result) {
      await respond({
        response_type: "ephemeral",
        replace_original: false,
        text: "That share link expired — re-run `/switchboard` and share again.",
      });
      return;
    }
    // Promote the ephemeral card to a channel-visible message (no extra scope needed).
    await respond({
      response_type: "in_channel",
      replace_original: true,
      blocks: buildBlocks(result, id, true) as any,
      text: fallbackText(result),
    });
  });
}
