/**
 * page_audio.ts — "Listen to this page" AI audio for generated sites.
 *
 * The visitor-facing PageAudio widget used to read the WHOLE page with the
 * browser's on-device speechSynthesis. Per Brian (2026-09): AI-SUMMARIZE the
 * page first, then speak the summary with an OPEN-SOURCE TTS — `@cf/myshell-ai/melotts`
 * (MeloTTS, MIT) on Workers AI. MeloTTS is the best OSS TTS we can use here: same
 * OSS quality tier as a self-hosted Piper container, but zero infrastructure +
 * edge-native (no container to stand up / maintain). (Whisper is speech-to-TEXT,
 * so it can't generate audio.)
 *
 * Pipeline: page text → Llama 3.3 70B (FP8, instant) warm spoken summary → MeloTTS
 * WAV → cached in R2 keyed by content hash. Only the FIRST visitor of a given page
 * version pays the summarize+TTS cost; everyone after streams the cached WAV. Every
 * AI/TTS fault returns `{ audioUrl: null }` so the widget degrades to on-device
 * speechSynthesis — a broken model must never break the button.
 */
import { z } from 'zod';
import type { Env } from '../types/env.js';
import { dbQueryOne } from './db.js';

/** Get-or-create result. `audioUrl: null` ⇒ caller should fall back to speechSynthesis. */
export interface PageAudioResult {
  audioUrl: string | null;
  summary: string | null;
  cached: boolean;
}

/** Page text fed to the summarizer is capped so a huge page can't blow up the prompt. */
const MAX_INPUT = 12000;
/** Spoken summary fed to TTS is capped so the WAV stays a bounded size. */
const MAX_SUMMARY = 700;
/** Summarizer model — free/instant FP8 Llama per model-routing. */
const SUMMARY_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
/** OSS TTS model — MeloTTS (MIT) on Workers AI. */
const TTS_MODEL = '@cf/myshell-ai/melotts';
const R2_PREFIX = 'page-audio';

const wavKey = (slug: string, hash: string): string => `${R2_PREFIX}/${slug}/${hash}.wav`;
const txtKey = (slug: string, hash: string): string => `${R2_PREFIX}/${slug}/${hash}.txt`;
const publicUrl = (slug: string, hash: string): string =>
  `/api/page-audio/${encodeURIComponent(slug)}/a/${hash}.wav`;

/** Zod schema for the POST /api/page-audio/:slug body (shared FE↔BE contract). */
export const PageAudioInputSchema = z.object({
  route: z.string().max(512).optional().default('/'),
  text: z.string().trim().min(1).max(MAX_INPUT),
});
export type PageAudioInput = z.infer<typeof PageAudioInputSchema>;

/** Collapse whitespace + hard-cap length. */
function normalize(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_INPUT);
}

/**
 * Trim to ≤max chars WITHOUT cutting mid-word — prefer the last sentence boundary,
 * else the last whole word. Keeps the spoken audio from ending on "…strength a".
 */
function trimToSentence(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (stop > max * 0.5) return cut.slice(0, stop + 1).trim();
  return cut.replace(/\s+\S*$/, '').trim(); // drop the dangling partial word
}

/** Stable 20-hex-char content id for (slug, route, text) → one cached object per page version. */
async function contentHash(slug: string, route: string, text: string): Promise<string> {
  const data = new TextEncoder().encode(`${slug}|${route}|${text}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 20);
}

/**
 * AI-summarize a page into a warm, SPOKEN overview for narration — never a
 * verbatim read of the whole page (that's the point of this feature).
 *
 * @param env - Worker bindings (needs `AI`).
 * @param text - The page's readable text.
 * @returns A ≤{@link MAX_SUMMARY}-char spoken summary, or '' on model fault.
 * @example
 * await summarizeForAudio(env, 'Ironhaus is a strength gym in Houston…')
 * // → 'Welcome to Ironhaus, a strength and conditioning gym in Houston…'
 */
async function summarizeForAudio(env: Env, text: string): Promise<string> {
  const system =
    'You narrate a business web page for a visitor listening hands-free. Write a warm, ' +
    'natural, SPOKEN summary of the page in 4 to 6 short sentences. Speak about the business ' +
    'directly and invitingly. No markdown, no lists, no headings, no emojis, and no ' +
    '"this page" / "this website" meta-talk — just the spoken words a friendly host would say.';
  const result = (await env.AI.run(SUMMARY_MODEL, {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: text },
    ],
    max_tokens: 200,
  })) as { response?: string };
  const summary = (result && typeof result.response === 'string' ? result.response : '')
    .replace(/\s+/g, ' ')
    .trim();
  return trimToSentence(summary, MAX_SUMMARY);
}

/**
 * Speak text with MeloTTS (OSS) → WAV bytes.
 *
 * @param env - Worker bindings (needs `AI`).
 * @param text - The (already-summarized) spoken text.
 * @returns WAV audio bytes.
 * @throws `PAGE_AUDIO_TTS_EMPTY` when the model returns no audio.
 */
async function synthesizeWav(env: Env, text: string): Promise<Uint8Array> {
  const result = (await env.AI.run(TTS_MODEL, { prompt: text, lang: 'en' })) as { audio?: string };
  const b64 = result && typeof result.audio === 'string' ? result.audio : '';
  if (!b64) throw new Error('PAGE_AUDIO_TTS_EMPTY');
  return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
}

/**
 * Cache-only lookup — returns the cached audio for a page version, or null on a
 * miss. Cheap (one R2 head); lets the route serve returning visitors WITHOUT
 * counting against the generate rate limit.
 */
export async function lookupPageAudio(
  env: Env,
  args: { slug: string; route: string; text: string },
): Promise<PageAudioResult | null> {
  const text = normalize(args.text);
  const route = (args.route || '/').slice(0, 512) || '/';
  const hash = await contentHash(args.slug, route, text);
  const head = await env.SITES_BUCKET.head(wavKey(args.slug, hash)).catch(() => null);
  if (!head) return null;
  const sidecar = await env.SITES_BUCKET.get(txtKey(args.slug, hash)).catch(() => null);
  const summary = sidecar ? await sidecar.text().catch(() => null) : null;
  return { audioUrl: publicUrl(args.slug, hash), summary, cached: true };
}

/**
 * Get-or-create the summarized audio for a page. Idempotent: same (slug, route,
 * text) → one R2 object. Never throws — returns `{ audioUrl: null }` on any
 * AI/TTS fault so the widget degrades to on-device speechSynthesis.
 */
export async function getOrCreatePageAudio(
  env: Env,
  args: { slug: string; route: string; text: string },
): Promise<PageAudioResult> {
  const cached = await lookupPageAudio(env, args);
  if (cached) return cached;

  const text = normalize(args.text);
  const route = (args.route || '/').slice(0, 512) || '/';
  const hash = await contentHash(args.slug, route, text);
  try {
    const summary = await summarizeForAudio(env, text);
    if (!summary) {
      // Fail-soft, but OBSERVABLE: an empty summary (Workers AI summary model faulted / returned a
      // non-string) previously returned null silently. Log it so a dead "Listen" feature has signal.
      console.warn(
        JSON.stringify({
          level: 'warn',
          message: 'page_audio.summary_empty',
          slug: args.slug,
          route,
        }),
      );
      return { audioUrl: null, summary: null, cached: false };
    }
    const wav = await synthesizeWav(env, summary);
    await env.SITES_BUCKET.put(wavKey(args.slug, hash), wav, {
      httpMetadata: {
        contentType: 'audio/wav',
        cacheControl: 'public, max-age=31536000, immutable',
      },
    });
    await env.SITES_BUCKET.put(txtKey(args.slug, hash), summary, {
      httpMetadata: { contentType: 'text/plain; charset=utf-8' },
    });
    return { audioUrl: publicUrl(args.slug, hash), summary, cached: false };
  } catch (err) {
    // Fail-soft (the widget degrades to on-device speechSynthesis) BUT now OBSERVABLE. The empty
    // catch here silently swallowed a FLEET-WIDE outage — Workers AI MeloTTS (`@cf/myshell-ai/melotts`)
    // returning `AiError: Internal server error (3043)` killed every site's "Listen to this page" with
    // ZERO signal (found 2026-09-16). Structured-log so a TTS/summary outage surfaces in Workers logs.
    console.warn(
      JSON.stringify({
        level: 'warn',
        message: 'page_audio.generate_failed',
        slug: args.slug,
        route,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      }),
    );
    return { audioUrl: null, summary: null, cached: false };
  }
}

/**
 * Stream a previously-generated WAV from R2. Returns null when absent or when the
 * filename doesn't match the expected `<20-hex>.wav` shape (path-escape guard).
 */
export async function fetchPageAudioObject(
  env: Env,
  slug: string,
  file: string,
): Promise<R2ObjectBody | null> {
  if (!/^[a-f0-9]{20}\.wav$/.test(file)) return null;
  const hash = file.replace(/\.wav$/, '');
  return env.SITES_BUCKET.get(wavKey(slug, hash));
}

/** Cheap existence check — the slug must map to a real (non-deleted) site. */
export async function siteExistsForSlug(env: Env, slug: string): Promise<boolean> {
  const row = await dbQueryOne<{ id: string }>(
    env.DB,
    'SELECT id FROM sites WHERE slug = ? AND deleted_at IS NULL',
    [slug],
  ).catch(() => null);
  return !!row;
}
