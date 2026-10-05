/**
 * @file claude-code-flag — the dark-flag gate for the embedded "Claude Code" editor tab
 * (WLK-39 §75 flagship). S7-prep replaces the S0 default-OFF module CONSTANT with the REAL
 * `claude_code_panel` worker flag, resolved over the embedded-mode bridge.
 *
 * @remarks
 * ## The resolution path (mirrors `per_site_data` EXACTLY)
 * The editor's canonical dark-gate pattern (see `DataSearchPalette.tsx` + the `per_site_data`
 * flow) is a BRIDGE PROBE: the embedded editor has no cross-origin session, so it asks the admin
 * (which holds `selectedSite` + the bearer) to call a flag-gated worker endpoint. A dark flag
 * returns a `404` whose body says the feature is "not enabled" → the admin translates that to
 * `{ enabled:false }` → the surface hides. Never 403, never a leaked existence.
 *
 * Here the probe is `GET /api/sites/:siteId/claude-code/status` (worker
 * `libs/features/claude_code_panel/handlers.ts`), reached via the `PS_CLAUDE_FLAG_REQUEST` →
 * `PS_CLAUDE_FLAG_RESPONSE` bridge ({@link requestClaudeCodeFlag}). The flag is registered in the
 * worker `FLAG_REGISTRY` (`claude_code_panel`, `enabled=0, rollout=0, stage='experimental'`), so it
 * is promotable per-tenant from `/admin/feature-flags` with NO code change.
 *
 * ## Why an atom, resolved once on mount
 * The Workbench reads {@link isClaudeCodePanelEnabled} SYNCHRONOUSLY at render (the tab strip must
 * render without a loading flash). So the resolved value lives in a module-scope nanostore
 * {@link claudeCodePanelEnabled} that DEFAULTS OFF; {@link resolveClaudeCodePanelFlag} runs the
 * bridge probe ONCE on mount and flips the atom to the resolved value, and the Workbench subscribes
 * to the atom so it re-renders when the flag resolves ON. Until it resolves (and forever in the
 * standalone editor, where the bridge rejects), the tab stays DARK — fail-safe: the flagship never
 * appears spuriously on a transport hiccup.
 */
import { atom } from 'nanostores';

import { isEmbedded, requestClaudeCodeFlag } from '~/lib/embed/embedded-mode';

/**
 * The resolved `claude_code_panel` flag state. DEFAULT OFF — the `claude` tab must not render for
 * any user until {@link resolveClaudeCodePanelFlag} resolves it ON via the worker flag. Exposed as a
 * nanostore so the Workbench can subscribe and re-render the moment it flips.
 */
export const claudeCodePanelEnabled = atom<boolean>(false);

/** Guards against re-probing: the bridge resolution runs at most once per session. */
let resolutionStarted = false;

/**
 * Whether the embedded Claude Code tab should render.
 *
 * Reads the resolved {@link claudeCodePanelEnabled} atom (synchronous — no loading flash at the tab
 * strip). `false` by default; `true` only after {@link resolveClaudeCodePanelFlag} resolves the
 * worker `claude_code_panel` flag ON for the current tenant. Isolated behind a function so the call
 * sites (the Workbench tab filter + the mount guard) never read the raw atom.
 *
 * @returns `true` only when the panel's worker flag has resolved ON (always `false` by default).
 */
export function isClaudeCodePanelEnabled(): boolean {
  return claudeCodePanelEnabled.get();
}

/**
 * Resolve the `claude_code_panel` worker flag ONCE and publish it to {@link claudeCodePanelEnabled}.
 * Call from the Workbench on mount. Idempotent (a second call is a no-op). Outside embedded mode the
 * bridge rejects, so the atom stays OFF and the standalone editor never shows the tab.
 *
 * Fail-safe: any rejection (dark flag, no selected site, timeout, standalone) leaves the atom OFF —
 * the flagship tab only ever appears on an explicit `enabled:true` reply.
 */
export async function resolveClaudeCodePanelFlag(): Promise<void> {
  if (resolutionStarted) {
    return;
  }

  resolutionStarted = true;

  // Standalone editor (no admin parent) — no bridge to probe; stay dark.
  if (!isEmbedded) {
    return;
  }

  try {
    const reply = await requestClaudeCodeFlag();
    claudeCodePanelEnabled.set(reply.enabled === true);
  } catch {
    // Dark flag / no site / timeout — keep the tab hidden (fail-safe, never throws).
    claudeCodePanelEnabled.set(false);
  }
}

/**
 * TEST-ONLY seam: force the resolved flag value AND reset the one-shot guard, so a unit test can
 * assert {@link isClaudeCodePanelEnabled} both ways (hidden when off, shown when on) without the
 * bridge. Never called by production code.
 *
 * @param enabled - the resolved value to publish.
 */
export function __setClaudeCodePanelEnabledForTest(enabled: boolean): void {
  resolutionStarted = false;
  claudeCodePanelEnabled.set(enabled);
}
