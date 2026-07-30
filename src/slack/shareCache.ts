import { randomUUID } from "node:crypto";
import type { RouteResult } from "../orchestrator/types";

/**
 * Slack action `value` is capped (~2000 chars), so we can't stuff a whole RouteResult into
 * the "Share to channel" button. Instead we stash the result in a small in-memory LRU keyed
 * by a short id and put the id in the button value. Ephemeral by design — a restart just
 * means a stale Share button falls back gracefully (handler treats a miss as expired).
 */
export class ShareCache {
  private readonly map = new Map<string, RouteResult>();
  constructor(private readonly max = 500) {}

  put(result: RouteResult): string {
    const id = randomUUID().slice(0, 8);
    this.map.set(id, result);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    return id;
  }

  get(id: string): RouteResult | undefined {
    return this.map.get(id);
  }
}
