import type { Store } from "../clients/store";
import type { Override, VoteMap } from "../orchestrator/types";
import { buildVoteMap } from "../pipeline/feedback";
import { log } from "../util/logger";

export interface SharedSnapshot {
  overrides: Override[];
  voteMap: VoteMap;
}

/**
 * Cross-request, read-mostly data (routing overrides + aggregated votes) that the browser
 * kept in module globals. Here it's a TTL cache over the Store, and `route()` receives an
 * immutable snapshot per request. Writes (a new vote/override) call `invalidate()` so the
 * next request refetches. Matches the web app's read limits (overrides 200, votes 2000).
 */
export class SharedDataCache {
  private snapshot: SharedSnapshot | null = null;
  private loadedAt = 0;
  private inflight: Promise<SharedSnapshot> | null = null;

  constructor(
    private readonly store: Store,
    private readonly ttlMs: number
  ) {}

  async get(): Promise<SharedSnapshot> {
    const fresh = this.snapshot && Date.now() - this.loadedAt < this.ttlMs;
    if (fresh) return this.snapshot!;
    if (this.inflight) return this.inflight;
    this.inflight = this.refresh();
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  invalidate(): void {
    this.loadedAt = 0;
    this.snapshot = null;
  }

  private async refresh(): Promise<SharedSnapshot> {
    try {
      const [overrides, votes] = await Promise.all([
        this.store.overrides.list(200),
        this.store.feedback.recent(2000),
      ]);
      this.snapshot = { overrides, voteMap: buildVoteMap(votes) };
      this.loadedAt = Date.now();
    } catch (e) {
      log.warn("SharedDataCache refresh failed; using empty snapshot", e);
      this.snapshot = { overrides: [], voteMap: {} };
      this.loadedAt = Date.now();
    }
    return this.snapshot;
  }
}
