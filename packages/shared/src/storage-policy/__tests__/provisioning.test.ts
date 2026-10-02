/**
 * @module storage-policy/__tests__/provisioning
 * @description Tests for the account/project storage-provisioning authority:
 * the happy-path versioned three-bucket manifest, invalid-input rejection
 * (bad slug / non-positive version / non-ISO date / unknown key), and
 * version-bump determinism (same input → identical manifest; bumping `version`
 * re-namespaces ONLY the `site` prefix, never media/artifacts).
 */
import {
  STORAGE_BUCKET_BINDINGS,
  STORAGE_MANIFEST_SCHEMA_VERSION,
  buildStorageManifest,
  buildStorageManifestInputSchema,
  safeBuildStorageManifest,
  storageLayoutVersionSchema,
  storageManifestSchema,
  storageSlugSchema,
} from '../provisioning.js';

const FIXED_ISO = '2026-10-02T12:00:00.000Z';

describe('buildStorageManifest — happy path', () => {
  it('builds a versioned three-bucket layout for a slug', () => {
    const manifest = buildStorageManifest({ slug: 'vitos-salon', version: 1, createdAt: FIXED_ISO });

    expect(manifest).toEqual({
      schemaVersion: STORAGE_MANIFEST_SCHEMA_VERSION,
      slug: 'vitos-salon',
      version: 1,
      buckets: {
        site: { role: 'ordinary', binding: STORAGE_BUCKET_BINDINGS.site, keyPrefix: 'sites/vitos-salon/1/' },
        media: { role: 'media', binding: STORAGE_BUCKET_BINDINGS.media, keyPrefix: 'media/vitos-salon/' },
        artifacts: {
          role: 'ordinary',
          binding: STORAGE_BUCKET_BINDINGS.artifacts,
          keyPrefix: 'artifacts/vitos-salon/',
        },
      },
      keyPrefixes: {
        site: 'sites/vitos-salon/1/',
        media: 'media/vitos-salon/',
        artifacts: 'artifacts/vitos-salon/',
      },
      createdAt: FIXED_ISO,
    });
  });

  it('defaults version to 1 and createdAt to a valid ISO timestamp when omitted', () => {
    const before = Date.now();
    const manifest = buildStorageManifest({ slug: 'acme-co' });
    const after = Date.now();

    expect(manifest.version).toBe(1);
    expect(manifest.keyPrefixes.site).toBe('sites/acme-co/1/');
    // createdAt is a real ISO timestamp taken at call time.
    const ts = Date.parse(manifest.createdAt);
    expect(Number.isNaN(ts)).toBe(false);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('emits a manifest that satisfies its own schema', () => {
    const manifest = buildStorageManifest({ slug: 'acme-co', createdAt: FIXED_ISO });
    expect(storageManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it('keyPrefixes exactly mirror the per-bucket keyPrefix values', () => {
    const m = buildStorageManifest({ slug: 'acme-co', version: 3, createdAt: FIXED_ISO });
    expect(m.keyPrefixes.site).toBe(m.buckets.site.keyPrefix);
    expect(m.keyPrefixes.media).toBe(m.buckets.media.keyPrefix);
    expect(m.keyPrefixes.artifacts).toBe(m.buckets.artifacts.keyPrefix);
  });
});

describe('buildStorageManifest — invalid input rejects', () => {
  it.each([
    ['UPPER', 'uppercase slug'],
    ['ab', 'too short (<3)'],
    ['-leading', 'leading hyphen'],
    ['trailing-', 'trailing hyphen'],
    ['has space', 'whitespace'],
    ['a'.repeat(64), 'too long (>63)'],
  ] as const)('throws for slug %p (%s)', (slug) => {
    expect(() => buildStorageManifest({ slug } as never)).toThrow();
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('throws for version %p', (version) => {
    expect(() => buildStorageManifest({ slug: 'acme-co', version } as never)).toThrow();
  });

  it('throws for a non-ISO createdAt', () => {
    expect(() => buildStorageManifest({ slug: 'acme-co', createdAt: 'not-a-date' } as never)).toThrow();
  });

  it('rejects unknown keys (strict schema)', () => {
    expect(() => buildStorageManifest({ slug: 'acme-co', bucketCount: 4 } as never)).toThrow();
  });
});

describe('safeBuildStorageManifest — untrusted input', () => {
  it('returns ok with a manifest for valid input', () => {
    const result = safeBuildStorageManifest({ slug: 'acme-co', version: 2, createdAt: FIXED_ISO });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.keyPrefixes.site).toBe('sites/acme-co/2/');
    }
  });

  it.each([null, undefined, {}, { slug: 'UP' }, { slug: 'acme-co', version: 0 }, 'nope'])(
    'returns a typed error for invalid %p',
    (bad) => {
      const result = safeBuildStorageManifest(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(typeof result.error).toBe('string');
        expect(result.error.length).toBeGreaterThan(0);
      }
    },
  );
});

describe('buildStorageManifest — version-bump determinism', () => {
  it('is fully deterministic for a fixed input', () => {
    const a = buildStorageManifest({ slug: 'acme-co', version: 2, createdAt: FIXED_ISO });
    const b = buildStorageManifest({ slug: 'acme-co', version: 2, createdAt: FIXED_ISO });
    expect(a).toEqual(b);
  });

  it('bumping version re-namespaces ONLY the site prefix', () => {
    const v1 = buildStorageManifest({ slug: 'acme-co', version: 1, createdAt: FIXED_ISO });
    const v2 = buildStorageManifest({ slug: 'acme-co', version: 2, createdAt: FIXED_ISO });

    expect(v1.keyPrefixes.site).toBe('sites/acme-co/1/');
    expect(v2.keyPrefixes.site).toBe('sites/acme-co/2/');
    expect(v1.keyPrefixes.site).not.toBe(v2.keyPrefixes.site);

    // media + artifacts are version-independent — identical across the bump.
    expect(v1.keyPrefixes.media).toBe(v2.keyPrefixes.media);
    expect(v1.keyPrefixes.artifacts).toBe(v2.keyPrefixes.artifacts);
    expect(v1.buckets.media).toEqual(v2.buckets.media);
    expect(v1.buckets.artifacts).toEqual(v2.buckets.artifacts);
  });

  it('distinct slugs never share a key namespace', () => {
    const a = buildStorageManifest({ slug: 'acme-co', createdAt: FIXED_ISO });
    const b = buildStorageManifest({ slug: 'other-co', createdAt: FIXED_ISO });
    expect(a.keyPrefixes.site).not.toBe(b.keyPrefixes.site);
    expect(a.keyPrefixes.media).not.toBe(b.keyPrefixes.media);
    expect(a.keyPrefixes.artifacts).not.toBe(b.keyPrefixes.artifacts);
  });
});

describe('exported schemas', () => {
  it('storageSlugSchema enforces the slug grammar', () => {
    expect(storageSlugSchema.safeParse('vitos-salon').success).toBe(true);
    expect(storageSlugSchema.safeParse('ab').success).toBe(false);
    expect(storageSlugSchema.safeParse('UP').success).toBe(false);
  });

  it('storageLayoutVersionSchema accepts positive safe integers only', () => {
    expect(storageLayoutVersionSchema.safeParse(1).success).toBe(true);
    expect(storageLayoutVersionSchema.safeParse(0).success).toBe(false);
    expect(storageLayoutVersionSchema.safeParse(1.5).success).toBe(false);
  });

  it('buildStorageManifestInputSchema applies defaults', () => {
    const parsed = buildStorageManifestInputSchema.parse({ slug: 'acme-co' });
    expect(parsed.version).toBe(1);
  });
});
