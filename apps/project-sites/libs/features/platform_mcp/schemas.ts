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

/**
 * `data_d1_exec` — run ONE PARAMETERIZED SQL statement against the OWNED site's own D1 (the gated WRITE
 * slice, MCP parity with the Data tab's parameterized row write). A caller names ONLY the OWNED `site_id` +
 * the `sql` (NEVER a CF/database id — the db is server-resolved from `site_database_allocations`) plus optional
 * positional `params` (bound VALUES only — identifiers can't be REST-parameterized) / `confirm` and the
 * environment. ⚠️ The dispatcher's d1 adapter CLASSIFIES the statement honestly by its leading keyword: a
 * data-MUTATING or DESTRUCTIVE (DROP/TRUNCATE/ALTER/DELETE-without-WHERE) statement REQUIRES `confirm:true` —
 * without it the tool returns `confirmation required` REPORTING the detected kind and running nothing; a
 * DESTRUCTIVE one additionally notes D1 Time Travel (30-day PITR) as the rollback path. This is NOT a false
 * "sandboxed read-only" claim — the classifier decides the gate, D1's `rows_written` is the ground truth.
 * `.strict()` rejects any attempt to smuggle a `databaseId`/`accountId`. Ownership + isolation +
 * `per_site_data` flag-gate + `data:write` scope are enforced server-side.
 */
export const DataD1ExecInput = z
  .object({
    site_id: z.string().min(1),
    sql: z.string().min(1).max(100_000),
    params: z.array(z.unknown()).max(100).optional(),
    confirm: z.boolean().optional(),
    environment: z.enum(['preview', 'production']).default('production'),
  })
  .strict();

/**
 * `data_kv_list_keys` — list keys in the OWNED site's own dedicated KV namespace (MCP parity with the
 * Data tab's KV surface). A caller names ONLY the OWNED `site_id` (NEVER a CF namespace id — the
 * namespace is server-resolved from `site_database_allocations`) plus optional prefix/cursor/limit and
 * the environment. `limit` is LENIENT (positive int) because the dispatcher CLAMPS it to `[1, 1000]`
 * (matching CF KV's page cap) rather than REJECTING an over-limit request. `.strict()` rejects any
 * attempt to smuggle a `namespaceId`/`accountId`. Ownership + isolation + `per_site_kv` flag-gate are
 * enforced server-side in the dispatcher, mirroring the per-site D1 Tables surface.
 */
export const DataKvListKeysInput = z
  .object({
    site_id: z.string().min(1),
    prefix: z.string().max(512).optional(),
    cursor: z.string().max(2048).optional(),
    limit: z.number().int().positive().optional(),
    environment: z.enum(['preview', 'production']).default('production'),
  })
  .strict();

/**
 * `data_kv_get` — read one key's value + metadata from the OWNED site's own KV namespace. A caller
 * names ONLY the OWNED `site_id` + the exact `key` (never a CF namespace id — server-resolved) plus the
 * optional environment. `.strict()` rejects unknown keys (no `namespaceId` smuggling). A missing key is
 * an honest `found:false` from the dispatcher (KV is eventually-consistent), never an error.
 */
export const DataKvGetInput = z
  .object({
    site_id: z.string().min(1),
    key: z.string().min(1).max(512),
    environment: z.enum(['preview', 'production']).default('production'),
  })
  .strict();

/**
 * `data_kv_put` — write ONE key's value (optional TTL + metadata) to the OWNED site's own KV namespace
 * (the FIRST WRITE slice, MCP parity with the Data tab's KV put). A caller names ONLY the OWNED `site_id`
 * + the `key` + the `value` (NEVER a CF namespace id — server-resolved) plus optional `expiration_ttl`
 * (seconds, CF minimum 60) / `metadata` / `confirm` and the environment. ⚠️ OVERWRITE is destructive of
 * the prior value: `confirm:true` is REQUIRED to overwrite an EXISTING key — without it the dispatcher
 * returns `confirmation required` and REPORTS the key + that it exists, changing nothing (a brand-new key
 * needs no confirm). `.strict()` rejects any attempt to smuggle a `namespaceId`/`accountId`. Ownership +
 * isolation + `per_site_kv` flag-gate + `data:write` scope are enforced server-side.
 */
export const DataKvPutInput = z
  .object({
    site_id: z.string().min(1),
    key: z.string().min(1).max(512),
    value: z.string().max(25 * 1024 * 1024),
    expiration_ttl: z.number().int().min(60).optional(),
    metadata: z.record(z.unknown()).optional(),
    confirm: z.boolean().optional(),
    environment: z.enum(['preview', 'production']).default('production'),
  })
  .strict();

/**
 * `data_kv_delete` — DELETE ONE key from the OWNED site's own KV namespace (the FIRST WRITE slice, MCP
 * parity with the Data tab's KV delete). A caller names ONLY the OWNED `site_id` + the `key` (NEVER a CF
 * namespace id — server-resolved) plus `confirm` and the environment. ⚠️ DESTRUCTIVE: `confirm:true` is
 * REQUIRED — without it the dispatcher returns `confirmation required` and REPORTS the key + whether it
 * currently exists, deleting nothing. `.strict()` rejects any attempt to smuggle a `namespaceId`/
 * `accountId`. Ownership + isolation + `per_site_kv` flag-gate + `data:write` scope are enforced
 * server-side. Delete is idempotent — removing an already-absent key is an honest `existed:false` success.
 */
export const DataKvDeleteInput = z
  .object({
    site_id: z.string().min(1),
    key: z.string().min(1).max(512),
    confirm: z.boolean().optional(),
    environment: z.enum(['preview', 'production']).default('production'),
  })
  .strict();

/**
 * `data_r2_list_objects` — list objects in the OWNED site's own dedicated R2 bucket (MCP parity with the
 * Data tab's R2 surface). A caller names ONLY the OWNED `site_id` (NEVER a CF bucket name — the bucket is
 * server-resolved from `site_database_allocations`) plus optional prefix/cursor/limit and the environment.
 * `limit` is LENIENT (positive int) because the dispatcher CLAMPS it to `[1, 1000]` (matching R2's page cap)
 * rather than REJECTING an over-limit request. `.strict()` rejects any attempt to smuggle a
 * `bucket`/`bucketName`/`accountId`. Ownership + isolation + `per_site_r2` flag-gate are enforced
 * server-side in the dispatcher, mirroring the per-site D1 Tables + per-site KV surfaces. NOTE: this lists
 * the customer's OWN R2 objects, NOT the platform's deployed-site static assets (a separate surface).
 */
export const DataR2ListObjectsInput = z
  .object({
    site_id: z.string().min(1),
    prefix: z.string().max(1024).optional(),
    cursor: z.string().max(4096).optional(),
    limit: z.number().int().positive().optional(),
    environment: z.enum(['preview', 'production']).default('production'),
  })
  .strict();

/**
 * `data_r2_head_object` — read ONE object's METADATA (size/etag/content-type/uploaded + http + custom
 * metadata) from the OWNED site's own R2 bucket. A caller names ONLY the OWNED `site_id` + the exact `key`
 * (never a CF bucket name — server-resolved) plus the optional environment. `.strict()` rejects unknown
 * keys (no `bucket` smuggling). Returns METADATA ONLY — never the object bytes (a large download uses a
 * signed URL in a later pass). A missing object is an honest `found:false`, never an error.
 */
export const DataR2HeadObjectInput = z
  .object({
    site_id: z.string().min(1),
    key: z.string().min(1).max(1024),
    environment: z.enum(['preview', 'production']).default('production'),
  })
  .strict();

/**
 * `data_r2_put_object` — write ONE SMALL object's bytes (optional content-type + http/custom metadata) to the
 * OWNED site's own dedicated R2 bucket (the FIRST WRITE slice, MCP parity with the Data tab's R2 put). A caller
 * names ONLY the OWNED `site_id` + the `key` + the `body` (NEVER a CF bucket name — server-resolved) plus
 * optional `content_type` / `http_metadata` / `custom_metadata` / `confirm` and the environment. ⚠️ OVERWRITE is
 * destructive of the prior object: `confirm:true` is REQUIRED to overwrite an EXISTING object — without it the
 * dispatcher returns `confirmation required` and REPORTS the key + that it exists, changing nothing (a brand-new
 * object needs no confirm). LARGE/multipart objects are NOT embedded — a body over the inline cap is rejected
 * with a note that a short-lived SCOPED (signed) upload URL is required (a later pass), never buffered inline.
 * `.strict()` rejects any attempt to smuggle a `bucket`/`bucketName`/`accountId`. Ownership + isolation +
 * `per_site_r2` flag-gate + `data:write` scope are enforced server-side. NOTE: this writes the customer's OWN R2
 * objects, NOT the platform's deployed-site static assets (a separate surface).
 */
export const DataR2PutObjectInput = z
  .object({
    site_id: z.string().min(1),
    key: z.string().min(1).max(1024),
    body: z.string().max(25 * 1024 * 1024),
    content_type: z.string().max(256).optional(),
    http_metadata: z.record(z.unknown()).optional(),
    custom_metadata: z.record(z.unknown()).optional(),
    confirm: z.boolean().optional(),
    environment: z.enum(['preview', 'production']).default('production'),
  })
  .strict();

/**
 * `data_r2_delete_object` — DELETE ONE object from the OWNED site's own R2 bucket (the FIRST WRITE slice, MCP
 * parity with the Data tab's R2 delete). A caller names ONLY the OWNED `site_id` + the `key` (NEVER a CF bucket
 * name — server-resolved) plus `confirm` and the environment. ⚠️ DESTRUCTIVE: `confirm:true` is REQUIRED —
 * without it the dispatcher returns `confirmation required` and REPORTS the key + whether it currently exists,
 * deleting nothing. `.strict()` rejects any attempt to smuggle a `bucket`/`bucketName`/`accountId`. Ownership +
 * isolation + `per_site_r2` flag-gate + `data:write` scope are enforced server-side. Delete is idempotent —
 * removing an already-absent object is an honest `existed:false` success.
 */
export const DataR2DeleteObjectInput = z
  .object({
    site_id: z.string().min(1),
    key: z.string().min(1).max(1024),
    confirm: z.boolean().optional(),
    environment: z.enum(['preview', 'production']).default('production'),
  })
  .strict();

/**
 * `data_vectorize_list` — summarise the OWNED site's own metadata NAMESPACE inside the shared Vectorize index
 * (MCP parity with the Data tab's Vectorize surface). A caller names ONLY the OWNED `site_id` (NEVER a CF index
 * name AND never a namespace — BOTH are server-derived: the index from the registry, the namespace from the
 * site id) plus the optional environment. `.strict()` rejects any attempt to smuggle an `index`/`indexName`/
 * `namespace`/`accountId`. Ownership + isolation + `per_site_vectorize` flag-gate are enforced server-side in
 * the dispatcher, mirroring the per-site D1/KV/R2 surfaces. Per-site isolation is a NAMESPACE partition, not a
 * dedicated per-site index (namespace ≠ quota). Honest 'not provisioned' until the site has a Vectorize row.
 */
export const DataVectorizeListInput = z
  .object({
    site_id: z.string().min(1),
    environment: z.enum(['preview', 'production']).default('production'),
  })
  .strict();

/**
 * `data_vectorize_describe` — read the shared index config (dimensions/metric/metadata-indexes) + the OWNED
 * site's server-derived namespace, and OPTIONALLY fetch specific vectors' id+METADATA via a NAMESPACE-SCOPED
 * get-by-ids (a foreign vector is never returned; the namespace filter is the site's own). A caller names ONLY
 * the OWNED `site_id` (never a CF index name/namespace — server-derived) + optional `ids` + environment. `ids`
 * is LENIENT (a positive-length string array) because the adapter CLAMPS it to at most 100 (deduped) rather
 * than REJECTING an over-length request. `.strict()` rejects unknown keys (no `index`/`namespace` smuggling).
 * Returns id + METADATA ONLY — never the raw vector float values. A missing/foreign id simply isn't returned.
 */
export const DataVectorizeDescribeInput = z
  .object({
    site_id: z.string().min(1),
    ids: z.array(z.string().min(1).max(512)).max(1000).optional(),
    environment: z.enum(['preview', 'production']).default('production'),
  })
  .strict();

/**
 * `data_vectorize_upsert` — write vectors to the OWNED site's own metadata NAMESPACE inside the shared Vectorize
 * index (a WRITE slice, MCP parity with the Data tab's Vectorize upsert). A caller names ONLY the OWNED
 * `site_id` + the `vectors` (NEVER a CF index name AND NEVER a namespace — the index is server-resolved, the
 * namespace server-DERIVED from the site id and FORCED onto every vector). Each vector is `{ id, values[],
 * metadata? }`; a caller-supplied `namespace` is not part of the schema (`.strict()`) and, even if smuggled,
 * the adapter overwrites it — a vector can never land in a foreign partition (INV-1). `values` is a non-empty
 * array of finite numbers; the adapter clamps the batch to at most 1000 vectors. Upsert is insert-or-overwrite
 * by id WITHIN the site's own namespace (no confirm needed — the destructive gate is on delete). Ownership +
 * isolation + `per_site_vectorize` flag-gate + `data:write` scope are enforced server-side.
 */
export const DataVectorizeUpsertInput = z
  .object({
    site_id: z.string().min(1),
    vectors: z
      .array(
        z
          .object({
            id: z.string().min(1).max(512),
            values: z.array(z.number().finite()).min(1),
            metadata: z.record(z.unknown()).optional(),
          })
          .strict(),
      )
      .min(1, 'Provide at least one vector as {id, values}.')
      .max(1000, 'An upsert may include at most 1000 vectors.'),
    environment: z.enum(['preview', 'production']).default('production'),
  })
  .strict();

/**
 * `data_vectorize_delete` — DELETE vectors BY ID from the OWNED site's own namespace (a WRITE slice, MCP parity
 * with the Data tab's Vectorize delete-by-ids). A caller names ONLY the OWNED `site_id` + the `ids` (NEVER a CF
 * index name AND NEVER a namespace — server-resolved/derived) plus `confirm` and the environment. ⚠️
 * DESTRUCTIVE: `confirm:true` is REQUIRED — without it the dispatcher returns `confirmation required` REPORTING
 * how many of the requested ids are in the site's namespace (the count that WOULD be removed), deleting
 * nothing. ISOLATION: the adapter first confirms which requested ids live in the site's OWN namespace and
 * deletes ONLY those — a foreign id (even if its id is guessed) is NEVER deleted (CF's delete_by_ids has no
 * namespace filter, so the adapter enforces it). `.strict()` rejects any attempt to smuggle an `index`/
 * `namespace`/`accountId`. Ownership + isolation + `per_site_vectorize` flag-gate + `data:write` scope are
 * enforced server-side.
 */
export const DataVectorizeDeleteInput = z
  .object({
    site_id: z.string().min(1),
    ids: z.array(z.string().min(1).max(512)).min(1, 'Provide at least one vector id.').max(1000),
    confirm: z.boolean().optional(),
    environment: z.enum(['preview', 'production']).default('production'),
  })
  .strict();

/**
 * `data_connections_list` — list the OWNED site's outbound connections to EXTERNAL providers (Hyperdrive /
 * external DB + `mcp_connections` OAuth/paste-key links), MCP parity with the Data tab's Connections
 * surface. A caller names ONLY the OWNED `site_id` plus the optional environment. `.strict()` rejects any
 * attempt to smuggle a connection id or a secret. Ownership + isolation + `per_site_connections` flag-gate
 * are enforced server-side in the dispatcher, mirroring the per-site D1/KV/R2/Vectorize surfaces. Returns
 * id/name/type/MASKED host/status ONLY — ⛔ NEVER a token, password, or connection string.
 */
export const DataConnectionsListInput = z
  .object({
    site_id: z.string().min(1),
    environment: z.enum(['preview', 'production']).default('production'),
  })
  .strict();

/**
 * `data_connection_describe` — read ONE connection's SECRET-FREE metadata (id/name/type/MASKED host/status)
 * from the OWNED site's connections. A caller names ONLY the OWNED `site_id` + the connection `id` (scoped
 * to the site — a foreign connection can't be read even if its id is guessed) plus the optional
 * environment. `.strict()` rejects unknown keys. ⛔ Returns metadata ONLY — never a token, password, or
 * connection string. A missing id is an honest `found:false`, never an error.
 */
export const DataConnectionDescribeInput = z
  .object({
    site_id: z.string().min(1),
    id: z.string().min(1).max(256),
    environment: z.enum(['preview', 'production']).default('production'),
  })
  .strict();

/**
 * `data_workflows_list` — list the OWNED site's workflow RUN INSTANCES (id/status/timestamps), MCP parity
 * with the Backend tab's Workflows surface. A caller names ONLY the OWNED `site_id` (NEVER a CF workflow
 * name AND never an account id — the workflow name is server-resolved from the site's registry row) plus an
 * optional `cursor`/`limit` and the environment. `limit` is LENIENT (a positive int) because the adapter
 * CLAMPS it to `[1, 100]` (matching CF's per_page cap) rather than REJECTING an over-limit request.
 * `.strict()` rejects any attempt to smuggle a `workflow`/`workflowName`/`accountId`/`instanceId`.
 * Ownership + isolation + `per_site_workflows` flag-gate are enforced server-side in the dispatcher,
 * mirroring the per-site D1/KV/R2/Vectorize surfaces. Workflows are platform-owned definitions (not
 * per-site); per-site workflow provisioning is NOT wired → honest 'not provisioned' until the site has a
 * workflow row. NEVER an optimistic run status — the adapter surfaces the ACTUAL CF status.
 */
export const DataWorkflowsListInput = z
  .object({
    site_id: z.string().min(1),
    cursor: z.string().max(4096).optional(),
    limit: z.number().int().positive().optional(),
    environment: z.enum(['preview', 'production']).default('production'),
  })
  .strict();

/**
 * `data_workflow_get_instance` — read ONE run instance's status + SANITIZED steps from the OWNED site's
 * workflow. A caller names ONLY the OWNED `site_id` + the instance `id` (scoped to the site's resolved
 * workflow — a foreign instance can't be read even if its id is guessed) plus the optional environment.
 * `.strict()` rejects unknown keys (no `workflow`/`accountId` smuggling). ⛔ Step output/error are SANITIZED
 * (secret-shaped keys redacted + truncated) — a raw credential/PII payload is never dumped. A missing
 * instance is an honest `found:false`, never an error. The status is the ACTUAL CF status, never optimistic.
 */
export const DataWorkflowGetInstanceInput = z
  .object({
    site_id: z.string().min(1),
    id: z.string().min(1).max(256),
    environment: z.enum(['preview', 'production']).default('production'),
  })
  .strict();

/**
 * `data_durable_objects_list` — list the OWNED site's Durable Object CLASS namespaces (id/class/script),
 * MCP parity with the Backend tab's Durable Objects surface. A caller names ONLY the OWNED `site_id` (NEVER
 * a CF namespace id AND never an account id — the namespace is server-resolved from the site's registry row)
 * plus the optional environment. `.strict()` rejects any attempt to smuggle a `namespace`/`namespaceId`/
 * `accountId`. Ownership + isolation + `per_site_durable_objects` flag-gate are enforced server-side in the
 * dispatcher, mirroring the per-site D1/KV/R2/Vectorize/Workflows surfaces. ⛔ This lists NAMESPACES
 * (classes), NEVER instances — CF has no API to enumerate DO instances. Only `SITE_BUILDER` is bound; there
 * is no per-site DO namespace → honest 'not provisioned' until the site has a durable_object row.
 */
export const DataDurableObjectsListInput = z
  .object({
    site_id: z.string().min(1),
    environment: z.enum(['preview', 'production']).default('production'),
  })
  .strict();

/**
 * `data_durable_object_describe` — describe the derivable METADATA of a NAMED object id within the OWNED
 * site's Durable Object namespace. A caller names ONLY the OWNED `site_id` + the object `id` (an id it
 * already KNOWS — never a browse) plus the optional environment. `.strict()` rejects unknown keys (no
 * `namespace`/`accountId` smuggling). ⛔ Returns identity metadata ONLY (id + namespace + hex form) —
 * NEVER the object's private storage or in-memory state, which no CF API can read (`stateBrowsable:false`
 * is permanent). This surfaces "which object did I address", never its data.
 */
export const DataDurableObjectDescribeInput = z
  .object({
    site_id: z.string().min(1),
    id: z.string().min(1).max(256),
    environment: z.enum(['preview', 'production']).default('production'),
  })
  .strict();

/**
 * `data_queues_list` — list the OWNED site's Queue(s) + their consumers/delivery-retry settings/DLQ/backlog
 * metrics/paused state (CONFIG + METRICS only), MCP parity with the Backend tab's Queues surface. A caller
 * names ONLY the OWNED `site_id` (NEVER a CF queue id AND never an account id — the queue id is
 * server-resolved from the site's registry row) plus the optional environment. `.strict()` rejects any
 * attempt to smuggle a `queue`/`queueId`/`accountId`. Ownership + isolation + `per_site_queues` flag-gate are
 * enforced server-side in the dispatcher, mirroring the per-site D1/KV/R2/Vectorize/Workflows/DO surfaces.
 * ⛔ Queues are UNSUPPORTED on this deployment (no `QUEUE` binding) → honest 'not available / not
 * provisioned' until Queues are enabled + the site has a queue row. peek ≠ history; pull = leases + ack —
 * this read pass returns config + metrics ONLY, never a message body.
 */
export const DataQueuesListInput = z
  .object({
    site_id: z.string().min(1),
    environment: z.enum(['preview', 'production']).default('production'),
  })
  .strict();

/**
 * `data_queue_describe` — read ONE queue's CONFIG + METRICS (name/paused/consumers/DLQ/backlog) from the
 * OWNED site's queue. A caller names ONLY the OWNED `site_id` (the queue is server-resolved from the site's
 * registry row — a foreign queue can't be read) plus an OPTIONAL `id` echo and the optional environment.
 * `id` is optional + non-identifier: the ONLY queue addressed is the site's resolved queue; a mismatching
 * echo can NEVER widen to another queue. `.strict()` rejects unknown keys (no `queue`/`accountId`
 * smuggling). ⛔ Returns CONFIG + METRICS ONLY — NEVER a message body or a "history" (peek ≠ history, HARD
 * FACT #1). A missing queue is an honest `found:false`, never an error.
 */
export const DataQueueDescribeInput = z
  .object({
    site_id: z.string().min(1),
    id: z.string().min(1).max(256).optional(),
    environment: z.enum(['preview', 'production']).default('production'),
  })
  .strict();

/**
 * `data_analytics_list` — summarise the OWNED site's Analytics Engine dataset(s) + the custom-event dimensions
 * the platform records (Observability, cross-cutting Backend tab). A caller names ONLY the OWNED `site_id`
 * (NEVER a CF dataset name AND never an account id — the dataset is server-resolved) plus the optional
 * environment. `.strict()` rejects any attempt to smuggle a `dataset`/`accountId`/`sql`. Ownership + isolation
 * + `per_site_observability` flag-gate are enforced server-side in the dispatcher, mirroring the per-site
 * D1/KV/R2/Vectorize/Workflows/DO/Queues surfaces. ⛔ Analytics Engine INGEST is DISABLED on this deployment
 * (`ANALYTICS_INGEST_ENABLED="false"`) → honest `available:false` (no events ingested yet), NEVER a fabricated
 * event stream. The dataset is `shared_platform` (one shared dataset, NOT per-site); per-site isolation is a
 * server-built `WHERE` on the site dimension, never a raw query from the caller.
 */
export const DataAnalyticsListInput = z
  .object({
    site_id: z.string().min(1),
    environment: z.enum(['preview', 'production']).default('production'),
  })
  .strict();

/**
 * `data_analytics_query_summary` — read a SITE-SCOPED recent event-count summary (total + per-event breakdown)
 * over a trailing window, via the Analytics Engine SQL API. ⛔ The caller supplies ONLY the OWNED `site_id` + an
 * OPTIONAL `window_days` (a bounded integer) — NEVER a SQL query, a dataset name, an account id, or a site
 * dimension. The query is SERVER-BUILT and carries a mandatory `WHERE blob3 = <siteId>`, so one site can never
 * read another's analytics (SECURITY-INVARIANTS: the AE SQL API is account-wide; isolation is a server-side
 * `WHERE`, never trust in a client query). `window_days` is LENIENT (a positive int) because the adapter CLAMPS
 * it to `[1, 90]` (AE retention ~3 months) rather than REJECTING an over-window request. `.strict()` rejects
 * any attempt to smuggle a `sql`/`dataset`/`accountId`/`where`. When ingest is disabled (the reality today) the
 * summary is an honest ZERO WITHOUT querying; counts are SAMPLED estimates (`sampled:true`), never exact.
 */
export const DataAnalyticsQuerySummaryInput = z
  .object({
    site_id: z.string().min(1),
    window_days: z.number().int().positive().optional(),
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
export type DataD1ExecArgs = z.infer<typeof DataD1ExecInput>;
export type DataKvListKeysArgs = z.infer<typeof DataKvListKeysInput>;
export type DataKvGetArgs = z.infer<typeof DataKvGetInput>;
export type DataKvPutArgs = z.infer<typeof DataKvPutInput>;
export type DataKvDeleteArgs = z.infer<typeof DataKvDeleteInput>;
export type DataR2ListObjectsArgs = z.infer<typeof DataR2ListObjectsInput>;
export type DataR2HeadObjectArgs = z.infer<typeof DataR2HeadObjectInput>;
export type DataR2PutObjectArgs = z.infer<typeof DataR2PutObjectInput>;
export type DataR2DeleteObjectArgs = z.infer<typeof DataR2DeleteObjectInput>;
export type DataVectorizeListArgs = z.infer<typeof DataVectorizeListInput>;
export type DataVectorizeDescribeArgs = z.infer<typeof DataVectorizeDescribeInput>;
export type DataVectorizeUpsertArgs = z.infer<typeof DataVectorizeUpsertInput>;
export type DataVectorizeDeleteArgs = z.infer<typeof DataVectorizeDeleteInput>;
export type DataConnectionsListArgs = z.infer<typeof DataConnectionsListInput>;
export type DataConnectionDescribeArgs = z.infer<typeof DataConnectionDescribeInput>;
export type DataWorkflowsListArgs = z.infer<typeof DataWorkflowsListInput>;
export type DataWorkflowGetInstanceArgs = z.infer<typeof DataWorkflowGetInstanceInput>;
export type DataDurableObjectsListArgs = z.infer<typeof DataDurableObjectsListInput>;
export type DataDurableObjectDescribeArgs = z.infer<typeof DataDurableObjectDescribeInput>;
export type DataQueuesListArgs = z.infer<typeof DataQueuesListInput>;
export type DataQueueDescribeArgs = z.infer<typeof DataQueueDescribeInput>;
export type DataAnalyticsListArgs = z.infer<typeof DataAnalyticsListInput>;
export type DataAnalyticsQuerySummaryArgs = z.infer<typeof DataAnalyticsQuerySummaryInput>;

/**
 * `data_backend_inventory` — the READ-ONLY Backend-tab connected-resource INVENTORY (Data & Resource
 * Platform Phase 8b): a site's scheduled tasks (Cron Triggers), its Worker bindings (service /
 * Secrets Store / AI / Browser Rendering / Images / KV / R2 / D1 / DO / Vectorize / Analytics /
 * Queues), and its secret NAMES + last-change metadata. ⛔ NEVER a secret VALUE — only names +
 * metadata; the value column is never read. Each binding carries `managed` + an in-platform
 * `manageRoute` when THIS platform has an integrated management surface, or an honest
 * `managed:false` + `notAvailableReason` when it does not (no fake CRUD for un-integrated products).
 * A caller names ONLY the OWNED `site_id` (+ optional environment) — NEVER a CF id/account (INV-1);
 * ownership + isolation + the `data_resource_platform` flag are enforced server-side in the
 * dispatcher. `.strict()` rejects any attempt to smuggle a binding id / dataset / account id.
 */
export const DataBackendInventoryInput = z
  .object({
    site_id: z.string().min(1),
    environment: z.enum(['preview', 'production']).default('production'),
  })
  .strict();
export type DataBackendInventoryArgs = z.infer<typeof DataBackendInventoryInput>;
