/**
 * claude-code-flag.spec.ts — the dark-flag gate for the embedded "Claude Code" tab (WLK-39 S7-prep).
 *
 * Proves the REAL `claude_code_panel` flag replaced the S0 default-OFF constant, and — critically —
 * that the gate is LOAD-BEARING: `isClaudeCodePanelEnabled()` reflects the RESOLVED flag both ways
 * (hidden when off, shown when on). The resolution mirrors the `per_site_data` bridge probe exactly
 * (`GET /api/sites/:siteId/claude-code/status` via `requestClaudeCodeFlag`), so the tests drive the
 * bridge mock + the module store directly — no React needed.
 *
 * Cases:
 *  1. Defaults OFF — the atom is false before any resolution (the tab never shows by default).
 *  2. A bridge reply `enabled:true` resolves the flag ON (the tab shows).
 *  3. A dark-flag reply `enabled:false` keeps it OFF (the tab stays hidden).
 *  4. A rejected probe (dark 404 / no site / timeout) keeps it OFF (fail-safe, never throws).
 *  5. Standalone editor (not embedded) never probes + stays OFF.
 *  6. Resolution is one-shot (idempotent) — a second call does not re-probe.
 *  7. LOAD-BEARING: the test seam flips the resolved value both ways + `isClaudeCodePanelEnabled()` tracks it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Embed bridge mock (mirror the real requestClaudeCodeFlag contract) ───────

const { requestClaudeCodeFlagSpy, isEmbeddedRef } = vi.hoisted(() => {
  return { requestClaudeCodeFlagSpy: vi.fn(), isEmbeddedRef: { value: true } };
});

vi.mock('~/lib/embed/embedded-mode', () => ({
  get isEmbedded() {
    return isEmbeddedRef.value;
  },
  requestClaudeCodeFlag: requestClaudeCodeFlagSpy,
}));

import {
  isClaudeCodePanelEnabled,
  resolveClaudeCodePanelFlag,
  claudeCodePanelEnabled,
  __setClaudeCodePanelEnabledForTest,
} from '../claude-code-flag';

beforeEach(() => {
  requestClaudeCodeFlagSpy.mockReset();
  isEmbeddedRef.value = true;
  // Reset the module store + the one-shot guard between tests (the seam resets both).
  __setClaudeCodePanelEnabledForTest(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isClaudeCodePanelEnabled — default (DARK)', () => {
  it('defaults OFF before any resolution — the tab never renders by default', () => {
    expect(isClaudeCodePanelEnabled()).toBe(false);
    expect(claudeCodePanelEnabled.get()).toBe(false);
  });
});

describe('resolveClaudeCodePanelFlag — bridge probe', () => {
  it('resolves ON when the bridge reply says enabled:true (the tab shows)', async () => {
    requestClaudeCodeFlagSpy.mockResolvedValue({ type: 'PS_CLAUDE_FLAG_RESPONSE', ok: true, enabled: true });

    await resolveClaudeCodePanelFlag();

    expect(requestClaudeCodeFlagSpy).toHaveBeenCalledTimes(1);
    expect(isClaudeCodePanelEnabled()).toBe(true);
  });

  it('stays OFF when the dark-flag reply says enabled:false (the tab stays hidden)', async () => {
    requestClaudeCodeFlagSpy.mockResolvedValue({ type: 'PS_CLAUDE_FLAG_RESPONSE', ok: false, enabled: false });

    await resolveClaudeCodePanelFlag();

    expect(isClaudeCodePanelEnabled()).toBe(false);
  });

  it('stays OFF (fail-safe) when the probe rejects — never throws', async () => {
    requestClaudeCodeFlagSpy.mockRejectedValue(new Error('timed out'));

    await expect(resolveClaudeCodePanelFlag()).resolves.toBeUndefined();
    expect(isClaudeCodePanelEnabled()).toBe(false);
  });

  it('never probes + stays OFF in the standalone editor (not embedded)', async () => {
    isEmbeddedRef.value = false;

    await resolveClaudeCodePanelFlag();

    expect(requestClaudeCodeFlagSpy).not.toHaveBeenCalled();
    expect(isClaudeCodePanelEnabled()).toBe(false);
  });

  it('is one-shot (idempotent) — a second call does not re-probe', async () => {
    requestClaudeCodeFlagSpy.mockResolvedValue({ type: 'PS_CLAUDE_FLAG_RESPONSE', ok: true, enabled: true });

    await resolveClaudeCodePanelFlag();
    await resolveClaudeCodePanelFlag();

    expect(requestClaudeCodeFlagSpy).toHaveBeenCalledTimes(1);
    expect(isClaudeCodePanelEnabled()).toBe(true);
  });
});

describe('isClaudeCodePanelEnabled — the gate is LOAD-BEARING', () => {
  it('reflects the resolved flag BOTH ways (hidden when off, shown when on)', () => {
    // OFF → hidden.
    __setClaudeCodePanelEnabledForTest(false);
    expect(isClaudeCodePanelEnabled()).toBe(false);

    // ON → shown.
    __setClaudeCodePanelEnabledForTest(true);
    expect(isClaudeCodePanelEnabled()).toBe(true);

    // Back OFF → hidden again (a reversible flag flip).
    __setClaudeCodePanelEnabledForTest(false);
    expect(isClaudeCodePanelEnabled()).toBe(false);
  });
});
