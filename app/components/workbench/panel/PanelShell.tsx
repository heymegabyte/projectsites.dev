/**
 * @file PanelShell — the ONE root wrapper every editor workbench panel uses.
 *
 * @remarks
 * Before this, all ~15 workbench panels hand-rolled the same root
 * (`h-full flex flex-col bg-bolt-elements-background-depth-1 …`), drifting on tokens +
 * `color-scheme`. PanelShell is the single source of that chrome — one dark, brand-accented
 * column (black `--ps-bg` / cyan `--ps-accent`) with `color-scheme:dark` so native controls
 * (scrollbars, selects, date pickers) render on-brand. Generalized FROM the gold-standard
 * `DatabasePanel` root. Pair with {@link PanelHeader}.
 */
import { memo, type ReactNode } from 'react';
import { classNames } from '~/utils/classNames';

export interface PanelShellProps {
  children: ReactNode;
  /** Extra classes appended after the shell defaults. */
  className?: string;
  /** Maps to `data-testid` on the root (e2e + the Deep-UI-Explorer rely on stable ids). */
  testId?: string;
}

export const PanelShell = memo(function PanelShell({ children, className, testId }: PanelShellProps) {
  return (
    <div
      data-testid={testId}
      className={classNames(
        'h-full flex flex-col bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary [color-scheme:dark] accent-[color:var(--ps-accent,#00e5ff)]',
        className,
      )}
    >
      {children}
    </div>
  );
});
