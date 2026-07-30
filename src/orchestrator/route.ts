import type { BigQueryClient } from "../clients/bigquery";
import type { LlmClient } from "../clients/llm";
import type {
  ChannelCard,
  OwnerRow,
  Override,
  RouteResult,
  VoteMap,
} from "./types";
import { classifyIntent } from "../pipeline/intent";
import { expandTerms } from "../pipeline/expand";
import { entityTokens, toTerms, GENERIC } from "../pipeline/text";
import {
  findOwnership,
  rankOwnership,
  ownerActionable,
  ownerMatch,
  findChannelOwner,
} from "../pipeline/ownership";
import { findChannels, rankChannels, resolveNamedChannels } from "../pipeline/channels";
import { findResponsiveness } from "../pipeline/responsiveness";
import { findCommitters } from "../pipeline/committers";
import { matchOverrides } from "../pipeline/overrides";

export interface RouteContext {
  bq: BigQueryClient;
  llm: LlmClient;
  /** Shared snapshot passed in (was a module global in the browser). */
  voteMap: VoteMap;
  overrides: Override[];
  userId?: string;
  /**
   * Optional debug hook — called at each pipeline decision point with the
   * intermediate value. A no-op in production (the server never sets it); the
   * local `route` CLI passes one to print *why* a query routed the way it did.
   */
  trace?: (label: string, data: unknown) => void;
}

/**
 * The routing pipeline — a faithful port of runQuery (L725-806). Instead of mutating the
 * DOM + module globals, it returns a RouteResult that the Block Kit renderer consumes.
 * Every per-request value (respMap, committers, dwError) is local, so concurrent commands
 * never corrupt each other.
 */
export async function route(query: string, ctx: RouteContext): Promise<RouteResult> {
  const { bq, llm, voteMap, overrides } = ctx;
  const tr = ctx.trace ?? (() => {});
  query = (query || "").trim();

  // One AI classification call decides the path (the unified router).
  const intent = await classifyIntent(llm, query);
  const entityMode = intent.mode === "entity";
  const etoks = entityTokens(intent.entity && intent.entity.length ? intent.entity : query);
  tr("intent", intent);
  tr("entityTokens", etoks);

  let ownership: OwnerRow[] = [];
  let channels: ChannelCard[] = [];

  // Fetch ownership and expand channel keywords in parallel.
  const [ownRaw, terms] = await Promise.all([
    findOwnership(bq, etoks).catch(() => [] as OwnerRow[]),
    expandTerms(llm, query).catch(() => toTerms(query)),
  ]);
  tr("expandedTerms", terms);
  tr("ownership.raw", ownRaw);

  // An owner card must be ACTIONABLE and a real match. Entity queries accept a whole-word
  // match; plain questions require an exact entity/repo-name match, else the channels carry
  // the answer.
  ownership = rankOwnership(ownRaw, etoks)
    .filter(ownerActionable)
    .map((r) => ({ r, m: ownerMatch(r, etoks) }))
    .filter((x) => x.m && (entityMode || x.m === "exact"))
    .map((x) => x.r);
  tr("ownership.actionable", ownership);

  const { rows: cands, dwError } = await findChannels(bq, terms).catch(() => ({
    rows: [],
    dwError: null as string | null,
  }));
  tr("channels.candidates", {
    count: cands.length,
    names: cands.map((c) => c.channel_name),
    dwError,
  });
  if (cands.length) {
    channels = await rankChannels(llm, query, terms, cands, voteMap);
  }
  tr("channels.ranked", channels);

  // Editable routing overrides: a curated route pins the right channels to the very top.
  let overrode = false;
  const ovHits = matchOverrides(overrides, query);
  if (ovHits.length) {
    const names = [...new Set(ovHits.flatMap((o) => o.channels || []))];
    const rows = await resolveNamedChannels(bq, names);
    const pinned: ChannelCard[] = rows.map((r) => ({
      id: r.channel_id,
      name: r.channel_name,
      reason: "Curated route (pinned by the team)",
      purpose: r.purpose || "",
      msgs: Number(r.msgs_90d) || 0,
      members: Number(r.members) || 0,
    }));
    if (pinned.length) {
      const have = new Set(pinned.map((p) => (p.name || "").toLowerCase()));
      channels = [...pinned, ...channels.filter((c) => !have.has((c.name || "").toLowerCase()))];
      overrode = true;
    }
  }
  tr("overrides", { hits: ovHits.length, triggers: ovHits.map((o) => o.trigger), pinned: overrode });

  // No confident entity-owner? Derive the owner FROM the top channel — but ONLY when the
  // query has a SPECIFIC (non-generic) term (or an override pinned a channel).
  const qSpecific = toTerms(query).some((t) => !GENERIC.has(t) && t.length >= 4);
  if (!ownership.length && channels.length && (qSpecific || overrode)) {
    const owners = await findChannelOwner(bq, channels.slice(0, 6).map((c) => c.name));
    if (owners.length) {
      for (const c of channels) {
        const cn = (c.name || "").toLowerCase();
        const t = owners.find((o) => o.sup === cn || o.gen === cn);
        if (t) {
          ownership = [
            {
              kind: "team",
              team_name: t.team_name,
              name_with_hierarchy: t.name_with_hierarchy,
              group_name: t.group_name,
              vault_id: t.vault_id,
              repository: null,
              gen: c.name,
              gen_id: c.id,
              sup: null,
              sup_id: null,
            },
          ];
          break;
        }
      }
    }
  }

  tr("ownership.final", ownership);

  // Responsiveness for the channels we're about to show (cheap: tight IN-list).
  const respNames: Array<string | null | undefined> = [];
  if (ownership.length) respNames.push(ownership[0]!.gen);
  for (const c of channels) respNames.push(c.name);
  const respMap = await findResponsiveness(bq, respNames);

  // Real code owners: top committers to the resolved repo (or a repo-like entity).
  let repoHint: string | null = null;
  if (ownership.length && ownership[0]!.repository) repoHint = ownership[0]!.repository!;
  else if (entityMode) {
    const e = (intent.entity || "").trim().toLowerCase();
    if (!e.includes(" ") && /^[a-z0-9][a-z0-9._\/-]{2,}$/.test(e)) repoHint = e;
  }
  const committers = repoHint ? await findCommitters(bq, repoHint) : [];
  tr("committers", { repoHint, committers });

  return {
    query,
    mode: intent.mode,
    ownership,
    channels,
    respMap,
    committers,
    overrode,
    dwError,
  };
}
