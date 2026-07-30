/**
 * Pure text helpers, ported VERBATIM from reference/index.html. These carry the
 * tokenization/sanitization the SQL builders rely on, so they must not drift.
 * (Line numbers below refer to the source file.)
 */

// ── link builders (L184-186) ────────────────────────────────────────────────
export function slackLink(id: string): string {
  return "https://shopify.slack.com/archives/" + encodeURIComponent(id);
}
export function vaultTeamLink(id: string | null | undefined): string | null {
  return id ? "https://vault.shopify.io/teams/" + encodeURIComponent(id) : null;
}
export function repoLink(repo: string | null | undefined): string | null {
  return repo && /^[\w.-]+\/[\w.-]+$/.test(repo)
    ? "https://github.com/" + repo
    : null;
}

// ── stopwords / generic tokens (L188, L191) ─────────────────────────────────
export const STOP = new Set<string>([
  "the", "a", "an", "to", "how", "do", "does", "i", "of", "for", "in", "on", "is",
  "my", "me", "and", "or", "where", "who", "what", "which", "why", "when", "can",
  "with", "about", "ask", "find", "need", "get", "should", "owns", "own", "owner",
  "team", "service", "repo", "new", "getting", "point", "thing", "things", "stuff",
  "please", "using", "use", "want", "make", "help", "support",
]);
// Tokens too generic to justify an ownership card on their own (channel search
// still uses them; this only guards the "who owns it" path).
export const GENERIC = new Set<string>([
  "admin", "app", "apps", "api", "platform", "service", "services", "team", "teams",
  "data", "web", "mobile", "core", "infra", "tool", "tools", "ui", "ux", "backend",
  "frontend", "help", "support", "system", "internal",
]);

export function repoName(rep: string | null | undefined): string {
  const r = (rep || "").toLowerCase();
  const i = r.lastIndexOf("/");
  return i >= 0 ? r.slice(i + 1) : r;
}

// ── channel-search terms (naive) (L211-214) ──────────────────────────────────
export function toTerms(raw: string): string[] {
  return [
    ...new Set(
      raw
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/\s+/)
        .map((w) => w.replace(/^-+|-+$/g, ""))
        .filter((w) => w.length >= 3 && !STOP.has(w))
    ),
  ].slice(0, 8);
}

// ── entity tokens (allow / . _ - for repos/services) (L216-219) ──────────────
export function entityTokens(raw: string): string[] {
  return [
    ...new Set(
      raw
        .toLowerCase()
        .replace(/[^a-z0-9\s\/._-]/g, " ")
        .split(/\s+/)
        .map((w) => w.replace(/^[._-]+|[._-]+$/g, ""))
        .filter((w) => w.length >= 3 && !STOP.has(w))
    ),
  ].slice(0, 6);
}

export function isEntityLike(raw: string): boolean {
  const q = raw.trim();
  const words = q.split(/\s+/);
  const hasQ = /\?|\b(how|where|who|what|which|why|when|do|does|can|should)\b/i.test(q);
  const identifierish = /[\/_-]/.test(q) || words.length === 1;
  return words.length <= 3 && (identifierish || !hasQ);
}

// ── product/feature → domain synonym map (L230-238) ──────────────────────────
export const QUERY_ALIASES: Array<{ keys: string[]; add: string[] }> = [
  {
    keys: ["translate and adapt", "translate & adapt", "translate&adapt", "translate adapt"],
    add: ["localization", "localize", "i18n", "markets", "translation", "translate"],
  },
  {
    keys: ["shop pay installments", "shop-pay-installments", "shoppay installments", "installments"],
    add: ["installments", "financing", "bnpl", "payments", "shop-pay"],
  },
];
export function aliasTerms(query: string): string[] {
  const q = (query || "").toLowerCase();
  const out: string[] = [];
  for (const a of QUERY_ALIASES) {
    if (a.keys.some((k) => q.includes(k))) out.push(...a.add);
  }
  return out;
}

// ── formatting (L345-346, L455-456) ──────────────────────────────────────────
export function fmtReply(sec: number): string {
  sec = Number(sec);
  if (!isFinite(sec)) return "";
  const min = sec / 60;
  if (min < 1) return "under a min";
  if (min < 60) return `~${Math.round(min)} min`;
  return `~${(min / 60).toFixed(min < 600 ? 1 : 0)}h`;
}
export function fmtNum(n: number): string {
  n = Number(n) || 0;
  return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n);
}
export function actDot(msgs: number): string {
  msgs = Number(msgs) || 0;
  return msgs >= 100 ? "🟢" : msgs >= 20 ? "🟡" : "⚪";
}

// ── noise-channel filter (L458-462) ──────────────────────────────────────────
export function isNoiseChannel(name: string): boolean {
  name = (name || "").toLowerCase();
  if (name.startsWith("help")) return false;
  return /(^(incident|inc|sev|pd|pager|page|alert|alerts|tmp|temp|zzz)[-_]?[0-9])|((^|[-_])(incident|incidents|alerting|alerts|notifications|notification|firehose|deploys|pr-reviews|oncall)([-_]|$))|(bot$)|(^bot[-_])/.test(
    name
  );
}

// ── prefix-aware token match (L466-471) ──────────────────────────────────────
export function tokenHit(text: string, t: string): boolean {
  if (!t || t.length < 3) return false;
  if (text.includes(t)) return true;
  const p = t.length >= 7 ? t.slice(0, 6) : t.length >= 6 ? t.slice(0, 5) : null;
  return p ? text.includes(p) : false;
}

/** Slack mrkdwn escaping for user-derived text (replaces the browser's HTML `esc`). */
export function mrkdwnEscape(s: unknown): string {
  return (s == null ? "" : String(s))
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
