import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createEvent, deleteEvent, PLANNER_UID_PREFIX, updateEvent } from '../_lib/caldav.js';
import { decrypt } from '../_lib/crypto.js';
import { caldavErrorResponse, calendarRoute, jsonResponse } from '../_lib/http.js';
import { byteaToBuffer, getSettings } from '../_lib/supabase.js';

// One file, method-dispatched (Vercel file routing — no `[uid].ts`):
//   POST   /api/calendar/events            create  → { ok, uid }
//   PATCH  /api/calendar/events            rebuild → { ok }
//   DELETE /api/calendar/events?uid=…      remove  → { ok, missing? }
// Planner blocks (chunk 39) create with `source: 'planner'`, which tags the
// uid with PLANNER_UID_PREFIX so `busy` can keep the mirror out of intervals.

// No path characters: the uid becomes `<calendarUrl><uid>.ics`.
const Uid = z.string().regex(/^[A-Za-z0-9-]{1,80}$/);

const CreateBody = z.object({
  title: z.string().min(1),
  start: z.string().min(1),
  end: z.string().min(1),
  description: z.string().optional(),
  source: z.literal('planner').optional(),
});

const UpdateBody = z.object({
  uid: Uid,
  title: z.string().min(1),
  start: z.string().min(1),
  end: z.string().min(1),
  description: z.string().optional(),
});

const DEFAULT_PLANNER_DESCRIPTION = 'Planned in Hupomnemata';

type Action =
  | { kind: 'create'; data: z.infer<typeof CreateBody> }
  | { kind: 'update'; data: z.infer<typeof UpdateBody> }
  | { kind: 'delete'; uid: string };

/** Method + body/query → a validated action, or null on a bad request. */
async function parseAction(req: Request): Promise<Action | null> {
  if (req.method === 'DELETE') {
    const uid = Uid.safeParse(new URL(req.url).searchParams.get('uid'));
    return uid.success ? { kind: 'delete', uid: uid.data } : null;
  }
  const raw = await req.json().catch(() => null);
  if (req.method === 'POST') {
    const parsed = CreateBody.safeParse(raw);
    return parsed.success ? { kind: 'create', data: parsed.data } : null;
  }
  const parsed = UpdateBody.safeParse(raw);
  return parsed.success ? { kind: 'update', data: parsed.data } : null;
}

export default {
  fetch: calendarRoute(async (req, userId) => {
    if (req.method !== 'POST' && req.method !== 'PATCH' && req.method !== 'DELETE') {
      return jsonResponse(req, 405, { ok: false, error: 'method_not_allowed' });
    }

    // Validate before touching credentials so a bad request never costs a
    // settings read or a decrypt.
    const action = await parseAction(req);
    if (!action) {
      return jsonResponse(req, 400, { ok: false, error: 'invalid_request' });
    }

    const settings = await getSettings(userId);
    if (
      !settings?.caldav_apple_id ||
      !settings.caldav_app_password_encrypted ||
      !settings.caldav_calendar_url
    ) {
      return jsonResponse(req, 412, { ok: false, error: 'no_credentials' });
    }
    const calendarUrl = settings.caldav_calendar_url;
    const appleId = settings.caldav_apple_id;
    const password = await decrypt(byteaToBuffer(settings.caldav_app_password_encrypted));

    try {
      switch (action.kind) {
        case 'create': {
          const planner = action.data.source === 'planner';
          const uid = planner ? `${PLANNER_UID_PREFIX}${randomUUID()}` : randomUUID();
          await createEvent(calendarUrl, appleId, password, {
            title: action.data.title,
            start: action.data.start,
            end: action.data.end,
            description:
              action.data.description ?? (planner ? DEFAULT_PLANNER_DESCRIPTION : undefined),
            uid,
          });
          return jsonResponse(req, 200, { ok: true, uid });
        }
        case 'update': {
          await updateEvent(calendarUrl, appleId, password, {
            title: action.data.title,
            start: action.data.start,
            end: action.data.end,
            description: action.data.description,
            uid: action.data.uid,
          });
          return jsonResponse(req, 200, { ok: true });
        }
        case 'delete': {
          const { missing } = await deleteEvent(calendarUrl, appleId, password, action.uid);
          return jsonResponse(req, 200, missing ? { ok: true, missing: true } : { ok: true });
        }
      }
    } catch (err) {
      return caldavErrorResponse(req, userId, err);
    }
  }),
};
