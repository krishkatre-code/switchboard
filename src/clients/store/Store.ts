import type { Override, Vote, RecentSearch } from "../../orchestrator/types";

/**
 * Abstraction over the three `quick.db` collections the web app used:
 *   - overrides        (crowd-editable routing pins; supports delete)
 *   - feedback         (append-only 👍/👎 votes)
 *   - recent_searches  (append-only recent lookups)
 *
 * The web app and this service are meant to share this knowledge eventually. The
 * default `FileStore` is a local bridge; `QuickApiStore` will talk to the Quick
 * site's REST API once service auth to its IAP-protected endpoints is resolved.
 */
export interface Store {
  overrides: {
    list(limit: number): Promise<Override[]>;
    create(o: Override): Promise<void>;
    delete(id: string): Promise<void>;
  };
  feedback: {
    recent(limit: number): Promise<Vote[]>;
    create(v: Vote): Promise<void>;
  };
  recent: {
    recent(limit: number): Promise<RecentSearch[]>;
    create(r: RecentSearch): Promise<void>;
  };
}
