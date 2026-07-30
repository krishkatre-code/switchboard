/**
 * Shared types for the routing pipeline. The browser app carried much of this as
 * loosely-typed objects + module globals; here we make the shapes explicit and pass
 * everything per-request so concurrent invocations never share mutable state.
 */

/** One row from the ownership query (`ownSql`) / a derived channel-owner. */
export interface OwnerRow {
  kind: "service" | "team";
  entity?: string;
  repository?: string | null;
  team_name?: string | null;
  name_with_hierarchy?: string | null;
  vault_id?: string | null;
  group_name?: string | null;
  gen?: string | null; // general_slack_channel_name
  sup?: string | null; // support_slack_channel_name
  gen_id?: string | null;
  sup_id?: string | null;
}

/** A ranked channel suggestion (the `toCard` shape from `rankChannels`). */
export interface ChannelCard {
  id: string;
  name: string;
  reason: string;
  purpose: string;
  msgs: number;
  members: number;
}

/** A raw channel candidate from `findChannels` (before ranking). */
export interface ChannelCandidate {
  channel_id: string;
  channel_name: string;
  purpose?: string | null;
  topic?: string | null;
  members?: number;
  msgs_90d?: number;
  /** set by prescoreChannels: an on-topic active #help channel we always keep. */
  _strongHelp?: boolean;
}

export interface Committer {
  username: string;
  commits: number;
}

/** channel_name (lowercased) → median first-reply seconds. */
export type RespMap = Record<string, number>;

/** channel_name (lowercased) → net vote total. */
export type VoteMap = Record<string, number>;

export interface Override {
  id?: string;
  trigger: string;
  channels: string[];
  by?: string;
  created_at?: string;
}

export interface Vote {
  id?: string;
  channel: string;
  vote: number;
  query?: string;
  by?: string;
  created_at?: string;
}

export interface RecentSearch {
  id?: string;
  query: string;
  by?: string;
  created_at?: string;
}

export type IntentMode = "entity" | "question";

export interface Intent {
  mode: IntentMode;
  entity: string;
  entity_type: string;
}

/** The structured result of one routing run — the single object the renderer reads. */
export interface RouteResult {
  query: string;
  mode: IntentMode;
  ownership: OwnerRow[];
  channels: ChannelCard[];
  respMap: RespMap;
  committers: Committer[];
  overrode: boolean;
  dwError: string | null;
}
