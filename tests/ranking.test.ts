import { describe, it, expect } from "vitest";
import {
  ownerMatch,
  ownerActionable,
  rankOwnership,
} from "../src/pipeline/ownership";
import { prescoreChannels } from "../src/pipeline/channels";
import { buildVoteMap, voteNet } from "../src/pipeline/feedback";
import { matchOverrides } from "../src/pipeline/overrides";
import type { ChannelCandidate, OwnerRow } from "../src/orchestrator/types";

describe("ownerMatch", () => {
  it("returns exact when a token IS the entity/repo name", () => {
    expect(ownerMatch({ kind: "service", entity: "checkout", repository: "shopify/checkout" }, ["checkout"])).toBe(
      "exact"
    );
  });
  it("returns word for a whole-word match inside the name", () => {
    expect(ownerMatch({ kind: "team", entity: "checkout-experience" }, ["experience"])).toBe("word");
  });
  it("ignores generic and short tokens", () => {
    expect(ownerMatch({ kind: "service", entity: "platform" }, ["platform"])).toBeNull();
    expect(ownerMatch({ kind: "service", entity: "abc" }, ["ab"])).toBeNull();
  });
});

describe("ownerActionable", () => {
  it("is true only with a channel or repo to click", () => {
    expect(ownerActionable({ kind: "team", gen: "help-x" })).toBe(true);
    expect(ownerActionable({ kind: "service", repository: "a/b" })).toBe(true);
    expect(ownerActionable({ kind: "team" })).toBe(false);
  });
});

describe("rankOwnership", () => {
  it("scores exact entity + service highest and drops zero-score rows", () => {
    const rows: OwnerRow[] = [
      { kind: "service", entity: "checkout", team_name: "Checkout" },
      { kind: "team", entity: "checkout-web", team_name: "Web" },
      { kind: "team", entity: "unrelated" }, // no token hit, no team_name → score 0, dropped
    ];
    const ranked = rankOwnership(rows, ["checkout"]);
    expect(ranked.map((r) => r.entity)).toEqual(["checkout", "checkout-web"]);
  });
});

describe("prescoreChannels", () => {
  it("ranks a specific #help channel above a busy off-topic feed", () => {
    const cands: ChannelCandidate[] = [
      { channel_id: "C1", channel_name: "help-checkout", purpose: "ask about checkout", msgs_90d: 300, members: 600 },
      { channel_id: "C2", channel_name: "random-firehose", purpose: "", msgs_90d: 9000, members: 3 },
      { channel_id: "C3", channel_name: "checkout-eng", purpose: "checkout team", msgs_90d: 120, members: 200 },
    ];
    const out = prescoreChannels(cands, ["checkout"], {});
    expect(out[0]!.channel_name).toBe("help-checkout");
    expect(out.map((c) => c.channel_name)).not.toContain("random-firehose");
  });
});

describe("buildVoteMap / voteNet", () => {
  it("aggregates case-insensitively", () => {
    const m = buildVoteMap([
      { channel: "help-a", vote: 1 },
      { channel: "HELP-A", vote: 1 },
      { channel: "help-b", vote: -1 },
    ]);
    expect(voteNet(m, "Help-A")).toBe(2);
    expect(voteNet(m, "help-b")).toBe(-1);
    expect(voteNet(m, "missing")).toBe(0);
  });
});

describe("matchOverrides", () => {
  it("matches an exact contiguous trigger phrase", () => {
    const ov = [{ trigger: "shop pay installments", channels: ["help-payments"] }];
    expect(matchOverrides(ov, "how do shop pay installments work").length).toBe(1);
    expect(matchOverrides(ov, "unrelated question")).toEqual([]);
  });

  it("stays precise: a missing trigger word means no match", () => {
    const ov = [{ trigger: "shop pay installments", channels: ["help-payments"] }];
    // "installments" is absent → must NOT fire on a plain shop-pay-payments query
    expect(matchOverrides(ov, "who do i ask about shop pay payments")).toEqual([]);
  });

  it("matches when all trigger words appear in any order (smarter)", () => {
    const ov = [{ trigger: "shop pay", channels: ["help-payments-account-capabilities"] }];
    expect(matchOverrides(ov, "who do i ask about shop pay payments").length).toBe(1);
  });

  it("normalizes dashes/underscores in trigger and query", () => {
    const ov = [{ trigger: "shop-pay", channels: ["help-x"] }];
    expect(matchOverrides(ov, "questions about shop pay").length).toBe(1);
  });

  it("ranks more specific matches first", () => {
    const ov = [
      { trigger: "pay", channels: ["broad"] },
      { trigger: "shop pay", channels: ["specific"] },
    ];
    const r = matchOverrides(ov, "shop pay stuff");
    expect(r[0]!.channels).toEqual(["specific"]);
  });
});
