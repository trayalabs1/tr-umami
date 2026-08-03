export const PRISMA = 'prisma';
export const POSTGRESQL = 'postgresql';
export const CLICKHOUSE = 'clickhouse';
export const KAFKA = 'kafka';
export const KAFKA_PRODUCER = 'kafka-producer';

// Fixes issue with converting bigint values
(BigInt.prototype as unknown as { toJSON(): number }).toJSON = function () {
  return Number(this);
};

export function getDatabaseType(url = process.env.DATABASE_URL) {
  const type = url?.split(':')[0];

  if (type === 'postgres') {
    return POSTGRESQL;
  }

  return type;
}

// In development, everything reads from and writes to Postgres; every other
// NODE_ENV keeps the ClickHouse/Kafka routing.
export function isPrismaOnly() {
  return process.env.NODE_ENV === 'development';
}

export async function runQuery(queries: any) {
  if (!isPrismaOnly() && process.env.CLICKHOUSE_URL) {
    if (queries[KAFKA]) {
      return queries[KAFKA]();
    }

    return queries[CLICKHOUSE]();
  }

  const db = getDatabaseType();

  if (db === POSTGRESQL) {
    return queries[PRISMA]();
  }
}

export function notImplemented() {
  throw new Error('Not implemented.');
}
