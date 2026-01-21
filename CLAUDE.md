# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Umami is a privacy-focused web analytics platform built with Next.js. This is a modified version (tr-umami) that supports multiple database backends and message queuing systems for high-throughput event collection.

**Tech Stack:**
- **Frontend:** Next.js 15 (App Router), React 19, TypeScript
- **Backend:** Next.js API routes, Prisma ORM
- **Databases:** PostgreSQL (primary), ClickHouse (analytics/optional)
- **Message Queue:** Kafka (optional)
- **Cache:** Redis (optional)
- **Package Manager:** pnpm (with Bun runtime support)

## Common Commands

### Development
```bash
# Start development server (runs on port 3001)
pnpm dev

# Start with environment setup
pnpm run start-env
```

### Building
```bash
# Full build (includes DB setup, tracker, geo data)
pnpm run build

# Build individual components
pnpm run build-app          # Next.js application
pnpm run build-tracker      # Analytics tracking script
pnpm run build-db           # Prisma client generation
pnpm run build-geo          # GeoIP database
```

### Database Operations
```bash
# Generate Prisma client
pnpm run build-db-client

# Run migrations
pnpm run update-db

# Check database connection
pnpm run check-db

# Pull schema from database
pnpm run build-db-schema
```

### Testing & Linting
```bash
# Run tests
pnpm test

# Lint code with Biome
pnpm lint

# Format code with Biome
pnpm format

# Check and fix code issues
pnpm check

# Run Cypress tests
pnpm run cypress-open       # Interactive mode
pnpm run cypress-run        # Headless mode
```

### Production
```bash
# Start production server (port 3000)
pnpm start

# Docker build
pnpm run build-docker
pnpm run start-docker
```

## Architecture

### Multi-Database Strategy

The codebase supports three storage backends through a query abstraction layer:

1. **PostgreSQL (via Prisma)** - Default relational database
   - Schema: `prisma/schema.prisma`
   - Queries: `src/queries/prisma/`

2. **ClickHouse** - Optional OLAP database for analytics
   - Schema: `db/clickhouse/schema.sql`
   - Client: `src/lib/clickhouse.ts`
   - Queries: `src/queries/sql/`

3. **Kafka → ClickHouse** - Optional high-throughput pipeline
   - Producer: `src/lib/kafka.ts.old`
   - Events sent to Kafka topics, consumed by ClickHouse

**Query Routing Logic** (`src/lib/db.ts`):
```typescript
runQuery({
  [PRISMA]: () => prismaQuery(),
  [CLICKHOUSE]: () => clickhouseQuery(),
  [KAFKA]: () => kafkaPublish()
})
```

The system automatically routes to Kafka if enabled, otherwise ClickHouse, otherwise PostgreSQL/Prisma.

### Event Collection Pipeline

**Entry Point:** `src/app/api/send/route.ts` (POST handler)

Flow:
1. Request validation (Zod schema)
2. Cache token parsing (session/visit deduplication)
3. Website lookup (with caching)
4. Client detection (IP, user agent, GeoIP)
5. Bot filtering (isbot)
6. Session/Visit ID generation (UUID with salt rotation)
7. Event persistence via `saveEvent()` → routes to appropriate backend
8. Cache token generation for next request

**Key Performance Optimizations:**
- Token caching (x-umami-cache header) - skips DB lookups for repeated events
- Visit grouping (30-minute windows)
- Deferred session creation for ClickHouse
- Performance timing logs for monitoring

### Data Models

**Core Entities:**
- `User` - Admin/team users
- `Team` - Multi-tenancy support
- `Website` - Analytics properties
- `Session` - User browsing sessions with device/geo data
- `WebsiteEvent` - Page views and custom events
- `EventData` - Custom event properties (key-value)
- `SessionData` - User identification data

**Storage Differences:**
- PostgreSQL: Full relational model with foreign keys
- ClickHouse: Denormalized event tables optimized for aggregations
  - `website_event` - Main event table (partitioned by month)
  - `event_data` - Custom event properties
  - `session_data` - User profile data (ReplacingMergeTree)

### Tracker Script

**Source:** `src/tracker/index.js`
**Build:** Rollup configuration in `rollup.tracker.config.js`
**Output:** `public/script.js`

Lightweight JavaScript snippet embedded on client websites. Sends events to `/api/send` endpoint.

### Configuration

**Environment Variables:**
- `DATABASE_URL` - PostgreSQL connection (required)
- `CLICKHOUSE_URL` - ClickHouse connection (optional)
- `KAFKA_URL`, `KAFKA_BROKER` - Kafka connection (optional)
- `REDIS_URL` - Redis cache (optional)
- `APP_SECRET` - JWT signing key
- `DEBUG` - Debug namespace filtering
- `LOG_QUERY` - Log all database queries

**Note:** `.env` file contains development credentials - never commit production credentials.

### Module Organization

```
src/
├── app/                 # Next.js App Router
│   ├── api/            # API routes (REST endpoints)
│   ├── (main)/         # Authenticated UI pages
│   ├── (collect)/      # Event collection routes
│   └── login/          # Auth pages
├── lib/                # Core utilities
│   ├── db.ts           # Query routing logic
│   ├── clickhouse.ts   # ClickHouse client
│   ├── kafka.ts.old        # Kafka producer
│   ├── redis.ts        # Redis client
│   ├── prisma.ts       # Prisma client setup
│   └── detect.ts       # User agent/geo parsing
├── queries/            # Database queries
│   ├── prisma/         # PostgreSQL/Prisma queries
│   └── sql/            # ClickHouse SQL queries
├── components/         # React components
├── tracker/            # Analytics tracking script
└── store/              # Zustand state management
```

## Development Notes

### Code Style
- Uses **Biome** (not ESLint/Prettier) for linting and formatting
- Single quotes, 2-space indentation, trailing commas
- Line width: 100 characters
- Run `pnpm check` before committing

### Testing
- Jest for unit tests (`src/lib/__tests__/`)
- Test files: `*.test.ts` or `*.spec.ts`
- Path alias: `@/` maps to `src/`

### Database Migrations

**PostgreSQL:**
1. Modify `prisma/schema.prisma`
2. Generate migration: `npx prisma migrate dev --name <migration-name>`
3. Migration files in `prisma/migrations/`

**ClickHouse:**
1. Modify `db/clickhouse/schema.sql`
2. Add migration SQL to `db/clickhouse/migrations/`
3. Manually apply via ClickHouse client

### Kafka Optimization

See `KAFKA_OPTIMIZATION_GUIDE.md` for detailed guidance on:
- Batched writes (10ms window or 1000 messages)
- Producer configuration (idempotence, compression, ACKs)
- Monitoring setup (Prometheus metrics)
- Expected 10-50x throughput improvements

### Common Patterns

**Query Abstraction:**
```typescript
import { runQuery } from '@/lib/db';

const result = await runQuery({
  [PRISMA]: async () => {
    return prisma.website.findUnique({ where: { id } });
  },
  [CLICKHOUSE]: async () => {
    return clickhouse.rawQuery('SELECT * FROM website WHERE id = {id:UUID}', { id });
  },
});
```

**Debug Logging:**
```typescript
import debug from 'debug';
const log = debug('umami:feature-name');
log('Message', { data });
```
Enable via `DEBUG=umami:*` environment variable.

**Client Detection:**
```typescript
import { getClientInfo } from '@/lib/detect';
const { ip, userAgent, device, browser, os, country, region, city } =
  await getClientInfo(request, payload);
```

## Important Considerations

1. **Session Deduplication:** Sessions are keyed by `uuid(websiteId, ip, userAgent, monthSalt)`. Same user from same IP/browser gets consistent session ID for the month.

2. **Visit Grouping:** Visits auto-expire after 30 minutes of inactivity. New visit ID generated hourly.

3. **Bot Filtering:** Uses `isbot` library. Disabled via `DISABLE_BOT_CHECK=1`.

4. **Geo Location:** Uses MaxMind GeoLite2 database (built via `pnpm run build-geo`).

5. **Performance:** Token caching is critical for high-traffic sites. The `x-umami-cache` header reduces DB queries by 80%+.

6. **Scaling:** For >10k events/sec, use Kafka → ClickHouse pipeline instead of direct writes.

## Scripts

Key scripts in `scripts/`:
- `check-db.js` - Database connectivity test
- `check-env.js` - Environment variable validation
- `build-geo.js` - Download/build GeoIP database
- `seed-data.ts` - Generate test data
- `change-password.js` - Admin password reset

## Docker

Docker Compose includes PostgreSQL database. For production, configure external PostgreSQL, ClickHouse, and Kafka services.

**Build Docker image:**
```bash
docker compose build
docker compose up -d
```

Default credentials: username `admin`, password `umami` (change immediately).
