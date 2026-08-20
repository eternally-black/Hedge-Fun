# syntax=docker/dockerfile:1.7
# One image, two run modes:
#   app    -> node server.js          (Next standalone)
#   poller -> npx tsx scripts/poller.ts (needs src/ + scripts/ + tsx + Prisma client)
# Debian (glibc) over Alpine (musl) — Prisma's query engine is most reliable there.

############################
# 1. deps — full install incl. devDeps (build needs typescript/@types; poller needs tsx)
############################
FROM node:24-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
# postinstall runs `prisma generate` — prisma/ is copied above so it has the schema.
RUN npm ci

############################
# 2. build — compile Next standalone
############################
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Regenerate against the in-tree schema (safety; deps already generated once).
RUN npx prisma generate
# Build-time public env: inlined into the client bundle by Next. Setting these in the VPS .env does
# NOTHING for the browser — NEXT_PUBLIC_* is substituted at build time, so anything the client reads
# has to arrive here as a build arg or it is `undefined` in production no matter what the host says.
ARG NEXT_PUBLIC_PRIVY_APP_ID
ENV NEXT_PUBLIC_PRIVY_APP_ID=${NEXT_PUBLIC_PRIVY_APP_ID}
# Public builder code (attribution tag, not a secret). Absent = orders sign unattributed.
ARG NEXT_PUBLIC_POLYMARKET_BUILDER_CODE
ENV NEXT_PUBLIC_POLYMARKET_BUILDER_CODE=${NEXT_PUBLIC_POLYMARKET_BUILDER_CODE}
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build
# Bundle the poller (+ its src/lib deps) into one CJS file. Its ONLY runtime require is
# @prisma/client (verified) — so the runtime needs that, not the 2GB dep tree.
RUN npm run build:poller

############################
# 3. runtime — minimal, non-root. The big win (per Next docs): the standalone output ALREADY
# traces just the node_modules the app imports (~tens of MB), so we DON'T copy the full 2GB tree.
# We only add what's not traced: the bundled poller + @prisma/client/.prisma (engine + client)
# + the prisma CLI for the migrate service's `prisma db push`.
############################
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN groupadd --system --gid 1001 nodejs \
    && useradd  --system --uid 1001 --gid nodejs nextjs

# --- Next standalone app: ships its OWN traced node_modules subset (this is the size win) ---
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public

# --- Poller: the bundled CJS only (no src/, no tsx, no devDeps) ---
COPY --from=build --chown=nextjs:nodejs /app/dist/poller.cjs ./dist/poller.cjs

# --- Prisma: copy the FULL @prisma scope (client + engines + CLI deps) + .prisma (generated
#     client/engine) + the prisma CLI + schema. This is the documented minimal set for both
#     @prisma/client at runtime (app + poller) AND the migrate service's `prisma migrate deploy`.
#     ~180MB total vs the 2GB full tree; the standalone trace can miss the engine .so, so we
#     copy these explicitly. ---
COPY --from=build --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=nextjs:nodejs /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build --chown=nextjs:nodejs /app/node_modules/prisma ./node_modules/prisma
COPY --from=build --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=build --chown=nextjs:nodejs /app/package.json ./package.json
# The prisma CLI's config loader (@prisma/config) needs effect/c12/deepmerge-ts/empathic (~35MB),
# not traced into the standalone output. Install them in an ISOLATED scratch dir (NOT against our
# package.json — `npm install <pkg>` there would reinstall the whole 2GB tree) and move them into
# node_modules. npm resolves their transitives correctly. Also recreate the .bin/prisma symlink
# (the COPY dereferenced it to a flat file, breaking its WASM paths). Before USER switch.
RUN mkdir -p /tmp/cli && cd /tmp/cli \
    && npm install --no-save --ignore-scripts effect@3.21.0 c12@3.1.0 deepmerge-ts@7.1.5 empathic@2.0.0 \
    && cp -R /tmp/cli/node_modules/. /app/node_modules/ \
    && rm -rf /tmp/cli \
    && cd /app \
    && ln -sf ../prisma/build/index.js node_modules/.bin/prisma \
    && chown -R nextjs:nodejs node_modules

USER nextjs
EXPOSE 3000

# Default = the app. The poller service overrides this command in compose.
CMD ["node", "server.js"]
