import { startOfHour, startOfMonth } from 'date-fns';
import debug from 'debug';
import { isbot } from 'isbot';
import { serializeError } from 'serialize-error';
import { z } from 'zod';
import clickhouse from '@/lib/clickhouse';
import { COLLECTION_TYPE, EVENT_TYPE } from '@/lib/constants';
import { hash, secret, uuid } from '@/lib/crypto';
import { getClientInfo, hasBlockedIp } from '@/lib/detect';
import { createToken, parseToken } from '@/lib/jwt';
import { fetchWebsite } from '@/lib/load';
import { parseRequest } from '@/lib/request';
import { badRequest, forbidden, json, serverError } from '@/lib/response';
import { anyObjectParam, urlOrPathParam } from '@/lib/schema';
import { safeDecodeURI, safeDecodeURIComponent } from '@/lib/url';
import { createSession, saveEvent, saveSessionData } from '@/queries/sql';

const log = debug('umami:send');

interface Cache {
  websiteId: string;
  sessionId: string;
  visitId: string;
  iat: number;
}

const schema = z.object({
  type: z.enum(['event', 'identify']),
  payload: z
    .object({
      website: z.uuid().optional(),
      link: z.uuid().optional(),
      pixel: z.uuid().optional(),
      data: anyObjectParam.optional(),
      hostname: z.string().max(100).optional(),
      language: z.string().max(35).optional(),
      referrer: urlOrPathParam.optional(),
      screen: z.string().max(11).optional(),
      title: z.string().optional(),
      url: urlOrPathParam.optional(),
      name: z.string().max(50).optional(),
      tag: z.string().max(50).optional(),
      ip: z.string().optional(),
      userAgent: z.string().optional(),
      timestamp: z.coerce.number().int().optional(),
      id: z.string().optional(),
      browser: z.string().optional(),
      os: z.string().optional(),
      device: z.string().optional(),
      deviceModel: z.string().max(50).optional(),
      deviceBrand: z.string().max(50).optional(),
      osVersion: z.string().max(50).optional(),
      appVersion: z.string().max(50).optional(),
    })
    .refine(
      data => {
        const keys = [data.website, data.link, data.pixel];
        const count = keys.filter(Boolean).length;
        return count === 1;
      },
      {
        message: 'Exactly one of website, link, or pixel must be provided',
        path: ['website'],
      },
    ),
});

export async function POST(request: Request) {
  const startTime = Date.now();
  const timings: Record<string, number | boolean> = {};

  try {
    const parseStart = Date.now();
    const { body, error } = await parseRequest(request, schema, { skipAuth: true });
    timings.parseRequest = Date.now() - parseStart;

    if (error) {
      return error();
    }

    const { type, payload } = body;

    const {
      website: websiteId,
      pixel: pixelId,
      link: linkId,
      hostname,
      screen,
      language,
      url,
      referrer,
      name,
      data,
      title,
      tag,
      timestamp,
      id,
      deviceModel,
      deviceBrand,
      osVersion,
      appVersion,
    } = payload;

    const sourceId = websiteId || pixelId || linkId;

    // Cache check
    let cache: Cache | null = null;

    if (websiteId) {
      const cacheStart = Date.now();
      const cacheHeader = request.headers.get('x-umami-cache');

      if (cacheHeader) {
        const result = await parseToken(cacheHeader, secret());

        if (result) {
          cache = result;
        }
      }
      timings.parseToken = Date.now() - cacheStart;

      // Find website
      const fetchStart = Date.now();
      if (!cache?.websiteId) {
        const website = await fetchWebsite(websiteId);

        if (!website) {
          return badRequest({ message: 'Website not found.' });
        }
      } else {
        timings.fetchWebsiteSkipped = true;
      }
      timings.fetchWebsite = Date.now() - fetchStart;
    }

    // Client info
    const clientInfoStart = Date.now();
    const { ip, userAgent, device, browser, os, country, region, city } = await getClientInfo(
      request,
      payload,
    );
    timings.getClientInfo = Date.now() - clientInfoStart;

    // Bot check
    if (!process.env.DISABLE_BOT_CHECK && isbot(userAgent)) {
      return json({ beep: 'boop' });
    }

    // IP block
    if (hasBlockedIp(ip)) {
      return forbidden();
    }

    const createdAt = timestamp ? new Date(timestamp * 1000) : new Date();
    const now = Math.floor(Date.now() / 1000);

    const sessionSalt = hash(startOfMonth(createdAt).toUTCString());
    const visitSalt = hash(startOfHour(createdAt).toUTCString());

    const sessionId = id ? uuid(sourceId, id) : uuid(sourceId, ip, userAgent, sessionSalt);

    // Create a session if not found
    if (!clickhouse.enabled && !cache?.sessionId) {
      await createSession({
        id: sessionId,
        websiteId: sourceId,
        browser,
        os,
        device,
        screen,
        language,
        country,
        region,
        city,
        distinctId: id,
        createdAt,
      });
    }

    // Visit info
    let visitId = cache?.visitId || uuid(sessionId, visitSalt);
    let iat = cache?.iat || now;

    // Expire visit after 30 minutes
    if (!timestamp && now - iat > 1800) {
      visitId = uuid(sessionId, visitSalt);
      iat = now;
    }

    const eventDataCollector = (eventName = name) => {
      const base = hostname ? `https://${hostname}` : 'https://localhost';
      const currentUrl = new URL(url, base);

      let urlPath =
        currentUrl.pathname === '/undefined' ? '' : currentUrl.pathname + currentUrl.hash;
      const urlQuery = currentUrl.search.substring(1);
      const urlDomain = currentUrl.hostname.replace(/^www./, '');

      let referrerPath: string;
      let referrerQuery: string;
      let referrerDomain: string;

      // UTM Params
      const utmSource = currentUrl.searchParams.get('utm_source');
      const utmMedium = currentUrl.searchParams.get('utm_medium');
      const utmCampaign = currentUrl.searchParams.get('utm_campaign');
      const utmContent = currentUrl.searchParams.get('utm_content');
      const utmTerm = currentUrl.searchParams.get('utm_term');

      // Click IDs
      const gclid = currentUrl.searchParams.get('gclid');
      const fbclid = currentUrl.searchParams.get('fbclid');
      const msclkid = currentUrl.searchParams.get('msclkid');
      const ttclid = currentUrl.searchParams.get('ttclid');
      const lifatid = currentUrl.searchParams.get('li_fat_id');
      const twclid = currentUrl.searchParams.get('twclid');

      if (process.env.REMOVE_TRAILING_SLASH) {
        urlPath = urlPath.replace(/\/(?=(#.*)?$)/, '');
      }

      if (referrer) {
        const referrerUrl = new URL(referrer, base);

        referrerPath = referrerUrl.pathname;
        referrerQuery = referrerUrl.search.substring(1);
        referrerDomain = referrerUrl.hostname.replace(/^www\./, '');
      }

      const eventType = linkId
        ? EVENT_TYPE.linkEvent
        : pixelId
          ? EVENT_TYPE.pixelEvent
          : name
            ? EVENT_TYPE.customEvent
            : EVENT_TYPE.pageView;

      saveEvent({
        websiteId: sourceId,
        sessionId,
        visitId,
        eventType,
        createdAt,

        // Page
        pageTitle: safeDecodeURIComponent(title),
        hostname: hostname || urlDomain,
        urlPath: safeDecodeURI(urlPath),
        urlQuery,
        referrerPath: safeDecodeURI(referrerPath),
        referrerQuery,
        referrerDomain,

        // Session
        distinctId: id,
        browser,
        os,
        device,
        screen,
        language,
        country,
        region,
        city,

        // Events
        eventName: eventName,
        eventData: data,
        tag,

        // UTM
        utmSource,
        utmMedium,
        utmCampaign,
        utmContent,
        utmTerm,

        // Click IDs
        gclid,
        fbclid,
        msclkid,
        ttclid,
        lifatid,
        twclid,

        // Mobile specific
        deviceModel,
        deviceBrand,
        osVersion,
        appVersion,
      });
    };

    if (type === COLLECTION_TYPE.event) {
      eventDataCollector();
    }

    if (type === COLLECTION_TYPE.identify) {
      if (data) {
        saveSessionData({
          websiteId,
          sessionId,
          sessionData: data,
          distinctId: id,
          createdAt,
        });
        eventDataCollector(`profile_identified`);
      }
    }

    const token = createToken({ websiteId, sessionId, visitId, iat }, secret());

    timings.total = Date.now() - startTime;

    // Log performance metrics
    log('[PERFORMANCE]', {
      type,
      cached: !!cache,
      timings: JSON.stringify(timings),
    });

    return json({ cache: token, sessionId, visitId });
  } catch (e) {
    const error = serializeError(e);

    // eslint-disable-next-line no-console
    console.log(error);

    return serverError({ errorObject: error });
  }
}
