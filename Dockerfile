ARG BUN_IMAGE_VERSION="1.3-alpine"

# Install dependencies only when needed
FROM oven/bun:${BUN_IMAGE_VERSION} AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN bun install -g pnpm
RUN pnpm install --frozen-lockfile

# Rebuild the source code only when needed
FROM oven/bun:${BUN_IMAGE_VERSION} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
COPY docker/middleware.ts ./src

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

RUN bun run build-docker

# Production image, copy all the files and run next
FROM oven/bun:${BUN_IMAGE_VERSION} AS runner
WORKDIR /app

ARG PRISMA_VERSION="6.19.0"
ARG BUN_OPTIONS

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV BUN_OPTIONS=$BUN_OPTIONS

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs
RUN set -x \
    && apk add --no-cache curl \
    && bun install -g pnpm

# Script dependencies
RUN pnpm --allow-build='@prisma/engines' add npm-run-all dotenv chalk semver \
    prisma@${PRISMA_VERSION} \
    @prisma/adapter-pg@${PRISMA_VERSION}

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder /app/prisma ./prisma
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

CMD ["bun", "run", "start-docker"]