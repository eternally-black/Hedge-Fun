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

# --- Next standalone app ---
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public

# --- Poller needs: full node_modules (tsx), TS source, scripts, Prisma client ---
COPY --from=build --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=nextjs:nodejs /app/src ./src
COPY --from=build --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=build --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=build --chown=nextjs:nodejs /app/tsconfig.json ./tsconfig.json
COPY --from=build --chown=nextjs:nodejs /app/package.json ./package.json

# Belt-and-suspenders: the standalone tracer can omit the Prisma engine .so
# (it's a data file, not an import). Overwrite the traced copies to guarantee it.
COPY --from=build --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=nextjs:nodejs /app/node_modules/@prisma/client ./node_modules/@prisma/client

USER nextjs
EXPOSE 3000

# Default = the app. The poller service overrides this command in compose.
CMD ["node", "server.js"]
