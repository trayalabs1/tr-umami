import clickhouse from '@/lib/clickhouse';
import { CLICKHOUSE, PRISMA, runQuery } from '@/lib/db';
import prisma from '@/lib/prisma';
import type { QueryFilters } from '@/lib/types';

export interface FunnelParameters {
  startDate: Date;
  endDate: Date;
  window: number;
  steps: { type: string; value: string }[];
}

export interface FunnelResult {
  value: string;
  visitors: number;
  dropoff: number;
}

export async function getFunnel(
  ...args: [websiteId: string, parameters: FunnelParameters, filters: QueryFilters]
) {
  return runQuery({
    [PRISMA]: () => relationalQuery(...args),
    [CLICKHOUSE]: () => clickhouseQuery(...args),
  });
}

async function relationalQuery(
  websiteId: string,
  parameters: FunnelParameters,
  filters: QueryFilters,
): Promise<FunnelResult[]> {
  const { startDate, endDate, window, steps } = parameters;
  const { rawQuery, getAddIntervalQuery, parseFilters } = prisma;
  const { filterQuery, joinSessionQuery, cohortQuery, queryParams } = parseFilters({
    ...filters,
    websiteId,
    startDate,
    endDate,
  });
  const { levelOneQuery, levelQuery, sumQuery, params } = getFunnelQuery(steps, window);

  function getFunnelQuery(
    steps: { type: string; value: string }[],
    window: number,
  ): {
    levelOneQuery: string;
    levelQuery: string;
    sumQuery: string;
    params: string[];
  } {
    return steps.reduce(
      (pv, cv, i) => {
        const levelNumber = i + 1;
        const startSum = i > 0 ? 'union ' : '';
        const isURL = cv.type === 'path';
        const column = isURL ? 'url_path' : 'event_name';

        let operator = '=';
        let paramValue = cv.value;

        if (cv.value.startsWith('*') || cv.value.endsWith('*')) {
          operator = 'like';
          paramValue = cv.value.replace(/^\*|\*$/g, '%');
        }

        if (levelNumber === 1) {
          pv.levelOneQuery = `
          WITH level1 AS (
            select distinct website_event.session_id, website_event.created_at
            from website_event
            ${cohortQuery}
            ${joinSessionQuery}
            where website_event.website_id = {{websiteId::uuid}}
              and website_event.created_at between {{startDate}} and {{endDate}}
              and ${column} ${operator} {{${i}}}
              ${filterQuery}
          )`;
        } else {
          pv.levelQuery += `
          , level${levelNumber} AS (
            select distinct we.session_id, we.created_at
            from level${i} l
            join website_event we
                on l.session_id = we.session_id
            where we.website_id = {{websiteId::uuid}}
                and we.created_at between l.created_at and ${getAddIntervalQuery(
                  `l.created_at `,
                  `${window} minute`,
                )}
                and we.${column} ${operator} {{${i}}}
                and we.created_at <= {{endDate}}
          )`;
        }

        pv.sumQuery += `\n${startSum}select ${levelNumber} as level, count(distinct(session_id)) as count from level${levelNumber}`;
        pv.params.push(paramValue);

        return pv;
      },
      {
        levelOneQuery: '',
        levelQuery: '',
        sumQuery: '',
        params: [],
      },
    );
  }

  return rawQuery(
    `
    ${levelOneQuery}
    ${levelQuery}
    ${sumQuery}
    ORDER BY level;
    `,
    {
      ...params,
      ...queryParams,
    },
  ).then(formatResults(steps));
}

async function clickhouseQuery(
  websiteId: string,
  parameters: FunnelParameters,
  filters: QueryFilters,
): Promise<
  {
    value: string;
    visitors: number;
    dropoff: number;
  }[]
> {
  const { startDate, endDate, window, steps } = parameters;
  const { rawQuery, parseFilters } = clickhouse;
  const { filterQuery, cohortQuery, queryParams } = parseFilters({
    ...filters,
    websiteId,
    startDate,
    endDate,
  });

  const windowSeconds = window * 60;
  const stepConditions: string[] = [];
  const stepFilterParts: string[] = [];
  const params: Record<string, string> = {};

  steps.forEach((step, i) => {
    const isURL = step.type === 'path';
    const column = isURL ? 'url_path' : 'event_name';

    let operator = '=';
    let paramValue = step.value;

    if (step.value.startsWith('*') || step.value.endsWith('*')) {
      operator = 'like';
      paramValue = step.value.replace(/^\*|\*$/g, '%');
    }

    stepConditions.push(`${column} ${operator} {param${i}:String}`);
    stepFilterParts.push(`${column} ${operator} {param${i}:String}`);
    params[`param${i}`] = paramValue;
  });

  const conditionsSQL = stepConditions.join(', ');
  const stepFilterQuery = stepFilterParts.join(' or ');

  return rawQuery(
    `
    SELECT
        level,
        count() AS count
    FROM (
        SELECT
            session_id,
            windowFunnel(${windowSeconds})(created_at, ${conditionsSQL}) AS max_level
        FROM website_event
        ${cohortQuery}
        WHERE website_id = {websiteId:UUID}
          AND created_at BETWEEN {startDate:DateTime64} AND {endDate:DateTime64}
          AND (${stepFilterQuery})
          ${filterQuery}
        GROUP BY session_id
        HAVING max_level > 0
    )
    ARRAY JOIN arrayMap(i -> i + 1, range(max_level)) AS level
    GROUP BY level
    ORDER BY level ASC;
    `,
    {
      ...params,
      ...queryParams,
    },
  ).then(formatResults(steps));
}

const formatResults = (steps: { type: string; value: string }[]) => (results: unknown) => {
  return steps.map((step: { type: string; value: string }, i: number) => {
    const visitors = Number(results[i]?.count) || 0;
    const previous = Number(results[i - 1]?.count) || 0;
    const dropped = previous > 0 ? previous - visitors : 0;
    const dropoff = 1 - visitors / previous;
    const firstCount = Number(results[0]?.count) || 0;
    const remaining = firstCount > 0 ? visitors / firstCount : 0;

    return {
      ...step,
      visitors,
      previous,
      dropped,
      dropoff,
      remaining,
    };
  });
};
