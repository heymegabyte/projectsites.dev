/**
 * @file claude-code-flag — the default-OFF gate for the embedded "Claude Code" editor tab
 * (WLK-39 §75 flagship, slices S0+S1).
 *
 * @remarks
 * ## Why this is a constant (and the TODO that replaces it)
 *
 * The editor's canonical dark-gate pattern (see `DataSearchPalette.tsx` + the `per_site_data`
 * flow) is: the client probes a worker endpoint → a dark flag returns `{ enabled:false }` (or the
 * route 404s) → the surface hides. The full WLK-39 S0 scope adds a WORKER flag `claude_code_panel`
 * and an embedded-mode bridge probe so the admin's `/admin/feature-flags` can promote it per-tenant.
 *
 * That worker+bridge round-trip is heavier than slices S0+S1 need (they prove types + a wired
 * panel + build, NOT per-tenant rollout). So — exactly as the brief permits — the tab is gated here
 * on a single default-OFF constant. The gate is REAL (the tab never renders by default) and the
 * promotion path is a one-line swap once the worker flag lands.
 *
 * TODO(WLK-39 S0, full flag): replace {@link isClaudeCodePanelEnabled}'s body with the worker
 * `claude_code_panel` bridge probe (dark → `{enabled:false}` → hide), matching `per_site_data`:
 *   - add the worker flag `claude_code_panel` (registry + manifest + docs, `enabled=0, rollout=0,
 *     stage='experimental'`), register a `PS_CLAUDE_FLAG`-style embedded-mode bridge message,
 *     resolve it once on mount, and key this function off the resolved value (KV-cached, like the
 *     other editor flags). Until then this constant is the single source of truth and stays OFF.
 *
 * NOTE: because the gate is a module-scope constant, the Workbench reads it synchronously at render
 * (no loading flash, no 404 round-trip). Flipping `CLAUDE_CODE_PANEL_ENABLED` to `true` is the only
 * step to dark-launch the tab locally.
 */

/**
 * The slice-S1 dark gate. DEFAULT OFF — the `claude` tab must not render for any user until a
 * deliberate flip (or the worker-flag swap described above). Do NOT wire this to `true` at launch.
 */
export const CLAUDE_CODE_PANEL_ENABLED = false;

/**
 * Whether the embedded Claude Code tab should render.
 *
 * Currently returns the default-OFF constant {@link CLAUDE_CODE_PANEL_ENABLED}. Isolated behind a
 * function so the call sites (the Workbench tab filter + the mount guard) never read the raw
 * constant and the future worker-flag probe is a single-file change.
 *
 * @returns `true` only when the panel is explicitly enabled (always `false` by default).
 */
export function isClaudeCodePanelEnabled(): boolean {
  return CLAUDE_CODE_PANEL_ENABLED;
}
