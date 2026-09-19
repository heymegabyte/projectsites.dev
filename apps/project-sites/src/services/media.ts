/**
 * @module services/media
 * @description Unified media library service for the projectsites.dev studio.
 *
 * Owns the `media_assets` D1 table + the `media/{org_id}/{asset_id}/{filename}`
 * R2 prefix. Reuses {@link image_discovery} patterns for stock search and
 * {@link image_generation.callDallE3} for AI image generation.
 *
 * ## Capabilities
 *
 * | Surface          | Function                       |
 * | ---------------- | ------------------------------ |
 * | List / read      | {@link listAssets} / {@link getAsset} |
 * | Soft delete      | {@link softDeleteAsset}        |
 * | Upload bytes     | {@link uploadAsset}            |
 * | Stock search     | {@link searchStock}            |
 * | Save stock asset | {@link saveStockToLibrary}     |
 * | Generate image   | {@link generateImage}          |
 * | Generate video   | {@link generateVideo} (queued stub — Sora/Veo) |
 * | Generate podcast | {@link generatePodcast}        |
 * | Send to bolt     | {@link sendToBolt}             |
 *
 * @packageDocumentation
 */

import type { Env } from '../types/env.js';
import { gatewayFetch } from './ai_gateway.js';
import { dbExecute, dbInsert, dbQuery, dbQueryOne, dbUpdate } from './db.js';
import { sanitizeLikeTerm } from './like_pattern.js';
import { callDallE3 } from './image_generation.js';
import { isSafeCrawlUrl } from './outbound_webhooks.js';

/** Realistic UA used for stock-downloads — most CDNs block default UAs. */
const STOCK_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Hard cap on a single stock candidate download (10 MB). */
const STOCK_MAX_BYTES = 10 * 1024 * 1024;

/** Asset row shape mirroring `media_assets` columns. */
export interface MediaAsset {
  id: string;
  org_id: string;
  created_by: string | null;
  kind: 'image' | 'video' | 'audio' | 'document' | 'other';
  source: 'uploaded' | 'generated' | 'stock' | 'imported';
  source_provider: string | null;
  name: string;
  mime: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  r2_key: string;
  thumbnail_r2_key: string | null;
  prompt: string | null;
  attribution: string | null;
  source_url: string | null;
  status: 'ready' | 'generating' | 'failed' | 'queued';
  status_message: string | null;
  metadata_json: string | null;
  tags_json: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

/** Candidate returned by {@link searchStock} — not yet downloaded. */
export interface StockCandidate {
  provider:
    | 'unsplash'
    | 'pexels'
    | 'pexels-video'
    | 'pixabay'
    | 'google-cse'
    | 'foursquare'
    | 'yelp';
  kind: 'image' | 'video';
  thumbUrl: string;
  fullUrl: string;
  title: string;
  attribution: string;
  sourceUrl: string;
  width?: number;
  height?: number;
  durationMs?: number;
}

/** Filters accepted by {@link listAssets}. */
export interface ListAssetOpts {
  kind?: MediaAsset['kind'];
  source?: MediaAsset['source'];
  search?: string;
  limit?: number;
  offset?: number;
}

/** Stock-search options. */
export interface SearchStockOpts {
  sources?: StockCandidate['provider'][];
  perPage?: number;
}

// ─── List / read ────────────────────────────────────────────

/**
 * List media assets for an org with optional filters.
 *
 * @example
 * ```ts
 * const images = await listAssets(env, orgId, { kind: 'image', limit: 50 });
 * ```
 */
export async function listAssets(
  env: Env,
  orgId: string,
  opts: ListAssetOpts = {},
): Promise<MediaAsset[]> {
  const { kind, source, search, limit = 50, offset = 0 } = opts;
  const wheres: string[] = ['org_id = ?', 'deleted_at IS NULL'];
  const params: unknown[] = [orgId];

  if (kind) {
    wheres.push('kind = ?');
    params.push(kind);
  }
  if (source) {
    wheres.push('source = ?');
    params.push(source);
  }
  if (search) {
    // Strip the user's %/_ wildcards so they match literally — an unstripped
    // wildcard-heavy term crashes the query ('LIKE pattern too complex').
    wheres.push('(name LIKE ? OR prompt LIKE ?)');
    const wildcard = `%${sanitizeLikeTerm(search)}%`;
    params.push(wildcard, wildcard);
  }

  const sql = `SELECT * FROM media_assets
     WHERE ${wheres.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`;
  params.push(Math.min(Math.max(limit, 1), 200), Math.max(offset, 0));

  const { data, error } = await dbQuery<MediaAsset>(env.DB, sql, params);
  if (error) {
    console.warn('[media] listAssets failed:', error);
    return [];
  }
  return data;
}

/** Fetch a single asset by id (org-scoped). Returns `null` when not found. */
export async function getAsset(env: Env, orgId: string, id: string): Promise<MediaAsset | null> {
  return dbQueryOne<MediaAsset>(
    env.DB,
    'SELECT * FROM media_assets WHERE id = ? AND org_id = ? AND deleted_at IS NULL',
    [id, orgId],
  );
}

/** Soft-delete an asset (sets `deleted_at`; preserves R2 object). */
export async function softDeleteAsset(
  env: Env,
  orgId: string,
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const now = Date.now();
  const { error, changes } = await dbExecute(
    env.DB,
    'UPDATE media_assets SET deleted_at = ?, updated_at = ? WHERE id = ? AND org_id = ? AND deleted_at IS NULL',
    [now, now, id, orgId],
  );
  if (error) return { ok: false, error };
  if (changes === 0) return { ok: false, error: 'Asset not found' };
  return { ok: true };
}

// ─── Upload ─────────────────────────────────────────────────

/** Arguments accepted by {@link uploadAsset}. */
export interface UploadAssetArgs {
  orgId: string;
  createdBy?: string | null;
  name: string;
  mime: string;
  bytes: ArrayBuffer;
  kind?: MediaAsset['kind'];
  source?: MediaAsset['source'];
  sourceProvider?: string;
  prompt?: string;
  attribution?: string;
  sourceUrl?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  metadata?: Record<string, unknown>;
  tags?: string[];
  status?: MediaAsset['status'];
  statusMessage?: string;
}

/**
 * Write bytes to R2 at `media/{orgId}/{assetId}/{safeName}` and insert the row.
 *
 * When `kind` is omitted it's inferred from `mime`. Returns the inserted row.
 */
export async function uploadAsset(env: Env, args: UploadAssetArgs): Promise<MediaAsset> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const safeName = safeFileName(args.name);
  const kind = args.kind ?? inferKind(args.mime, safeName);
  const source = args.source ?? 'uploaded';
  const r2Key = `media/${args.orgId}/${id}/${safeName}`;

  await env.SITES_BUCKET.put(r2Key, args.bytes, {
    httpMetadata: { contentType: args.mime || 'application/octet-stream' },
    customMetadata: {
      orgId: args.orgId,
      assetId: id,
      source,
      ...(args.sourceProvider ? { provider: args.sourceProvider } : {}),
    },
  });

  const row: MediaAsset = {
    id,
    org_id: args.orgId,
    created_by: args.createdBy ?? null,
    kind,
    source,
    source_provider: args.sourceProvider ?? null,
    name: args.name,
    mime: args.mime || 'application/octet-stream',
    size_bytes: args.bytes.byteLength,
    width: args.width ?? null,
    height: args.height ?? null,
    duration_ms: args.durationMs ?? null,
    r2_key: r2Key,
    thumbnail_r2_key: null,
    prompt: args.prompt ?? null,
    attribution: args.attribution ?? null,
    source_url: args.sourceUrl ?? null,
    status: args.status ?? 'ready',
    status_message: args.statusMessage ?? null,
    metadata_json: args.metadata ? JSON.stringify(args.metadata) : null,
    tags_json: args.tags ? JSON.stringify(args.tags) : null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };

  const { error } = await dbInsert(env.DB, 'media_assets', {
    ...row,
    // dbInsert tries to inject ISO timestamps for created_at/updated_at if
    // missing — we want the epoch-ms integers, so pass them explicitly above.
  });
  if (error) {
    // The R2 object was already written (external side-effect) but the D1 row
    // dropped — compensate by deleting the orphaned object BEFORE throwing, so a
    // failed upload never leaks an unreferenced R2 object (invisible to
    // listAssets, never cleaned up, wasted storage). Saga/compensating-action
    // pattern (cf. domains.ts hostname rollback). Best-effort: log if the cleanup
    // itself fails (the orphan then needs manual removal) but still throw.
    await env.SITES_BUCKET.delete(r2Key).catch((delErr) => {
      console.warn(
        JSON.stringify({
          level: 'warn',
          service: 'media',
          message: 'uploadAsset_r2_orphan_cleanup_failed',
          r2_key: r2Key,
          error: delErr instanceof Error ? delErr.message : String(delErr),
        }),
      );
    });
    console.warn('[media] uploadAsset insert failed:', error);
    throw new Error(`MEDIA_INSERT_FAILED: ${error}`);
  }
  return row;
}

// ─── Stock search ──────────────────────────────────────────

/**
 * Run a federated stock search across every configured provider in parallel.
 *
 * Per-source patterns mirror {@link image_discovery} (Unsplash / Pexels /
 * Pixabay / Google CSE / Foursquare / Yelp). Sources missing API keys are
 * silently skipped. Results are NOT downloaded — callers pick a candidate
 * and pass it to {@link saveStockToLibrary}.
 *
 * @returns deduplicated array of {@link StockCandidate}.
 */
export async function searchStock(
  env: Env,
  _orgId: string,
  query: string,
  opts: SearchStockOpts = {},
): Promise<StockCandidate[]> {
  const perPage = Math.min(Math.max(opts.perPage ?? 12, 1), 30);
  const allow = new Set<StockCandidate['provider']>(
    opts.sources && opts.sources.length > 0
      ? opts.sources
      : ['unsplash', 'pexels', 'pexels-video', 'pixabay', 'google-cse', 'foursquare', 'yelp'],
  );

  const fetchers: Promise<StockCandidate[]>[] = [];

  if (allow.has('unsplash') && env.UNSPLASH_ACCESS_KEY) {
    fetchers.push(searchUnsplash(query, perPage, env.UNSPLASH_ACCESS_KEY));
  }
  if (allow.has('pexels') && env.PEXELS_API_KEY) {
    fetchers.push(searchPexelsPhotos(query, perPage, env.PEXELS_API_KEY));
  }
  if (allow.has('pexels-video') && env.PEXELS_API_KEY) {
    fetchers.push(
      searchPexelsVideos(query, Math.max(Math.floor(perPage / 2), 1), env.PEXELS_API_KEY),
    );
  }
  if (allow.has('pixabay') && env.PIXABAY_API_KEY) {
    fetchers.push(searchPixabay(query, perPage, env.PIXABAY_API_KEY));
  }
  if (allow.has('google-cse') && env.GOOGLE_CSE_KEY && env.GOOGLE_CSE_CX) {
    fetchers.push(searchGoogleCSE(query, env.GOOGLE_CSE_KEY, env.GOOGLE_CSE_CX));
  }
  if (allow.has('foursquare') && env.FOURSQUARE_API_KEY) {
    fetchers.push(searchFoursquare(query, env.FOURSQUARE_API_KEY));
  }
  if (allow.has('yelp') && env.YELP_API_KEY) {
    fetchers.push(searchYelp(query, env.YELP_API_KEY));
  }

  if (fetchers.length === 0) return [];

  const settled = await Promise.allSettled(fetchers);
  const out: StockCandidate[] = [];
  const seen = new Set<string>();
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      for (const c of s.value) {
        if (seen.has(c.fullUrl)) continue;
        seen.add(c.fullUrl);
        out.push(c);
      }
    } else {
      console.warn('[media:searchStock] source failed:', s.reason);
    }
  }
  return out;
}

/**
 * SSRF-safe fetch for stock downloads. `saveStockToLibrary` pulls a client-supplied
 * `fullUrl` server-side and stores the body as a readable asset, so a plain `fetch(url)`
 * (default `redirect:'follow'`) is a TOCTOU SSRF: a host-allowlisted FIRST url can 302 to
 * an internal target (169.254.169.254 cloud-metadata, RFC1918) — exactly the redirect gap
 * documented in {@link isSafeCrawlUrl}. This follows redirects MANUALLY, re-validating
 * EVERY hop's host with {@link isSafeCrawlUrl} before connecting, capped at `maxRedirects`.
 *
 * @param url - the initial (already client-supplied) URL to download.
 * @param init - fetch init; `redirect` is forced to `'manual'` per hop.
 * @param maxRedirects - hop cap (default 4).
 * @returns the first non-3xx {@link Response} reached through only-safe hosts.
 * @throws {Error} `MEDIA_STOCK_UNSAFE_URL` when any hop resolves to a non-public host.
 * @throws {Error} `MEDIA_STOCK_TOO_MANY_REDIRECTS` past `maxRedirects` hops.
 */
async function fetchStockUrlNoSsrf(
  url: string,
  init: RequestInit,
  maxRedirects = 4,
): Promise<Response> {
  let target = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!isSafeCrawlUrl(target)) {
      throw new Error(`MEDIA_STOCK_UNSAFE_URL: ${target}`);
    }
    const res = await fetch(target, { ...init, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return res;
      target = new URL(location, target).toString(); // resolve relative Location
      continue;
    }
    return res;
  }
  throw new Error(`MEDIA_STOCK_TOO_MANY_REDIRECTS: ${url}`);
}

/** Download a stock candidate's `fullUrl` and persist via {@link uploadAsset}. */
export async function saveStockToLibrary(
  env: Env,
  args: { orgId: string; createdBy?: string | null; candidate: StockCandidate },
): Promise<MediaAsset> {
  const { candidate } = args;
  const res = await fetchStockUrlNoSsrf(candidate.fullUrl, {
    headers: { 'User-Agent': STOCK_UA, Accept: '*/*' },
  });
  if (!res.ok) {
    throw new Error(`MEDIA_STOCK_DOWNLOAD_FAILED: ${res.status} ${candidate.fullUrl}`);
  }
  const mime =
    res.headers.get('content-type') || (candidate.kind === 'video' ? 'video/mp4' : 'image/jpeg');
  const buf = await res.arrayBuffer();
  if (buf.byteLength > STOCK_MAX_BYTES) {
    throw new Error(`MEDIA_STOCK_TOO_LARGE: ${buf.byteLength} bytes exceeds ${STOCK_MAX_BYTES}`);
  }

  const ext = guessExtension(mime, candidate.fullUrl);
  const baseName = safeFileName(candidate.title || `${candidate.provider}-asset`);
  const name = baseName.endsWith(`.${ext}`) ? baseName : `${baseName}.${ext}`;

  return uploadAsset(env, {
    orgId: args.orgId,
    createdBy: args.createdBy ?? null,
    name,
    mime,
    bytes: buf,
    kind: candidate.kind,
    source: 'stock',
    sourceProvider: candidate.provider,
    attribution: candidate.attribution,
    sourceUrl: candidate.sourceUrl,
    width: candidate.width,
    height: candidate.height,
    durationMs: candidate.durationMs,
    metadata: { thumbUrl: candidate.thumbUrl, title: candidate.title },
  });
}

// ─── Generate image ────────────────────────────────────────

/** Arguments for {@link generateImage}. */
export interface GenerateImageArgs {
  orgId: string;
  createdBy?: string | null;
  prompt: string;
  size?: '1024x1024' | '1792x1024' | '1024x1792';
  n?: number;
}

/**
 * Generate N images via DALL·E 3 (sequential — DALL·E 3 only supports n=1
 * per request) and persist each as a new asset row.
 *
 * @throws `MEDIA_OPENAI_NOT_CONFIGURED` when `OPENAI_API_KEY` is missing.
 * @throws `MEDIA_GENERATION_FAILED` when all attempted generations return null.
 */
export async function generateImage(env: Env, args: GenerateImageArgs): Promise<MediaAsset[]> {
  if (!env.OPENAI_API_KEY) {
    throw new Error('MEDIA_OPENAI_NOT_CONFIGURED');
  }
  const n = Math.min(Math.max(args.n ?? 1, 1), 4);
  const size = args.size ?? '1024x1024';
  const [w, h] = size.split('x').map((v) => Number(v));

  const out: MediaAsset[] = [];
  for (let i = 0; i < n; i++) {
    const buf = await callDallE3(env, args.prompt, size);
    if (!buf) continue;
    const asset = await uploadAsset(env, {
      orgId: args.orgId,
      createdBy: args.createdBy ?? null,
      name: `generated-${Date.now()}-${i + 1}.png`,
      mime: 'image/png',
      bytes: buf,
      kind: 'image',
      source: 'generated',
      sourceProvider: 'dall-e-3',
      prompt: args.prompt,
      width: Number.isFinite(w) ? w : undefined,
      height: Number.isFinite(h) ? h : undefined,
    });
    out.push(asset);
  }

  if (out.length === 0) {
    throw new Error('MEDIA_GENERATION_FAILED');
  }
  return out;
}

// ─── Generate video (stub) ─────────────────────────────────

/** Arguments for {@link generateVideo}. */
export interface GenerateVideoArgs {
  orgId: string;
  createdBy?: string | null;
  prompt: string;
  durationSec?: number;
  model?: 'sora' | 'veo';
}

/**
 * Stub: enqueues a video-generation job by writing an asset row with
 * `status = 'queued'`.
 *
 * @remarks
 * TODO — when Sora / Veo public APIs land, the worker should POST the job
 * here and flip status to `generating` while polling. Current targets:
 *   - Sora  → `POST https://api.openai.com/v1/videos` (uses `SORA_API_KEY`
 *     or falls back to `OPENAI_API_KEY`).
 *   - Veo   → Google Vertex AI `models/veo-3.0-generate-001:generateVideos`
 *     (uses `VEO_API_KEY` + a service-account JWT).
 *
 * Operators see the queued asset in the library list and can either delete
 * or wait for the worker to flip status when the upstream call returns.
 */
export async function generateVideo(env: Env, args: GenerateVideoArgs): Promise<MediaAsset> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const model = args.model ?? 'sora';
  const placeholderName = `generated-video-${now}.mp4`;
  // No bytes yet — placeholder r2_key, no R2 object until the upstream API returns.
  const r2Key = `media/${args.orgId}/${id}/${placeholderName}`;

  const row: MediaAsset = {
    id,
    org_id: args.orgId,
    created_by: args.createdBy ?? null,
    kind: 'video',
    source: 'generated',
    source_provider: model,
    name: placeholderName,
    mime: 'video/mp4',
    size_bytes: 0,
    width: null,
    height: null,
    duration_ms: args.durationSec ? Math.round(args.durationSec * 1000) : null,
    r2_key: r2Key,
    thumbnail_r2_key: null,
    prompt: args.prompt,
    attribution: null,
    source_url: null,
    status: 'queued',
    status_message: `Queued for ${model} — pending public API availability`,
    metadata_json: JSON.stringify({ model, durationSec: args.durationSec ?? null }),
    tags_json: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };

  const { error } = await dbInsert(
    env.DB,
    'media_assets',
    row as unknown as Record<string, unknown>,
  );
  if (error) {
    console.warn('[media] generateVideo insert failed:', error);
    throw new Error(`MEDIA_INSERT_FAILED: ${error}`);
  }
  return row;
}

// ─── Generate podcast (TTS) ────────────────────────────────

/** Single line in a podcast script. */
export interface PodcastScriptLine {
  voice: string;
  text: string;
}

/** Arguments for {@link generatePodcast}. */
export interface GeneratePodcastArgs {
  orgId: string;
  createdBy?: string | null;
  title: string;
  script: PodcastScriptLine[];
  voiceProvider?: 'elevenlabs' | 'openai';
}

/**
 * Render each script segment via ElevenLabs or OpenAI TTS, concatenate the
 * resulting MP3 buffers naïvely, and persist as a single audio asset.
 *
 * @remarks
 * The concat is byte-level — MP3 frames stitch tolerably for stable
 * bitrates but a future iteration could use ffmpeg via a Container DO for
 * proper frame-aligned joins with silence-gap padding.
 *
 * @throws `MEDIA_NO_TTS_CONFIGURED` when neither key is present.
 * @throws `MEDIA_TTS_FAILED` when the upstream provider returns a non-2xx.
 */
export async function generatePodcast(env: Env, args: GeneratePodcastArgs): Promise<MediaAsset> {
  const provider = args.voiceProvider ?? (env.ELEVENLABS_API_KEY ? 'elevenlabs' : 'openai');
  if (provider === 'elevenlabs' && !env.ELEVENLABS_API_KEY) {
    throw new Error('MEDIA_NO_TTS_CONFIGURED');
  }
  if (provider === 'openai' && !env.OPENAI_API_KEY) {
    throw new Error('MEDIA_NO_TTS_CONFIGURED');
  }
  if (!args.script || args.script.length === 0) {
    throw new Error('MEDIA_PODCAST_EMPTY_SCRIPT');
  }

  const segments: ArrayBuffer[] = [];
  for (const line of args.script) {
    const buf =
      provider === 'elevenlabs'
        ? await ttsElevenLabs(env, line.voice, line.text)
        : await ttsOpenAI(env, line.voice, line.text);
    if (!buf) {
      throw new Error('MEDIA_TTS_FAILED');
    }
    segments.push(buf);
  }

  const total = segments.reduce((n, s) => n + s.byteLength, 0);
  const merged = new Uint8Array(total);
  let cursor = 0;
  for (const s of segments) {
    merged.set(new Uint8Array(s), cursor);
    cursor += s.byteLength;
  }

  const safeTitle = safeFileName(args.title || 'podcast');
  const name = safeTitle.endsWith('.mp3') ? safeTitle : `${safeTitle}.mp3`;

  return uploadAsset(env, {
    orgId: args.orgId,
    createdBy: args.createdBy ?? null,
    name,
    mime: 'audio/mpeg',
    bytes: merged.buffer,
    kind: 'audio',
    source: 'generated',
    sourceProvider: provider === 'elevenlabs' ? 'elevenlabs' : 'openai-tts',
    prompt: args.script.map((l) => `[${l.voice}] ${l.text}`).join('\n'),
    metadata: {
      title: args.title,
      segments: args.script.length,
      voices: [...new Set(args.script.map((l) => l.voice))],
    },
  });
}

// ─── Send to bolt iframe ───────────────────────────────────

/**
 * Mint an URL the frontend can postMessage to the bolt iframe.
 *
 * Tries to use an R2 signed URL when the binding supports it; otherwise
 * falls back to the worker-relayed `/api/media/assets/:id/raw` route so
 * the asset stays org-gated.
 */
export async function sendToBolt(
  env: Env,
  args: { orgId: string; assetId: string; siteSlug?: string },
): Promise<{ url: string; asset: MediaAsset }> {
  const asset = await getAsset(env, args.orgId, args.assetId);
  if (!asset) {
    throw new Error('MEDIA_ASSET_NOT_FOUND');
  }

  // Try R2 signed URL when available. Cloudflare's first-party R2 binding
  // does not expose `createSignedUrl` in all environments; degrade gracefully.
  const bucket = env.SITES_BUCKET as unknown as {
    createSignedUrl?: (key: string, opts: { expiresIn: number }) => Promise<string>;
  };
  if (typeof bucket.createSignedUrl === 'function') {
    try {
      const signed = await bucket.createSignedUrl(asset.r2_key, { expiresIn: 60 * 30 });
      return { url: signed, asset };
    } catch (err) {
      console.warn('[media:sendToBolt] signed-url mint failed, falling back:', err);
    }
  }

  // Fallback: worker-relayed raw stream URL. The frontend (admin app) knows
  // its own origin and stitches it in front before posting to the iframe.
  return { url: `/api/media/assets/${asset.id}/raw`, asset };
}

// ─── Helpers ───────────────────────────────────────────────

/** Infer `kind` from a MIME string + filename extension. */
function inferKind(mime: string, name: string): MediaAsset['kind'] {
  const m = (mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (
    m === 'application/pdf' ||
    m.startsWith('application/msword') ||
    m.includes('officedocument') ||
    m === 'text/plain' ||
    m === 'text/markdown'
  ) {
    return 'document';
  }
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif', 'heic'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'webm', 'mkv', 'm4v'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'].includes(ext)) return 'audio';
  if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md'].includes(ext)) {
    return 'document';
  }
  return 'other';
}

/** Sanitize a filename for use as an R2 key suffix. */
function safeFileName(input: string): string {
  const trimmed = (input || 'asset').trim().substring(0, 120);
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, '_') || 'asset';
}

/** Pick a reasonable extension from MIME + URL when the candidate lacks one. */
function guessExtension(mime: string, url: string): string {
  const m = (mime || '').toLowerCase();
  if (m === 'image/png') return 'png';
  if (m === 'image/jpeg' || m === 'image/jpg') return 'jpg';
  if (m === 'image/webp') return 'webp';
  if (m === 'image/gif') return 'gif';
  if (m === 'image/svg+xml') return 'svg';
  if (m === 'image/avif') return 'avif';
  if (m === 'video/mp4') return 'mp4';
  if (m === 'video/webm') return 'webm';
  if (m === 'audio/mpeg') return 'mp3';
  if (m === 'audio/wav') return 'wav';
  // Fall back to URL extension.
  const urlExt = url.split('?')[0].split('#')[0].split('.').pop()?.toLowerCase() ?? '';
  if (urlExt.length > 0 && urlExt.length <= 5) return urlExt;
  return 'bin';
}

// ─── Stock-search per-source helpers ───────────────────────

async function searchUnsplash(
  query: string,
  perPage: number,
  accessKey: string,
): Promise<StockCandidate[]> {
  try {
    const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=${perPage}&orientation=landscape`;
    const res = await fetch(url, { headers: { Authorization: `Client-ID ${accessKey}` } });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      results?: {
        urls?: { regular?: string; small?: string };
        description?: string;
        alt_description?: string;
        width?: number;
        height?: number;
        links?: { html?: string };
        user?: { name?: string };
      }[];
    };
    return (data.results ?? []).flatMap((p) => {
      const full = p.urls?.regular;
      if (!full) return [];
      return [
        {
          provider: 'unsplash' as const,
          kind: 'image' as const,
          thumbUrl: p.urls?.small ?? full,
          fullUrl: full,
          title: p.description || p.alt_description || 'Unsplash photo',
          attribution: p.user?.name ? `Photo by ${p.user.name} on Unsplash` : 'Unsplash',
          sourceUrl: p.links?.html ?? full,
          width: p.width,
          height: p.height,
        },
      ];
    });
  } catch (err) {
    console.warn('[media:unsplash] failed:', err);
    return [];
  }
}

async function searchPexelsPhotos(
  query: string,
  perPage: number,
  apiKey: string,
): Promise<StockCandidate[]> {
  try {
    const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${perPage}&orientation=landscape`;
    const res = await fetch(url, { headers: { Authorization: apiKey } });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      photos?: {
        src?: { large?: string; medium?: string };
        alt?: string;
        photographer?: string;
        url?: string;
        width?: number;
        height?: number;
      }[];
    };
    return (data.photos ?? []).flatMap((p) => {
      const full = p.src?.large;
      if (!full) return [];
      return [
        {
          provider: 'pexels' as const,
          kind: 'image' as const,
          thumbUrl: p.src?.medium ?? full,
          fullUrl: full,
          title: p.alt || 'Pexels photo',
          attribution: p.photographer ? `Photo by ${p.photographer} on Pexels` : 'Pexels',
          sourceUrl: p.url ?? full,
          width: p.width,
          height: p.height,
        },
      ];
    });
  } catch (err) {
    console.warn('[media:pexels-photos] failed:', err);
    return [];
  }
}

async function searchPexelsVideos(
  query: string,
  perPage: number,
  apiKey: string,
): Promise<StockCandidate[]> {
  try {
    const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=${perPage}&orientation=landscape`;
    const res = await fetch(url, { headers: { Authorization: apiKey } });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      videos?: {
        image?: string;
        video_files?: { link?: string; quality?: string; file_type?: string }[];
        url?: string;
        width?: number;
        height?: number;
        duration?: number;
        user?: { name?: string };
      }[];
    };
    return (data.videos ?? []).flatMap((v) => {
      const hd =
        v.video_files?.find((f) => f.quality === 'hd' && f.file_type === 'video/mp4') ??
        v.video_files?.[0];
      if (!hd?.link) return [];
      return [
        {
          provider: 'pexels-video' as const,
          kind: 'video' as const,
          thumbUrl: v.image ?? hd.link,
          fullUrl: hd.link,
          title: v.url
            ? `Pexels video — ${v.url.split('/').filter(Boolean).pop() ?? ''}`
            : 'Pexels video',
          attribution: v.user?.name ? `Video by ${v.user.name} on Pexels` : 'Pexels',
          sourceUrl: v.url ?? hd.link,
          width: v.width,
          height: v.height,
          durationMs: v.duration ? v.duration * 1000 : undefined,
        },
      ];
    });
  } catch (err) {
    console.warn('[media:pexels-videos] failed:', err);
    return [];
  }
}

async function searchPixabay(
  query: string,
  perPage: number,
  apiKey: string,
): Promise<StockCandidate[]> {
  try {
    const url = `https://pixabay.com/api/?key=${apiKey}&q=${encodeURIComponent(query)}&image_type=photo&orientation=horizontal&per_page=${perPage}&safesearch=true`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as {
      hits?: {
        largeImageURL?: string;
        webformatURL?: string;
        tags?: string;
        user?: string;
        pageURL?: string;
        imageWidth?: number;
        imageHeight?: number;
      }[];
    };
    return (data.hits ?? []).flatMap((h) => {
      const full = h.largeImageURL;
      if (!full) return [];
      return [
        {
          provider: 'pixabay' as const,
          kind: 'image' as const,
          thumbUrl: h.webformatURL ?? full,
          fullUrl: full,
          title: h.tags ?? 'Pixabay photo',
          attribution: h.user ? `Photo by ${h.user} on Pixabay` : 'Pixabay',
          sourceUrl: h.pageURL ?? full,
          width: h.imageWidth,
          height: h.imageHeight,
        },
      ];
    });
  } catch (err) {
    console.warn('[media:pixabay] failed:', err);
    return [];
  }
}

async function searchGoogleCSE(
  query: string,
  apiKey: string,
  cx: string,
): Promise<StockCandidate[]> {
  try {
    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('key', apiKey);
    url.searchParams.set('cx', cx);
    url.searchParams.set('q', query);
    url.searchParams.set('searchType', 'image');
    url.searchParams.set('num', '10');
    url.searchParams.set('imgSize', 'large');
    url.searchParams.set('safe', 'active');
    const res = await fetch(url.toString());
    if (!res.ok) return [];
    const data = (await res.json()) as {
      items?: {
        link?: string;
        title?: string;
        image?: { thumbnailLink?: string; contextLink?: string; width?: number; height?: number };
      }[];
    };
    return (data.items ?? []).flatMap((i) => {
      if (!i.link) return [];
      return [
        {
          provider: 'google-cse' as const,
          kind: 'image' as const,
          thumbUrl: i.image?.thumbnailLink ?? i.link,
          fullUrl: i.link,
          title: i.title ?? 'Web image',
          attribution: i.image?.contextLink
            ? `Source: ${i.image.contextLink}`
            : 'Google Image Search',
          sourceUrl: i.image?.contextLink ?? i.link,
          width: i.image?.width,
          height: i.image?.height,
        },
      ];
    });
  } catch (err) {
    console.warn('[media:google-cse] failed:', err);
    return [];
  }
}

async function searchFoursquare(query: string, apiKey: string): Promise<StockCandidate[]> {
  try {
    const searchUrl = `https://api.foursquare.com/v3/places/search?query=${encodeURIComponent(query)}&limit=1`;
    const searchRes = await fetch(searchUrl, {
      headers: { Authorization: apiKey, Accept: 'application/json' },
    });
    if (!searchRes.ok) return [];
    const search = (await searchRes.json()) as { results?: { fsq_id?: string; name?: string }[] };
    const venue = search.results?.[0];
    if (!venue?.fsq_id) return [];

    const photosRes = await fetch(
      `https://api.foursquare.com/v3/places/${venue.fsq_id}/photos?limit=10`,
      { headers: { Authorization: apiKey, Accept: 'application/json' } },
    );
    if (!photosRes.ok) return [];
    const photos = (await photosRes.json()) as { prefix?: string; suffix?: string }[];
    if (!Array.isArray(photos)) return [];

    return photos.flatMap((p) => {
      if (!p.prefix || !p.suffix) return [];
      const full = `${p.prefix}original${p.suffix}`;
      const thumb = `${p.prefix}300x300${p.suffix}`;
      return [
        {
          provider: 'foursquare' as const,
          kind: 'image' as const,
          thumbUrl: thumb,
          fullUrl: full,
          title: `Foursquare — ${venue.name ?? query}`,
          attribution: `Foursquare — ${venue.name ?? query}`,
          sourceUrl: full,
        },
      ];
    });
  } catch (err) {
    console.warn('[media:foursquare] failed:', err);
    return [];
  }
}

async function searchYelp(query: string, apiKey: string): Promise<StockCandidate[]> {
  try {
    const searchUrl = `https://api.yelp.com/v3/businesses/search?term=${encodeURIComponent(query)}&limit=1`;
    const searchRes = await fetch(searchUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!searchRes.ok) return [];
    const search = (await searchRes.json()) as {
      businesses?: { id?: string; name?: string; image_url?: string; photos?: string[] }[];
    };
    const biz = search.businesses?.[0];
    if (!biz) return [];

    const photos = new Set<string>();
    if (biz.image_url) photos.add(biz.image_url);
    for (const p of biz.photos ?? []) photos.add(p);

    if (biz.id) {
      try {
        const detail = await fetch(`https://api.yelp.com/v3/businesses/${biz.id}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (detail.ok) {
          const d = (await detail.json()) as { photos?: string[] };
          for (const p of d.photos ?? []) photos.add(p);
        }
      } catch {
        /* ignore */
      }
    }

    return [...photos].map((p) => ({
      provider: 'yelp' as const,
      kind: 'image' as const,
      thumbUrl: p,
      fullUrl: p,
      title: `Yelp — ${biz.name ?? query}`,
      attribution: `Yelp — ${biz.name ?? query}`,
      sourceUrl: p,
    }));
  } catch (err) {
    console.warn('[media:yelp] failed:', err);
    return [];
  }
}

// ─── TTS helpers ───────────────────────────────────────────

async function ttsElevenLabs(env: Env, voiceId: string, text: string): Promise<ArrayBuffer | null> {
  if (!env.ELEVENLABS_API_KEY) return null;
  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      },
    );
    if (!res.ok) {
      console.warn('[media:tts:elevenlabs] non-2xx:', res.status, await res.text().catch(() => ''));
      return null;
    }
    return res.arrayBuffer();
  } catch (err) {
    console.warn('[media:tts:elevenlabs] failed:', err);
    return null;
  }
}

async function ttsOpenAI(env: Env, voice: string, text: string): Promise<ArrayBuffer | null> {
  if (!env.OPENAI_API_KEY) return null;
  try {
    const { response: res } = await gatewayFetch(env, 'openai', '/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1-hd',
        voice,
        input: text,
        response_format: 'mp3',
      }),
    });
    if (!res.ok) {
      console.warn('[media:tts:openai] non-2xx:', res.status, await res.text().catch(() => ''));
      return null;
    }
    return res.arrayBuffer();
  } catch (err) {
    console.warn('[media:tts:openai] failed:', err);
    return null;
  }
}
