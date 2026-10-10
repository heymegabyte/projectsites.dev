/**
 * @file PanelEmpty — the ONE launchpad empty-state every editor workbench panel uses.
 *
 * @remarks
 * Per `embarrassingly-easy-to-use`: an empty state is NEVER a dead "no data" wall — it's a
 * LAUNCHPAD (a tasteful icon + a one-line headline + a one-line helper + ONE obvious primary
 * action). Before this, each panel hand-rolled the same centered column
 * (`flex-1 … items-center justify-center text-center gap-N p-8`) with an accent icon badge,
 * a `font-medium`/`font-semibold` title, a `text-[11px] text-bolt-elements-textSecondary` helper (AA-contrast on the dark canvas),
 * and a primary button — drifting on gaps, icon size, and max-widths.
 *
 * PanelEmpty is the single source of that chrome, generalized FROM the gold-standard
 * `DatabasePanel` launchpad cards + `BucketsPanel`'s `BucketsEmpty`. It is purely presentational:
 * the caller passes the icon, copy, and (via the `action` slot) its own already-wired primary
 * button — PanelEmpty holds zero business logic. On-brand (bolt-elements tokens / `--ps-accent`),
 * the icon sits in an accent badge, and nothing here is interactive except what the caller hands in.
 * Pair with {@link ./PanelShell} + {@link ./PanelHeader}.
 */
import { memo, type ReactNode } from 'react';
import { classNames } from '~/utils/classNames';

export interface PanelEmptyProps {
  /** Phosphor icon class, e.g. `'i-ph:hard-drives-duotone'` — rendered inside the accent badge. */
  icon: string;
  /** One-line headline naming what's empty (e.g. "No buckets yet"). */
  title: string;
  /** One-line helper explaining the value / what the primary action does. Optional. */
  description?: ReactNode;
  /** The ONE obvious primary action — the caller passes its own already-wired button. Optional. */
  action?: ReactNode;
  /** Extra classes appended after the launchpad defaults. */
  className?: string;
  /** Maps to `data-testid` on the root (e2e + the Deep-UI-Explorer rely on stable ids). */
  testId?: string;
}

/**
 * The canonical launchpad empty-state: centered icon badge + headline + helper + one primary action.
 * Reusable + presentational — no data, no handlers, no bridge logic.
 */
export const PanelEmpty = memo(function PanelEmpty({
  icon,
  title,
  description,
  action,
  className,
  testId,
}: PanelEmptyProps) {
  return (
    <div
      data-testid={testId}
      className={classNames(
        'flex-1 min-h-0 flex flex-col items-center justify-center text-center gap-3 p-8',
        className,
      )}
    >
      {/* Accent icon badge — the cinematic black+cyan tone, AA-safe on the dark panel bg. */}
      <div className="flex items-center justify-center h-16 w-16 rounded-2xl border border-bolt-elements-item-contentAccent/25 bg-bolt-elements-item-contentAccent/[0.06]">
        <div className={classNames(icon, 'text-3xl text-bolt-elements-item-contentAccent')} aria-hidden="true" />
      </div>

      <div className="space-y-1">
        <p className="text-sm font-medium text-bolt-elements-textPrimary">{title}</p>
        {description != null && description !== '' && (
          <p className="text-[11px] text-bolt-elements-textSecondary max-w-[320px] leading-relaxed">{description}</p>
        )}
      </div>

      {action != null && <div className="mt-1 flex items-center justify-center">{action}</div>}
    </div>
  );
});
