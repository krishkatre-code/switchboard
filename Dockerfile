# Switchboard — production image (long-lived HTTP service for Shopify Cloud Platform).
# Multi-stage: build with all deps, ship only prod deps + compiled dist on a slim, non-root base.
# Runs in HTTP mode (SWITCHBOARD_SOCKET_MODE=false) so Slack can POST to /slack/events.

# ── base: Node 20 + pnpm (matches packageManager / pnpm-lock.yaml) ────────────
FROM node:20-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

# ── build: install ALL deps (needs tsc), compile TypeScript → dist/ ───────────
FROM base AS build
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# ── prod-deps: production dependencies only (no tsx/vitest/typescript) ────────
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

# ── runner: minimal runtime, non-root ────────────────────────────────────────
FROM node:20-slim AS runner
ENV NODE_ENV=production
ENV SWITCHBOARD_SOCKET_MODE=false
ENV PORT=3000
WORKDIR /app

# Drop privileges (the base image ships an unprivileged `node` user).
COPY --chown=node:node package.json ./
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node

EXPOSE 3000
# Liveness/readiness signal (Kubernetes probes should also target GET /health).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
