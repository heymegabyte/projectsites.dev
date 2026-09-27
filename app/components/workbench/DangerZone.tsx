/**
 * @module components/workbench/DangerZone
 *
 * The Database tab's Danger Zone (FIRE 8) — a clearly-separated, red-accented, COLLAPSED-by-default
 * section that holds destructive actions (currently the per-site greenfield reset). Collapsed by
 * default so a busy owner can never trip a destructive control by accident (`embarrassingly-easy-to-use`):
 * the reset flow + its type-to-confirm gate only mount once the owner deliberately expands this.
 *
 * Rendered at the bottom of the Database tab's Table-view. Self-contained: it only needs a
 * `postToParent` bridge helper (to proxy the authed reset call through the Angular admin) — no other
 * DatabasePanel state. DatabasePanel supplies the same `postToParent` its sibling per-site panels use.
 */
import { memo, useState } from 'react';

import type { ResetRequestMessage } from '~/lib/embed/embedded-mode';
import { classNames } from '~/utils/classNames';
import { GreenfieldReset } from './GreenfieldReset';

export interface DangerZoneProps {
  /** The bridge helper — forwarded to the reset flow (posts PS_RESET_REQUEST to the admin parent). */
  readonly postToParent: (msg: ResetRequestMessage) => void;
}

/** Collapsed, red-accented container for destructive Database-tab actions. */
export const DangerZone = memo(({ postToParent }: DangerZoneProps) => {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-6 pt-3 border-t border-red-500/20" data-testid="data-danger-zone">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="data-danger-zone-toggle"
        className="w-full flex items-center gap-2 rounded-md px-1 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-red-400/80 hover:text-red-300 cursor-pointer transition-colors"
      >
        <div className={classNames('i-ph:caret-right text-xs transition-transform', open && 'rotate-90')} />
        <div className="i-ph:warning-octagon text-sm" />
        <span className="flex-1">Danger zone</span>
      </button>

      {open && (
        <div className="mt-2 px-1">
          <GreenfieldReset postToParent={postToParent} />
        </div>
      )}
    </div>
  );
});

DangerZone.displayName = 'DangerZone';
