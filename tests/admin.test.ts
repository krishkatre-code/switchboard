import { describe, it, expect } from "vitest";
import { summarizeFeedback } from "../src/pipeline/feedback";
import { normTrigger, findByTrigger, dedupeQueries, renderRoutes } from "../src/slack/admin";
import type { Override, Vote, RecentSearch } from "../src/orchestrator/types";

describe("summarizeFeedback", () => {
  it("nets votes per query×channel and per channel, most-negative first", () => {
    const votes: Vote[] = [
      { channel: "help-checkout-wallets", vote: -1, query: "shop pay payments" },
      { channel: "help-checkout-wallets", vote: -1, query: "shop pay payments" },
      { channel: "HELP-CHECKOUT-WALLETS", vote: +1, query: "shop pay payments" },
      { channel: "help-data-warehouse", vote: +1, query: "prod data export" },
    ];
    const rep = summarizeFeedback(votes);
    expect(rep.total).toBe(4);
    // worst pair first: net -1, two downvotes, case-folded channel
    expect(rep.pairs[0]).toMatchObject({
      channel: "help-checkout-wallets",
      query: "shop pay payments",
      net: -1,
      up: 1,
      down: 2,
    });
    // channels ranked by net asc
    expect(rep.channels[0]).toEqual({ channel: "help-checkout-wallets", net: -1 });
    expect(rep.channels[1]).toEqual({ channel: "help-data-warehouse", net: 1 });
  });

  it("ignores rows with no channel", () => {
    const rep = summarizeFeedback([{ channel: "", vote: -1 }, { channel: "x", vote: -1 }]);
    expect(rep.channels).toEqual([{ channel: "x", net: -1 }]);
  });
});

describe("normTrigger / findByTrigger", () => {
  it("matches case-insensitively and collapses whitespace", () => {
    expect(normTrigger("  Shop   Pay ")).toBe("shop pay");
    const ov: Override[] = [
      { id: "1", trigger: "shop pay", channels: ["a"] },
      { id: "2", trigger: "checkout", channels: ["b"] },
    ];
    expect(findByTrigger(ov, "SHOP  PAY").map((o) => o.id)).toEqual(["1"]);
    expect(findByTrigger(ov, "nope")).toEqual([]);
    expect(findByTrigger(ov, "")).toEqual([]);
  });
});

describe("dedupeQueries", () => {
  it("keeps newest-first order, drops case-insensitive dupes, and caps", () => {
    const rows: RecentSearch[] = [
      { query: "Checkout" },
      { query: "checkout" },
      { query: "storefront" },
      { query: "  " },
      { query: "data warehouse" },
    ];
    expect(dedupeQueries(rows, 12)).toEqual(["Checkout", "storefront", "data warehouse"]);
    expect(dedupeQueries(rows, 2)).toEqual(["Checkout", "storefront"]);
  });
});

describe("renderRoutes", () => {
  it("shows an empty-state hint with no routes", () => {
    expect(renderRoutes([])).toContain("No routes taught yet");
  });
  it("lists triggers → channels with a remove hint", () => {
    const out = renderRoutes([{ id: "1", trigger: "shop pay", channels: ["help-payments-account-capabilities"] }]);
    expect(out).toContain("*shop pay*");
    expect(out).toContain("#help-payments-account-capabilities");
    expect(out).toContain("/switchboard forget");
  });
});
