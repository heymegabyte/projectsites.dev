/**
 * @file Shared editor workbench PANEL primitives — the re-architecture spine.
 *
 * Every workbench panel composes these so chrome/tokens/empty/loading read identically + on-brand,
 * instead of 15 hand-rolled roots + 4 header paddings. Migrate panels onto these incrementally.
 *
 * Shipped: {@link PanelShell} (root), {@link PanelHeader} (canonical header).
 * Next (fan-out): PanelBody, PanelEmpty (launchpad empties), PanelLoading (in-panel Nebula),
 * PanelSegmentedNav (the Database pill sub-nav, generalized).
 */
export { PanelShell, type PanelShellProps } from './PanelShell';
export { PanelHeader, type PanelHeaderProps } from './PanelHeader';
