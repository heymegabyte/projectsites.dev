import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { Env, Variables } from '../../../src/types/env.js';
import { unauthorized, notFound } from '../../../src/lib/feature_guard.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import { parseContent, ContentImportError } from '../../../src/services/content_import.js';
import { FLAG_KEY } from './service.js';
import { ContentImportParseRequestSchema, ContentImportParseResponseSchema } from './schemas.js';

type AppContext = { Bindings: Env; Variables: Variables };
export const contentImport = new Hono<AppContext>();

/** Structured JSON log (charter: every path a fire touches emits correlated logs). */
function log(
  c: import('hono').Context<AppContext>,
  event: string,
  extra: Record<string, unknown>,
): void {
  console.warn(
    JSON.stringify({
      level: 'info',
      service: 'content_import',
      event,
      requestId: c.get('requestId') ?? null,
      orgId: c.get('orgId') ?? null,
      ...extra,
    }),
  );
}

/** Auth + flag gate — returns a Response to short-circuit, or null to proceed. Flag off → 404 (dark, never 403). */
async function guard(c: import('hono').Context<AppContext>): Promise<Response | null> {
  const userId = c.get('userId');
  if (!userId) return unauthorized(c);
  const on = await isFlagOn(c.env, FLAG_KEY, { userId, orgId: c.get('orgId') }).catch(() => false);
  if (!on) return notFound(c);
  return null;
}

/**
 * POST /api/content-import/parse — parse a platform export (WordPress/Squarespace/Wix/Webflow/
 * CSV/RSS) into normalized ContentItem[] the owner can seed into their site. Wraps the pure,
 * unit-tested parsers in `src/services/content_import.ts` — previously reachable by NO route.
 * A malformed export → 400 (typed CONTENT_IMPORT_PARSE_ERROR); flag off → 404; unauth → 401.
 */
contentImport.post(
  '/api/content-import/parse',
  zValidator('json', ContentImportParseRequestSchema),
  async (c) => {
    const blocked = await guard(c);
    if (blocked) return blocked;
    const { source, raw } = c.req.valid('json');
    try {
      const items = parseContent(source, raw);
      log(c, 'parsed', { source, count: items.length });
      return c.json({
        data: ContentImportParseResponseSchema.parse({ source, count: items.length, items }),
      });
    } catch (err) {
      // A parser rejecting malformed input is a CLIENT error (400), not a 500.
      if (err instanceof ContentImportError) {
        log(c, 'parse_failed', { source, error: err.message });
        return c.json({ error: { code: 'CONTENT_IMPORT_PARSE_ERROR', message: err.message } }, 400);
      }
      log(c, 'parse_error', { source, error: err instanceof Error ? err.message : String(err) });
      return c.json(
        { error: { code: 'INTERNAL_ERROR', message: 'Could not parse the export' } },
        500,
      );
    }
  },
);
