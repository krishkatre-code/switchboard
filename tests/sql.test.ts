import { describe, it, expect } from "vitest";
import { ownSql, findChannelOwner } from "../src/pipeline/ownership";
import {
  findChannels,
  resolveNamedChannels,
  channelsExist,
  suggestChannels,
} from "../src/pipeline/channels";
import { findResponsiveness } from "../src/pipeline/responsiveness";
import { findCommitters } from "../src/pipeline/committers";

/**
 * Records every SQL string handed to querySync so we can snapshot the generated queries
 * without a live BigQuery. `throwOn` (1-based) makes a call reject, exercising the
 * smart→fallback path in findChannels.
 */
class RecordingBq {
  calls: string[] = [];
  constructor(private throwOn = 0) {}
  async querySync(sql: string): Promise<{ results: any[] }> {
    this.calls.push(sql);
    if (this.calls.length === this.throwOn) throw new Error("simulated BQ error");
    return { results: [] };
  }
}

const TOKENS = ["checkout", "payments"];

describe("SQL is byte-stable (verbatim-port guarantee)", () => {
  it("ownSql", () => {
    expect(ownSql(TOKENS)).toMatchSnapshot();
  });

  it("findChannels — smart query", async () => {
    const bq = new RecordingBq();
    await findChannels(bq as any, TOKENS);
    expect(bq.calls).toHaveLength(1);
    expect(bq.calls[0]).toMatchSnapshot();
  });

  it("findChannels — fallback query (smart rejected)", async () => {
    const bq = new RecordingBq(1); // reject the first (smart) call
    const { dwError } = await findChannels(bq as any, TOKENS);
    expect(bq.calls).toHaveLength(2);
    expect(dwError).toBeNull();
    expect(bq.calls[1]).toMatchSnapshot();
  });

  it("findChannelOwner", async () => {
    const bq = new RecordingBq();
    await findChannelOwner(bq as any, ["help-checkout", "checkout-eng"]);
    expect(bq.calls[0]).toMatchSnapshot();
  });

  it("resolveNamedChannels", async () => {
    const bq = new RecordingBq();
    await resolveNamedChannels(bq as any, ["#help-payments", "help-billing"]);
    expect(bq.calls[0]).toMatchSnapshot();
  });

  it("findResponsiveness", async () => {
    const bq = new RecordingBq();
    await findResponsiveness(bq as any, ["help-checkout", "help-payments"]);
    expect(bq.calls[0]).toMatchSnapshot();
  });

  it("findCommitters (org/name split)", async () => {
    const bq = new RecordingBq();
    await findCommitters(bq as any, "Shopify/Checkout-Web");
    expect(bq.calls[0]).toMatchSnapshot();
  });

  it("channelsExist", async () => {
    const bq = new RecordingBq();
    await channelsExist(bq as any, ["#help-payments", "help-checkout-wallets"]);
    expect(bq.calls[0]).toMatchSnapshot();
  });

  it("suggestChannels", async () => {
    const bq = new RecordingBq();
    await suggestChannels(bq as any, ["help-payments"]);
    expect(bq.calls[0]).toMatchSnapshot();
  });
});
