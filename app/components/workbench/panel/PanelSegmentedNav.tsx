/**
 * @file PanelSegmentedNav — the shared segmented pill sub-nav for editor workbench panels.
 *
 * @remarks
 * A concise, Airtable/Notion-like segmented BUTTON bar (e.g. Tables · SQL · KV). Generalized FROM
 * the gold-standard {@link DatabasePanel} sub-nav so every panel's sub-nav reads identically +
 * on-brand instead of each hand-rolling a pill row. Presentational + controlled: the parent owns
 * the active state; this renders the pills, the accent treatment, and keyboard roving.
 *
 * On-brand black+cyan: the active pill carries the cyan accent treatment, inactive pills stay muted
 * and lift on hover. WCAG AA — real `<button>` per item, `aria-current` on the active one, `role="tab"`
 * inside a `role="tablist"` with Left/Right/Home/End roving-tabindex, a visible focus ring, and a
 * 24px minimum target (`min-h-[24px]`). Icons are optional `i-ph:*` phosphor classes; counts render
 * as a trailing badge.
 */
import { memo, useCallback, type KeyboardEvent } from 'react';
import { classNames } from '~/utils/classNames';

/** One segment in the pill bar. `icon` is an optional `i-ph:*` class; `count` renders as a trailing badge. */
export interface PanelSegmentedNavItem {
  id: string;
  label: string;
  icon?: string;
  count?: number;
}

export interface PanelSegmentedNavProps {
  items: PanelSegmentedNavItem[];
  /** The currently-active item id. */
  activeId: string;
  /** Fired with the chosen item id on click or keyboard roving. */
  onSelect: (id: string) => void;
  /** Accessible label for the tablist (defaults to "Views"). */
  ariaLabel?: string;
  /** Extra classes appended to the pill-bar container. */
  className?: string;
  /** Maps to `data-testid` on the tablist container (e2e + Deep-UI-Explorer rely on stable ids). */
  testId?: string;
}

export const PanelSegmentedNav = memo(function PanelSegmentedNav({
  items,
  activeId,
  onSelect,
  ariaLabel = 'Views',
  className,
  testId,
}: PanelSegmentedNavProps) {
  // Roving-tabindex keyboard nav across the segmented bar (Left/Right/Home/End) — so the whole
  // control is one tab stop and arrows move between pills, matching the gold-standard DatabasePanel.
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];

      if (!keys.includes(event.key)) {
        return;
      }

      event.preventDefault();

      const idx = items.findIndex((item) => item.id === activeId);

      if (idx === -1) {
        return;
      }

      let nextIdx = idx;

      if (event.key === 'ArrowLeft') {
        nextIdx = (idx - 1 + items.length) % items.length;
      } else if (event.key === 'ArrowRight') {
        nextIdx = (idx + 1) % items.length;
      } else if (event.key === 'Home') {
        nextIdx = 0;
      } else if (event.key === 'End') {
        nextIdx = items.length - 1;
      }

      onSelect(items[nextIdx].id);
    },
    [items, activeId, onSelect],
  );

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      data-testid={testId}
      onKeyDown={onKeyDown}
      className={classNames(
        'flex items-center gap-1 rounded-lg bg-bolt-elements-background-depth-2 p-0.5 border border-bolt-elements-borderColor/60 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]',
        className,
      )}
    >
      {items.map((item) => {
        const active = item.id === activeId;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            data-filled-pill=""
            aria-selected={active}
            aria-current={active ? 'true' : undefined}
            tabIndex={active ? 0 : -1}
            data-testid={`panel-segnav-${item.id}`}
            onClick={() => onSelect(item.id)}
            className={classNames(
              'min-h-[24px] flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md transition-all duration-150 motion-reduce:transition-none',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer',
              active
                ? 'bg-bolt-elements-item-contentAccent/[0.12] text-bolt-elements-item-contentAccent border border-bolt-elements-item-contentAccent/30'
                : 'border border-transparent text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3',
            )}
          >
            {item.icon != null && item.icon !== '' && (
              <div className={classNames(item.icon, 'text-sm')} aria-hidden="true" />
            )}
            {item.label}
            {item.count != null && (
              <span className="ml-0.5 inline-flex items-center justify-center min-w-[1.25rem] px-1 text-[10px] font-semibold rounded-full bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary">
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
});
