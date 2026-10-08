/**
 * @file Resources › Functions — the panel's state-derivation + byte formatting (Resources sub-tab #5).
 *
 * The Functions panel lists a site's CODE-DEFINED Functions on Workers-for-Platforms (ADR-0035): its
 * deployed `functions/` worker + its declared crons, via the parent-bridge `requestFunctions` reply.
 * Per the sibling `AutomationsPanel`/`MediaPageStats` pattern, the reply→state mapping is a PURE
 * function (`deriveFunctionsState`) so every render branch — loading / disabled / error / data /
 * honest-empty — is falsifiable WITHOUT mounting the cross-origin iframe panel.
 *
 * These tests pin:
 *   1. The DARK `site_functions` flag (reply `enabled:false`, or a "not enabled" message) → `disabled`.
 *   2. A genuine failure → `error` with the reply's message (or a safe default), NEVER `disabled`.
 *   3. A successful reply → `ready` with the functions + both deploy signals; honest-empty `[]` stays
 *      a ready state (a site with no functions is valid, not an error).
 *   4. `formatBytes` renders the deployed bundle size (B / KB / MB), and is null-safe.
 */
import { describe, expect, it } from 'vitest';
import { deriveFunctionsState, formatBytes } from '../FunctionsPanel';
import type { FunctionEntry } from '~/lib/embed/embedded-mode';

/** Build a FunctionEntry with the fields the panel reads. */
function httpFn(name: string): FunctionEntry {
  return {
    id: name,
    kind: 'http',
    name,
    status: 'deployed',
    cron: null,
    bundleBytes: 2048,
    deployed_at: '2026-10-08T12:00:00.000Z',
  };
}

function cronFn(cron: string): FunctionEntry {
  return {
    id: `cron:${cron}`,
    kind: 'scheduled',
    name: cron,
    status: 'deployed',
    cron,
    bundleBytes: null,
    deployed_at: '2026-10-08T12:00:00.000Z',
  };
}

// ─── deriveFunctionsState — the reply→render-state mapping ───────────────────

describe('deriveFunctionsState', () => {
  it('maps the DARK flag (enabled:false) → disabled (friendly card, not an error)', () => {
    expect(deriveFunctionsState({ ok: false, enabled: false })).toEqual({ status: 'disabled' });
  });

  it('maps a "not enabled" error message → disabled', () => {
    expect(deriveFunctionsState({ ok: false, error: 'this feature is not enabled yet' })).toEqual({
      status: 'disabled',
    });
  });

  it('maps a genuine failure → error with the reply message (never disabled)', () => {
    expect(deriveFunctionsState({ ok: false, error: 'Could not load functions.' })).toEqual({
      status: 'error',
      message: 'Could not load functions.',
    });
  });

  it('maps ok:false with no message → error with a safe default', () => {
    const s = deriveFunctionsState({ ok: false });
    expect(s.status).toBe('error');
    expect((s as { status: 'error'; message: string }).message).toMatch(/could not load/i);
  });

  it('maps a successful reply → ready with the functions list + both deploy signals', () => {
    const functions = [httpFn('site-abc'), cronFn('0 * * * *')];
    expect(deriveFunctionsState({ ok: true, functions, functionsDeployed: true, wfpConfigured: true })).toEqual({
      status: 'ready',
      functions,
      functionsDeployed: true,
      wfpConfigured: true,
    });
  });

  it('honest-empty: ok:true + no functions → ready with [] (a valid state, not an error)', () => {
    expect(deriveFunctionsState({ ok: true, functions: [], functionsDeployed: false, wfpConfigured: true })).toEqual({
      status: 'ready',
      functions: [],
      functionsDeployed: false,
      wfpConfigured: true,
    });
  });

  it('defaults the deploy signals to false when the reply omits them (never undefined)', () => {
    const s = deriveFunctionsState({ ok: true });
    expect(s).toEqual({ status: 'ready', functions: [], functionsDeployed: false, wfpConfigured: false });
  });
});

// ─── formatBytes — deployed bundle size ──────────────────────────────────────

describe('formatBytes', () => {
  it('renders bytes under 1 KiB as B', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(834)).toBe('834 B');
  });

  it('renders KiB with one decimal under 10, rounded at/over 10', () => {
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(20480)).toBe('20 KB');
  });

  it('renders MiB for large bundles', () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('is null-safe (no size → undefined, never a crash)', () => {
    expect(formatBytes(null)).toBeUndefined();
    expect(formatBytes(undefined)).toBeUndefined();
    expect(formatBytes(-1)).toBeUndefined();
    expect(formatBytes(Number.NaN)).toBeUndefined();
  });
});
