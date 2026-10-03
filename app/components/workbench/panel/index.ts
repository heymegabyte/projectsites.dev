/**
 * @file Shared editor workbench PANEL primitives — the re-architecture spine.
 *
 * Every workbench panel composes these so chrome/tokens/empty/loading read identically + on-brand,
 * instead of 15 hand-rolled roots + 4 header paddings. Migrate panels onto these incrementally.
 *
 * Shipped: {@link PanelShell} (root), {@link PanelHeader} (canonical header),
 * {@link PanelLoading} (in-panel Nebula loading), {@link PanelEmpty} (launchpad empties),
 * {@link PanelSegmentedNav} (the Database pill sub-nav, generalized).
 * Next (fan-out): PanelBody.
 */
export { PanelShell, type PanelShellProps } from './PanelShell';
export { PanelHeader, type PanelHeaderProps } from './PanelHeader';
export { PanelLoading, type PanelLoadingProps } from './PanelLoading';
export { PanelEmpty, type PanelEmptyProps } from './PanelEmpty';
export { PanelSegmentedNav, type PanelSegmentedNavProps } from './PanelSegmentedNav';
