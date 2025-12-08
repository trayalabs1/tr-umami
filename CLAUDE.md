# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Umami is a privacy-focused analytics platform built with Next.js, TypeScript, and supporting both PostgreSQL and MySQL databases. It provides real-time website analytics, user sessions tracking, and comprehensive reporting capabilities.

## Commands

### Development
- `npm run dev` - Start development server on port 3000
- `npm run dev-turbo` - Start development server with Turbopack

### Build and Production
- `npm run build` - Full build (includes DB setup, tracker build, geo data, and app build)
- `npm run start` - Start production server
- `npm run build-docker` - Build for Docker deployment
- `npm run start-docker` - Start Docker container

### Testing
- `npm test` - Run Jest unit tests
- `npm run cypress-open` - Open Cypress for E2E tests
- `npm run cypress-run` - Run Cypress tests headlessly

### Code Quality
- `npm run lint` - Run ESLint
- TypeScript checking is done automatically during build

### Database Management
- `npm run update-db` - Apply Prisma migrations
- `npm run build-db-client` - Generate Prisma client
- `npm run check-db` - Verify database connection

## Architecture

### Core Technologies
- **Frontend**: Next.js 15.3 with React 19, TypeScript
- **Styling**: CSS Modules with PostCSS
- **Database**: Prisma ORM supporting PostgreSQL (12.14+) and MySQL (8.0+)
- **Analytics Storage**: Optional ClickHouse integration for high-volume data
- **Caching**: Redis support via @umami/redis-client
- **Message Queue**: Kafka integration for event streaming (optional)
- **Authentication**: JWT-based with bcryptjs

### Project Structure
- `/src/app` - Next.js App Router structure
  - `/api` - API routes organized by feature (auth, users, websites, reports, etc.)
  - `/(main)` - Main application UI routes
- `/src/lib` - Shared utilities and services
  - Key modules: `auth.ts`, `prisma.ts`, `clickhouse.ts`, `kafka.ts`, `redis.ts`
- `/src/queries` - Database query layer with Prisma and raw SQL support
- `/src/components` - React components with hooks for data fetching
- `/public` - Static assets and internationalization files
- `/db` - Database schemas for PostgreSQL and MySQL

### Key Features
- Real-time analytics tracking via `/api/send` endpoint
- Session and event data collection with UTM parameter support
- Multiple database support (PostgreSQL, MySQL, ClickHouse)
- Kafka integration for event streaming (when KAFKA_URL and KAFKA_BROKER are configured)
- IP blocking and bot detection
- Multi-tenant support with teams and user management
- Comprehensive reporting (funnel, attribution, retention, revenue, etc.)

### Environment Configuration
Required environment variables:
- `DATABASE_URL` - Connection string for PostgreSQL/MySQL
- `APP_SECRET` - Random string for JWT signing (production)

Optional services:
- `KAFKA_URL` and `KAFKA_BROKER` - Kafka configuration
- `CLICKHOUSE_URL` - ClickHouse connection
- `REDIS_URL` - Redis connection
- `DISABLE_BOT_CHECK` - Disable bot detection
- `REMOVE_TRAILING_SLASH` - URL normalization

### Development Guidelines
- TypeScript with path aliasing: `@/` maps to `./src/`
- Prisma for database operations with generated client
- React Query (Tanstack Query) for data fetching
- Zod for API request/response validation
- ESLint and Prettier for code formatting (with Husky pre-commit hooks)

### API Structure
All API routes follow Next.js App Router conventions in `/src/app/api/`:
- Authentication: `/auth/*`
- Analytics collection: `/send`
- Website management: `/websites/*`
- Reporting: `/reports/*`
- Real-time data: `/realtime/*`
- User/Team management: `/users/*`, `/teams/*`

### Docker Support
The project includes `docker-compose.yml` for local development with PostgreSQL. Production Docker images are available for both PostgreSQL and MySQL backends.