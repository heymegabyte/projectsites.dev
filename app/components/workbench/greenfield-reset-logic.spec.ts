/**
 * @file Unit tests for greenfield-reset-logic pure helpers (FIRE 8). Run with Vitest.
 * The confirm gate is the safety of a destructive feature — it gets adversarial coverage.
 */
import { describe, it, expect } from 'vitest';
import type { ResetPreviewData } from '~/lib/embed/embedded-mode';
import {
  isResetConfirmed,
  summarizeResetImpact,
  isResetEmpty,
  RESET_KEYWORD,
} from './greenfield-reset-logic.js';

describe('isResetConfirmed', () => {
  it('authorizes the literal RESET keyword (any case, trimmed)', () => {
    expect(isResetConfirmed('RESET', 'my-cafe')).toBe(true);
    expect(isResetConfirmed('reset', 'my-cafe')).toBe(true);
    expect(isResetConfirmed('  Reset  ', 'my-cafe')).toBe(true);
  });

  it('authorizes an exact slug match (case-insensitive, trimmed)', () => {
    expect(isResetConfirmed('my-cafe', 'my-cafe')).toBe(true);
    expect(isResetConfirmed('MY-CAFE', 'my-cafe')).toBe(true);
    expect(isResetConfirmed(' my-cafe ', 'my-cafe')).toBe(true);
  });

  it('refuses empty / whitespace / a wrong string', () => {
    expect(isResetConfirmed('', 'my-cafe')).toBe(false);
    expect(isResetConfirmed('   ', 'my-cafe')).toBe(false);
    expect(isResetConfirmed('wrong', 'my-cafe')).toBe(false);
    expect(isResetConfirmed('my-caf', 'my-cafe')).toBe(false); // near-miss must fail
  });

  it('still authorizes RESET when the slug is unknown/empty', () => {
    expect(isResetConfirmed('RESET', null)).toBe(true);
    expect(isResetConfirmed('anything', null)).toBe(false);
    expect(isResetConfirmed('anything', '')).toBe(false);
  });

  it('exports RESET_KEYWORD as the canonical keyword', () => {
    expect(RESET_KEYWORD).toBe('RESET');
  });
});

describe('summarizeResetImpact', () => {
  it('sums rows + KV keys + R2 objects into a grand total', () => {
    const preview: ResetPreviewData = {
      available: true,
      d1: {
        databaseId: 'd1',
        databaseName: 'ps-site-x',
        tables: [
          { name: 'leads', rowCount: 10 },
          { name: 'orders', rowCount: 5 },
        ],
        tablesAvailable: true,
      },
      kv: { namespaceId: 'kv', namespaceName: 'ps-site-x-kv', keyCount: 3, keysAvailable: true },
      r2: { bucket: 'ps-site-x', objectCount: 7, objectsAvailable: true },
    };
    const s = summarizeResetImpact(preview);
    expect(s.tableCount).toBe(2);
    expect(s.rowCount).toBe(15);
    expect(s.kvKeyCount).toBe(3);
    expect(s.r2ObjectCount).toBe(7);
    expect(s.total).toBe(25);
    expect(s.hasUnknown).toBe(false);
  });

  it('flips hasUnknown (never a fake 0) when a row/probe count is null or a surface is unavailable', () => {
    const preview: ResetPreviewData = {
      available: true,
      d1: {
        databaseId: 'd1',
        databaseName: null,
        tables: [{ name: 'leads', rowCount: null }],
        tablesAvailable: true,
      },
      kv: { namespaceId: null, namespaceName: null, keyCount: 0, keysAvailable: false },
      r2: { bucket: null, objectCount: 0, objectsAvailable: true },
    };
    const s = summarizeResetImpact(preview);
    expect(s.rowCount).toBe(0); // null contributes 0 to the sum…
    expect(s.hasUnknown).toBe(true); // …but the UI is told the total is not exact
  });

  it('handles a null/absent preview as all-zero', () => {
    const s = summarizeResetImpact(null);
    expect(s.total).toBe(0);
    expect(s.hasUnknown).toBe(false);
  });
});

describe('isResetEmpty', () => {
  it('true when unavailable or literally nothing to delete', () => {
    expect(isResetEmpty(null)).toBe(true);
    expect(isResetEmpty({ available: false })).toBe(true);
    expect(
      isResetEmpty({
        available: true,
        d1: { databaseId: 'd1', databaseName: null, tables: [], tablesAvailable: true },
        kv: { namespaceId: null, namespaceName: null, keyCount: 0, keysAvailable: true },
        r2: { bucket: null, objectCount: 0, objectsAvailable: true },
      }),
    ).toBe(true);
  });

  it('false when there is anything to delete OR an unknown count', () => {
    expect(
      isResetEmpty({
        available: true,
        d1: { databaseId: 'd1', databaseName: null, tables: [{ name: 't', rowCount: 1 }], tablesAvailable: true },
        kv: { namespaceId: null, namespaceName: null, keyCount: 0, keysAvailable: true },
        r2: { bucket: null, objectCount: 0, objectsAvailable: true },
      }),
    ).toBe(false);
    // Unknown counts must NOT read as empty (we can't prove it's empty).
    expect(
      isResetEmpty({
        available: true,
        d1: { databaseId: 'd1', databaseName: null, tables: [], tablesAvailable: false },
        kv: { namespaceId: null, namespaceName: null, keyCount: 0, keysAvailable: true },
        r2: { bucket: null, objectCount: 0, objectsAvailable: true },
      }),
    ).toBe(false);
  });
});
