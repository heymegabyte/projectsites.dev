/**
 * Progressive-disclosure level shared by both feature control-plane layers
 * (`feature-flags` = platform admin, `site-features` = per-site): show fewer or
 * more controls. A tiny shared type lives here so consumers don't import it from
 * the `mode-switcher` component (which is otherwise decoupled from them).
 */
export type DisclosureMode = 'simple' | 'advanced' | 'expert';
