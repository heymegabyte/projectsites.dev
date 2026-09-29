/**
 * @module routes/bolt_admin
 * @description bolt.diy editor-side admin endpoints.
 *
 * Chat-state mirror, voice transcribe (Whisper), vision OCR (Llama 3.2
 * Vision), and AI prompt-suggestion endpoints. The bolt.diy iframe calls
 * these via `fetch()` while embedded inside the admin shell.
 *
 * ## Path-prefix migration (2026-05-25)
 *
 * Routes are registered at BOTH `/admin-api/...` (legacy) and
 * `/api/bolt/...` (current). The Cloudflare zone-level WAF blocks every
 * `POST` to paths matching `/admin*` regardless of host or Origin (we
 * confirmed with curl: `POST /admin-api/...` → 403 Cloudflare WAF block
 * page, `POST /api/bolt/...` → reaches Worker). The new prefix avoids
 * the rule entirely. The legacy prefix is kept registered so local dev
 * (`wrangler dev` where the WAF doesn't run) keeps working and so any
 * cached iframe bundle that hasn't reloaded yet still functions when
 * the WAF rule is eventually loosened.
 *
 * ## Auth policy (fire-56 — the marker is NEVER an auth grant in production)
 *
 * In **production** every endpoint requires an AUTHENTICATED PRINCIPAL:
 *
 *   1. A session/API-key principal — `c.get('userId')` set by the global
 *      auth middleware from `Authorization: Bearer <session|psk_…>`.
 *   2. The machine principal — the bolt.diy fork's SERVER-side chat fetch
 *      (`app/lib/modules/llm/providers/projectsites-ai.ts`) sends the
 *      provisioned `PS_BOLT_SERVICE_TOKEN` as its Bearer (the AI SDK emits
 *      `apiKey` as `Authorization: Bearer …`). Compared timing-safe here
 *      after the session lookup misses.
 *
 * The BROWSER-called surfaces (chat-state mirror, suggest-prompts,
 * vision-OCR, transcribe — fetched client-side from the iframe, which holds
 * no bearer) additionally accept a real browser `Origin` in production, but
 * ONLY when the request arrived on the `projectsites.dev` zone, where
 * Cloudflare Bot Fight Mode challenges non-browser POSTs. The WAF-less
 * `workers.dev` host never qualifies. The chat inference endpoints get NO
 * origin allowance at all — principal or 401.
 *
 * The `X-Bolt-Origin-Check: bolt-iframe` marker and the localhost origins
 * remain a **development-mode allowance only** (`ENVIRONMENT !== 'production'`,
 * i.e. `wrangler dev` + local editor dev) — any curl can set both, so they
 * grant nothing in production. Denials: 401 in production, 403 in dev.
 * CORS allow-list for `editor.projectsites.dev` is handled by the global
 * CORS middleware in `src/index.ts`.
 *
 * **NOTE (2026-05-24)**: Whisper is no longer wired from the editor
 * surface. `transcribe` remains live so the browser SpeechRecognition
 * path or future support tooling can still hit it, but no in-editor
 * UI calls it anymore.
 *
 * @packageDocumentation
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { routeBoltChat } from '../services/edge_ai_router.js';
import { writeAuditLog } from '../services/audit.js';

const bolt = new Hono<{ Bindings: Env; Variables: Variables }>();

const MODEL_TEXT = '@cf/meta/llama-3.1-8b-instruct-fp8' as const;
const MODEL_VISION = '@cf/meta/llama-3.2-11b-vision-instruct' as const;
const MODEL_WHISPER = '@cf/openai/whisper' as const;

/** Trusted origins for the DEV-ONLY relaxed iframe-auth path (never auth in production). */
const TRUSTED_BOLT_ORIGINS = new Set([
  'https://editor.projectsites.dev',
  'https://projectsites.dev',
  'http://localhost:4200',
  'http://localhost:5173',
]);

/**
 * The two real-product origins the embedded editor legitimately calls from in
 * production. Localhost origins never graduate here.
 */
const PROD_TRUSTED_BOLT_ORIGINS = new Set([
  'https://editor.projectsites.dev',
  'https://projectsites.dev',
]);

/**
 * Constant-time string comparison for the service-token check — never
 * short-circuit on the first differing byte of a credential.
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

/**
 * Which auth contract an endpoint runs under.
 *
 * - `inference` — the `/chat` + `/chat/completions` AI endpoints (route real
 *   provider spend through the AI Gateway): authenticated principal ONLY in
 *   production, no origin allowance whatsoever.
 * - `browser` — the iframe's client-side surfaces (chat-state mirror,
 *   suggest-prompts, vision-OCR, transcribe): a principal, OR a real browser
 *   Origin arriving via the Bot-Fight-Mode-screened `projectsites.dev` zone.
 */
type BoltSurface = 'inference' | 'browser';

/**
 * Authorize a bolt endpoint call; returns `null` when allowed, else the
 * 401 (production) / 403 (dev) denial response.
 *
 * Production grants (see module JSDoc § Auth policy):
 *   1. `c.get('userId')` — session Bearer / org API key via the global auth
 *      middleware (real user principal).
 *   2. `Authorization: Bearer <PS_BOLT_SERVICE_TOKEN>` — the editor fork's
 *      server-side machine principal (timing-safe compare; the session lookup
 *      already missed, so the raw bearer is compared against the secret).
 *   3. `browser` surfaces only: a `PROD_TRUSTED_BOLT_ORIGINS` Origin on a
 *      `projectsites.dev`-zone host (never `workers.dev`).
 *
 * Outside production the legacy allowances (trusted Origin incl. localhost,
 * `X-Bolt-Origin-Check` marker) keep `wrangler dev` + local editor dev working.
 * The marker header is NEVER an auth grant in production.
 */
function boltAuthDenial(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  surface: BoltSurface,
): Response | null {
  // 1. Authenticated user principal (session Bearer or org API key).
  if (c.get('userId')) return null;

  // 2. Machine principal — the fork's server-side chat fetch.
  const serviceToken = c.env.PS_BOLT_SERVICE_TOKEN ?? '';
  const authHeader = c.req.header('authorization') ?? '';
  if (serviceToken && authHeader.toLowerCase().startsWith('bearer ')) {
    const bearer = authHeader.slice(7).trim();
    if (bearer && timingSafeEqualStr(bearer, serviceToken)) return null;
  }

  if (c.env.ENVIRONMENT !== 'production') {
    // Dev-mode allowance ONLY (wrangler dev / local editor): trusted Origin or
    // the bolt-iframe marker. Any curl can set both — production ignores them.
    const origin = c.req.header('origin') ?? '';
    if (origin && TRUSTED_BOLT_ORIGINS.has(origin)) return null;
    if (c.req.header('x-bolt-origin-check') === 'bolt-iframe') return null;
    return c.json({ error: 'forbidden' }, 403);
  }

  // 3. PRODUCTION browser surfaces: the iframe holds no bearer, so its direct
  // fetches authorize by a REAL browser Origin — accepted only via the
  // projectsites.dev zone (Bot Fight Mode challenges non-browser POSTs there;
  // the WAF-less workers.dev host gets no such allowance).
  if (surface === 'browser') {
    const origin = c.req.header('origin') ?? '';
    const host = new URL(c.req.url).hostname;
    const onZone = host === 'projectsites.dev' || host.endsWith('.projectsites.dev');
    if (onZone && PROD_TRUSTED_BOLT_ORIGINS.has(origin)) return null;
  }

  return c.json({ error: 'unauthorized' }, 401);
}

/**
 * POST /api/bolt/chat (+ legacy /admin-api/chat) — the editor's custom AI.
 *
 * Bolt's chat streams from HERE, not from per-user provider keys: the worker
 * routes every call through {@link chooseProviderForTier} (DeepSeek preferred,
 * OpenAI fallback) and {@link gatewayFetch} — which uses the Cloudflare AI
 * Gateway when `CF_ACCOUNT_ID` is set and `AI_GATEWAY_ENABLED !== "false"`,
 * else the provider directly. The endpoint is OpenAI-compatible
 * (`chat/completions` pass-through, SSE stream) so the fork's AI SDK needs no
 * protocol changes. Kills the "user's Anthropic key has no credits" class:
 * secrets live in the worker, never in a bolt cookie.
 */
const boltChatHandler = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  const denied = boltAuthDenial(c, 'inference');
  if (denied) return denied;
  const body = (await c.req.json().catch(() => null)) as {
    messages?: { role: string; content: string }[];
    model?: string;
    stream?: boolean;
  } | null;
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: 'messages_required' }, 400);
  }

  // THE edge decision: classify → Workers AI (instant, free) → else AI Gateway.
  // `stream` drives the response shape (SSE vs chat.completion JSON) so both
  // the fork's streamText AND generateText (llmcall non-streaming) paths work.
  // OpenAI convention: stream defaults to FALSE (generateText omits the field);
  // only an explicit stream:true gets SSE.
  //
  // Audit (palette precedent): fire-and-forget `bolt.ai.answered` so editor-AI
  // usage is visible in the admin audit trail — first 40 chars of the last user
  // turn only, never the streamed answer.
  const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user');
  // Only audit when the caller has a REAL session (orgId set by auth middleware).
  // The service-token machine principal (the fork's server-side call) has no org
  // to attribute to — and audit_logs.org_id has a FK to orgs(id), so a synthetic
  // sentinel would FK-violate and silently drop the write (live-verified). Skip
  // instead of fabricating an org.
  const orgId = c.get('orgId');
  if (lastUser?.content && orgId) {
    c.executionCtx.waitUntil(
      writeAuditLog(c.env.DB, {
        org_id: orgId,
        actor_id: c.get('userId') ?? null,
        action: 'bolt.ai.answered',
        message: `Editor AI answered: '${lastUser.content.slice(0, 40)}'`,
        target_type: 'bolt_ai',
        metadata_json: {
          model_hint: body.model ?? null,
          stream: body.stream === true,
          query_length: lastUser.content.length,
        },
      }),
    );
  }

  return routeBoltChat(c.env, body.messages, body.model ?? null, body.stream === true);
};

/**
 * Mirrors IDB chat-state to D1 once every 30s from the bolt.diy client.
 *
 * @see {@link boltAuthDenial} for the auth contract (browser surface).
 */
const chatStateHandler = async (
  c: Context<{ Bindings: Env; Variables: Variables }>,
): Promise<Response> => {
  const denied = boltAuthDenial(c, 'browser');
  if (denied) return denied;

  const slug = c.req.param('slug');

  if (!slug || slug.length > 128) {
    return c.json({ error: 'invalid_slug' }, 400);
  }

  let body: {
    chat_id?: string;
    message_count?: number;
    last_message_id?: string;
    updated_at?: string;
    tail?: Array<{ id?: string; role?: string; excerpt?: string }>;
  };

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  if (!body.chat_id) {
    return c.json({ error: 'chat_id_required' }, 400);
  }

  try {
    await c.env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS bolt_chat_state (
         slug TEXT NOT NULL,
         chat_id TEXT NOT NULL,
         message_count INTEGER NOT NULL DEFAULT 0,
         last_message_id TEXT,
         updated_at TEXT NOT NULL,
         tail_json TEXT,
         PRIMARY KEY (slug, chat_id)
       )`,
    ).run();

    await c.env.DB.prepare(
      `INSERT INTO bolt_chat_state (slug, chat_id, message_count, last_message_id, updated_at, tail_json)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug, chat_id) DO UPDATE SET
         message_count = excluded.message_count,
         last_message_id = excluded.last_message_id,
         updated_at = excluded.updated_at,
         tail_json = excluded.tail_json`,
    )
      .bind(
        slug,
        body.chat_id,
        body.message_count ?? 0,
        body.last_message_id ?? null,
        body.updated_at ?? new Date().toISOString(),
        body.tail ? JSON.stringify(body.tail).slice(0, 8000) : null,
      )
      .run();

    return c.json({ ok: true });
  } catch (err) {
    console.warn('chat-state mirror failed', err);
    return c.json({ error: 'persist_failed' }, 500);
  }
};

/**
 * multipart/form-data audio → Whisper text.
 *
 * @see {@link boltAuthDenial} for the auth contract (browser surface).
 */
const transcribeHandler = async (
  c: Context<{ Bindings: Env; Variables: Variables }>,
): Promise<Response> => {
  const denied = boltAuthDenial(c, 'browser');
  if (denied) return denied;

  const start = Date.now();

  let form: FormData;

  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: 'invalid_form' }, 400);
  }

  const audio = form.get('audio');

  if (!audio || typeof audio === 'string') {
    return c.json({ error: 'audio_required' }, 400);
  }

  const buf = await (audio as File).arrayBuffer();

  if (buf.byteLength > 20 * 1024 * 1024) {
    return c.json({ error: 'audio_too_large' }, 413);
  }

  try {
    const result = (await c.env.AI.run(
      MODEL_WHISPER as Parameters<typeof c.env.AI.run>[0],
      { audio: [...new Uint8Array(buf)] } as unknown as Parameters<typeof c.env.AI.run>[1],
    )) as { text?: string };

    return c.json({
      text: (result?.text ?? '').trim(),
      durationMs: Date.now() - start,
    });
  } catch (err) {
    console.warn('whisper failed', err);
    return c.json({ error: 'transcribe_failed' }, 502);
  }
};

/**
 * { image_data_url } → { caption, ocrText }
 *
 * @see {@link boltAuthDenial} for the auth contract (browser surface).
 */
const visionOcrHandler = async (
  c: Context<{ Bindings: Env; Variables: Variables }>,
): Promise<Response> => {
  const denied = boltAuthDenial(c, 'browser');
  if (denied) return denied;

  let body: { image_data_url?: string };

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const dataUrl = body.image_data_url ?? '';
  const match = dataUrl.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);

  if (!match) {
    return c.json({ error: 'invalid_data_url' }, 400);
  }

  const base64 = match[2];
  const bin = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));

  if (bin.byteLength > 8 * 1024 * 1024) {
    return c.json({ error: 'image_too_large' }, 413);
  }

  try {
    const result = (await c.env.AI.run(
      MODEL_VISION as Parameters<typeof c.env.AI.run>[0],
      {
        image: [...bin],
        prompt:
          'Describe this image in one sentence, then on a new line list any text visible in the image verbatim under the heading OCR:.',
        max_tokens: 400,
      } as unknown as Parameters<typeof c.env.AI.run>[1],
    )) as { description?: string; response?: string };

    const text = (result?.description ?? result?.response ?? '').trim();
    const ocrIdx = text.toLowerCase().indexOf('ocr:');
    const caption = ocrIdx >= 0 ? text.slice(0, ocrIdx).trim() : text;
    const ocrText = ocrIdx >= 0 ? text.slice(ocrIdx + 4).trim() : '';

    return c.json({ caption, ocrText });
  } catch (err) {
    console.warn('vision failed', err);
    return c.json({ error: 'vision_failed' }, 502);
  }
};

/**
 * { tail: [{role, content}], max } → { suggestions: [{label, prompt}] }
 * Caches by tail hash in KV (60s TTL) to avoid repeated Llama calls.
 *
 * @see {@link boltAuthDenial} for the auth contract (browser surface).
 */
const suggestPromptsHandler = async (
  c: Context<{ Bindings: Env; Variables: Variables }>,
): Promise<Response> => {
  const denied = boltAuthDenial(c, 'browser');
  if (denied) return denied;

  let body: { tail?: Array<{ role?: string; content?: string }>; max?: number };

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const tail = (body.tail ?? []).slice(-6);

  if (!tail.length) {
    return c.json({ suggestions: [] });
  }

  const cacheKey =
    'bolt-suggest:' + btoa(unescape(encodeURIComponent(JSON.stringify(tail)))).slice(0, 96);

  try {
    const cached = await c.env.CACHE_KV.get(cacheKey, 'json');

    if (cached) {
      return c.json(cached as { suggestions: Array<{ label: string; prompt: string }> });
    }
  } catch (err) {
    console.warn('suggest cache read failed', err);
  }

  const transcript = tail
    .map((m) => `${(m.role ?? 'user').toUpperCase()}: ${(m.content ?? '').slice(0, 400)}`)
    .join('\n');

  const sys =
    'You suggest 3 short, distinct next prompts the user might send in a coding-chat. Reply ONLY with JSON of shape {"suggestions":[{"label":"<4-6 words>","prompt":"<full prompt 1 sentence>"}]} — no markdown, no preamble.';

  try {
    const result = (await c.env.AI.run(
      MODEL_TEXT as Parameters<typeof c.env.AI.run>[0],
      {
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: `Recent chat:\n${transcript}\n\nSuggest 3 next prompts.` },
        ],
        max_tokens: 280,
      } as Parameters<typeof c.env.AI.run>[1],
    )) as { response?: string };

    const raw = (result?.response ?? '').trim();
    const jsonStart = raw.indexOf('{');
    const jsonEnd = raw.lastIndexOf('}');

    if (jsonStart < 0 || jsonEnd <= jsonStart) {
      return c.json({ suggestions: [] });
    }

    let parsed: { suggestions?: Array<{ label?: string; prompt?: string }> };

    try {
      parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
    } catch {
      return c.json({ suggestions: [] });
    }

    const suggestions = (parsed.suggestions ?? [])
      .filter((s) => s && s.label && s.prompt)
      .slice(0, Math.min(body.max ?? 3, 3))
      .map((s) => ({
        label: String(s.label).slice(0, 60),
        prompt: String(s.prompt).slice(0, 400),
      }));

    const payload = { suggestions };

    try {
      await c.env.CACHE_KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: 60 });
    } catch (err) {
      console.warn('suggest cache write failed', err);
    }

    return c.json(payload);
  } catch (err) {
    console.warn('suggest llm failed', err);
    return c.json({ suggestions: [] });
  }
};

// ─── Route registration ────────────────────────────────────
// Each handler is mounted at BOTH the legacy `/admin-api/...` prefix
// (kept for backward compat + local dev) AND the new `/api/bolt/...`
// prefix (the production-callable path that survives the Cloudflare
// zone WAF). Iframe code should use the `/api/bolt/...` URLs.
bolt.post('/admin-api/sites/by-slug/:slug/chat-state', chatStateHandler);
bolt.post('/api/bolt/sites/by-slug/:slug/chat-state', chatStateHandler);

bolt.post('/admin-api/transcribe', transcribeHandler);
bolt.post('/api/bolt/transcribe', transcribeHandler);

bolt.post('/admin-api/vision-ocr', visionOcrHandler);
bolt.post('/api/bolt/vision-ocr', visionOcrHandler);

bolt.post('/admin-api/chat/suggest-prompts', suggestPromptsHandler);
bolt.post('/admin-api/chat', boltChatHandler);
bolt.post('/api/bolt/chat', boltChatHandler);
// The AI SDK's createOpenAI appends `/chat/completions` to its baseURL — the
// fork's ProjectsitesAiProvider points at this mount, so register the
// SDK-shaped path too (first attempt hit 'Unknown API route' on the doubled
// suffix). All four routes run the same edge-classifying handler.
bolt.post('/admin-api/chat/completions', boltChatHandler);
bolt.post('/api/bolt/chat/completions', boltChatHandler);
bolt.post('/api/bolt/chat/suggest-prompts', suggestPromptsHandler);

export { bolt };
