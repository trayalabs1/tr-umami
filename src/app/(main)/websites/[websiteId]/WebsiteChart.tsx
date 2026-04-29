import { Column, Row } from '@umami/react-zen';
import { useMemo } from 'react';
import { LoadingPanel } from '@/components/common/LoadingPanel';
import { useDateRange, useLocale, useTimezone } from '@/components/hooks';
import { useWebsitePageviewsQuery } from '@/components/hooks/queries/useWebsitePageviewsQuery';
import { DownloadButton } from '@/components/input/DownloadButton';
import { PageviewsChart } from '@/components/metrics/PageviewsChart';
import { generateTimeSeries } from '@/lib/date';

export function WebsiteChart({
  websiteId,
  compareMode,
}: {
  websiteId: string;
  compareMode?: boolean;
}) {
  const { timezone } = useTimezone();
  const { dateRange, dateCompare } = useDateRange({ timezone: timezone });
  const { startDate, endDate, unit, value } = dateRange;
  const { dateLocale } = useLocale();
  const { data, isLoading, isFetching, error } = useWebsitePageviewsQuery({
    websiteId,
    compare: compareMode ? dateCompare?.compare : undefined,
  });
  const { pageviews, sessions, compare } = (data || {}) as any;

  const chartData = useMemo(() => {
    if (!data) {
      return { pageviews: [], sessions: [] };
    }

    return {
      pageviews,
      sessions,
      ...(compare && {
        compare: {
          pageviews: pageviews.map(({ x }, i) => ({
            x,
            y: compare.pageviews[i]?.y,
            d: compare.pageviews[i]?.x,
          })),
          sessions: sessions.map(({ x }, i) => ({
            x,
            y: compare.sessions[i]?.y,
            d: compare.sessions[i]?.x,
          })),
        },
      }),
    };
  }, [data, startDate, endDate, unit]);

  const csvData = useMemo(() => {
    if (!pageviews || !sessions) return [];
    const visitorsTS = generateTimeSeries(sessions, startDate, endDate, unit, dateLocale);
    const viewsTS = generateTimeSeries(pageviews, startDate, endDate, unit, dateLocale);
    return visitorsTS.map(({ x, y }, i) => ({
      time: x,
      visitors: y ?? 0,
      views: viewsTS[i]?.y ?? 0,
    }));
  }, [pageviews, sessions, startDate, endDate, unit, dateLocale]);

  return (
    <Column gap="2">
      <Row justifyContent="flex-end">
        <DownloadButton filename="overview" data={csvData} />
      </Row>
      <LoadingPanel data={data} isFetching={isFetching} isLoading={isLoading} error={error}>
        <PageviewsChart
          key={value}
          data={chartData}
          minDate={startDate}
          maxDate={endDate}
          unit={unit}
        />
      </LoadingPanel>
    </Column>
  );
}
