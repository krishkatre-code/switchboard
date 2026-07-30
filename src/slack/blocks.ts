import type {
  ChannelCard,
  OwnerRow,
  RespMap,
  Committer,
  RouteResult,
} from "../orchestrator/types";
import {
  slackLink,
  vaultTeamLink,
  repoLink,
  fmtReply,
  fmtNum,
  actDot,
  mrkdwnEscape,
} from "../pipeline/text";

/** Block Kit blocks are schema-shaped plain objects; keep the type permissive. */
type Block = Record<string, any>;

// action_ids shared with slack/actions.ts
export const ACTION_FB_UP = "fb_up";
export const ACTION_FB_DOWN = "fb_down";
export const ACTION_SHARE = "share_to_channel";

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** `<url|label>` mrkdwn link with an escaped label. */
function link(url: string, label: string): string {
  return `<${url}|${mrkdwnEscape(label)}>`;
}

/** A channel as a mrkdwn link (or plain #name when we have no id). */
function chanRef(name: string, id?: string | null, withDot?: number): string {
  const dot = withDot != null ? actDot(withDot) + " " : "";
  if (!id) return `${dot}#${mrkdwnEscape(name)}`;
  return `${dot}${link(slackLink(id), "#" + name)}`;
}

function section(text: string): Block {
  return { type: "section", text: { type: "mrkdwn", text: truncate(text, 3000) } };
}
function context(text: string): Block {
  return { type: "context", elements: [{ type: "mrkdwn", text: truncate(text, 3000) }] };
}
function header(text: string): Block {
  return { type: "header", text: { type: "plain_text", text: truncate(text, 150), emoji: true } };
}
const divider: Block = { type: "divider" };

/** 👍 / 👎 buttons for one channel; carry the query in the value (no server-side lastQuery). */
function feedbackButtons(channel: string, query: string): Block {
  const value = JSON.stringify({ c: channel, q: truncate(query, 1500) });
  return {
    type: "actions",
    elements: [
      {
        type: "button",
        action_id: ACTION_FB_UP,
        text: { type: "plain_text", text: "👍 Helpful", emoji: true },
        value,
      },
      {
        type: "button",
        action_id: ACTION_FB_DOWN,
        text: { type: "plain_text", text: "👎 Not helpful", emoji: true },
        value,
      },
    ],
  };
}

function shareButton(shareId: string): Block {
  return {
    type: "button",
    action_id: ACTION_SHARE,
    style: "primary",
    text: { type: "plain_text", text: "📣 Share to channel", emoji: true },
    value: shareId,
  };
}

// ── hero: owner AND where to ask, in one card (port of heroCard, L551-568) ───
function heroBlocks(
  owner: OwnerRow,
  respMap: RespMap,
  committers: Committer[],
  shareId: string,
  query: string
): Block[] {
  const blocks: Block[] = [];
  const title = owner.team_name || owner.entity || "Owner";
  blocks.push(header(title));

  // Details section: linked team name (header can't link), service tag, hierarchy, repo, group.
  const vlink = vaultTeamLink(owner.vault_id);
  const rlink = repoLink(owner.repository);
  const lines: string[] = [];
  lines.push(vlink ? `*${link(vlink, title)}*` : `*${mrkdwnEscape(title)}*`);
  if (owner.kind === "service" && owner.entity) lines.push(`service: \`${mrkdwnEscape(owner.entity)}\``);
  if (owner.name_with_hierarchy) lines.push(mrkdwnEscape(owner.name_with_hierarchy));
  if (owner.repository)
    lines.push(`Repo: ${rlink ? link(rlink, owner.repository) : `*${mrkdwnEscape(owner.repository)}*`}`);
  if (owner.group_name) lines.push(`Group: *${mrkdwnEscape(owner.group_name)}*`);
  blocks.push(section(lines.join("\n")));

  // Ask here: the owner's general/support channels.
  const ownChans: Array<{ name: string; id?: string | null }> = [];
  if (owner.gen) ownChans.push({ name: owner.gen, id: owner.gen_id });
  if (owner.sup && owner.sup !== owner.gen) ownChans.push({ name: owner.sup, id: owner.sup_id });
  if (ownChans.length) {
    blocks.push(section(`*Ask here*\n${ownChans.map((c) => chanRef(c.name, c.id)).join("   ")}`));
  }

  // Responsiveness for the general channel.
  const genKey = (owner.gen || "").toLowerCase();
  if (owner.gen && respMap[genKey] != null) {
    blocks.push(context(`⚡ #${mrkdwnEscape(owner.gen)} usually first reply ${fmtReply(respMap[genKey]!)}`));
  }

  // Top committers.
  if (committers.length) {
    const chips = committers
      .map((c) => link(`https://github.com/${c.username}`, "@" + c.username))
      .join("  ·  ");
    blocks.push(context(`Top committers (last 180d): ${chips}`));
  }

  // Actions: feedback on the general channel + share.
  const actionEls: Block[] = [];
  if (owner.gen) {
    const fb = feedbackButtons(owner.gen, query);
    actionEls.push(...fb.elements);
  }
  actionEls.push(shareButton(shareId));
  blocks.push({ type: "actions", elements: actionEls.slice(0, 5) });

  return blocks;
}

// ── channel card (port of chanCard, L598-614) ────────────────────────────────
function channelBlocks(p: ChannelCard, respMap: RespMap, query: string): Block[] {
  const blocks: Block[] = [];
  const head = `*${chanRef(p.name, p.id)}*`;
  const reason = p.reason ? `\n${mrkdwnEscape(p.reason)}` : "";
  blocks.push(section(head + reason));
  if (p.purpose) blocks.push(context(mrkdwnEscape(p.purpose)));
  const hasAct = (Number(p.msgs) || 0) || (Number(p.members) || 0);
  if (hasAct) {
    blocks.push(
      context(`${actDot(p.msgs)} ~${fmtNum(p.msgs)} msgs / 90d · ${fmtNum(p.members)} members`)
    );
  }
  const rs = respMap[(p.name || "").toLowerCase()];
  if (rs != null) blocks.push(context(`⚡ usually first reply ${fmtReply(rs)}`));
  blocks.push(feedbackButtons(p.name, query));
  return blocks;
}

// ── other-owner card (port of ownCard, L585-597) ─────────────────────────────
function ownerBlocks(r: OwnerRow): Block[] {
  const vlink = vaultTeamLink(r.vault_id);
  const rlink = repoLink(r.repository);
  const title = r.team_name || r.entity || "Owner";
  const lines: string[] = [];
  lines.push(vlink ? `*${link(vlink, title)}*` : `*${mrkdwnEscape(title)}*`);
  if (r.name_with_hierarchy) lines.push(mrkdwnEscape(r.name_with_hierarchy));
  if (r.kind === "service" && r.entity) lines.push(`Matched service: *${mrkdwnEscape(r.entity)}*`);
  if (r.repository)
    lines.push(`Repo: ${rlink ? link(rlink, r.repository) : `*${mrkdwnEscape(r.repository)}*`}`);
  if (r.group_name) lines.push(`Group: *${mrkdwnEscape(r.group_name)}*`);
  const chans: string[] = [];
  if (r.gen) chans.push(chanRef(r.gen, r.gen_id));
  if (r.sup && r.sup !== r.gen) chans.push(chanRef(r.sup, r.sup_id));
  if (chans.length) lines.push(chans.join("   "));
  return [section(lines.join("\n"))];
}

function emptyStateBlocks(mode: string): Block[] {
  const text =
    mode === "entity"
      ? "Couldn't find an owning team for that. Try the exact repo (`org/name`), service, or team name — or rephrase it as a question and I'll route you to the right channel."
      : 'No clear channel matched. Try naming the product area or tool (e.g. "checkout", "storefront-renderer", "data warehouse"), or paste a repo/service name to find its owner.';
  return [section(text)];
}

/**
 * Assemble the full response (port of renderResults, L617-634). `shareId` keys the cached
 * RouteResult for the "Share to channel" button. Set `forShare` when rendering the public
 * copy (drops interactive feedback/share buttons).
 */
export function buildBlocks(result: RouteResult, shareId: string, forShare = false): Block[] {
  const { ownership, channels, respMap, committers, mode, query } = result;

  let blocks: Block[] = [];

  if (ownership && ownership.length) {
    const owner = ownership[0]!;
    blocks.push(...heroBlocks(owner, respMap, committers, shareId, query));

    // 2-3 other suggestions, excluding the owner's own channel(s).
    const ownNames = new Set([owner.gen, owner.sup].filter(Boolean).map((x) => String(x).toLowerCase()));
    const others = (channels || []).filter((c) => !ownNames.has((c.name || "").toLowerCase())).slice(0, 3);
    if (others.length) {
      blocks.push(divider, section("*Other places to ask*"));
      for (const c of others) blocks.push(...channelBlocks(c, respMap, query));
    }
    const more = ownership.slice(1, 3);
    if (more.length) {
      blocks.push(divider, section("*Other possible owners*"));
      for (const o of more) blocks.push(...ownerBlocks(o));
    }
  } else if (channels && channels.length) {
    blocks.push(section("*Ask here*"));
    for (const c of channels) blocks.push(...channelBlocks(c, respMap, query));
    // No owner → attach the Share button to a trailing actions block.
    if (!forShare) blocks.push({ type: "actions", elements: [shareButton(shareId)] });
  } else {
    blocks = emptyStateBlocks(mode);
  }

  // A small footer showing what was asked.
  blocks.push(context(`🔌 Switchboard · _${mrkdwnEscape(truncate(query, 200))}_`));

  if (forShare) {
    // Public copy: strip interactive elements (feedback/share) — leave the content.
    blocks = blocks.filter((b) => b.type !== "actions");
  }
  return blocks;
}

/** Plain-text notification fallback (the `text` field alongside blocks). */
export function fallbackText(result: RouteResult): string {
  if (result.ownership.length) {
    const o = result.ownership[0]!;
    return `Switchboard: ${o.team_name || o.entity || "owner"}${o.gen ? ` · ask in #${o.gen}` : ""}`;
  }
  if (result.channels.length) {
    return `Switchboard: ask in ${result.channels.slice(0, 3).map((c) => "#" + c.name).join(", ")}`;
  }
  return "Switchboard: no clear match — try rephrasing.";
}
