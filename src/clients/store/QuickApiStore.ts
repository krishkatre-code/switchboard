import type { Store } from "./Store";
import type { Override, Vote, RecentSearch } from "../../orchestrator/types";

/**
 * STUB — future backend that reads/writes the Quick site's shared collections via its
 * REST API (e.g. `${baseUrl}/overrides`, `${baseUrl}/feedback`) so the Slack command and
 * the web app share learned routes and votes.
 *
 * Blocked on service auth: those endpoints sit behind Google IAP, and a non-interactive
 * service identity (OIDC token audience = the IAP client) has to be granted access first.
 * Until then, use STORE_BACKEND=file. Every method throws with an actionable message so a
 * misconfiguration surfaces immediately rather than silently losing data.
 */
export class QuickApiStore implements Store {
  constructor(private readonly baseUrl: string) {}

  private nope(op: string): never {
    throw new Error(
      `QuickApiStore.${op} is not implemented yet (${this.baseUrl}). ` +
        `The Quick REST API is IAP-protected; resolve service auth or set STORE_BACKEND=file.`
    );
  }

  overrides = {
    list: (_limit: number): Promise<Override[]> => this.nope("overrides.list"),
    create: (_o: Override): Promise<void> => this.nope("overrides.create"),
    delete: (_id: string): Promise<void> => this.nope("overrides.delete"),
  };

  feedback = {
    recent: (_limit: number): Promise<Vote[]> => this.nope("feedback.recent"),
    create: (_v: Vote): Promise<void> => this.nope("feedback.create"),
  };

  recent = {
    recent: (_limit: number): Promise<RecentSearch[]> => this.nope("recent.recent"),
    create: (_r: RecentSearch): Promise<void> => this.nope("recent.create"),
  };
}
