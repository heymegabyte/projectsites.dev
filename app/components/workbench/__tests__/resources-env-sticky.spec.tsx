// @vitest-environment jsdom
/**
 * @file Resources › env switcher persistence (RES-ENV-STICKY, fire-142; Resources EPIC cross-cut).
 *
 * The preview↔production env switcher was `useState('production')` with NO persistence, so navigating
 * away from Resources (section change) and back — or remounting the tab / rebooting the editor — snapped
 * a business owner who was working in Preview silently back to Production. This proves the selection is
 * now PERSISTED (localStorage, SSR/quota-guarded) and therefore survives a full unmount + remount.
 *
 *   1. Pure round-trip — `persistResEnv` writes, `readPersistedResEnv` reads it back; a corrupt/absent
 *      value falls back to the default (never strands the panel on an invalid env).
 *   2. Render + remount survival — select Preview, UNMOUNT the panel, re-render a FRESH instance; the
 *      new mount's lazy initializer restores Preview (`aria-pressed=true`), not the default Production.
 *
 * The bridge + heavy child panels are mocked so this stays about the env switcher's persistence.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';

// Non-embedded bridge: media/files fall to a friendly error, but the header env switcher still renders.
vi.mock('~/lib/embed/embedded-mode', () => ({
  isEmbedded: false,
  postToastToParent: vi.fn(),
  requestResMedia: vi.fn(async () => ({ ok: false, error: 'not embedded' })),
  requestMediaUpload: vi.fn(async () => ({ ok: false, error: 'not embedded' })),
  requestResSiteFiles: vi.fn(async () => ({ ok: false, error: 'not embedded' })),
}));

// Stub the heavy sibling panels (they have their own specs) so this spec is just the switcher.
vi.mock('./ResourceOverviewPanel', () => ({ ResourceOverviewPanel: () => <div data-testid="stub-overview" /> }));
vi.mock('./BucketsPanel', () => ({ BucketsPanel: () => <div data-testid="stub-buckets" /> }));
vi.mock('./AutomationsPanel', () => ({ AutomationsPanel: () => <div data-testid="stub-automations" /> }));

import { ResourcesPanel, readPersistedResEnv, persistResEnv, RES_ENV_STORAGE_KEY } from '../ResourcesPanel';

beforeEach(() => {
  try {
    localStorage.removeItem(RES_ENV_STORAGE_KEY);
  } catch {
    /* ignore */
  }
});

afterEach(() => cleanup());

describe('RES-ENV-STICKY — pure persistence helpers', () => {
  it('round-trips the selected environment through localStorage', () => {
    expect(readPersistedResEnv()).toBe('production'); // nothing stored → default
    persistResEnv('preview');
    expect(readPersistedResEnv()).toBe('preview');
    persistResEnv('production');
    expect(readPersistedResEnv()).toBe('production');
  });

  it('falls back to the default for a corrupt/unknown stored value', () => {
    localStorage.setItem(RES_ENV_STORAGE_KEY, 'staging-nonsense');
    expect(readPersistedResEnv()).toBe('production');
  });
});

describe('RES-ENV-STICKY — selection survives a remount', () => {
  it('restores the previously-selected Preview env after a full unmount + remount', () => {
    // First mount: defaults to Production (nothing persisted).
    const first = render(<ResourcesPanel />);
    const productionBtn = screen.getByTestId('resources-env-production');
    expect(productionBtn.getAttribute('aria-pressed')).toBe('true');

    // The owner switches to Preview.
    fireEvent.click(screen.getByTestId('resources-env-preview'));
    expect(screen.getByTestId('resources-env-preview').getAttribute('aria-pressed')).toBe('true');

    // Persisted immediately (the lazy initializer of the NEXT mount reads this).
    expect(readPersistedResEnv()).toBe('preview');

    // Fully unmount (simulates leaving the tab / editor reboot) …
    first.unmount();

    // … and re-render a FRESH instance — it must come up on Preview, not snap back to Production.
    render(<ResourcesPanel />);
    expect(screen.getByTestId('resources-env-preview').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('resources-env-production').getAttribute('aria-pressed')).toBe('false');
  });
});
