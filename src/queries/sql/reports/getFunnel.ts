import clickhouse from '@/lib/clickhouse';
import { CLICKHOUSE, PRISMA, runQuery } from '@/lib/db';
import prisma from '@/lib/prisma';
import type { QueryFilters } from '@/lib/types';

export interface FunnelStepFilter {
  property: string;
  operator: string;
  value: string;
}

export interface FunnelStep {
  type: string;
  value: string;
  filters?: Array<FunnelStepFilter>;
}

export interface FunnelParameters {
  startDate: Date;
  endDate: Date;
  window: number;
  steps: Array<FunnelStep>;
}

export interface FunnelResult extends FunnelStep {
  visitors: number;
  previous: number;
  dropped: number;
  dropoff: number;
  remaining: number;
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
): Promise<Array<FunnelResult>> {
  const { startDate, endDate, window, steps } = parameters;
  const { rawQuery, getAddIntervalQuery, parseFilters } = prisma;
  const { filterQuery, joinSessionQuery, cohortQuery, queryParams } = parseFilters({
    ...filters,
    websiteId,
    startDate,
    endDate,
  });
  const { levelOneQuery, levelQuery, sumQuery, params } = getFunnelQuery(steps, window);

  function buildExistsFilters(
    stepIndex: number,
    stepFilters: Array<FunnelStepFilter> | undefined,
    eventAlias: string,
    extraParams: Record<string, string>,
  ): string {
    if (!stepFilters?.length) return '';

    return stepFilters
      .map((f, fi) => {
        const keyParam = `f_${stepIndex}_${fi}_k`;
        const valParam = `f_${stepIndex}_${fi}_v`;
        extraParams[keyParam] = f.property;

        let op = '=';
        let val = f.value;
        if (f.operator === 'neq') op = '!=';
        else if (f.operator === 'c') {
          op = 'ilike';
          val = `%${val}%`;
        } else if (f.operator === 'dnc') {
          op = 'not ilike';
          val = `%${val}%`;
        }
        extraParams[valParam] = val;

        return `and exists (
          select 1 from event_data _ed${stepIndex}_${fi}
          where _ed${stepIndex}_${fi}.website_event_id = ${eventAlias}.event_id
            and _ed${stepIndex}_${fi}.website_id = {{websiteId::uuid}}
            and _ed${stepIndex}_${fi}.created_at between {{startDate}} and {{endDate}}
            and _ed${stepIndex}_${fi}.data_key = {{${keyParam}}}
            and case when _ed${stepIndex}_${fi}.data_type = 2 then replace(_ed${stepIndex}_${fi}.string_value, '.0000', '') else _ed${stepIndex}_${fi}.string_value end ${op} {{${valParam}}}
        )`;
      })
      .join('\n');
  }

  function getFunnelQuery(
    steps: Array<FunnelStep>,
    window: number,
  ): {
    levelOneQuery: string;
    levelQuery: string;
    sumQuery: string;
    params: Record<string, string>;
  } {
    const extraParams: Record<string, string> = {};

    const result = steps.reduce(
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

        const existsClause =
          !isURL && cv.filters?.length
            ? buildExistsFilters(
                i,
                cv.filters,
                levelNumber === 1 ? 'website_event' : 'we',
                extraParams,
              )
            : '';

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
              ${existsClause}
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
                ${existsClause}
          )`;
        }

        pv.sumQuery += `\n${startSum}select ${levelNumber} as level, count(distinct(session_id)) as count from level${levelNumber}`;
        pv.params[i] = paramValue;

        return pv;
      },
      {
        levelOneQuery: '',
        levelQuery: '',
        sumQuery: '',
        params: {} as Record<string, string>,
      },
    );

    return { ...result, params: { ...result.params, ...extraParams } };
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
): Promise<Array<FunnelResult>> {
  const { startDate, endDate, window, steps } = parameters;
  const { rawQuery, parseFilters } = clickhouse;
  const { filterQuery, cohortQuery, queryParams } = parseFilters({
    ...filters,
    websiteId,
    startDate,
    endDate,
  });

  function buildEventDataFilters(
    stepIndex: number,
    stepFilters: Array<FunnelStepFilter> | undefined,
    params: Record<string, string>,
  ): string {
    if (!stepFilters?.length) return '';

    return stepFilters
      .map((f, fi) => {
        const keyParam = `f_${stepIndex}_${fi}_k`;
        const valParam = `f_${stepIndex}_${fi}_v`;
        params[keyParam] = f.property;

        let op = '=';
        let val = f.value;
        if (f.operator === 'neq') op = '!=';
        else if (f.operator === 'c') {
          op = 'like';
          val = `%${val}%`;
        } else if (f.operator === 'dnc') {
          op = 'not like';
          val = `%${val}%`;
        }
        params[valParam] = val;

        return `and event_id in (
          select event_id from event_data
          where website_id = {websiteId:UUID}
            and created_at between {startDate:DateTime64} and {endDate:DateTime64}
            and data_key = {${keyParam}:String}
            and multiIf(data_type = 2, replaceAll(string_value, '.0000', ''), string_value) ${op} {${valParam}:String}
        )`;
      })
      .join(' ');
  }

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

    const eventDataClause =
      !isURL && step.filters?.length ? buildEventDataFilters(i, step.filters, params) : '';

    const baseCond = `${column} ${operator} {param${i}:String}`;
    const fullCond = eventDataClause
      ? `(${baseCond} ${eventDataClause.replace(/^and /, 'and ')})`
      : baseCond;

    stepConditions.push(fullCond);
    stepFilterParts.push(baseCond);
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

const formatResults = (steps: Array<FunnelStep>) => (results: unknown) => {
  return steps.map((step: FunnelStep, i: number) => {
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
