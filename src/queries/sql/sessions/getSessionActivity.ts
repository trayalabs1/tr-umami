import clickhouse from '@/lib/clickhouse';
import { CLICKHOUSE, PRISMA, runQuery } from '@/lib/db';
import prisma from '@/lib/prisma';
import type { QueryFilters } from '@/lib/types';

const FUNCTION_NAME = 'getSessionActivity';

export async function getSessionActivity(
  ...args: [websiteId: string, sessionId: string, filters: QueryFilters]
) {
  return runQuery({
    [PRISMA]: () => relationalQuery(...args),
    [CLICKHOUSE]: () => clickhouseQuery(...args),
  });
}

async function relationalQuery(websiteId: string, sessionId: string, filters: QueryFilters) {
  const { rawQuery } = prisma;
  const { startDate, endDate } = filters;

  return rawQuery(
    `
    select
      created_at as "createdAt",
      url_path as "urlPath",
      url_query as "urlQuery",
      referrer_domain as "referrerDomain",
      event_id as "eventId",
      event_type as "eventType",
      event_name as "eventName",
      visit_id as "visitId",
      hostname,
      event_id IN (select website_event_id 
                   from event_data
                   where website_id = {{websiteId::uuid}}
                      and created_at between {{startDate}} and {{endDate}}) AS "hasData"
    from website_event
    where website_id = {{websiteId::uuid}}
      and session_id = {{sessionId::uuid}}
      and created_at between {{startDate}} and {{endDate}}
    order by created_at desc
    limit 500
    `,
    { websiteId, sessionId, startDate, endDate },
    FUNCTION_NAME,
  );
}

async function clickhouseQuery(websiteId: string, sessionId: string, filters: QueryFilters) {
  const { rawQuery } = clickhouse;
  const { startDate, endDate } = filters;

  return rawQuery(
    `
    WITH filtered_event_ids AS (
        SELECT DISTINCT event_id
        FROM event_data
        WHERE website_id = {websiteId:UUID}
          AND session_id = {sessionId:UUID}
          AND created_at BETWEEN {startDate:DateTime64} and {endDate:DateTime64}
    ),
    filtered_event_data AS (
    SELECT event_id, website_id, data_key, string_value, number_value, date_value
    FROM event_data
    WHERE website_id = {websiteId:UUID}
      AND session_id = {sessionId:UUID}
      AND created_at BETWEEN {startDate:DateTime64} and {endDate:DateTime64}
    )
    SELECT
        we.created_at AS createdAt,
        we.url_path AS urlPath,
        we.url_query AS urlQuery,
        we.referrer_domain AS referrerDomain,
        we.event_id AS eventId,
        we.event_type AS eventType,
        we.event_name AS eventName,
        we.visit_id AS visitId,
        we.hostname AS hostname,
        we.event_id IN (SELECT event_id FROM filtered_event_ids) AS hasData,
        groupArray(
        (
            'dataKey', ed.data_key,
            'stringValue', ed.string_value,
            'numberValue', ed.number_value,
            'dateValue', ed.date_value
        )
    ) AS eventData
    FROM website_event AS we
             LEFT JOIN filtered_event_data AS ed
                       ON we.event_id = ed.event_id
                           AND we.website_id = ed.website_id
                           AND we.event_name = 'profile_identified'
    WHERE we.website_id = {websiteId:UUID}
      AND we.session_id = {sessionId:UUID}
      AND we.created_at BETWEEN {startDate:DateTime64} and {endDate:DateTime64}
    GROUP BY
        we.created_at,
        we.url_path,
        we.url_query,
        we.referrer_domain,
        we.event_id,
        we.event_type,
        we.event_name,
        we.visit_id,
        we.hostname
    ORDER BY createdAt DESC
    LIMIT 500
    `,
    { websiteId, sessionId, startDate, endDate },
    FUNCTION_NAME,
  );
}
