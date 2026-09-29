/**
 * @module routes/voice
 * @description Authenticated `/api/voice/*` routes for the AI Voice + SMS feature.
 *
 * Every route enforces: bearer auth (`userId`/`orgId`), org membership of the
 * target site, a 3-numbers-per-site purchase cap, and a graceful 501 when
 * `TWILIO_AUTH_TOKEN` is missing.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env, Variables } from '../types/env.js';
import { dbQueryOne, dbQuery, dbInsert, dbUpdate } from '../services/db.js';
import {
  isTwilioConfigured,
  searchAvailableNumbers,
  purchaseNumber,
  releaseNumber,
  formatVanity,
  letterToDigit,
} from '../services/twilio.js';
import { suggestVanityWords, type VanityBusinessProfile } from '../services/vanity_generator.js';
import { simulateInbound } from '../services/sms_agent.js';
import * as auditService from '../services/audit.js';
import { PROMPT_META } from '../services/voice_agent.js';
import { requireOrgFlag } from '../lib/feature_guard.js';
import {
  AppError,
  unauthorized,
  notFound,
  badRequest,
  conflict,
  internalError,
} from '@project-sites/shared';

export const voiceRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * `GET /api/voice/meta-prompt` — the immutable voice-agent safety meta-prompt
 * (the 10 non-negotiable rules every agent obeys). Read-only; the admin agent-
 * settings panel renders it as the "immutable safety meta-prompt".
 *
 * @returns `{ data: { text: string } }` — the meta-prompt template (with
 *   `{{BUSINESS_NAME}}` / `{{BUSINESS_LOCATION}}` placeholders, as stored).
 */
voiceRoutes.get('/api/voice/meta-prompt', (c) => c.json({ data: { text: PROMPT_META } }));

function publicHost(env: Env): string {
  return env.ENVIRONMENT === 'production'
    ? 'projectsites.dev'
    : 'project-sites.manhattan.workers.dev';
}

function notConfigured(): AppError {
  return new AppError({
    code: 'SERVICE_UNAVAILABLE',
    message: 'TWILIO_NOT_CONFIGURED: set TWILIO_AUTH_TOKEN via `wrangler secret put`',
    statusCode: 501,
  });
}

/**
 * Resolve a site the caller's org owns.
 *
 * @remarks Multi-tenant isolation — a missing site AND a foreign-org site both
 * throw `notFound()` (404), never `forbidden()` (403), so a prober can't use the
 * status code as an existence oracle ("this site exists but isn't yours").
 * @param env    - Worker env (D1 binding).
 * @param siteId - the site id from the request.
 * @param orgId  - the caller's org (from the authenticated context).
 * @returns the owned site row (id + org_id + business name/address).
 * @throws {AppError} `notFound` (404) when the site is missing or not owned by `orgId`.
 */
async function requireSiteMembership(
  env: Env,
  siteId: string,
  orgId: string,
): Promise<{
  id: string;
  org_id: string;
  business_name: string | null;
  business_address: string | null;
}> {
  const site = await dbQueryOne<{
    id: string;
    org_id: string;
    business_name: string | null;
    business_address: string | null;
  }>(
    env.DB,
    `SELECT id, org_id, business_name, business_address
       FROM sites WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    [siteId],
  );
  // 404 for both missing AND foreign-org (never 403 — don't leak that the site exists).
  if (!site || site.org_id !== orgId) throw notFound('Site not found');
  return site;
}

function requireAuth(c: { get: (k: string) => string | undefined }): {
  userId: string;
  orgId: string;
} {
  const userId = c.get('userId');
  const orgId = c.get('orgId');
  if (!userId || !orgId) throw unauthorized();
  return { userId, orgId };
}

const searchQuery = z.object({
  contains: z.string().min(1).max(20).optional(),
  areaCode: z
    .string()
    .regex(/^\d{3}$/)
    .optional(),
  country: z.string().length(2).optional(),
  limit: z.coerce.number().int().min(1).max(30).optional(),
});

/**
 * `GET /api/voice/numbers/search?contains=&areaCode=&country=&limit=` —
 * search available Twilio phone numbers.
 *
 * @throws 400 BAD_REQUEST when query validation fails.
 * @throws 401 UNAUTHORIZED when auth context is missing.
 * @throws 501 NOT_IMPLEMENTED when Twilio isn't configured on this worker.
 */
voiceRoutes.get('/api/voice/numbers/search', async (c) => {
  requireAuth(c);
  if (!isTwilioConfigured(c.env)) throw notConfigured();
  const q = searchQuery.parse(Object.fromEntries(new URL(c.req.url).searchParams));
  const numbers = await searchAvailableNumbers(c.env, {
    country: q.country ?? 'US',
    areaCode: q.areaCode,
    contains: q.contains,
    limit: q.limit ?? 20,
  });
  // Annotate each with the vanity-rendered display IF a `contains` word was provided.
  const annotated = numbers.map((n) => ({
    ...n,
    vanity_display:
      q.contains && /[A-Za-z]/.test(q.contains)
        ? formatVanity(n.phone_number, q.contains.toUpperCase())
        : null,
    contains_digits: q.contains ? letterToDigit(q.contains) : null,
  }));
  return c.json({ numbers: annotated, total: annotated.length });
});

/**
 * `GET /api/voice/vanity-suggestions?site_id=` — AI-suggested vanity-number
 * dial words for a site (e.g., 1-800-FLOWERS).
 *
 * @throws 401 UNAUTHORIZED when auth context is missing.
 * @throws 404 NOT_FOUND when site isn't in the caller's org (never 403 — don't leak existence).
 * @throws 404 NOT_FOUND when site doesn't exist.
 */
voiceRoutes.get('/api/voice/vanity-suggestions', async (c) => {
  const { orgId } = requireAuth(c);
  const siteId = c.req.query('siteId');
  if (!siteId) throw badRequest('siteId required');
  const site = await requireSiteMembership(c.env, siteId, orgId);

  const profile: VanityBusinessProfile = {
    businessName: site.business_name ?? 'business',
    location: site.business_address ?? undefined,
  };
  const result = await suggestVanityWords(c.env, { siteId, businessProfile: profile });
  return c.json(result);
});

const purchaseBody = z.object({
  siteId: z.string().min(1),
  phoneNumber: z.string().regex(/^\+\d{8,15}$/, 'Must be E.164'),
  friendlyName: z.string().max(64).optional(),
  vanityWord: z
    .string()
    .regex(/^[A-Za-z]{3,7}$/)
    .optional(),
});

/**
 * `POST /api/voice/numbers/purchase` — buy a Twilio phone number for a site.
 * Enforces the 3-numbers-per-site cap and wires Twilio webhooks to
 * `/webhooks/sms/*` on the public host. Audit-logged.
 *
 * @throws 400 BAD_REQUEST when payload missing required fields.
 * @throws 401 UNAUTHORIZED when auth context is missing.
 * @throws 404 NOT_FOUND when site isn't in the caller's org (never 403 — don't leak existence).
 * @throws 404 NOT_FOUND when site doesn't exist.
 * @throws 404 NOT_FOUND when the `voice_numbers` killswitch flag is OFF (default) —
 *   the flag gates this money-spending carrier purchase, so OFF = no buy, and we
 *   404 (never 403) so the feature's existence isn't leaked.
 * @throws 409 CONFLICT when site already owns 3 numbers.
 * @throws 501 NOT_IMPLEMENTED when Twilio isn't configured on this worker.
 */
voiceRoutes.post('/api/voice/numbers/purchase', async (c) => {
  // KILLSWITCH FIRST — this handler spends real carrier money. `voice_numbers` is
  // default-OFF, so an accidental/orphan purchase can never fire without an explicit
  // flag flip. The gate runs BEFORE auth/Twilio/DB so OFF is a hard, fail-safe 404.
  const gate = await requireOrgFlag(c, 'voice_numbers');
  if (gate instanceof Response) return gate;
  const { userId, orgId } = gate;
  if (!isTwilioConfigured(c.env)) throw notConfigured();
  const body = purchaseBody.parse(await c.req.json().catch(() => ({})));
  await requireSiteMembership(c.env, body.siteId, orgId);

  const existing = await dbQuery<{ id: string }>(
    c.env.DB,
    `SELECT id FROM voice_numbers
       WHERE site_id = ? AND status = 'active' AND deleted_at IS NULL`,
    [body.siteId],
  );
  if (existing.data.length >= 3) {
    throw conflict('Per-site cap reached (3 active numbers).');
  }

  const host = publicHost(c.env);
  // Voice routing moves to LiveKit SIP (see docs/decisions/voice-architecture.md);
  // the number carries no Twilio VoiceUrl until the SIP trunk is wired (slice 3).
  const smsUrl = `https://${host}/webhooks/sms/inbound`;

  const purchased = await purchaseNumber(c.env, {
    phoneNumber: body.phoneNumber,
    smsUrl,
    friendlyName: body.friendlyName ?? body.phoneNumber,
  });

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const { error: numErr } = await dbInsert(c.env.DB, 'voice_numbers', {
    id,
    site_id: body.siteId,
    org_id: orgId,
    phone_number: purchased.phone_number,
    friendly_name: purchased.friendly_name,
    vanity_display: body.vanityWord ? formatVanity(purchased.phone_number, body.vanityWord) : null,
    twilio_sid: purchased.sid,
    capabilities: JSON.stringify(purchased.capabilities),
    voice_url: null,
    sms_url: smsUrl,
    monthly_cost_cents: 100,
    purchased_at: now,
    status: 'active',
  });
  // PRIMARY durable record — the number the user just paid Twilio for. A silent
  // drop = paid-but-invisible number (lying-success). Surface it so support can
  // reconcile the Twilio purchase against the missing D1 row.
  if (numErr) {
    // Compensating action (B0): the number was bought from Twilio but the durable
    // D1 record failed — release the carrier line so the org is never billed for an
    // orphaned number that exists nowhere in our system. Best-effort; log both sides.
    let released = false;
    try {
      await releaseNumber(c.env, purchased.sid);
      released = true;
    } catch (releaseErr) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          service: 'voice',
          message: 'voice_number_compensation_release_failed',
          twilio_sid: purchased.sid,
          error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
        }),
      );
    }
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'voice',
        message: 'voice_numbers_insert_failed',
        id,
        org_id: orgId,
        twilio_sid: purchased.sid,
        compensated: released,
        error: numErr,
      }),
    );
    return c.json(
      {
        error: {
          code: 'INTERNAL_ERROR',
          message: released
            ? 'The number could not be saved and was safely released — no charge. Please try again.'
            : 'The number was purchased but could not be saved. Contact support with this ID.',
          id,
        },
      },
      500,
    );
  }

  await auditService.writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: userId,
    action: 'voice.number_purchased',
    message: `Purchased ${purchased.phone_number} for site ${body.siteId}`,
    target_type: 'voice_number',
    target_id: id,
    metadata_json: {
      site_id: body.siteId,
      phone_number: purchased.phone_number,
      twilio_sid: purchased.sid,
      vanity_word: body.vanityWord ?? null,
    },
    request_id: c.get('requestId'),
  });

  return c.json({
    id,
    site_id: body.siteId,
    phone_number: purchased.phone_number,
    vanity_display: body.vanityWord ? formatVanity(purchased.phone_number, body.vanityWord) : null,
    twilio_sid: purchased.sid,
    capabilities: purchased.capabilities,
    monthly_cost_cents: 100,
    status: 'active',
  });
});

/**
 * `GET /api/voice/numbers?site_id=` — list phone numbers owned by a site.
 *
 * @throws 401 UNAUTHORIZED when auth context is missing.
 * @throws 404 NOT_FOUND when site isn't in the caller's org (never 403 — don't leak existence).
 * @throws 404 NOT_FOUND when site doesn't exist.
 */
voiceRoutes.get('/api/voice/numbers', async (c) => {
  const { orgId } = requireAuth(c);
  const siteId = c.req.query('siteId');
  if (!siteId) throw badRequest('siteId required');
  await requireSiteMembership(c.env, siteId, orgId);
  const rows = await dbQuery<Record<string, unknown>>(
    c.env.DB,
    `SELECT id, site_id, phone_number, friendly_name, vanity_display, twilio_sid,
            capabilities, monthly_cost_cents, purchased_at, released_at, status,
            created_at, updated_at
       FROM voice_numbers
       WHERE site_id = ? AND deleted_at IS NULL
       ORDER BY created_at DESC`,
    [siteId],
  );
  // Map D1 rows → the SPA contract. `capabilities` is stored as a JSON STRING
  // (or NULL for numbers purchased before capture) and cost lives in cents — but
  // the numbers list expects a {voice,sms,mms} OBJECT + `monthly_cost_usd`.
  // Returning the raw row meant `capabilities: null` → the template's `.voice`
  // read did `null.voice` → TypeError that crashed the ENTIRE Voice section. Normalize.
  const numbers = (rows.data ?? []).map((r) => {
    // Default for a purchased US local number (voice + SMS; MMS carrier-varies).
    let caps = { voice: true, sms: true, mms: false };
    const raw = r['capabilities'];
    if (raw != null) {
      try {
        const p = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
        caps = { voice: !!p?.['voice'], sms: !!p?.['sms'], mms: !!p?.['mms'] };
      } catch {
        // malformed JSON → keep the sane default
      }
    }
    return {
      id: r['id'],
      phone_number: r['phone_number'],
      friendly_name: r['friendly_name'] ?? null,
      vanity_display: r['vanity_display'] ?? null,
      capabilities: caps,
      monthly_cost_usd: Number(r['monthly_cost_cents'] ?? 0) / 100,
      purchased_at: r['purchased_at'],
      status: r['status'],
    };
  });
  return c.json({ numbers });
});

/**
 * `DELETE /api/voice/numbers/:id` — release a phone number back to Twilio and
 * remove it from the site. Audit-logged.
 *
 * @throws 401 UNAUTHORIZED when auth context is missing.
 * @throws 404 NOT_FOUND when the number is missing OR isn't in the caller's org (never 403 — don't leak existence).
 * @throws 501 NOT_IMPLEMENTED when Twilio isn't configured on this worker.
 */
voiceRoutes.delete('/api/voice/numbers/:id', async (c) => {
  const { userId, orgId } = requireAuth(c);
  const id = c.req.param('id');
  if (!id) throw badRequest('id required');
  const row = await dbQueryOne<{
    id: string;
    org_id: string;
    twilio_sid: string | null;
    phone_number: string;
  }>(
    c.env.DB,
    `SELECT id, org_id, twilio_sid, phone_number FROM voice_numbers
       WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    [id],
  );
  // 404 for both missing AND foreign-org (never 403 — don't leak that the number exists).
  if (!row || row.org_id !== orgId) throw notFound('Number not found');
  if (!isTwilioConfigured(c.env)) throw notConfigured();

  if (row.twilio_sid) {
    try {
      await releaseNumber(c.env, row.twilio_sid);
    } catch (err) {
      // Swallow 404 — Twilio may have already released; still soft-delete locally.
      console.warn(
        JSON.stringify({
          level: 'warn',
          service: 'voice_routes',
          message: 'twilio_release_failed_soft_continue',
          error: err instanceof Error ? err.message : String(err),
          twilio_sid: row.twilio_sid,
        }),
      );
    }
  }

  const { error: relErr } = await dbUpdate(
    c.env.DB,
    'voice_numbers',
    {
      status: 'released',
      released_at: new Date().toISOString(),
      deleted_at: new Date().toISOString(),
    },
    'id = ?',
    [id],
  );
  // Twilio release already happened above (idempotent on retry) — but if the local
  // soft-delete failed, surface it rather than showing a "released" number that D1
  // still marks active. Row + org were 404-guarded, so this is a real error.
  if (relErr) throw internalError(`Failed to record number release: ${relErr}`);

  await auditService.writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: userId,
    action: 'voice.number_released',
    message: `Released ${row.phone_number}`,
    target_type: 'voice_number',
    target_id: id,
    request_id: c.get('requestId'),
  });

  return c.json({ ok: true, id });
});

/**
 * `GET /api/voice/conversations?site_id=&kind=&limit=` — list recent
 * conversations (calls + SMS threads) for a site.
 *
 * @throws 401 UNAUTHORIZED when auth context is missing.
 * @throws 404 NOT_FOUND when site isn't in the caller's org (never 403 — don't leak existence).
 */
voiceRoutes.get('/api/voice/conversations', async (c) => {
  const { orgId } = requireAuth(c);
  const siteId = c.req.query('siteId');
  const since = c.req.query('since'); // ISO datetime
  if (!siteId) throw badRequest('siteId required');
  await requireSiteMembership(c.env, siteId, orgId);

  const sinceClause = since ? `AND started_at >= ?` : '';
  const params: unknown[] = [siteId];
  if (since) params.push(since);
  const calls = await dbQuery<Record<string, unknown>>(
    c.env.DB,
    `SELECT id, 'call' AS kind, voice_number_id, direction, from_number, to_number,
            status, started_at AS event_at, ended_at, duration_seconds, sentiment,
            summary, twilio_call_sid
       FROM voice_calls
       WHERE site_id = ? AND deleted_at IS NULL ${sinceClause}
       ORDER BY started_at DESC LIMIT 200`,
    params,
  );

  const msgsParams: unknown[] = [siteId];
  if (since) msgsParams.push(since);
  const sinceClauseMsg = since ? `AND sent_at >= ?` : '';
  const messages = await dbQuery<Record<string, unknown>>(
    c.env.DB,
    `SELECT id, 'sms' AS kind, voice_number_id, direction, from_number, to_number,
            status, sent_at AS event_at, body, ai_reply_id, twilio_message_sid
       FROM voice_messages
       WHERE site_id = ? AND deleted_at IS NULL ${sinceClauseMsg}
       ORDER BY sent_at DESC LIMIT 400`,
    msgsParams,
  );

  const merged = [...calls.data, ...messages.data].sort((a, b) => {
    const at = (a as { event_at?: string }).event_at ?? '';
    const bt = (b as { event_at?: string }).event_at ?? '';
    return bt.localeCompare(at);
  });
  return c.json({ items: merged.slice(0, 300) });
});

/**
 * Map `voice_calls.transcript_json` (`[{role,text,ts_ms}]`, role ∈ user|assistant|system)
 * to the Conversations UI's `TranscriptTurn` shape (`[{speaker,text,t_ms}]`): the human
 * `user` → `caller`, everything else (assistant/system) → `agent`. Malformed/absent JSON
 * → `[]` (never throws — a bad transcript must not 500 the detail view).
 */
function parseTranscript(
  raw: unknown,
): Array<{ speaker: 'caller' | 'agent'; text: string; t_ms: number }> {
  if (typeof raw !== 'string' || !raw) return [];
  let turns: unknown;
  try {
    turns = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(turns)) return [];
  return turns
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t) => ({
      speaker: t['role'] === 'user' ? ('caller' as const) : ('agent' as const),
      text: typeof t['text'] === 'string' ? t['text'] : '',
      t_ms: typeof t['ts_ms'] === 'number' ? t['ts_ms'] : 0,
    }))
    .filter((t) => t.text.length > 0);
}

/**
 * `GET /api/voice/conversations/:id` — full detail for ONE conversation: a voice CALL
 * with its parsed transcript, or an SMS. The list route serves only summary-level items
 * with NO transcript, so the admin detail pane fetches this route on open to load it.
 * Org-scoped (`id` + `org_id` + not-deleted → both missing AND foreign-org collapse to
 * 404, no existence leak). Returns `{ data: Conversation }` in the shape the detail view
 * consumes directly.
 *
 * @throws 401 UNAUTHORIZED when auth context is missing.
 * @throws 404 NOT_FOUND when no owned call/message matches the id.
 */
voiceRoutes.get('/api/voice/conversations/:id', async (c) => {
  const { orgId } = requireAuth(c);
  const id = c.req.param('id');
  if (!id) throw badRequest('id required');

  const call = await dbQueryOne<{
    id: string;
    from_number: string | null;
    to_number: string | null;
    started_at: string | null;
    duration_seconds: number | null;
    status: string | null;
    sentiment: string | null;
    summary: string | null;
    transcript_json: string | null;
  }>(
    c.env.DB,
    `SELECT id, from_number, to_number, started_at, duration_seconds, status,
            sentiment, summary, transcript_json
       FROM voice_calls WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
    [id, orgId],
  );
  if (call) {
    // Surface recording presence so the detail pane can enable the mp3/mp4
    // download buttons + render the audio/video players. `voice_recordings.kind`
    // ∈ audio|video|transcript_text|transcript_vtt — we only care about media here.
    const recs = await dbQuery<{ kind: string }>(
      c.env.DB,
      `SELECT kind FROM voice_recordings
         WHERE call_id = ? AND deleted_at IS NULL AND kind IN ('audio', 'video')`,
      [call.id],
    );
    const kinds = new Set((recs.data ?? []).map((r) => r.kind));
    return c.json({
      data: {
        id: call.id,
        channel: 'call',
        from_number: call.from_number ?? '',
        to_number: call.to_number ?? '',
        started_at: call.started_at ?? '',
        duration_s: call.duration_seconds ?? undefined,
        status: call.status ?? 'completed',
        sentiment: call.sentiment ?? undefined,
        summary: call.summary ?? undefined,
        transcript: parseTranscript(call.transcript_json),
        // `has_recording` = an audio recording exists; `has_video` = a browse-session video exists.
        has_recording: kinds.has('audio'),
        has_video: kinds.has('video'),
      },
    });
  }

  const msg = await dbQueryOne<{
    id: string;
    from_number: string | null;
    to_number: string | null;
    sent_at: string | null;
    status: string | null;
    body: string | null;
  }>(
    c.env.DB,
    `SELECT id, from_number, to_number, sent_at, status, body
       FROM voice_messages WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
    [id, orgId],
  );
  if (msg) {
    return c.json({
      data: {
        id: msg.id,
        channel: 'sms',
        from_number: msg.from_number ?? '',
        to_number: msg.to_number ?? '',
        started_at: msg.sent_at ?? '',
        status: msg.status ?? 'completed',
        message_preview: msg.body ?? undefined,
      },
    });
  }

  throw notFound('Conversation not found');
});

/** ms → WebVTT timestamp `HH:MM:SS.mmm`. */
function vttTime(ms: number): string {
  const clamped = Math.max(0, Math.floor(ms));
  const totalS = Math.floor(clamped / 1000);
  const hh = String(Math.floor(totalS / 3600)).padStart(2, '0');
  const mm = String(Math.floor((totalS % 3600) / 60)).padStart(2, '0');
  const ss = String(totalS % 60).padStart(2, '0');
  const mmm = String(clamped % 1000).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${mmm}`;
}

/**
 * `GET /api/voice/conversations/:id/download.:kind` — download a conversation's
 * transcript (`txt`/`vtt`, generated from `transcript_json`) or its recording
 * (`mp3` audio / `mp4` video, streamed from R2 via the recordings route).
 * Registered as `:id/:file` because Hono treats `download.mp3` as one segment; the kind
 * is parsed + allow-listed off `:file` (anything else → 404). Org-scoped via the owning call.
 *
 * @throws 401 UNAUTHORIZED when auth context is missing.
 * @throws 404 NOT_FOUND for an unknown kind, a foreign/missing call, or an absent recording.
 */
voiceRoutes.get('/api/voice/conversations/:id/:file', async (c) => {
  const { orgId } = requireAuth(c);
  const id = c.req.param('id');
  const kind = /^download\.(txt|vtt|mp3|mp4)$/.exec(c.req.param('file'))?.[1];
  if (!id || !kind) throw notFound('Not found');

  const call = await dbQueryOne<{ id: string; transcript_json: string | null }>(
    c.env.DB,
    `SELECT id, transcript_json FROM voice_calls
       WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
    [id, orgId],
  );
  if (!call) throw notFound('Conversation not found');

  if (kind === 'txt' || kind === 'vtt') {
    const turns = parseTranscript(call.transcript_json);
    const who = (s: 'caller' | 'agent') => (s === 'agent' ? 'AI' : 'Caller');
    const body =
      kind === 'txt'
        ? turns.map((t) => `${who(t.speaker)}: ${t.text}`).join('\n')
        : `WEBVTT\n\n${turns
            .map(
              (t, i) =>
                `${i + 1}\n${vttTime(t.t_ms)} --> ${vttTime(turns[i + 1]?.t_ms ?? t.t_ms + 3000)}\n<v ${who(t.speaker)}>${t.text}`,
            )
            .join('\n\n')}`;
    return new Response(body || (kind === 'vtt' ? 'WEBVTT\n' : ''), {
      headers: {
        'Content-Type': kind === 'vtt' ? 'text/vtt; charset=utf-8' : 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${id}.${kind}"`,
      },
    });
  }

  // mp3 → audio recording, mp4 → video recording; both stream from R2 via the
  // proven recordings route (range-aware). Absent → 404 (never fabricate bytes).
  const rec = await dbQueryOne<{ id: string }>(
    c.env.DB,
    `SELECT id FROM voice_recordings WHERE call_id = ? AND kind = ? AND deleted_at IS NULL LIMIT 1`,
    [id, kind === 'mp3' ? 'audio' : 'video'],
  );
  if (!rec) throw notFound('Recording not available for this conversation');
  return c.redirect(`/api/voice/recordings/${rec.id}/stream`, 302);
});

/**
 * `GET /api/voice/calls/:id` — fetch a single call with transcript +
 * sentiment + intent breakdown.
 *
 * @throws 401 UNAUTHORIZED when auth context is missing.
 * @throws 404 NOT_FOUND when the call is missing OR isn't in the caller's org (never 403 — don't leak existence).
 */
voiceRoutes.get('/api/voice/calls/:id', async (c) => {
  const { orgId } = requireAuth(c);
  const id = c.req.param('id');
  if (!id) throw badRequest('id required');
  const call = await dbQueryOne<Record<string, unknown>>(
    c.env.DB,
    `SELECT * FROM voice_calls WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    [id],
  );
  // 404 for both missing AND foreign-org (never 403 — don't leak that the call exists).
  if (!call || (call as { org_id?: string }).org_id !== orgId) throw notFound('Call not found');
  const recordings = await dbQuery<Record<string, unknown>>(
    c.env.DB,
    `SELECT id, kind, r2_key, mime, size_bytes, duration_seconds, created_at
       FROM voice_recordings WHERE call_id = ? AND deleted_at IS NULL`,
    [id],
  );
  return c.json({ call, recordings: recordings.data });
});

/**
 * `GET /api/voice/recordings/:id/stream` — stream the audio recording (MP3)
 * for playback in the admin UI.
 *
 * @remarks Reads from R2 (`recordings/{call_sid}/{recording_sid}.mp3`) or falls
 * back to Twilio if not yet mirrored. Range-aware.
 *
 * @throws 401 UNAUTHORIZED when auth context is missing.
 * @throws 404 NOT_FOUND when the recording is missing OR isn't in the caller's org (never 403 — don't leak existence).
 */
voiceRoutes.get('/api/voice/recordings/:id/stream', async (c) => {
  const { orgId } = requireAuth(c);
  const id = c.req.param('id');
  if (!id) throw badRequest('id required');
  const rec = await dbQueryOne<{
    id: string;
    call_id: string;
    r2_key: string;
    mime: string | null;
    size_bytes: number | null;
  }>(
    c.env.DB,
    `SELECT id, call_id, r2_key, mime, size_bytes FROM voice_recordings
       WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    [id],
  );
  if (!rec) throw notFound('Recording not found');
  // Ensure ownership through the call.
  const ownCheck = await dbQueryOne<{ org_id: string }>(
    c.env.DB,
    `SELECT org_id FROM voice_calls WHERE id = ? LIMIT 1`,
    [rec.call_id],
  );
  // 404 (never 403) when the recording's call isn't owned by the caller — don't leak existence.
  if (!ownCheck || ownCheck.org_id !== orgId) throw notFound('Recording not found');

  const range = c.req.header('range');
  let r2Object: R2ObjectBody | null;
  if (range) {
    const match = /^bytes=(\d+)-(\d*)/.exec(range);
    if (match) {
      const offset = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : undefined;
      const length = end !== undefined ? end - offset + 1 : undefined;
      r2Object = await c.env.SITES_BUCKET.get(rec.r2_key, { range: { offset, length } });
    } else {
      r2Object = await c.env.SITES_BUCKET.get(rec.r2_key);
    }
  } else {
    r2Object = await c.env.SITES_BUCKET.get(rec.r2_key);
  }
  if (!r2Object) throw notFound('Recording bytes missing in R2');

  return new Response(r2Object.body, {
    status: range ? 206 : 200,
    headers: {
      'Content-Type': rec.mime ?? 'audio/mpeg',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=60',
      ...(rec.size_bytes ? { 'Content-Length': String(r2Object.size) } : {}),
    },
  });
});

const agentSettingsBody = z.object({
  siteId: z.string().min(1),
  voice_system_prompt: z.string().max(8000).nullable().optional(),
  sms_system_prompt: z.string().max(8000).nullable().optional(),
  voice_voice_id: z.string().max(120).nullable().optional(),
  voice_model: z.string().max(120).nullable().optional(),
  sms_model: z.string().max(120).nullable().optional(),
  max_call_seconds: z.number().int().min(30).max(3600).optional(),
  recording_enabled: z.boolean().optional(),
  video_browse_enabled: z.boolean().optional(),
  mcp_connection_ids: z.array(z.string()).max(20).optional(),
  escalation_phone: z
    .string()
    .regex(/^\+\d{8,15}$/)
    .nullable()
    .optional(),
  business_hours_json: z.string().max(2000).nullable().optional(),
  knowledge_base_urls: z.array(z.string().url()).max(20).optional(),
});

/** Parse a JSON `string[]` column defensively → always a `string[]`. */
function parseIdList(v: string | null | undefined): string[] {
  if (!v) return [];
  try {
    const a: unknown = JSON.parse(v);
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Body for `PUT /api/voice/mcp-attachments` — which MCP connections each channel
 * (voice, sms) may use. Each id ≤64 chars, ≤20 per channel. Note the FE sends
 * `site_id` (snake), unlike agent-settings' `siteId`.
 */
const mcpAttachmentsBody = z.object({
  site_id: z.string().min(1),
  voice: z.array(z.string().min(1).max(64)).max(20),
  sms: z.array(z.string().min(1).max(64)).max(20),
});

/**
 * `GET /api/voice/mcp-attachments?siteId=` — the per-channel MCP attachment
 * lists (`{voice, sms}`) for the site's voice agent. The voice list reuses the
 * existing `mcp_connection_ids` column (same concept the Agent tab writes); the
 * sms list lives in `mcp_sms_connection_ids` (migration 0610). A site with no
 * settings row yet returns empty lists, never an error.
 *
 * @throws 401 UNAUTHORIZED when auth context is missing.
 * @throws 404 NOT_FOUND when the site isn't in the caller's org (never 403).
 */
voiceRoutes.get('/api/voice/mcp-attachments', async (c) => {
  const { orgId } = requireAuth(c);
  const siteId = c.req.query('siteId');
  if (!siteId) throw badRequest('siteId required');
  await requireSiteMembership(c.env, siteId, orgId);
  const row = await dbQueryOne<{
    mcp_connection_ids: string | null;
    mcp_sms_connection_ids: string | null;
  }>(
    c.env.DB,
    `SELECT mcp_connection_ids, mcp_sms_connection_ids FROM voice_agent_settings WHERE site_id = ? AND deleted_at IS NULL LIMIT 1`,
    [siteId],
  );
  return c.json({
    data: {
      voice: parseIdList(row?.mcp_connection_ids),
      sms: parseIdList(row?.mcp_sms_connection_ids),
    },
  });
});

/**
 * `PUT /api/voice/mcp-attachments` — persist the `{voice, sms}` MCP attachment
 * lists for a site's voice agent. Upserts the `voice_agent_settings` row.
 *
 * @throws 401 UNAUTHORIZED when auth context is missing.
 * @throws 404 NOT_FOUND when the site isn't in the caller's org (never 403).
 * @throws 400 VALIDATION_ERROR when the body fails {@link mcpAttachmentsBody}.
 */
voiceRoutes.put('/api/voice/mcp-attachments', async (c) => {
  const { userId, orgId } = requireAuth(c);
  const body = mcpAttachmentsBody.parse(await c.req.json().catch(() => ({})));
  await requireSiteMembership(c.env, body.site_id, orgId);

  const voiceJson = body.voice.length ? JSON.stringify(body.voice) : null;
  const smsJson = body.sms.length ? JSON.stringify(body.sms) : null;

  const existing = await dbQueryOne<{ id: string }>(
    c.env.DB,
    `SELECT id FROM voice_agent_settings WHERE site_id = ? AND deleted_at IS NULL LIMIT 1`,
    [body.site_id],
  );
  if (existing) {
    // Match the INSERT path (else branch): surface a genuine write failure instead
    // of a lying 200 that silently drops the caller's MCP-attachment changes.
    const { error: updErr } = await dbUpdate(
      c.env.DB,
      'voice_agent_settings',
      { mcp_connection_ids: voiceJson, mcp_sms_connection_ids: smsJson },
      'id = ?',
      [existing.id],
    );
    if (updErr) throw internalError(`Failed to save voice MCP attachments: ${updErr}`);
  } else {
    const { error: vErr } = await dbInsert(c.env.DB, 'voice_agent_settings', {
      id: crypto.randomUUID(),
      site_id: body.site_id,
      mcp_connection_ids: voiceJson,
      mcp_sms_connection_ids: smsJson,
    });
    if (vErr) throw internalError(`Failed to save voice MCP attachments: ${vErr}`);
  }

  await auditService.writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: userId,
    action: 'voice.mcp_attachments_updated',
    message: `Voice/SMS MCP attachments updated for site ${body.site_id}`,
    target_type: 'site',
    target_id: body.site_id,
  });

  return c.json({ data: { voice: body.voice, sms: body.sms } });
});

/**
 * `GET /api/voice/agent-settings?site_id=` — read the AI voice agent's
 * per-site settings (greeting, voice, escalation rules, hours).
 *
 * @throws 401 UNAUTHORIZED when auth context is missing.
 * @throws 404 NOT_FOUND when site isn't in the caller's org (never 403 — don't leak existence).
 */
voiceRoutes.get('/api/voice/agent-settings', async (c) => {
  const { orgId } = requireAuth(c);
  const siteId = c.req.query('siteId');
  if (!siteId) throw badRequest('siteId required');
  await requireSiteMembership(c.env, siteId, orgId);
  const row = await dbQueryOne<Record<string, unknown>>(
    c.env.DB,
    `SELECT * FROM voice_agent_settings WHERE site_id = ? AND deleted_at IS NULL LIMIT 1`,
    [siteId],
  );
  return c.json({ settings: row ?? null });
});

/**
 * `PUT /api/voice/agent-settings` — update the AI voice agent settings for a site.
 * Audit-logged.
 *
 * @throws 401 UNAUTHORIZED when auth context is missing.
 * @throws 404 NOT_FOUND when site isn't in the caller's org (never 403 — don't leak existence).
 */
voiceRoutes.put('/api/voice/agent-settings', async (c) => {
  const { userId, orgId } = requireAuth(c);
  const body = agentSettingsBody.parse(await c.req.json().catch(() => ({})));
  await requireSiteMembership(c.env, body.siteId, orgId);

  const updates: Record<string, unknown> = {
    voice_system_prompt: body.voice_system_prompt ?? null,
    sms_system_prompt: body.sms_system_prompt ?? null,
    voice_voice_id: body.voice_voice_id ?? null,
    voice_model: body.voice_model ?? null,
    sms_model: body.sms_model ?? null,
    max_call_seconds: body.max_call_seconds ?? 600,
    recording_enabled: body.recording_enabled === false ? 0 : 1,
    video_browse_enabled: body.video_browse_enabled === false ? 0 : 1,
    escalation_phone: body.escalation_phone ?? null,
    business_hours_json: body.business_hours_json ?? null,
    knowledge_base_urls: body.knowledge_base_urls ? JSON.stringify(body.knowledge_base_urls) : null,
  };
  // `mcp_connection_ids` is OWNED by the dedicated PUT /api/voice/mcp-attachments
  // endpoint (which manages BOTH the voice + sms channels). The agent-settings tab
  // NEVER sends it, so writing it UNCONDITIONALLY here NULLED the column on every
  // settings save — silently WIPING the user's voice MCP attachments. Only touch it
  // when the caller EXPLICITLY provides it; otherwise leave the column untouched.
  if (body.mcp_connection_ids !== undefined) {
    updates.mcp_connection_ids = JSON.stringify(body.mcp_connection_ids);
  }

  const existing = await dbQueryOne<{ id: string }>(
    c.env.DB,
    `SELECT id FROM voice_agent_settings WHERE site_id = ? AND deleted_at IS NULL LIMIT 1`,
    [body.siteId],
  );
  if (existing) {
    const { error: updErr } = await dbUpdate(c.env.DB, 'voice_agent_settings', updates, 'id = ?', [
      existing.id,
    ]);
    if (updErr) throw internalError(`Failed to save voice agent settings: ${updErr}`);
  } else {
    const { error: vErr } = await dbInsert(c.env.DB, 'voice_agent_settings', {
      id: crypto.randomUUID(),
      site_id: body.siteId,
      ...updates,
    });
    if (vErr) throw internalError(`Failed to save voice agent settings: ${vErr}`);
  }

  await auditService.writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: userId,
    action: 'voice.agent_settings_updated',
    message: `Voice/SMS agent settings updated for site ${body.siteId}`,
    target_type: 'site',
    target_id: body.siteId,
    request_id: c.get('requestId'),
  });

  return c.json({ ok: true });
});

const testSmsBody = z.object({
  siteId: z.string().min(1),
  body: z.string().min(1).max(2000),
});

/**
 * `POST /api/voice/test/sms` — test-mode SMS agent simulator (does not send a
 * real SMS; runs the inbound message through {@link simulateInbound}). Returns
 * the agent's reply + intent + sentiment for debugging the persona.
 *
 * @throws 401 UNAUTHORIZED when auth context is missing.
 * @throws 404 NOT_FOUND when site isn't in the caller's org (never 403 — don't leak existence).
 */
voiceRoutes.post('/api/voice/test/sms', async (c) => {
  const { orgId } = requireAuth(c);
  const body = testSmsBody.parse(await c.req.json().catch(() => ({})));
  const site = await requireSiteMembership(c.env, body.siteId, orgId);

  const settingsRow = await dbQueryOne<Record<string, unknown>>(
    c.env.DB,
    `SELECT * FROM voice_agent_settings WHERE site_id = ? AND deleted_at IS NULL LIMIT 1`,
    [body.siteId],
  );

  const result = await simulateInbound(c.env, {
    siteId: body.siteId,
    orgId,
    body: body.body,
    profile: {
      businessName: site.business_name ?? 'this business',
      businessLocation: site.business_address ?? undefined,
    },
    settings: (settingsRow ?? {}) as Record<string, never>,
  });
  return c.json(result);
});

/**
 * `POST /api/voice/test/call-token` — mint a short-lived Twilio JWT for the
 * admin "test call" widget so the admin's browser can place a call directly to
 * the AI voice agent through the Twilio Voice SDK.
 *
 * @throws 401 UNAUTHORIZED when auth context is missing.
 * @throws 404 NOT_FOUND when site isn't in the caller's org (never 403 — don't leak existence).
 * @throws 501 NOT_IMPLEMENTED when Twilio isn't configured on this worker.
 */
voiceRoutes.post('/api/voice/test/call-token', async (c) => {
  const { userId, orgId } = requireAuth(c);
  const body = z.object({ siteId: z.string().min(1) }).parse(await c.req.json().catch(() => ({})));
  await requireSiteMembership(c.env, body.siteId, orgId);

  const apiKey = (c.env.TWILIO_API_KEY ?? '').trim();
  const apiSecret = (c.env.TWILIO_API_SECRET ?? '').trim();
  const accountSid = (c.env.TWILIO_ACCOUNT_SID ?? '').trim();
  const appSid = (c.env.TWILIO_TWIML_APP_SID ?? '').trim();
  if (!apiKey || !apiSecret || !accountSid || !appSid) {
    throw new AppError({
      code: 'SERVICE_UNAVAILABLE',
      statusCode: 501,
      message:
        'TWILIO_CLIENT_NOT_CONFIGURED — paste TWILIO_API_KEY, TWILIO_API_SECRET, TWILIO_TWIML_APP_SID via `wrangler secret put`',
    });
  }
  const identity = `user-${userId.slice(0, 8)}-site-${body.siteId.slice(0, 8)}`;
  const token = await mintTwilioAccessToken({
    accountSid,
    apiKey,
    apiSecret,
    identity,
    twimlAppSid: appSid,
    ttlSeconds: 3600,
  });
  // Nest under `data` — the Test Console FE reads `res.data.token`. A top-level
  // `{ token }` left `res.data.token` undefined, so the Twilio Device booted with
  // `undefined` and every test call failed (A0 fix).
  return c.json({
    data: { token, identity, edge_url: 'wss://chunderw-vpc-gll.twilio.com/signal' },
  });
});

/**
 * Mint a Twilio Access Token with a Voice grant. Pure Web-Crypto, no twilio SDK.
 * https://www.twilio.com/docs/iam/access-tokens
 */
async function mintTwilioAccessToken(opts: {
  accountSid: string;
  apiKey: string;
  apiSecret: string;
  identity: string;
  twimlAppSid: string;
  ttlSeconds: number;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT', cty: 'twilio-fpa;v=1' };
  const payload = {
    jti: `${opts.apiKey}-${now}`,
    iss: opts.apiKey,
    sub: opts.accountSid,
    iat: now,
    exp: now + opts.ttlSeconds,
    grants: {
      identity: opts.identity,
      voice: {
        incoming: { allow: true },
        outgoing: { application_sid: opts.twimlAppSid },
      },
    },
  };
  const enc = new TextEncoder();
  const b64url = (b: Uint8Array | string): string => {
    const bin = typeof b === 'string' ? b : String.fromCharCode(...b);
    return btoa(bin).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  };
  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(opts.apiSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(signingInput)));
  return `${signingInput}.${b64url(sig)}`;
}
