ARG NODE_IMAGE_VERSION="22-alpine"

# Install dependencies only when needed
FROM node:${NODE_IMAGE_VERSION} AS deps
# Check https://github.com/nodejs/docker-node/tree/b4117f9333da4138b03a546ec926ef50a31506c3#nodealpine to understand why libc6-compat might be needed.
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install -g pnpm
RUN pnpm install --frozen-lockfile

# Rebuild the source code only when needed
FROM node:${NODE_IMAGE_VERSION} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
COPY docker/proxy.ts ./src

ARG BASE_PATH
ARG DATABASE_URL
ARG REDIS_URL
ARG DEBUG
ARG CLICKHOUSE_URL
ARG KAFKA_URL
ARG KAFKA_BROKER

ENV BASE_PATH=$BASE_PATH
ENV DATABASE_URL=$DATABASE_URL
ENV REDIS_URL=$REDIS_URL
ENV DEBUG=$DEBUG
ENV CLICKHOUSE_URL=$CLICKHOUSE_URL
ENV KAFKA_URL=$KAFKA_URL
ENV KAFKA_BROKER=$KAFKA_BROKER

ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build-docker

# Production image, copy all the files and run next
FROM node:${NODE_IMAGE_VERSION} AS runner
WORKDIR /app

ARG PRISMA_VERSION="7.3.0"
# Must match the version pnpm-lock.yaml resolves for the app, so this install and
# the Next standalone output below share one node_modules/.pnpm/semver@<v> directory
# and merge. On a mismatch the standalone COPY replaces this complete copy with its
# own partially traced one (the app imports only semver submodules, so index.js is
# absent) and scripts/check-db.js dies on `import semver from 'semver'`.
ARG SEMVER_VERSION="7.7.4"
ARG NODE_OPTIONS

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_OPTIONS=$NODE_OPTIONS

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs
RUN set -x \
    && apk add --no-cache curl \
    && npm install -g pnpm

# Script dependencies
# Two things are required for the Prisma engines postinstall to actually run here:
#   1. pnpm 11 refuses to run dependency build scripts unless they are allow-listed
#      in pnpm-workspace.yaml (allowBuilds), else the install dies with
#      ERR_PNPM_IGNORED_BUILDS.
#   2. pnpm silently SKIPS all dependency build scripts when the install directory
#      has no package.json, so a minimal one is seeded first. Without it the
#      schema-engine binary is never baked in and `prisma migrate deploy` (run by
#      scripts/check-db.js on container start) has to download it at runtime.
# verifyDepsBeforeRun: false is what upstream umami sets here too. Without it pnpm 11
# defaults to "install" and auto-runs `pnpm install` before any `pnpm run`, which
# fails EACCES as the unprivileged nextjs user and crashloops the container. The
# workspace file is deliberately kept in the image for that reason.
# package.json is replaced later by the standalone build output COPY below.
RUN printf '{"name":"umami-runner","version":"0.0.0","private":true}' > package.json \
    && printf "allowBuilds:\n  '@prisma/client': true\n  '@prisma/engines': true\n  prisma: true\nverifyDepsBeforeRun: false\n" > pnpm-workspace.yaml
RUN pnpm add npm-run-all dotenv chalk semver@${SEMVER_VERSION} \
    prisma@${PRISMA_VERSION} \
    @prisma/client@${PRISMA_VERSION} \
    @prisma/adapter-pg@${PRISMA_VERSION}

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/generated ./generated

# Automatically leverage output traces to reduce image size
# https://nextjs.org/docs/advanced-features/output-file-tracing
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# npm, not pnpm — same as upstream umami. Combined with verifyDepsBeforeRun: false
# above, this keeps pnpm's dependency-state check out of container startup.
CMD ["npm", "run", "start-docker"]
