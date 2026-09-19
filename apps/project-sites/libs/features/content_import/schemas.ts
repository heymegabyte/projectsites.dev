import { z } from 'zod';

/**
 * Zod boundary for the content-import parse endpoint. Wraps the pure parsers in
 * `src/services/content_import.ts` (WordPress/Squarespace/Wix/Webflow/CSV/RSS exports →
 * normalized ContentItem[]) — previously tested but consumed by NO route.
 */

/** Supported export platforms — kept in lockstep with `ContentSource` in the parser service. */
export const ContentSourceSchema = z.enum([
  'wordpress',
  'squarespace',
  'wix',
  'webflow',
  'csv',
  'rss',
]);
export type ContentSource = z.infer<typeof ContentSourceSchema>;

/**
 * The raw export payload. Capped at 200_000 chars so a request stays under the Worker's global
 * 256 KB body limit (payload_limit middleware) and returns a clear 400 instead of an opaque 413.
 * Large multi-MB exports are a follow-on (R2 upload → parse), tracked in the feature README.
 */
export const ContentImportParseRequestSchema = z
  .object({
    source: ContentSourceSchema,
    raw: z
      .string()
      .min(1, 'raw export payload is required')
      .max(200_000, 'export too large — max 200 KB'),
  })
  .strict();
export type ContentImportParseRequest = z.infer<typeof ContentImportParseRequestSchema>;

/** One normalized content item (mirrors ContentItem in the parser service). */
export const ContentItemSchema = z.object({
  title: z.string(),
  body: z.string(),
  slug: z.string(),
  publishedAt: z.string(),
  author: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
export type ContentItem = z.infer<typeof ContentItemSchema>;

/** The parse response: the normalized items + a convenience count. */
export const ContentImportParseResponseSchema = z.object({
  source: ContentSourceSchema,
  count: z.number().int().nonnegative(),
  items: z.array(ContentItemSchema),
});
export type ContentImportParseResponse = z.infer<typeof ContentImportParseResponseSchema>;
