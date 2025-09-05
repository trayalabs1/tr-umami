import { z } from 'zod';
import { parseRequest } from '@/lib/request';
import { unauthorized, json } from '@/lib/response';
import { canViewWebsite } from '@/lib/auth';
import { getSessionActivity } from '@/queries';

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
  const { startAt, endAt } = query;

  if (!(await canViewWebsite(auth, websiteId))) {
    return unauthorized();
  }

  const startDate = new Date(+startAt);
  const endDate = new Date(+endAt);

  const data = await getSessionActivity(websiteId, sessionId, startDate, endDate);
  const parsedData = data.map(event => ({
    ...event,
    eventData: event.eventData.map(([, dataKey, , stringValue, , numberValue, , dateValue]) => ({
      dataKey,
      stringValue,
      numberValue,
      dateValue,
    })),
  }));
  // const profileIdentifyEventIds: string[] = [];
  for (const event of parsedData) {
    if (event.eventName === 'profile_identified') {
      const caseId = event.eventData.find(data => data.dataKey === 'caseId')?.stringValue;
      const phNo = event.eventData.find(data => data.dataKey === 'phone_number')?.stringValue;
      event.eventName = `profile_identify_${caseId || ''}_${phNo ? '****' + phNo.slice(-4) : ''}`;
    }
    delete event.eventData;
  }

  return json(parsedData);
}
