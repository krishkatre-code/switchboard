# Deploying Switchboard (Shopify Cloud Platform)

Target: a long-lived **HTTP** service with a public HTTPS route, so the Shopify Slack app
(`slack1`) can POST slash-command + interactivity payloads to `…/slack/events`. (Socket Mode
is for local demos only — it can't receive Slack's HTTP callbacks in production.)

## Artifacts in this repo

| File | Purpose |
|---|---|
| `Dockerfile` | Multi-stage prod image: build → prod-deps → slim non-root runner (`node dist/server.js`). |
| `.dockerignore` | Keeps secrets/local state (`.env`, `data/`, `reference/`, SA keys) out of the image. |
| `deploy/services.yml` | **Template** Cloud Platform manifest — verify the schema, then move to repo root. |

> Docker build was **not** validated in this environment (no Docker daemon). Run
> `docker build -t switchboard .` once before wiring up the platform.

## Production config

Set in `services.yml` env (non-secret) and the platform **secret manager** (secret):

- `SWITCHBOARD_SOCKET_MODE=false` — HTTP mode.
- **Secrets:** `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `LLM_BASE_URL`, `LLM_API_KEY`,
  `BIGQUERY_PROJECT_ID`, and the BigQuery SA key (mount as a file; point
  `GOOGLE_APPLICATION_CREDENTIALS` at the mount path). **Never** put these in `services.yml`
  or `.env` in the image.
- In HTTP mode `SLACK_APP_TOKEN` is unused; `SLACK_SIGNING_SECRET` **is** required (Bolt
  verifies every request signature with it).

## Slack app (production)

1. Deploy, get the public host (e.g. `https://switchboard.<platform-domain>`).
2. In the Slack app config, set **both** Request URLs to `https://<host>/slack/events`:
   - Slash Commands → `/switchboard`
   - Interactivity & Shortcuts (needed for 👍/👎 + Share buttons)
3. Scopes: `commands` (that's all the current flows need — Share uses `response_url`).
4. Reinstall the app if scopes changed. Verify: `curl https://<host>/health` → `{"ok":true}`.

## ⚠️ Two things to resolve before go-live

1. **Shared store is per-pod & ephemeral.** With `STORE_BACKEND=file` and `replicas: 2`, a
   "teach" override or 👍/👎 written on one pod is invisible to the other and is **lost on
   redeploy** (container filesystem is not durable). Pick one:
   - implement `QuickApiStore` (writes back to the Quick site's REST API — the original shared
     source of truth; currently a stub, blocked on IAP service-auth), **or**
   - add a small shared datastore (e.g. a managed Postgres/KV) behind the `Store` interface, **or**
   - for a demo only: `replicas: 1` + a persistent volume at `STORE_FILE_PATH`.
   Routing itself works fine without this — only crowd overrides/votes are affected.

2. **BigQuery access is a shared service account.** The web app queries *as the logged-in
   user*; this service uses one SA, removing per-user scoping. Queries are metadata-only
   (channel names, purposes, counts, commit authors — never message text), but before go-live:
   request **least-privilege read** on exactly the referenced datasets, keep the
   `maximumBytesBilled` cap, and **audit-log `{user_id, query, ts}`**. Get data/security sign-off.

## Local image smoke test

```bash
docker build -t switchboard .
docker run --rm -p 3000:3000 --env-file .env \
  -e SWITCHBOARD_SOCKET_MODE=false switchboard
curl localhost:3000/health      # → {"ok":true,"service":"switchboard"}
```
