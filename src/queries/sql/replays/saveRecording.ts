import { gzipSync } from 'node:zlib';
import clickhouse from '@/lib/clickhouse';
import { uuid } from '@/lib/crypto';
import { CLICKHOUSE, PRISMA, runQuery } from '@/lib/db';
import kafka from '@/lib/kafka';
import prisma from '@/lib/prisma';

export interface SaveRecordingArgs {
  websiteId: string;
  sessionId: string;
  visitId: string;
  chunkIndex: number;
  events: any[];
  eventCount: number;
  startedAt: Date;
  endedAt: Date;
}

export async function saveRecording(args: SaveRecordingArgs) {
  return runQuery({
    [PRISMA]: () => relationalQuery(args),
    [CLICKHOUSE]: () => clickhouseQuery(args),
  });
}

async function relationalQuery({
  websiteId,
  sessionId,
  visitId,
  chunkIndex,
  events,
  eventCount,
  startedAt,
  endedAt,
}: SaveRecordingArgs) {
  const compressed = gzipSync(Buffer.from(JSON.stringify(events), 'utf-8'));

  return prisma.client.sessionReplay.create({
    data: {
      id: uuid(),
      websiteId,
      sessionId,
      visitId,
      chunkIndex,
      events: compressed as any,
      eventCount,
      startedAt,
      endedAt,
    },
  });
}

async function clickhouseQuery({
  websiteId,
  sessionId,
  visitId,
  chunkIndex,
  events,
  eventCount,
  startedAt,
  endedAt,
}: SaveRecordingArgs) {
  const { insert, getUTCString } = clickhouse;
  const { sendMessage } = kafka;

  const baseMessage = {
    replay_id: uuid(),
    website_id: websiteId,
    session_id: sessionId,
    visit_id: visitId,
    chunk_index: chunkIndex,
    event_count: eventCount,
    started_at: getUTCString(startedAt),
    ended_at: getUTCString(endedAt),
  };

  if (kafka.enabled) {
    // gzip+base64 events to keep Kafka message under broker per-message limit.
    // Consumer must un-gzip before inserting into ClickHouse.
    const compressed = gzipSync(Buffer.from(JSON.stringify(events), 'utf-8')).toString('base64');

    return sendMessage('session_replay', {
      ...baseMessage,
      events: compressed,
      encoding: 'gzip',
    });
  }

  return insert('session_replay', [
    {
      ...baseMessage,
      events: JSON.stringify(events),
    },
  ]);
}
