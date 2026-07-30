# Switchboard — Slack slash command

Switchboard answers **"who owns this, and where do I ask?"** Give it a repo, service, or
team name — or a plain-language question — and it routes you to the owning team and the
right public Slack channel to ask in.

This service is a **backend port** of the internal Switchboard Quick site
(`switchboard-hq.quick.shopify.io`), exposed as the Slack slash command `/switchboard`. A
slash command is server-to-server (Slack POSTs to us with no user session), so it needs a
hosted service with its **own** credentials. The routing logic, SQL, and LLM prompts are
ported **verbatim** from the web app; only the three runtime clients are swapped:

| Web app (browser, runs as the user) | This service (server, own creds) |
|---|---|
| `quick.dw.querySync` | `@google-cloud/bigquery` (service account) + `maximumBytesBilled` cap |
| `quick.ai` (`gpt-5.4`) | `openai` client → internal OpenAI-compatible gateway |
| `quick.db.collection(...)` | `Store` interface — local file store now, Quick REST stub for later |

## How it works

```
/switchboard <query>
   │  ack "⚡ Routing…" within 3s
   ▼
classifyIntent (LLM)  ──► entity vs. question
   ├─ findOwnership (BigQuery: infra_central services + vault teams)
   ├─ expandTerms (LLM)  ──► findChannels (BigQuery, smart→fallback)  ──► rankChannels (LLM)
   ├─ matchOverrides (curated "teach" routes pin channels to the top)
   ├─ findResponsiveness (median first-reply time) + findCommitters (top repo authors)
   ▼
RouteResult  ──► Block Kit  ──► respond() via response_url (ephemeral, replaces the ack)
```

Everything per-request (`respMap`, `committers`, `dwError`) is returned in a `RouteResult`,
never stored in module globals, so concurrent commands can't corrupt each other. Shared
read-mostly data (curated `overrides` + aggregated `voteMap`) is loaded through a ~60s TTL
cache and passed into `route()` as parameters; writes invalidate the cache.

## Prerequisites you provide

1. **Slack app** (internal): add the slash command `/switchboard`, enable Interactivity,
   grant the `commands` scope. For HTTP mode, point both the slash-command and interactivity
   **Request URLs** at `https://<host>/slack/events`. Capture the **Signing Secret** and
   **Bot Token** (`xoxb-…`); for Socket Mode also create an **App-Level Token** (`xapp-…`).
2. **LLM gateway**: an OpenAI-compatible base URL + API key (`LLM_MODEL` defaults to `gpt-5.4`).
3. **BigQuery**: a service-account key with **read** on the referenced datasets
   (`shopify-dw.people.slack_*`, `…base__infra_central__*`,
   `…base__github__default_branch_commits`, `…infrastructure.github_users`) plus a billing
   project id. All queries read **metadata only** (channel names, purposes, activity counts,
   commit authors) — never message text.

Copy `.env.example` → `.env` and fill these in. Without the pipeline creds the service still
boots and acks, but a real query returns a clear "not configured" message (fail-fast via
`assertPipelineReady`).

## Try it yourself

> **What a full demo needs:** live routing answers require Shopify-internal credentials — the
> OpenAI-compatible LLM gateway and a BigQuery service account with read on the `shopify-dw`
> datasets listed above. If you're inside Shopify you can wire your own. If you don't have those,
> you can still install, boot the service, connect it to a Slack app, run the test suite, and read
> the verbatim-ported pipeline — a real query just returns a clear "not configured" message.

**1. Toolchain** — Node 20+ and pnpm (this repo pins `pnpm@10.28.0`; the easiest way to get the
exact version is Corepack, which ships with Node):

```bash
node --version          # must be >= 20
corepack enable         # provides the pinned pnpm — no global install needed
```

**2. Clone & install:**

```bash
git clone https://github.com/krishkatre-code/switchboard.git
cd switchboard
pnpm install
```

**3. Configure** — copy the template and fill in your Slack app + (optionally) LLM/BigQuery creds:

```bash
cp .env.example .env
# then edit .env — see "Prerequisites you provide" above
```

For the fastest path, create an internal Slack app with a `/switchboard` slash command,
enable **Socket Mode**, and set `SWITCHBOARD_SOCKET_MODE=true` with a `SLACK_APP_TOKEN` (`xapp-…`) —
no public URL or tunnel required.

**4. Verify the build without any creds** (proves the port compiles and the SQL/logic is intact):

```bash
pnpm typecheck
pnpm test               # pure-fn units + byte-for-byte SQL snapshot tests
```

**5. Run it:**

```bash
# Fastest local demo — no public URL/tunnel needed:
SWITCHBOARD_SOCKET_MODE=true pnpm dev        # needs SLACK_APP_TOKEN (xapp-…)

# HTTP mode (mirrors production): expose :3000 and set the Slack Request URLs
pnpm dev
cloudflared tunnel --url http://localhost:3000
#   → set slash-command + interactivity URLs to https://<tunnel>/slack/events

# Production
pnpm build && pnpm start
```

Health check (HTTP mode): `curl localhost:3000/health` → `{"ok":true,"service":"switchboard"}`.

Then, in any Slack channel the app is in, try the queries under **Usage** below. No creds handy?
`pnpm route "how do I request a prod data export"` runs the same pipeline from the CLI (still needs
LLM + BigQuery to return real answers).

## Usage

```
/switchboard checkout-experience                     # entity → owning team + committers + channels
/switchboard how do I request a prod data export     # question → best #help-* channels
/switchboard teach shop pay installments => help-payments help-billing   # pin a curated route
```

- 👍 / 👎 on any suggestion records feedback (nudges ranking after the cache TTL).
- **📣 Share to channel** promotes the ephemeral result to a channel-visible post (no extra
  scope — uses the command's `response_url`).

## Scripts

| | |
|---|---|
| `pnpm dev` | watch + run (`tsx`) |
| `pnpm build` / `pnpm start` | compile to `dist/` / run compiled |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` / `pnpm test:watch` | Vitest (pure-fn units + SQL snapshots) |

The SQL snapshot tests (`tests/sql.test.ts`) lock every generated query string so the
verbatim-from-`index.html` port can't silently drift.

## Configuration

All config is read once and validated (zod) in `src/config/env.ts`. See `.env.example` for
the full list. Notable knobs:

- `SWITCHBOARD_SOCKET_MODE` — `true` for Socket Mode (needs `SLACK_APP_TOKEN`), else HTTP.
- `BIGQUERY_MAX_BYTES_BILLED` — hard cost cap per job (default 50 GB). The web app documents a
  prior byte-scan blowup; the tight `LIMIT 150` + smart→fallback two-query shape is preserved.
- `STORE_BACKEND` — `file` (JSONL under `STORE_FILE_PATH=./data`) or `quick` (REST stub;
  IAP-protected, not yet implemented).
- `SHARED_CACHE_TTL_MS` — overrides/votes cache freshness (default 60s).

## Layout

```
src/
  server.ts              entrypoint: config → clients → App → /health → start
  config/env.ts          zod-validated env → typed Config
  clients/               bigquery, llm, store/{FileStore,QuickApiStore}
  pipeline/              text, intent, expand, ownership, channels, responsiveness,
                         committers, overrides, feedback   (verbatim logic, no globals)
  orchestrator/          types + route() (port of runQuery)
  cache/sharedData.ts    TTL cache over {overrides, voteMap}
  slack/                 app (receiver factory), command, blocks, actions, shareCache
tests/                   pure-fn units + SQL snapshots
reference/index.html     READ-ONLY source of truth (gitignored, internal source)
```

## Security notes

- **Never commit secrets.** `.env`, `data/`, `*-sa.json`, and `reference/` are gitignored.
  Use a platform secret manager for the deployed service.
- **`reference/index.html` is internal, IAP-protected source** — kept locally for parity, not
  for publishing.
- **Shared service account vs. per-user:** the web app queries BigQuery *as the logged-in
  user*; this service uses one service account, which removes per-user access scoping. Queries
  are metadata-only, but request **least-privilege read** on exactly the datasets above and
  audit-log `{user_id, query, ts}`. **Flag for data/security review before go-live.**
- LLM calls use `maxRetries:0` + a timeout, and every pipeline stage keeps its heuristic
  fallback, so a gateway or BigQuery outage degrades gracefully instead of hanging.
