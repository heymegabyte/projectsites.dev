/**
 * @module libs/features/platform_mcp/schemas
 * @description Zod contracts for the platform-level MCP server — the JSON-RPC 2.0
 * envelope plus every tool's input shape. One schema → runtime validation →
 * advertised `inputSchema` in `tools/list`. No hand-kept second copy.
 */
import { z } from 'zod';

/** JSON-RPC 2.0 request envelope accepted at POST /api/mcp. */
export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

/** `tools/call` params. */
export const ToolCallParamsSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.unknown()).default({}),
});

// ── Tool input schemas (also serialized into tools/list inputSchema) ──────────
export const ListSitesInput = z.object({
  limit: z.number().int().min(1).max(100).default(50),
});
export const GetSiteInput = z.object({
  site_id: z.string().min(1),
});
export const BuildStatusInput = z.object({
  site_id: z.string().min(1),
});

/**
 * `deploy_site` input. Hardened against R2 path traversal + resource exhaustion:
 * each `path` is relative, slash-normalized, and may not escape the site prefix
 * (no `..` segments, no leading `/`, no backslashes, no protocol). Bounds cap
 * file count + per-file + total size so a single token can't exhaust the Worker.
 */
export const DEPLOY_MAX_FILES = 500;
export const DEPLOY_MAX_FILE_BYTES = 2_000_000; // 2 MB per file
export const DEPLOY_MAX_TOTAL_BYTES = 20_000_000; // 20 MB per deploy

const safeRelPath = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => !p.includes('\0') && !p.includes('\\'), 'Path may not contain backslashes or null bytes.')
  .refine((p) => !p.startsWith('/') && !/^[a-zA-Z]+:/.test(p), 'Path must be relative (no leading slash or scheme).')
  .refine(
    (p) => p.split('/').every((seg) => seg !== '..' && seg !== '.'),
    'Path may not contain "." or ".." segments.',
  )
  .refine((p) => p.split('/').every((seg) => seg.length > 0), 'Path may not contain empty segments.');

export const DeploySiteInput = z
  .object({
    site_id: z.string().min(1),
    files: z
      .array(
        z.object({
          path: safeRelPath,
          content: z.string().max(DEPLOY_MAX_FILE_BYTES, 'File content exceeds the per-file size limit.'),
        }),
      )
      .min(1, 'Provide at least one file as {path, content}.')
      .max(DEPLOY_MAX_FILES, `A deploy may include at most ${DEPLOY_MAX_FILES} files.`),
  })
  .refine(
    (v) => v.files.reduce((n, f) => n + f.content.length, 0) <= DEPLOY_MAX_TOTAL_BYTES,
    'Total deploy size exceeds the 20 MB limit.',
  );

export const TailLogsInput = z.object({
  site_id: z.string().min(1),
  limit: z.number().int().min(1).max(100).default(20),
});

/** `set_domain` — connect a custom hostname to a site. Hostname is lowercased +
 *  validated as a real FQDN (no scheme/path/port) before any provisioning. */
export const SetDomainInput = z.object({
  site_id: z.string().min(1),
  hostname: z
    .string()
    .min(1)
    .max(253)
    .transform((s) => s.trim().toLowerCase())
    .refine(
      (h) => /^(?!-)([a-z0-9-]{1,63}\.)+[a-z]{2,}$/.test(h),
      'Enter a bare domain like app.example.com (no https://, path, or port).',
    ),
});

/**
 * `data_list_resources` + `data_reconcile_resources` — the Data & Resource Platform
 * MCP surface. A caller names ONLY the OWNED `site_id` (never a CF id) + the
 * environment; `environment` defaults to production. `.strict()` rejects any attempt
 * to smuggle a `resourceId`/`databaseId`/`accountId`. Ownership + isolation are
 * enforced server-side in the dispatcher (org-scope + 404-on-foreign), mirroring the
 * per-site D1 Tables surface.
 */
export const DataListResourcesInput = z
  .object({
    site_id: z.string().min(1),
    environment: z.enum(['preview', 'production']).default('production'),
  })
  .strict();

/** Reconcile the registry against CF ground truth for the OWNED site + environment. */
export const DataReconcileResourcesInput = z
  .object({
    site_id: z.string().min(1),
    environment: z.enum(['preview', 'production']).default('production'),
  })
  .strict();

/**
 * `data_list_tables` + `data_read_table` — the per-site D1 READ surface (MCP parity with the
 * editor's SiteTablesPanel / the `/api/sites/:id/db/tables` endpoint). A caller names ONLY the
 * OWNED `site_id` (NEVER a CF/database id — the db is server-resolved from `site_database_allocations`)
 * plus the optional environment. `.strict()` rejects any attempt to smuggle a `databaseId`/`accountId`.
 * Ownership + isolation + `per_site_data` flag-gate are enforced server-side in the dispatcher,
 * mirroring the per-site D1 Tables surface.
 */
export const DataListTablesInput = z
  .object({
    site_id: z.string().min(1),
    environment: z.enum(['preview', 'production']).default('production'),
  })
  .strict();

/**
 * Browse one table's rows (paginated) from the OWNED site's own D1. `limit`/`offset` are LENIENT
 * here — a positive-int `limit` and a non-negative `offset` — because the dispatcher CLAMPS them to
 * `[1, 200]` / `[0, ∞)` (matching the `/api/sites/:id/db/tables/:table` endpoint) rather than
 * REJECTING an over-limit request. A `.max(200)` bound would throw on `limit=201`; the endpoint
 * instead serves 200 rows. `.strict()` still rejects unknown keys (no `databaseId` smuggling).
 */
export const DataReadTableInput = z
  .object({
    site_id: z.string().min(1),
    table: z.string().min(1),
    limit: z.number().int().positive().optional(),
    offset: z.number().int().min(0).optional(),
    environment: z.enum(['preview', 'production']).default('production'),
  })
  .strict();

export type ListSitesArgs = z.infer<typeof ListSitesInput>;
export type GetSiteArgs = z.infer<typeof GetSiteInput>;
export type BuildStatusArgs = z.infer<typeof BuildStatusInput>;
export type DeploySiteArgs = z.infer<typeof DeploySiteInput>;
export type TailLogsArgs = z.infer<typeof TailLogsInput>;
export type SetDomainArgs = z.infer<typeof SetDomainInput>;
export type DataListResourcesArgs = z.infer<typeof DataListResourcesInput>;
export type DataReconcileResourcesArgs = z.infer<typeof DataReconcileResourcesInput>;
export type DataListTablesArgs = z.infer<typeof DataListTablesInput>;
export type DataReadTableArgs = z.infer<typeof DataReadTableInput>;
