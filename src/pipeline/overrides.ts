import type { Override } from "../orchestrator/types";
import { toTerms, tokenHit } from "./text";

/** Normalize for matching: lowercase, dashes/underscores/slashes → spaces, collapse whitespace. */
function norm(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[-_/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Curated routing overrides that match a query (smarter successor to the web app's
 * matchOverrides L656-659). A trigger matches when EITHER:
 *   1. its normalized phrase appears contiguously in the query (the original behavior), or
 *   2. ALL of its significant words appear anywhere in the query, in any order, with the
 *      same prefix tolerance the channel search uses (tokenHit).
 * Results are returned most-specific-first (contiguous phrase > more trigger words), so the
 * best-targeted route pins its channels ahead of broader ones.
 *
 * Example: trigger "shop pay" now matches "who do i ask about shop pay payments", while
 * "shop pay installments" still does NOT (— "installments" is absent), so it stays precise.
 */
export function matchOverrides(overrides: Override[], query: string): Override[] {
  const qn = norm(query || "");
  if (!qn) return [];
  const scored: Array<{ o: Override; score: number }> = [];
  for (const o of overrides) {
    if (!o || !o.trigger) continue;
    const tn = norm(String(o.trigger));
    if (!tn) continue;
    if (qn.includes(tn)) {
      // Contiguous phrase — strongest signal; longer phrases rank above shorter ones.
      scored.push({ o, score: 1000 + tn.length });
      continue;
    }
    const toks = toTerms(tn);
    if (toks.length && toks.every((t) => tokenHit(qn, t))) {
      // All significant words present in any order — score by how many must line up.
      scored.push({ o, score: toks.length });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((x) => x.o);
}
