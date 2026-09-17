/**
 * @module site-repository
 * @packageDocumentation
 *
 * Zod schemas for **site repositories**, **export/import**, **resource bindings**,
 * and **Workers for Platforms** function manifests.
 *
 * A site repository models a standalone ProjectSites site as a portable workspace
 * containing frontend source, backend functions, data resources, media, and metadata.
 * The export format is a versioned `.zip` with a manifest, checksums, and redacted secrets.
 *
 * | Zod Schema                    | Inferred Type          | Purpose                                    |
 * | ----------------------------- | ---------------------- | ------------------------------------------ |
 * | `projectSiteManifestSchema`   | `ProjectSiteManifest`  | Top-level site descriptor                  |
 * | `siteRepositorySchema`        | `SiteRepository`       | Full workspace structure                   |
 * | `functionManifestSchema`      | `FunctionManifest`     | Single function/binding descriptor         |
 * | `resourceBindingSchema`       | `ResourceBinding`      | DB/KV/Redis/R2 binding                     |
 * | `exportManifestSchema`        | `ExportManifest`       | `.zip` export header                       |
 * | `importPlanSchema`            | `ImportPlan`           | Import dry-run result                      |
 * | `mediaAssetSchema`            | `MediaAsset`           | Site-scoped media entry                    |
 * | `sqliteSnapshotSchema`        | `SQLiteSnapshot`       | SQLite schema/seed/snapshot                |
 * | `editorTabStateSchema`        | `EditorTabState`       | Active tab + panel state                   |
 */
import { z } from 'zod';
import { httpsUrlSchema } from './base.js';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const jsIdentifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z_$][a-zA-Z0-9_$]*$/, 'Must be a valid JavaScript identifier');

const semverSchema = z.string().regex(/^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/);

const environmentModeSchema = z.enum(['mock', 'local', 'preview', 'remote']);

const repositoryModeSchema = z.enum(['standalone', 'embedded']);

const exportFormatSchema = z.literal('projectsites.site-export');

// ---------------------------------------------------------------------------
// Resource bindings
// ---------------------------------------------------------------------------

export const resourceBindingSchema = z.object({
  name: jsIdentifierSchema,
  type: z.enum(['sqlite', 'postgres', 'redis', 'kv', 'r2', 'secret', 'env']),
  /** For dispatch-namespace Workers — the binding the site Worker expects */
  siteWorkerBinding: jsIdentifierSchema.optional(),
  /** Cloudflare binding name in wrangler.jsonc */
  cfBinding: z.string().max(128).optional(),
  /** Optional default value for env vars */
  defaultValue: z.string().optional(),
  /** Whether this is a secret (never exported) */
  isSecret: z.boolean().default(false),
});

export type ResourceBinding = z.infer<typeof resourceBindingSchema>;

// ---------------------------------------------------------------------------
// SQLite / Postgres resource descriptors
// ---------------------------------------------------------------------------

export const sqliteResourceSchema = z.object({
  name: jsIdentifierSchema,
  databaseId: z.string().optional(),
  mode: environmentModeSchema,
  bindingName: jsIdentifierSchema.optional(),
  migrationDir: z.string().default('data/sqlite/migrations/'),
  schemaPath: z.string().default('data/sqlite/schema.sql'),
  seedPath: z.string().default('data/sqlite/seed.sql'),
  snapshotPath: z.string().default('data/sqlite/snapshot.json'),
});

export type SQLiteResource = z.infer<typeof sqliteResourceSchema>;

export const sqliteSnapshotSchema = z.object({
  version: z.number().int().positive(),
  tables: z.array(
    z.object({
      name: z.string(),
      columns: z.array(
        z.object({
          name: z.string(),
          type: z.string(),
          nullable: z.boolean(),
          primaryKey: z.boolean().default(false),
        }),
      ),
      rowCount: z.number().int().nonnegative(),
    }),
  ),
  createdAt: z.string().datetime(),
});

export type SQLiteSnapshot = z.infer<typeof sqliteSnapshotSchema>;

export const postgresProfileSchema = z.object({
  name: jsIdentifierSchema,
  host: z.string(),
  port: z.number().int().min(1).max(65535),
  database: z.string(),
  user: z.string(),
  /** Connection string is NEVER exported — only stored via wrangler secret */
  mode: environmentModeSchema,
  ssl: z.boolean().default(true),
});

export type PostgresProfile = z.infer<typeof postgresProfileSchema>;

export const postgresSnapshotSchema = z.object({
  version: z.number().int().positive(),
  schemas: z.array(
    z.object({
      name: z.string(),
      tables: z.array(
        z.object({
          name: z.string(),
          columns: z.array(
            z.object({
              name: z.string(),
              type: z.string(),
              nullable: z.boolean(),
            }),
          ),
        }),
      ),
    }),
  ),
  extensions: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
});

export type PostgresSnapshot = z.infer<typeof postgresSnapshotSchema>;

// ---------------------------------------------------------------------------
// Redis / KV resource descriptors
// ---------------------------------------------------------------------------

export const redisProfileSchema = z.object({
  name: jsIdentifierSchema,
  mode: environmentModeSchema,
  /** URL is NEVER exported; stored via wrangler secret */
  namespacePrefix: z.string().max(64).default(''),
});

export type RedisProfile = z.infer<typeof redisProfileSchema>;

export const redisSnapshotSchema = z.object({
  version: z.number().int().positive(),
  keys: z.array(
    z.object({
      key: z.string(),
      type: z.enum(['string', 'hash', 'list', 'set', 'zset', 'stream']),
      ttl: z.number().int(),
      value: z.unknown(),
    }),
  ),
  createdAt: z.string().datetime(),
});

export type RedisSnapshot = z.infer<typeof redisSnapshotSchema>;

export const kvNamespaceSchema = z.object({
  name: jsIdentifierSchema,
  bindingName: jsIdentifierSchema.optional(),
  mode: environmentModeSchema,
  previewId: z.string().optional(),
});

export type KVNamespace = z.infer<typeof kvNamespaceSchema>;

export const kvSnapshotSchema = z.object({
  version: z.number().int().positive(),
  entries: z.array(
    z.object({
      key: z.string(),
      value: z.string(),
      metadata: z.record(z.unknown()).optional(),
    }),
  ),
  createdAt: z.string().datetime(),
});

export type KVSnapshot = z.infer<typeof kvSnapshotSchema>;

// ---------------------------------------------------------------------------
// Media assets
// ---------------------------------------------------------------------------

export const mediaAssetSchema = z.object({
  id: z.string(),
  filename: z.string(),
  kind: z.enum(['uploaded', 'ai_generated', 'external_url', 'r2_object']),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  altText: z.string().optional(),
  caption: z.string().optional(),
  sourceUrl: httpsUrlSchema.optional(),
  license: z.string().optional(),
  creator: z.string().optional(),
  approvalStatus: z.enum(['pending', 'approved', 'rejected']).default('approved'),
  r2Key: z.string().optional(),
  /** Include in export zip or reference by manifest checksum */
  exportPolicy: z.enum(['embed', 'reference', 'omit']).default('embed'),
  createdAt: z.string().datetime(),
});

export type MediaAsset = z.infer<typeof mediaAssetSchema>;

export const mediaManifestSchema = z.object({
  version: z.number().int().positive(),
  assets: z.array(mediaAssetSchema),
});

export type MediaManifest = z.infer<typeof mediaManifestSchema>;

// ---------------------------------------------------------------------------
// Worker route / middleware descriptors
// ---------------------------------------------------------------------------

export const workerRouteSchema = z.object({
  path: z.string().max(256),
  methods: z.array(z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])),
  handlerFile: z.string(),
  handlerExport: z.string().default('default'),
  /** Which resources this route touches */
  usesResources: z.array(z.string()).default([]),
});

export type WorkerRoute = z.infer<typeof workerRouteSchema>;

export const workerMiddlewareSchema = z.object({
  name: z.string(),
  file: z.string(),
  order: z.number().int().nonnegative(),
});

export type WorkerMiddleware = z.infer<typeof workerMiddlewareSchema>;

// ---------------------------------------------------------------------------
// Function manifest (Workers for Platforms)
// ---------------------------------------------------------------------------

export const functionManifestSchema = z.object({
  name: jsIdentifierSchema,
  entrypoint: z.string(),
  routes: z.array(workerRouteSchema).default([]),
  middleware: z.array(workerMiddlewareSchema).default([]),
  bindings: z.array(resourceBindingSchema).default([]),
  compatibilityDate: z.string(),
  compatibilityFlags: z.array(z.string()).default([]),
  /** Dispatch namespace this function targets */
  dispatchNamespace: z.string().optional(),
  /** Future CPU / subrequest / memory limits */
  limits: z
    .object({
      cpuMs: z.number().int().optional(),
      subrequests: z.number().int().optional(),
      memoryMb: z.number().int().optional(),
    })
    .optional(),
});

export type FunctionManifest = z.infer<typeof functionManifestSchema>;

// ---------------------------------------------------------------------------
// Project site manifest
// ---------------------------------------------------------------------------

export const projectSiteManifestSchema = z.object({
  domain: z.string().max(253),
  ownerEmail: z.string().email(),
  repositoryMode: repositoryModeSchema,
  repositoryUrl: z.string().url().optional(),
  environment: environmentModeSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  version: semverSchema.default('1.0.0'),
});

export type ProjectSiteManifest = z.infer<typeof projectSiteManifestSchema>;

// ---------------------------------------------------------------------------
// Site repository (full workspace model)
// ---------------------------------------------------------------------------

export const siteRepositorySchema = z.object({
  manifest: projectSiteManifestSchema,
  frontend: z
    .object({
      framework: z.string().optional(),
      buildCommand: z.string().optional(),
      outputDir: z.string().default('dist'),
    })
    .default({}),
  functions: z.array(functionManifestSchema).default([]),
  resources: z
    .object({
      sqlite: z.array(sqliteResourceSchema).default([]),
      postgres: z.array(postgresProfileSchema).default([]),
      redis: z.array(redisProfileSchema).default([]),
      kv: z.array(kvNamespaceSchema).default([]),
    })
    .default({}),
  media: mediaManifestSchema.optional(),
  meta: z.record(z.unknown()).default({}),
});

export type SiteRepository = z.infer<typeof siteRepositorySchema>;

// ---------------------------------------------------------------------------
// Export / Import
// ---------------------------------------------------------------------------

export const exportManifestSchema = z.object({
  format: exportFormatSchema,
  version: z.number().int().positive(),
  site: projectSiteManifestSchema.pick({
    domain: true,
    ownerEmail: true,
    repositoryMode: true,
  }),
  repository: siteRepositorySchema.omit({ manifest: true }),
  checksums: z.record(z.string()).default({}),
  sourceAppVersion: z.string(),
  createdAt: z.string().datetime(),
  createdBy: z.literal('projectsites.dev'),
});

export type ExportManifest = z.infer<typeof exportManifestSchema>;

export const importDryRunResultSchema = z.object({
  conflicts: z.array(
    z.object({
      path: z.string(),
      reason: z.string(),
      action: z.enum(['overwrite', 'skip', 'merge']),
    }),
  ),
  newFiles: z.array(z.string()),
  resourceChanges: z.array(
    z.object({
      resource: z.string(),
      change: z.string(),
    }),
  ),
  warnings: z.array(z.string()).default([]),
  canProceed: z.boolean(),
});

export type ImportDryRunResult = z.infer<typeof importDryRunResultSchema>;

export const importPlanSchema = z.object({
  dryRun: importDryRunResultSchema,
  backupBeforeOverwrite: z.boolean().default(true),
  overwriteByDefault: z.boolean().default(true),
});

export type ImportPlan = z.infer<typeof importPlanSchema>;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const validationProblemSchema = z.object({
  severity: z.enum(['error', 'warning', 'info']),
  path: z.string(),
  message: z.string(),
  code: z.string().optional(),
  suggestion: z.string().optional(),
});

export type ValidationProblem = z.infer<typeof validationProblemSchema>;

// ---------------------------------------------------------------------------
// Editor state
// ---------------------------------------------------------------------------

export const editorTabStateSchema = z.object({
  activeTopTab: z.enum(['code', 'visual', 'preview', 'media', 'functions', 'data', 'settings']),
  activeBottomTab: z.enum(['terminal', 'problems', 'logs', 'sqlite', 'postgres', 'redis', 'kv', 'search']).nullable(),
  bottomPanelSize: z.number().min(0).max(100).default(30),
  showTerminal: z.boolean().default(false),
});

export type EditorTabState = z.infer<typeof editorTabStateSchema>;

// ---------------------------------------------------------------------------
// Route-to-resource graph
// ---------------------------------------------------------------------------

export const routeResourceGraphSchema = z.object({
  routes: z.array(
    z.object({
      path: z.string(),
      method: z.string(),
      handlerFile: z.string(),
      resources: z.array(
        z.object({
          type: resourceBindingSchema.shape.type,
          name: z.string(),
          tables: z.array(z.string()).optional(),
          keyPrefixes: z.array(z.string()).optional(),
        }),
      ),
    }),
  ),
});

export type RouteResourceGraph = z.infer<typeof routeResourceGraphSchema>;

// ---------------------------------------------------------------------------
// Log entry (for Logs tab)
// ---------------------------------------------------------------------------

export const logEntrySchema = z.object({
  timestamp: z.string().datetime(),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  source: z.string(),
  message: z.string(),
  correlationId: z.string().optional(),
  durationMs: z.number().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type LogEntry = z.infer<typeof logEntrySchema>;
