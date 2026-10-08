/**
 * @file Resources › Connections — the panel's state-derivation + pure list helpers (Resources sub-tab #6).
 *
 * The Connections panel lists a site's active MCP connections (Mailchimp, Stripe, GitHub, …) via the
 * parent-bridge `requestConnections` reply, and disconnects one via `disconnectConnection`. Per the
 * sibling `FunctionsPanel`'s `deriveFunctionsState`, the reply→state mapping is a PURE function
 * (`deriveConnectionsState`) so every render branch — loading / disabled / error / data / honest-empty
 * — is falsifiable WITHOUT mounting the cross-origin iframe panel.
 *
 * These tests pin:
 *   1. The DARK `site_connections` gate (reply `enabled:false`, or a "not enabled" message) → `disabled`.
 *   2. A genuine failure → `error` with the reply's message (or a safe default), NEVER `disabled`.
 *   3. A successful reply → `ready` with the connections + provider catalog; honest-empty `[]` stays
 *      a ready state (a site with no connections is valid, not an error).
 *   4. `providerLabel` title-cases/de-snakes keys with proper-noun fixups.
 *   5. `removeConnection` / `restoreConnection` are a sound optimistic-remove + exact-position undo pair.
 */
import { describe, expect, it } from 'vitest';
import {
  deriveConnectionsState,
  providerLabel,
  removeConnection,
  restoreConnection,
} from '../ConnectionsPanel';
import type { ConnectionEntry } from '~/lib/embed/embedded-mode';

/** Build a ConnectionEntry with the fields the panel reads. */
function conn(id: string, provider: string): ConnectionEntry {
  return {
    id,
    provider,
    display_name: null,
    status: 'active',
    metadata: {},
    connected_at: '2026-10-08T12:00:00.000Z',
  };
}

// ─── deriveConnectionsState — the reply→render-state mapping ─────────────────

describe('deriveConnectionsState', () => {
  it('maps the DARK gate (enabled:false) → disabled (friendly card, not an error)', () => {
    expect(deriveConnectionsState({ ok: false, enabled: false })).toEqual({ status: 'disabled' });
  });

  it('maps a "not enabled" error message → disabled', () => {
    expect(deriveConnectionsState({ ok: false, error: 'this feature is not enabled yet' })).toEqual({
      status: 'disabled',
    });
  });

  it('maps a genuine failure → error with the reply message (never disabled)', () => {
    expect(deriveConnectionsState({ ok: false, error: 'Could not load connections.' })).toEqual({
      status: 'error',
      message: 'Could not load connections.',
    });
  });

  it('maps ok:false with no message → error with a safe default', () => {
    const s = deriveConnectionsState({ ok: false });
    expect(s.status).toBe('error');
    expect((s as { status: 'error'; message: string }).message).toMatch(/could not load/i);
  });

  it('maps a successful reply → ready with the connections + provider catalog', () => {
    const connections = [conn('c1', 'mailchimp'), conn('c2', 'github')];
    const providers = ['mailchimp', 'github', 'stripe'];
    expect(deriveConnectionsState({ ok: true, connections, providers })).toEqual({
      status: 'ready',
      connections,
      providers,
    });
  });

  it('honest-empty: ok:true + no connections → ready with [] (a valid state, not an error)', () => {
    expect(deriveConnectionsState({ ok: true, connections: [], providers: ['stripe'] })).toEqual({
      status: 'ready',
      connections: [],
      providers: ['stripe'],
    });
  });

  it('defaults connections + providers to [] when the reply omits them (never undefined)', () => {
    expect(deriveConnectionsState({ ok: true })).toEqual({
      status: 'ready',
      connections: [],
      providers: [],
    });
  });
});

// ─── providerLabel — human provider names ────────────────────────────────────

describe('providerLabel', () => {
  it('applies proper-noun fixups for common providers', () => {
    expect(providerLabel('github')).toBe('GitHub');
    expect(providerLabel('hubspot')).toBe('HubSpot');
    expect(providerLabel('google_calendar')).toBe('Google Calendar');
    expect(providerLabel('cal_com')).toBe('Cal.com');
  });

  it('title-cases + de-snakes an unknown provider key', () => {
    expect(providerLabel('my_custom_tool')).toBe('My Custom Tool');
    expect(providerLabel('mailchimp')).toBe('Mailchimp');
  });

  it('is empty-safe', () => {
    expect(providerLabel('')).toBe('');
  });
});

// ─── removeConnection / restoreConnection — optimistic disconnect + undo ──────

describe('removeConnection / restoreConnection', () => {
  it('removes a connection by id and reports its original index', () => {
    const list = [conn('a', 'stripe'), conn('b', 'github'), conn('c', 'slack')];
    const { connections, removed, index } = removeConnection(list, 'b');
    expect(connections.map((c) => c.id)).toEqual(['a', 'c']);
    expect(removed?.id).toBe('b');
    expect(index).toBe(1);
    // input not mutated
    expect(list.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('is a no-op for an absent id (removed undefined, index -1)', () => {
    const list = [conn('a', 'stripe')];
    const { connections, removed, index } = removeConnection(list, 'zzz');
    expect(connections.map((c) => c.id)).toEqual(['a']);
    expect(removed).toBeUndefined();
    expect(index).toBe(-1);
  });

  it('restores a removed connection at its exact original index (round-trip)', () => {
    const list = [conn('a', 'stripe'), conn('b', 'github'), conn('c', 'slack')];
    const { connections, removed, index } = removeConnection(list, 'b');
    const restored = restoreConnection(connections, removed, index);
    expect(restored.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('restore is a no-op when removed is undefined or already present (idempotent)', () => {
    const list = [conn('a', 'stripe'), conn('b', 'github')];
    expect(restoreConnection(list, undefined, 0).map((c) => c.id)).toEqual(['a', 'b']);
    expect(restoreConnection(list, conn('a', 'stripe'), 0).map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('restore clamps an out-of-range index (appends, never drops)', () => {
    const list = [conn('a', 'stripe')];
    const restored = restoreConnection(list, conn('z', 'slack'), 99);
    expect(restored.map((c) => c.id)).toEqual(['a', 'z']);
  });
});
