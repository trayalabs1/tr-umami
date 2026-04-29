import { z } from 'zod';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { json, unauthorized } from '@/lib/response';
import { canViewWebsite } from '@/permissions';
import { getSessionActivity } from '@/queries/sql';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string; sessionId: string }> },
) {
  const schema = z.object({
    startAt: z.coerce.number().int(),
    endAt: z.coerce.number().int(),
  });

  const { auth, query, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { websiteId, sessionId } = await params;

  if (!(await canViewWebsite(auth, websiteId))) {
    return unauthorized();
  }

  const filters = await getQueryFilters(query, websiteId);

  const data = await getSessionActivity(websiteId, sessionId, filters);
  const parsedData = data.map(event => ({
    ...event,
    eventData: event.eventData.map(([, dataKey, , stringValue, , numberValue, , dateValue]) => ({
      dataKey,
      stringValue,
      numberValue,
      dateValue,
    })),
  }));
  for (const event of parsedData) {
    if (event.eventName === 'profile_identified') {
      const caseId = event.eventData.find(data => data.dataKey === 'caseId')?.stringValue;
      const phNo = event.eventData.find(data => data.dataKey === 'phone_number')?.stringValue;
      event.eventName = `profile_identified_${caseId || ''}_${phNo ? '****' + phNo.slice(-4) : ''}`;
    }
    delete event.eventData;
  }

  return json(parsedData);
}
