import OpenAI from "openai";
import type { Config } from "../config/env";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

/**
 * Replacement for the browser's `quick.ai` (an OpenAI client pointed at `/api/ai`,
 * model `gpt-5.4`). Points at Shopify's internal OpenAI-compatible gateway instead.
 * Same model + prompts; the pipeline callers keep their own fence-strip + JSON.parse
 * so the porting stays verbatim.
 *
 * `maxRetries: 0` + a per-call `timeout` stop a hung/slow gateway from stalling the
 * request for minutes — the pipeline's heuristic fallbacks take over on failure.
 */
export class LlmClient {
  private readonly client: OpenAI;
  readonly model: string;

  constructor(cfg: Config["llm"]) {
    this.client = new OpenAI({
      baseURL: cfg.baseUrl,
      apiKey: cfg.apiKey || "not-needed",
      timeout: cfg.timeoutMs,
      maxRetries: 0,
    });
    this.model = cfg.model;
  }

  /** Returns the assistant message content, or throws (callers catch and fall back). */
  async chat(messages: ChatMessage[]): Promise<string> {
    const r = await this.client.chat.completions.create({
      model: this.model,
      messages,
    });
    return r.choices[0]?.message?.content ?? "";
  }
}
