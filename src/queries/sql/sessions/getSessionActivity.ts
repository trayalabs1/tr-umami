import clickhouse from '@/lib/clickhouse';
import { CLICKHOUSE, PRISMA, runQuery } from '@/lib/db';
import prisma from '@/lib/prisma';

export async function getSessionActivity(
  ...args: [websiteId: string, sessionId: string, startDate: Date, endDate: Date]
) {
  return runQuery({
    [PRISMA]: () => relationalQuery(...args),
    [CLICKHOUSE]: () => clickhouseQuery(...args),
  });
}

async function relationalQuery(
  websiteId: string,
  sessionId: string,
  startDate: Date,
  endDate: Date,
) {
  return prisma.client.websiteEvent.findMany({
    where: {
      sessionId,
      websiteId,
      createdAt: { gte: startDate, lte: endDate },
    },
    take: 500,
    orderBy: { createdAt: 'desc' },
  });
}

async function clickhouseQuery(
  websiteId: string,
  sessionId: string,
  startDate: Date,
  endDate: Date,
) {
  const { rawQuery } = clickhouse;

  return rawQuery(
    `
      SELECT
        we.created_at AS createdAt,
        we.url_path AS urlPath,
        we.url_query AS urlQuery,
        we.referrer_domain AS referrerDomain,
        we.event_id AS eventId,
        we.event_type AS eventType,
        we.event_name AS eventName,
        we.visit_id AS visitId,
        groupArray(
            (
            'dataKey', ed.data_key,
            'stringValue', ed.string_value,
            'numberValue', ed.number_value,
            'dateValue', ed.date_value
          )
        ) AS eventData
      FROM website_event AS we
             LEFT JOIN event_data AS ed
                       ON we.event_id = ed.event_id
                         AND we.website_id = ed.website_id
      WHERE we.website_id = {websiteId:UUID}
        AND we.session_id = {sessionId:UUID}
        AND we.created_at BETWEEN {startDate:DateTime64} AND {endDate:DateTime64}
      GROUP BY
        we.created_at,
        we.url_path,
        we.url_query,
        we.referrer_domain,
        we.event_id,
        we.event_type,
        we.event_name,
        we.visit_id
      ORDER BY we.created_at DESC
        LIMIT 500
    `,
    { websiteId, sessionId, startDate, endDate },
  );
}
