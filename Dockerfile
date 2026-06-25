# syntax=docker/dockerfile:1.7
# One image, two run modes:
#   app    -> node server.js          (Next standalone)
#   poller -> npx tsx scripts/poller.ts (needs src/ + scripts/ + tsx + Prisma client)
# Debian (glibc) over Alpine (musl) — Prisma's query engine is most reliable there.

############################
# 1. deps — full install incl. devDeps (build needs typescript/@types; poller needs tsx)
############################
FROM node:22-bookworm-slim AS deps
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
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Regenerate against the in-tree schema (safety; deps already generated once).
RUN npx prisma generate
# Build-time public env: inlined into the client bundle by Next.
ARG NEXT_PUBLIC_PRIVY_APP_ID
ENV NEXT_PUBLIC_PRIVY_APP_ID=${NEXT_PUBLIC_PRIVY_APP_ID}
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build
# Bundle the poller (+ its src/lib deps) into one CJS file so the runtime needs neither tsx nor
# devDeps nor src/. @prisma/client stays external (native engine — can't be bundled).
RUN npm run build:poller

############################
# 2b. prod-deps — a SEPARATE, thin node_modules (no devDeps) for the runtime. The build stage's
# node_modules carries typescript/esbuild/tsx/@types (huge); the runtime must not. This is the
# whole point of the speedup — the fat layer never reaches the final image.
############################
FROM node:22-bookworm-slim AS proddeps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
# --omit=dev → prod-only tree; postinstall still runs prisma generate against the schema above.
RUN npm ci --omit=dev

############################
# 3. runtime — minimal, non-root, carries BOTH app + poller needs
############################
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN groupadd --system --gid 1001 nodejs \
    && useradd  --system --uid 1001 --gid nodejs nextjs

# --- Next standalone app (ships its OWN traced node_modules subset for the server) ---
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public

# --- Poller: just the bundled CJS + a PROD-ONLY node_modules (no tsx/devDeps/src). This is the
#     fat layer that used to bloat the image; now it's the thin --omit=dev tree from proddeps. ---
COPY --from=proddeps --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=nextjs:nodejs /app/dist/poller.cjs ./dist/poller.cjs
COPY --from=build --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=build --chown=nextjs:nodejs /app/package.json ./package.json

# Belt-and-suspenders: the standalone tracer can omit the Prisma engine .so (it's a data file,
# not an import). Overwrite the traced copies from the prod-deps tree to guarantee both the app
# and the poller find the query engine.
COPY --from=proddeps --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=proddeps --chown=nextjs:nodejs /app/node_modules/@prisma/client ./node_modules/@prisma/client

USER nextjs
EXPOSE 3000

# Default = the app. The poller service overrides this command in compose.
CMD ["node", "server.js"]
