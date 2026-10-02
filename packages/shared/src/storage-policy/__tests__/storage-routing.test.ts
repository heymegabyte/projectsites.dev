/**
 * @module storage-policy/__tests__/storage-routing
 * @description Boundary tests for the single file-storage-routing authority:
 * exact decimal-threshold cases (29,999,999 / 30,000,000 / 30,000,001), the
 * 30 MiB-is-above-30-MB case, empty files, and invalid/dishonest sizes that
 * must throw (RangeError) or fail schema validation rather than mis-route.
 */
import {
  LARGE_FILE_THRESHOLD_BYTES,
  StorageRoleSchema,
  fileByteLengthSchema,
  isMediaTier,
  isOrdinaryTier,
  safeSelectFileStorage,
  selectFileStorage,
} from '../routing.js';

describe('LARGE_FILE_THRESHOLD_BYTES', () => {
  it('is 30,000,000 decimal bytes (not 30 MiB)', () => {
    expect(LARGE_FILE_THRESHOLD_BYTES).toBe(30_000_000);
    expect(LARGE_FILE_THRESHOLD_BYTES).not.toBe(31_457_280); // 30 MiB
  });
});

describe('selectFileStorage — exact threshold cases', () => {
  it.each([
    [0, 'ordinary'], // empty file
    [1, 'ordinary'],
    [29_999_999, 'ordinary'],
    [30_000_000, 'ordinary'], // exactly at the threshold stays ordinary
  ] as const)('routes %d bytes to %s', (bytes, role) => {
    expect(selectFileStorage(bytes)).toBe(role);
  });

  it.each([
    [30_000_001, 'media'], // one byte over
    [31_457_280, 'media'], // 30 MiB is above 30 decimal MB
    [350 * 1024 * 1024, 'media'], // a 350 MB video
  ] as const)('routes %d bytes to %s', (bytes, role) => {
    expect(selectFileStorage(bytes)).toBe(role);
  });
});

describe('selectFileStorage — invalid sizes throw RangeError', () => {
  it.each([-1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])('throws for %p', (bad) => {
    expect(() => selectFileStorage(bad as number)).toThrow(RangeError);
  });
});

describe('isMediaTier / isOrdinaryTier', () => {
  it('are exact complements at the boundary', () => {
    expect(isOrdinaryTier(30_000_000)).toBe(true);
    expect(isMediaTier(30_000_000)).toBe(false);
    expect(isMediaTier(30_000_001)).toBe(true);
    expect(isOrdinaryTier(30_000_001)).toBe(false);
  });
});

describe('fileByteLengthSchema', () => {
  it('accepts non-negative safe integers', () => {
    expect(fileByteLengthSchema.parse(0)).toBe(0);
    expect(fileByteLengthSchema.parse(30_000_001)).toBe(30_000_001);
  });

  it.each([-1, 2.5, NaN, Number.MAX_SAFE_INTEGER + 1, '100' as unknown as number])('rejects %p', (bad) => {
    expect(fileByteLengthSchema.safeParse(bad).success).toBe(false);
  });
});

describe('safeSelectFileStorage — untrusted declared size', () => {
  it('routes a valid declared size', () => {
    expect(safeSelectFileStorage(30_000_001)).toEqual({ ok: true, role: 'media' });
    expect(safeSelectFileStorage(10)).toEqual({ ok: true, role: 'ordinary' });
  });

  it.each([-1, 1.25, 'nope', null, undefined, {}])('rejects dishonest/invalid %p', (bad) => {
    const result = safeSelectFileStorage(bad);
    expect(result.ok).toBe(false);
  });
});

describe('StorageRoleSchema', () => {
  it('accepts the two tiers and rejects anything else', () => {
    expect(StorageRoleSchema.parse('ordinary')).toBe('ordinary');
    expect(StorageRoleSchema.parse('media')).toBe('media');
    expect(StorageRoleSchema.safeParse('preview').success).toBe(false);
  });
});
