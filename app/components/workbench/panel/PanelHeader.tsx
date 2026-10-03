/**
 * @file PanelHeader — the canonical header for every editor workbench panel.
 *
 * @remarks
 * One chrome for every panel, so they read identically + on-brand: a subtle black→cyan brand
 * wash, an accent icon BADGE, a single `<h2>` title + optional subtitle, a right-aligned
 * `actions` slot (live-freshness, buttons…), and an optional `toolbar` row beneath.
 *
 * Generalized FROM the gorgeous `ResourceOverviewPanel` header so the drift it replaces is gone:
 * panels previously hand-rolled headers at `px-3 py-2` / `px-4 py-3` / `px-4 py-2.5` / `px-3 py-2.5`
 * (four paddings) with `<h2>`-vs-`<h3>` titles and muted-vs-accent icons. This is the SINGLE header:
 * fixed `px-4 py-3`, one `<h2 text-sm font-semibold tracking-tight>`, one accent icon badge.
 * Per `gorgeous-by-default` (black+cyan, cinematic) + `embarrassingly-easy-to-use` (one clear title
 * + at most one obvious action cluster) + WCAG AA (the accent badge keeps ≥4.5:1 on the dark bg).
 */
import { memo, type ReactNode } from 'react';
import { classNames } from '~/utils/classNames';

export interface PanelHeaderProps {
  /** Phosphor icon class, e.g. `'i-ph:stack-duotone'` — rendered inside the accent badge. */
  icon: string;
  title: string;
  /** One muted line under the title (status, scope, count). Omit for a bare title. */
  subtitle?: ReactNode;
  /** Right-aligned action cluster (live-freshness affordance, buttons). No manual Refresh buttons. */
  actions?: ReactNode;
  /** Optional sub-toolbar row rendered under the title row (segmented nav, filters). */
  toolbar?: ReactNode;
  className?: string;
  testId?: string;
}

export const PanelHeader = memo(function PanelHeader({
  icon,
  title,
  subtitle,
  actions,
  toolbar,
  className,
  testId,
}: PanelHeaderProps) {
  return (
    <div
      data-testid={testId}
      className={classNames(
        'relative flex flex-col border-b border-bolt-elements-borderColor shrink-0 overflow-hidden',
        className,
      )}
    >
      {/* Brand wash — the cinematic black→cyan tone from the first pixel (decorative, AA-neutral). */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          background: 'linear-gradient(90deg, color-mix(in oklch, #00e5ff 8%, transparent), transparent 40%)',
        }}
      />
      <div className="relative flex items-center gap-3 px-4 py-3">
        <div className="flex items-center justify-center h-9 w-9 rounded-xl border border-bolt-elements-item-contentAccent/30 bg-bolt-elements-item-contentAccent/[0.08] shrink-0">
          <div className={classNames(icon, 'text-xl text-bolt-elements-item-contentAccent')} aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-bolt-elements-textPrimary tracking-tight">{title}</h2>
          {subtitle != null && subtitle !== '' && (
            <p className="text-[10px] text-bolt-elements-textTertiary truncate">{subtitle}</p>
          )}
        </div>
        {actions != null && <div className="ml-auto flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
      {toolbar != null && <div className="relative px-4 pb-2">{toolbar}</div>}
    </div>
  );
});
