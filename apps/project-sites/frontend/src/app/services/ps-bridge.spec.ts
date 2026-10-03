import { resolveResourceKind, PS_RES_REQUEST_TYPES } from './ps-bridge';

/**
 * Regression lock for the editor↔worker resource-bridge field-name contract (admin-relay side).
 * fire-101: the relay read `msg.resourceKind` but the editor sends `kind` → resource detail
 * drill-in + inline D1 cell-edit short-circuited silently. This pins the canonical precedence
 * so any future drift fails HERE, not in prod.
 */
describe('resolveResourceKind — editor↔worker bridge SSOT (admin relay)', () => {
  it("resolves the editor's canonical `kind` field (the real payload shape)", () => {
    expect(resolveResourceKind({ kind: 'd1' })).toBe('d1');
    expect(resolveResourceKind({ kind: 'kv' })).toBe('kv');
    expect(resolveResourceKind({ kind: 'r2' })).toBe('r2');
  });

  it('falls back to the legacy `resourceKind` alias only when `kind` is absent', () => {
    expect(resolveResourceKind({ resourceKind: 'd1' })).toBe('d1');
  });

  it('prefers `kind` over `resourceKind` when both are present (precedence lock)', () => {
    expect(resolveResourceKind({ kind: 'd1', resourceKind: 'kv' })).toBe('d1');
  });

  it('an empty `kind` falls through to a valid legacy `resourceKind`', () => {
    expect(resolveResourceKind({ kind: '', resourceKind: 'd1' })).toBe('d1');
  });

  it('returns undefined for neither / empty / non-string / nullish (no silent wrong-kind)', () => {
    expect(resolveResourceKind({})).toBeUndefined();
    expect(resolveResourceKind({ kind: '' })).toBeUndefined();
    expect(resolveResourceKind({ kind: '', resourceKind: '' })).toBeUndefined();
    expect(resolveResourceKind({ kind: 123 as unknown })).toBeUndefined();
    expect(resolveResourceKind(null)).toBeUndefined();
    expect(resolveResourceKind(undefined)).toBeUndefined();
  });

  it('governs exactly the two migrated request types', () => {
    expect([...PS_RES_REQUEST_TYPES]).toEqual(['PS_RES_DETAIL_REQUEST', 'PS_RES_MUTATE_REQUEST']);
  });
});
