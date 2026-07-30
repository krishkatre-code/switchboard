import { describe, it, expect } from "vitest";
import {
  toTerms,
  entityTokens,
  isEntityLike,
  tokenHit,
  fmtReply,
  fmtNum,
  actDot,
  mrkdwnEscape,
  repoLink,
  vaultTeamLink,
  slackLink,
  aliasTerms,
} from "../src/pipeline/text";

describe("toTerms", () => {
  it("drops stopwords/short tokens, dedupes, caps at 8", () => {
    const t = toTerms("How do I request a prod data export?");
    expect(t).toContain("request");
    expect(t).toContain("export");
    expect(t).toContain("data");
    expect(t).not.toContain("how");
    expect(t).not.toContain("do");
    expect(t.length).toBeLessThanOrEqual(8);
  });
});

describe("entityTokens", () => {
  it("keeps slash/dot/underscore/dash so repo & service names survive", () => {
    expect(entityTokens("shopify/checkout-web")).toEqual(["shopify/checkout-web"]);
    expect(entityTokens("storefront_renderer")).toEqual(["storefront_renderer"]);
  });
});

describe("isEntityLike", () => {
  it("treats short identifier-ish input as an entity", () => {
    expect(isEntityLike("checkout-experience")).toBe(true);
    expect(isEntityLike("shopify/checkout")).toBe(true);
    expect(isEntityLike("storefront renderer")).toBe(true);
  });
  it("treats a plain question as NOT an entity", () => {
    expect(isEntityLike("how do I request a prod data export")).toBe(false);
    expect(isEntityLike("who owns checkout")).toBe(false);
  });
});

describe("tokenHit", () => {
  it("matches substrings and 5/6-char prefixes", () => {
    expect(tokenHit("checkout-web", "checkout")).toBe(true);
    expect(tokenHit("deploys", "deploy")).toBe(true);
    expect(tokenHit("xyzland", "checkout")).toBe(false); // prefix 'checko' not present
    expect(tokenHit("anything", "ab")).toBe(false); // <3 chars never hits
  });
});

describe("formatters", () => {
  it("fmtReply buckets seconds → human", () => {
    expect(fmtReply(30)).toBe("under a min");
    expect(fmtReply(120)).toBe("~2 min");
    expect(fmtReply(3600)).toBe("~1.0h");
  });
  it("fmtNum compacts thousands", () => {
    expect(fmtNum(500)).toBe("500");
    expect(fmtNum(1500)).toBe("1.5k");
    expect(fmtNum(15000)).toBe("15k");
  });
  it("actDot reflects activity tier", () => {
    expect(actDot(150)).toBe("🟢");
    expect(actDot(50)).toBe("🟡");
    expect(actDot(5)).toBe("⚪");
  });
});

describe("links & escaping", () => {
  it("mrkdwnEscape neutralizes Slack control chars", () => {
    expect(mrkdwnEscape("<a>&b")).toBe("&lt;a&gt;&amp;b");
    expect(mrkdwnEscape(null)).toBe("");
  });
  it("repoLink only builds for org/name", () => {
    expect(repoLink("shopify/checkout")).toBe("https://github.com/shopify/checkout");
    expect(repoLink("checkout")).toBeNull();
  });
  it("vaultTeamLink & slackLink", () => {
    expect(vaultTeamLink("abc")).toBe("https://vault.shopify.io/teams/abc");
    expect(vaultTeamLink(null)).toBeNull();
    expect(slackLink("C123")).toBe("https://shopify.slack.com/archives/C123");
  });
});

describe("aliasTerms", () => {
  it("expands known product phrases into domain terms", () => {
    expect(aliasTerms("questions about shop pay installments")).toContain("bnpl");
    expect(aliasTerms("nothing here")).toEqual([]);
  });
});
