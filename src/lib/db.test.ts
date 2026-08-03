import { afterEach, expect, test, vi } from 'vitest';
import { CLICKHOUSE, KAFKA, PRISMA, isPrismaOnly, runQuery } from './db';

afterEach(() => {
  vi.unstubAllEnvs();
});

function createQueries() {
  return {
    [PRISMA]: vi.fn().mockResolvedValue('prisma'),
    [CLICKHOUSE]: vi.fn().mockResolvedValue('clickhouse'),
  };
}

test('development routes to prisma even when clickhouse is configured', async () => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('CLICKHOUSE_URL', 'http://localhost:8123');
  vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/umami');

  const queries = createQueries();

  await expect(runQuery(queries)).resolves.toBe('prisma');
  expect(queries[CLICKHOUSE]).not.toHaveBeenCalled();
});

test('development routes to prisma when clickhouse is not configured', async () => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('CLICKHOUSE_URL', '');
  vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/umami');

  const queries = createQueries();

  await expect(runQuery(queries)).resolves.toBe('prisma');
});

test('production routes to clickhouse when configured', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('CLICKHOUSE_URL', 'http://localhost:8123');
  vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/umami');

  const queries = createQueries();

  await expect(runQuery(queries)).resolves.toBe('clickhouse');
  expect(queries[PRISMA]).not.toHaveBeenCalled();
});

test('production routes to prisma when clickhouse is not configured', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('CLICKHOUSE_URL', '');
  vi.stubEnv('DATABASE_URL', 'postgres://user:pass@localhost:5432/umami');

  const queries = createQueries();

  await expect(runQuery(queries)).resolves.toBe('prisma');
});

test('production still prefers an explicit kafka branch over clickhouse', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('CLICKHOUSE_URL', 'http://localhost:8123');

  const queries = {
    ...createQueries(),
    [KAFKA]: vi.fn().mockResolvedValue('kafka'),
  };

  await expect(runQuery(queries)).resolves.toBe('kafka');
});

test('development never reaches kafka even if a kafka handler is present', async () => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('CLICKHOUSE_URL', 'http://localhost:8123');
  vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/umami');

  const queries = {
    ...createQueries(),
    [KAFKA]: vi.fn().mockResolvedValue('kafka'),
  };

  await expect(runQuery(queries)).resolves.toBe('prisma');
  expect(queries[KAFKA]).not.toHaveBeenCalled();
});

test('isPrismaOnly is true only in development', () => {
  vi.stubEnv('NODE_ENV', 'development');
  expect(isPrismaOnly()).toBe(true);

  vi.stubEnv('NODE_ENV', 'production');
  expect(isPrismaOnly()).toBe(false);

  vi.stubEnv('NODE_ENV', 'test');
  expect(isPrismaOnly()).toBe(false);
});
