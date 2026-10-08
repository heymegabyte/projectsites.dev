/**
 * @module libs/features/site_functions/schemas
 * @description Zod schemas for the Functions discovery endpoint — the UI-list
 * shape of a site's code-defined Functions (Workers-for-Platforms). Single
 * source of truth for this feature's contract (per [[zod-everywhere]]).
 *
 * DOCTRINE (ADR-0035, docs/FUNCTIONS-CONVERGENCE.md): Functions are code-defined
 * — owners author a `functions/` folder in the editor, NOT a dashboard form. This
 * endpoint is a READ/MANAGE VIEW: it lists what the site's functions plane HAS
 * (its deployed Functions Worker + its scheduled functions) with real deploy
 * status, sourced from authoritative persisted signals — NEVER a fabricated
 * per-route CRUD list (mirrors the honest `backend_inventory` stance: we do not
 * invent data we cannot truthfully source).
 */
import { z } from 'zod';

/**
 * The KIND of function entry the panel lists. A site's code-defined functions
 * surface as TWO honest, persisted kinds:
 *  - `http` — the site's bundled `functions/` HTTP worker deployed on WfP (one
 *    deployment unit; its routes are authored in the `functions/` folder). We
 *    surface its real deploy status + script name + bundle size, never a guessed
 *    per-route list (the route manifest isn't persisted server-side).
 *  - `scheduled` — one row per cron the site declared in `functions/_scheduled.*`
 *    (real `site_functions_schedules` rows; WfP has no native cron so the
 *    platform cron dispatcher fires them).
 */
export const FunctionKindSchema = z.enum(['http', 'scheduled']);
export type FunctionKind = z.infer<typeof FunctionKindSchema>;

/** The deploy status of a function on Workers-for-Platforms. */
export const FunctionStatusSchema = z.enum(['deployed', 'not_deployed']);
export type FunctionStatus = z.infer<typeof FunctionStatusSchema>;

/**
 * One code-defined Function entry, shaped for the Functions panel list. Every
 * field is sourced from a REAL persisted signal — never fabricated.
 */
export const SiteFunction = z
  .object({
    /** Stable id for the row (the WfP script name for `http`, a `cron:<expr>` key for `scheduled`). */
    id: z.string().min(1),
    /** `http` (the bundled functions worker) | `scheduled` (a declared cron). */
    kind: FunctionKindSchema,
    /** Human label — the WfP script name, or the cron expression for a scheduled function. */
    name: z.string().min(1),
    /** `deployed` when a live functions worker backs it on WfP, else `not_deployed`. */
    status: FunctionStatusSchema,
    /** For `scheduled`: the 5-field cron expression. `null` for `http`. */
    cron: z.string().nullable(),
    /**
     * For `http`: the deployed bundle size in bytes (from the R2 last-good bundle),
     * `null` when no bundle is live. Always `null` for `scheduled`.
     */
    bundleBytes: z.number().int().nonnegative().nullable(),
    /** ISO timestamp the functions worker was last deployed, or `null` when never / removed. */
    deployed_at: z.string().nullable(),
  })
  .strict();
export type SiteFunction = z.infer<typeof SiteFunction>;

/**
 * Response envelope for GET /api/sites/:siteId/functions.
 *
 * `functionsDeployed` is the authoritative `sites.functions_deployed_at` signal
 * (does a live `functions/` worker back this site?). `wfpConfigured` is false on
 * a deployment where Workers-for-Platforms isn't provisioned — the panel then
 * explains the deploy plane isn't available rather than showing a false empty.
 */
export const ListFunctionsResponse = z
  .object({
    data: z.array(SiteFunction),
    /** Whether a live Functions Worker is deployed for this site (the deploy signal). */
    functionsDeployed: z.boolean(),
    /** Whether Workers-for-Platforms is provisioned on this deployment. */
    wfpConfigured: z.boolean(),
  })
  .strict();
export type ListFunctionsResponse = z.infer<typeof ListFunctionsResponse>;
