import type { LlmClient } from "../clients/llm";
import { toTerms, aliasTerms } from "./text";

/** Verbatim system prompt from reference/index.html L242. */
const SYSTEM_PROMPT =
  "You turn a Shopify employee's question into 4-12 short Slack-channel search keywords (single words or short hyphenated tokens, lowercase). Include: the core product/feature nouns; obvious synonyms and the DOMAIN/area; and morphological variants so directory search matches channel names (e.g. 'extension' -> also 'extensions','extensibility'; 'deploy' -> 'deployment'; 'migrate' -> 'migration'). IMPORTANT: if the query names a Shopify product, app, or feature, ALSO output its functional domain and the terms an owning team or #help channel would actually use (e.g. 'Translate & Adapt' -> 'localization','i18n','markets','translation'; 'Shopify Payments' -> 'payments','money'; 'Sidekick' -> 'ai','sidekick'). Prefer specific terms over generic ones; never output 'help' or 'support'. Reply ONLY with a JSON array of strings.";

/**
 * Expand a query into channel-search keywords (port of expandTerms, L239-250).
 * Merges the LLM's keywords with the naive toTerms() + aliasTerms(); on any failure
 * degrades to the deterministic toTerms + aliasTerms union.
 */
export async function expandTerms(llm: LlmClient, query: string): Promise<string[]> {
  try {
    const content = await llm.chat([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: query },
    ]);
    const txt = content.trim().replace(/^```(json)?/i, "").replace(/```$/, "");
    const arr = JSON.parse(txt);
    const clean = (arr as unknown[])
      .map((t) => String(t).toLowerCase().replace(/[^a-z0-9-]/g, ""))
      .filter((t) => t.length >= 2);
    const merged = [...new Set([...clean, ...toTerms(query), ...aliasTerms(query)])].slice(0, 16);
    return merged.length ? merged : [...new Set([...toTerms(query), ...aliasTerms(query)])];
  } catch {
    return [...new Set([...toTerms(query), ...aliasTerms(query)])];
  }
}
