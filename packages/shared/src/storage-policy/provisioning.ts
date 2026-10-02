/**
 * @module storage-policy/provisioning
 * @description
 * Account/project storage provisioning for the Cloudflare Artifacts three-bucket
 * architecture (Cycle 1b, builds on the Cycle 1a routing authority in
 * `routing.ts`). `buildStorageManifest(input)` is the ONE pure, Zod-typed
 * authority that computes a VERSIONED three-bucket layout for a site/project:
 * the canonical R2 bucket bindings plus the key-prefix namespace each managed
 * file writes under.
 *
 * Three logical buckets, one manifest:
 *  - `site`      — the site's source/draft/deployment files (the ordinary tier,
 *                  per `selectFileStorage` → `'ordinary'`). Keyed `sites/{slug}/{version}/…`.
 *  - `media`     — the protected large-file / asset tier (per `selectFileStorage`
 *                  → `'media'`, files `> LARGE_FILE_THRESHOLD_BYTES`). Keyed `media/{slug}/…`.
 *  - `artifacts` — build outputs + generated artifacts for the project. Keyed
 *                  `artifacts/{slug}/…`.
 *
 * The manifest is a PURE function of its input — deterministic, no I/O, no clock
 * read unless the caller omits `createdAt`. Server code resolves a site's physical
 * R2 bindings elsewhere (a Worker can't statically bind thousands of per-site
 * buckets); this manifest is the layout contract those resolvers honor, and the
 * single place the key-prefix namespacing is defined so no two call sites drift.
 *
 * The `version` is the per-site storage-layout revision (NOT a deployment or a
 * content version). It lets the key namespace evolve without a destructive
 * migration: bumping the version produces a fresh `sites/{slug}/{newVersion}/…`
 * prefix while older prefixes remain addressable. `site` key prefixes embed the
 * version; `media` and `artifacts` are version-independent per-site namespaces.
 *
 * See `routing.ts` (which TIER a file lands in) + `README.md` (consumption
 * contract). This module answers WHERE, by stable key, within that tier.
 */
import { z } from 'zod';

import { StorageRoleSchema, type StorageRole } from './routing.js';

/**
 * The current storage-layout manifest schema version. Bump ONLY when the shape
 * of {@link StorageManifest} changes in a way consumers must branch on; the
 * per-site `version` field is a separate, runtime value.
 */
export const STORAGE_MANIFEST_SCHEMA_VERSION = 1 as const;

/**
 * A site slug, mirroring the shared `slugSchema` contract (3-63 chars,
 * `[a-z0-9]` bounded, single hyphens internal). Re-declared locally so this
 * module stays a leaf of the storage-policy folder with no cross-folder import;
 * the regex is the exact same grammar used platform-wide for site slugs.
 */
export const storageSlugSchema = z
  .string()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/,
    'Slug must be 3-63 lowercase alphanumeric chars with single internal hyphens.',
  );

/**
 * The per-site storage-layout revision: a positive, 1-based safe integer.
 * `1` is the first layout. Incrementing re-namespaces the versioned `site`
 * prefix without destroying prior versions.
 */
export const storageLayoutVersionSchema = z
  .number()
  .int('Storage layout version must be an integer.')
  .positive('Storage layout version must be >= 1.')
  .refine(Number.isSafeInteger, { message: 'Storage layout version must be a safe integer.' });

/** Input to {@link buildStorageManifest}. `version`/`createdAt` default when omitted. */
export const buildStorageManifestInputSchema = z
  .object({
    /** The site/project slug the manifest is scoped to. */
    slug: storageSlugSchema,
    /** Per-site storage-layout revision. Defaults to `1` (the first layout). */
    version: storageLayoutVersionSchema.default(1),
    /**
     * ISO-8601 creation timestamp for the manifest. Defaults to `new Date()`
     * at call time; pass an explicit value to keep the function fully pure
     * (e.g. in tests or when persisting a stable record).
     */
    createdAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export type BuildStorageManifestInput = z.input<typeof buildStorageManifestInputSchema>;

/** A single logical bucket within a site's storage manifest. */
export const storageBucketSchema = z
  .object({
    /** The storage tier this bucket maps to (`ordinary` → site/artifacts, `media` → media). */
    role: StorageRoleSchema,
    /** The wrangler R2 binding name a Worker uses to reach this bucket. */
    binding: z.string().min(1),
    /** The top-level key namespace every object in this bucket writes under. */
    keyPrefix: z.string().min(1),
  })
  .strict();

export type StorageBucket = z.infer<typeof storageBucketSchema>;

/**
 * The versioned three-bucket layout for one site/project. Returned by
 * {@link buildStorageManifest}; the single contract every write boundary +
 * resolver honors for key namespacing.
 */
export const storageManifestSchema = z
  .object({
    /** Manifest shape version — equals {@link STORAGE_MANIFEST_SCHEMA_VERSION}. */
    schemaVersion: z.literal(STORAGE_MANIFEST_SCHEMA_VERSION),
    /** The site/project slug this manifest is scoped to. */
    slug: storageSlugSchema,
    /** The per-site storage-layout revision baked into the versioned `site` prefix. */
    version: storageLayoutVersionSchema,
    /** The three logical buckets, keyed by purpose. */
    buckets: z
      .object({
        site: storageBucketSchema,
        media: storageBucketSchema,
        artifacts: storageBucketSchema,
      })
      .strict(),
    /** Flat key-prefix lookup (same prefixes as `buckets.*.keyPrefix`), for callers that only need the namespace. */
    keyPrefixes: z
      .object({
        site: z.string().min(1),
        media: z.string().min(1),
        artifacts: z.string().min(1),
      })
      .strict(),
    /** ISO-8601 timestamp the manifest was built. */
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type StorageManifest = z.infer<typeof storageManifestSchema>;

/** The canonical wrangler R2 binding names the three buckets resolve to. */
export const STORAGE_BUCKET_BINDINGS = {
  site: 'SITE_BUCKET',
  media: 'MEDIA_BUCKET',
  artifacts: 'ARTIFACTS_BUCKET',
} as const;

/** Each bucket's tier, mirroring `routing.ts`: large files → media, everything else → ordinary. */
const STORAGE_BUCKET_ROLES: {
  readonly site: StorageRole;
  readonly media: StorageRole;
  readonly artifacts: StorageRole;
} = {
  site: 'ordinary',
  media: 'media',
  artifacts: 'ordinary',
};

/**
 * Build the versioned three-bucket storage layout for a site/project.
 *
 * Pure + deterministic for a fixed input: identical `slug`/`version`/`createdAt`
 * always yield an identical manifest. Only an omitted `createdAt` reads the clock.
 * Bumping `version` deterministically re-namespaces the `site` prefix to
 * `sites/{slug}/{version}/` while `media`/`artifacts` stay version-independent.
 *
 * @param input - `{ slug, version?, createdAt? }`; validated by {@link buildStorageManifestInputSchema}.
 * @returns The validated {@link StorageManifest}.
 * @throws {z.ZodError} When `input` fails validation (bad slug, non-positive version, non-ISO date, unknown key).
 * @example
 * ```ts
 * buildStorageManifest({ slug: 'vitos-salon' });
 * // → { schemaVersion: 1, slug: 'vitos-salon', version: 1,
 * //     keyPrefixes: { site: 'sites/vitos-salon/1/', media: 'media/vitos-salon/', artifacts: 'artifacts/vitos-salon/' }, … }
 *
 * buildStorageManifest({ slug: 'vitos-salon', version: 2 }).keyPrefixes.site;
 * // → 'sites/vitos-salon/2/'  (media + artifacts prefixes are unchanged)
 * ```
 */
export function buildStorageManifest(input: BuildStorageManifestInput): StorageManifest {
  const { slug, version, createdAt } = buildStorageManifestInputSchema.parse(input);

  const keyPrefixes = {
    site: `sites/${slug}/${version}/`,
    media: `media/${slug}/`,
    artifacts: `artifacts/${slug}/`,
  } as const;

  const manifest: StorageManifest = {
    schemaVersion: STORAGE_MANIFEST_SCHEMA_VERSION,
    slug,
    version,
    buckets: {
      site: {
        role: STORAGE_BUCKET_ROLES.site,
        binding: STORAGE_BUCKET_BINDINGS.site,
        keyPrefix: keyPrefixes.site,
      },
      media: {
        role: STORAGE_BUCKET_ROLES.media,
        binding: STORAGE_BUCKET_BINDINGS.media,
        keyPrefix: keyPrefixes.media,
      },
      artifacts: {
        role: STORAGE_BUCKET_ROLES.artifacts,
        binding: STORAGE_BUCKET_BINDINGS.artifacts,
        keyPrefix: keyPrefixes.artifacts,
      },
    },
    keyPrefixes,
    createdAt: createdAt ?? new Date().toISOString(),
  };

  // Validate the fully-assembled shape so the function can never emit a manifest
  // that would fail its own schema (defense-in-depth per zod-everywhere).
  return storageManifestSchema.parse(manifest);
}

/**
 * Non-throwing variant for untrusted input: validate + build, returning a
 * discriminated result so a trust boundary can reject bad input without try/catch.
 *
 * @param input - Possibly-untrusted manifest input.
 */
export function safeBuildStorageManifest(
  input: unknown,
): { ok: true; manifest: StorageManifest } | { ok: false; error: string } {
  const parsed = buildStorageManifestInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid storage manifest input.' };
  }
  return { ok: true, manifest: buildStorageManifest(parsed.data) };
}
