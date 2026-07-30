import type { LlmClient } from "../clients/llm";
import type { Intent } from "../orchestrator/types";
import { isEntityLike } from "./text";

/** Verbatim system prompt from reference/index.html L259. */
const SYSTEM_PROMPT =
  'You are the intent router for Switchboard, an internal Shopify tool. Classify the input as exactly one of: "entity" (the user named a specific repo, service, team, data table/dataset, or tool and wants to know who owns it) or "question" (a plain-language question about where to ask or get help). If entity, extract the core entity name only (strip words like \'who owns\', \'the\', \'team for\'). Reply ONLY with JSON: {"mode":"entity"|"question","entity":"<core entity or empty>","entity_type":"repo|service|team|data|tool|"}.';

/**
 * Unified intent router (port of classifyIntent, L255-268). One LLM call, then branch.
 * Falls back to the isEntityLike() heuristic if the model call fails or returns junk.
 */
export async function classifyIntent(llm: LlmClient, query: string): Promise<Intent> {
  const fb: Intent = {
    mode: isEntityLike(query) ? "entity" : "question",
    entity: query.trim(),
    entity_type: "",
  };
  try {
    const content = await llm.chat([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: query },
    ]);
    const txt = content.trim().replace(/^```(json)?/i, "").replace(/```$/, "");
    const p = JSON.parse(txt);
    if (p && (p.mode === "entity" || p.mode === "question")) {
      return {
        mode: p.mode,
        entity: String(p.entity || "").trim() || query.trim(),
        entity_type: String(p.entity_type || "").trim(),
      };
    }
  } catch {
    /* fall through to heuristic */
  }
  return fb;
}
