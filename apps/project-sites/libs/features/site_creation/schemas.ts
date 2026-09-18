/**
 * @module libs/features/site_creation/schemas
 *
 * @description
 * Zod boundary schemas for the site-creation cluster. The create-from-search body
 * is the PRIMARY conversion-funnel entry point (`POST /api/sites/create-from-search`,
 * mounted always-live at `src/index.ts`), so its boundary MUST be validated — the
 * handler previously read it as a raw `as CreateFromSearchBody` cast with zero runtime
 * narrowing (AL-724). Both payload shapes are accepted:
 * - v1 (flat):   `{ business_name, business_address, business_phone, google_place_id, … }`
 * - v2 (nested): `{ mode, business: { name, address, types, … }, additional_context }`
 *
 * @packageDocumentation
 */

import { z } from 'zod';

/**
 * Nested business object sent by the homepage SPA (v2 payload). `.passthrough()` tolerates
 * the extra fields Google Places attaches — only the TYPES of the known fields are enforced,
 * so an unexpected `rating`/`user_ratings_total` never rejects a real submission.
 */
export const businessPayloadSchema = z
  .object({
    name: z.string(),
    address: z.string().optional(),
    place_id: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().optional(),
    hours: z.string().optional(),
    website: z.string().optional(),
    /** Some callers nest the vertical here instead of the flat `business_category`. */
    category: z.string().optional(),
    types: z.array(z.string()).optional(),
  })
  .passthrough();

/**
 * Request body for `POST /api/sites/create-from-search`. Every field is an OPTIONAL STRING
 * (the handler enforces `business_name`/`business.name` presence + length itself) — the point
 * of the schema is TYPE safety at the boundary: a wrong-typed field (e.g. `business_type: 12345`)
 * must fail-soft as a `400`, never (a) crash 500 via `(12345).trim()` on a numeric name, nor
 * (b) lying-success persist a number into the `business_category` TEXT column that then throws
 * downstream when the vertical classifier calls `.toLowerCase()` (AL-724). `.passthrough()`
 * keeps the polymorphic v1+v2 keys tolerant of extras.
 */
export const createFromSearchSchema = z
  .object({
    /** @deprecated v1 flat key — prefer `business.name`. */
    business_name: z.string().optional(),
    /** @deprecated v1 flat key — prefer `business.address`. */
    business_address: z.string().optional(),
    business_hours: z.string().optional(),
    business_phone: z.string().optional(),
    business_email: z.string().optional(),
    business_category: z.string().optional(),
    business_type: z.string().optional(),
    /** @deprecated v1 flat key — prefer `business.place_id`. */
    google_place_id: z.string().optional(),
    additional_context: z.string().optional(),
    business: businessPayloadSchema.optional(),
    /** Creation mode: 'business' or 'custom'. */
    mode: z.string().optional(),
    /**
     * Explicit visual personality the /create form chose (one of the 16 theme-style presets).
     * Authoritative when a valid preset name; otherwise the workflow re-derives (AL-467).
     */
    theme_style: z.string().optional(),
  })
  .passthrough();

/** Inferred body type — never hand-maintained alongside the schema (zod-everywhere). */
export type CreateFromSearchBody = z.infer<typeof createFromSearchSchema>;
