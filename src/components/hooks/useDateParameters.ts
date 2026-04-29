import { useDateRange } from './useDateRange';
import { useTimezone } from './useTimezone';

export function useDateParameters() {
  const { timezone, toUtc, canonicalizeTimezone } = useTimezone();
  const {
    dateRange: { startDate, endDate, unit },
  } = useDateRange({ timezone });

  return {
    startAt: +toUtc(startDate),
    endAt: +toUtc(endDate),
    startDate: toUtc(startDate).toISOString(),
    endDate: toUtc(endDate).toISOString(),
    unit,
    timezone: canonicalizeTimezone(timezone),
  };
}
