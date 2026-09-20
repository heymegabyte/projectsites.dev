/**
 * editor_vision_qa — in-editor AI vision critique (no Docker).
 *
 * `POST /api/vision-qa { url }` screenshots the URL via Cloudflare Browser
 * Rendering (`@cloudflare/playwright`) and scores it 1-10 across layout /
 * typography / color / imagery / whitespace / distinctiveness with the Workers
 * AI Llama 4 Scout vision model, returning `{ score, findings[] }` with inline
 * fix suggestions. Flag-gated by `editor_vision_qa` (404 when off). Reuses the
 * scoring shape from the snapshot-quality workflow; here the screenshot is taken
 * on-demand from a live URL instead of read from R2.
 */

import { Hono } from 'hono';
import type { BrowserWorker } from '@cloudflare/playwright';
import type { Env, Variables } from '../types/env.js';
import { isFlagOn } from '../modules/feature_flags/services.js';
import { sanitizeUrl } from '../services/url_sanitizer.js';

const VISION_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';

export interface VisionScore {
  layout: number | null;
  typography: number | null;
  color: number | null;
  imagery: number | null;
  whitespace: number | null;
  distinctiveness: number | null;
  overall: number | null;
  notes: string;
  model: string;
}

const AXIS_HINTS: Record<string, string> = {
  layout: 'tighten the grid / alignment and visual hierarchy',
  typography: 'fix the type scale, line-length, or weight contrast',
  color: 'raise contrast and tame the palette (WCAG AA)',
  imagery: 'use sharper, on-brand, non-stock imagery',
  whitespace: 'add breathing room — increase section padding',
  distinctiveness: 'push the design further from a generic template',
};

/**
 * SSRF guard for the vision-qa target URL. vision-qa drives a real headless browser to
 * `page.goto()` the caller-supplied URL and returns an AI description of the render, so an
 * unguarded value lets an authenticated caller screenshot internal / private / cloud-metadata
 * hosts and read them back (info-leak SSRF — the `ssrf-redirect-follow` class). Route the URL
 * through the canonical `sanitizeUrl` SSOT (scheme + RFC-1918/loopback/link-local `isPrivateHost`
 * + metadata-host block) and require public `https` (vision-qa targets public sites). Pure +
 * deterministic (exported for unit tests).
 *
 * @param raw - The caller-supplied URL string.
 * @returns `{ ok, url }` — `url` is the sanitized public https URL when ok, else `{ ok:false, url:null }`.
 * @remarks Residual: a PUBLIC hostname that DNS-resolves to a private IP (rebinding) is not caught
 * here — a string guard has no resolver, and CF Browser Rendering performs the actual DNS + fetch.
 * @example
 * assertPublicHttpsUrl('https://example.com');       // { ok: true, url: 'https://example.com/' }
 * assertPublicHttpsUrl('https://169.254.169.254/');  // { ok: false, url: null }  (metadata)
 * assertPublicHttpsUrl('http://example.com');        // { ok: false, url: null }  (https-only)
 */
export function assertPublicHttpsUrl(raw: string): { ok: boolean; url: string | null } {
  const clean = sanitizeUrl((raw ?? '').trim());
  if (!clean.valid || !clean.url || !/^https:/i.test(clean.url)) return { ok: false, url: null };
  return { ok: true, url: clean.url };
}

/**
 * Turn a rubric into plain-English findings: any axis scoring below 7 becomes a
 * fix suggestion. Pure + deterministic (exported for unit tests).
 */
export function rubricToFindings(
  score: VisionScore,
): Array<{ axis: string; value: number; suggestion: string }> {
  const axes: Array<keyof VisionScore> = [
    'layout',
    'typography',
    'color',
    'imagery',
    'whitespace',
    'distinctiveness',
  ];
  const out: Array<{ axis: string; value: number; suggestion: string }> = [];
  for (const a of axes) {
    const v = score[a];
    if (typeof v === 'number' && v < 7) {
      out.push({ axis: a, value: v, suggestion: AXIS_HINTS[a] ?? 'improve this dimension' });
    }
  }
  // Worst-first so the highest-impact fixes lead.
  return out.sort((x, y) => x.value - y.value);
}

function bytesToDataUrl(bytes: Uint8Array, contentType = 'image/png'): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK)
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return `data:${contentType};base64,${btoa(binary)}`;
}

async function scoreImageBytes(env: Env, bytes: Uint8Array): Promise<VisionScore> {
  const fallback = (notes: string): VisionScore => ({
    layout: null,
    typography: null,
    color: null,
    imagery: null,
    whitespace: null,
    distinctiveness: null,
    overall: null,
    notes,
    model: VISION_MODEL,
  });
  if (!env.AI) return fallback('model_unavailable');
  const system =
    'You are a senior brand designer scoring website screenshots 1-10 across: ' +
    'layout, typography, color, imagery, whitespace, distinctiveness. ' +
    'Reply JSON exactly: {layout, typography, color, imagery, whitespace, distinctiveness, overall, notes}.';
  try {
    const response = (await env.AI.run(VISION_MODEL, {
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Score this page screenshot and reply with the JSON rubric only.',
            },
            { type: 'image_url', image_url: { url: bytesToDataUrl(bytes) } },
          ],
        },
      ],
      max_tokens: 512,
    })) as { response?: string } | string;
    const raw =
      typeof response === 'string'
        ? response
        : typeof response?.response === 'string'
          ? response.response
          : '';
    if (!raw) return fallback('empty_response');
    const cleaned = raw
      .replace(/```json\s*/gi, '')
      .replace(/```/g, '')
      .trim();
    const a = cleaned.indexOf('{');
    const b = cleaned.lastIndexOf('}');
    if (a === -1 || b <= a) return fallback('parse_failed');
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(cleaned.slice(a, b + 1)) as Record<string, unknown>;
    } catch {
      return fallback('parse_failed');
    }
    const rubric =
      (parsed.score as Record<string, unknown>) ||
      (parsed.rubric as Record<string, unknown>) ||
      parsed;
    const num = (k: string): number | null => {
      const v = rubric[k];
      if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.min(10, v));
      if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v)))
        return Math.max(0, Math.min(10, Number(v)));
      return null;
    };
    const axes = {
      layout: num('layout'),
      typography: num('typography'),
      color: num('color'),
      imagery: num('imagery'),
      whitespace: num('whitespace'),
      distinctiveness: num('distinctiveness'),
    };
    const present = Object.values(axes).filter((v): v is number => v !== null);
    const overall = present.length
      ? Math.round((present.reduce((s, v) => s + v, 0) / present.length) * 10) / 10
      : null;
    return {
      ...axes,
      overall,
      notes: typeof rubric.notes === 'string' ? rubric.notes : '',
      model: VISION_MODEL,
    };
  } catch (err) {
    return fallback(`vision_failed: ${(err as Error).message}`.slice(0, 200));
  }
}

async function screenshot(env: Env, url: string): Promise<Uint8Array | null> {
  if (!env.BROWSER) return null;
  const { launch } = await import('@cloudflare/playwright');
  const browser = await launch(env.BROWSER as BrowserWorker);
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 25_000 });
    const buf = await page.screenshot({ fullPage: false });
    return new Uint8Array(buf);
  } finally {
    await browser.close();
  }
}

export const visionQa = new Hono<{ Bindings: Env; Variables: Variables }>();

visionQa.post('/api/vision-qa', async (c) => {
  const on = await isFlagOn(c.env, 'editor_vision_qa', {
    orgId: c.get('orgId'),
    siteId: c.req.query('site_id') ?? undefined,
    userId: c.get('userId'),
  });
  if (!on) return c.notFound();

  const body = (await c.req.json().catch(() => ({}))) as { url?: string };
  // SSRF guard (AL-843): sanitize the caller URL BEFORE the headless-browser goto — block
  // private/loopback/link-local/metadata hosts + require public https (see assertPublicHttpsUrl).
  const guard = assertPublicHttpsUrl(body.url ?? '');
  if (!guard.ok)
    return c.json(
      { error: { code: 'BAD_REQUEST', message: 'A valid public https url is required.' } },
      400,
    );
  const url = guard.url as string;

  const bytes = await screenshot(c.env, url).catch(() => null);
  if (!bytes)
    return c.json(
      { score: null, findings: [], notes: 'Browser Rendering binding unavailable.' },
      200,
    );

  const score = await scoreImageBytes(c.env, bytes);
  return c.json({ score, findings: rubricToFindings(score) });
});
