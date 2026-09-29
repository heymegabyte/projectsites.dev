/**
 * @file PromoteHeaderControl — one-click Promote -> Production in the editor's MAIN HEADER (Slice 5).
 *
 * @remarks
 * The cyan "Promote" button that lives in the editor's Code-view command bar (beside the Deploy /
 * snapshots / git ProjectHub), so publishing the Preview to Production is ONE click from the main view —
 * not three (editor -> Source Control tab -> Promote). It REUSES the shared {@link usePromote} flow, so it
 * dispatches the SAME `PS_PROMOTE_REQUEST` and renders the SAME honest terminal outcome as
 * {@link SourceControlPanel} — the promote state machine is NEVER forked (interconnectedness).
 *
 * - One obvious primary action; disabled WITH a reason (title + aria) when nothing is promotable — never a
 *   dead/doomed control (embarrassingly-easy-to-use).
 * - The label reserves its widest width ("Promote" | "Publishing…") so the button never resizes
 *   (buttons-accommodate-largest-text).
 * - DARK behind `durable_preview`: when the flag is off the gate reason is "coming soon" and the button is
 *   disabled — it never presents a working control for an unavailable feature.
 *
 * @module components/workbench/PromoteHeaderControl
 */
import { memo } from 'react';

import { classNames } from '~/utils/classNames';
import { usePromote } from './use-promote';

/** Cyan-primary button classes (mirrors SourceControlPanel's primary variant — zero raw hex). */
const PRIMARY_BTN =
  'inline-flex items-center justify-center gap-1.5 rounded-md font-medium select-none ' +
  'min-h-[26px] px-2.5 text-[11px] ' +
  'transition-[background-color,border-color,color,box-shadow,transform] duration-150 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 ' +
  'focus-visible:ring-offset-bolt-elements-background-depth-1 focus-visible:ring-bolt-elements-item-contentAccent ' +
  'active:translate-y-px disabled:cursor-not-allowed disabled:active:translate-y-0 ' +
  'motion-reduce:transition-none motion-reduce:active:translate-y-0 ' +
  'cursor-pointer bg-bolt-elements-item-contentAccent text-bolt-elements-background-depth-1 ' +
  'shadow-[0_2px_10px_-3px_rgba(0,229,255,0.55)] hover:shadow-[0_4px_18px_-4px_rgba(0,229,255,0.7)] ' +
  'hover:brightness-110 disabled:opacity-60 disabled:shadow-none disabled:hover:brightness-100';

/**
 * The main-header Promote button. Consumes the shared {@link usePromote} flow; the ProjectHub row (above
 * Files / Search / Locks) renders it beside Deploy so Promote is a one-click, front-and-center action.
 */
export const PromoteHeaderControl = memo(() => {
  const { promote, canPromote, promoteReason, doPromote } = usePromote();

  const submitting = promote.status === 'submitting';
  const success = promote.status === 'success';
  const retryable = promote.status === 'failed' || promote.status === 'commit_ok_deploy_failed';

  // Disabled -> surface WHY (title + aria) so the control is never a silent dead end.
  const reason = submitting
    ? 'Publishing to Production…'
    : success
      ? promote.idempotent
        ? 'Already live — Production is up to date.'
        : 'Published! Production is now serving your Preview.'
      : retryable
        ? `${promote.message} Click to retry.`
        : canPromote
          ? 'Publish your Preview to Production'
          : promoteReason;

  // A settled non-idle outcome tints the button so the header reflects success/failure without a toast.
  const stateTint = success ? 'ring-1 ring-emerald-400/50' : retryable ? 'ring-1 ring-amber-400/50' : '';

  const icon = submitting
    ? 'i-svg-spinners:90-ring-with-bg'
    : success
      ? 'i-ph:check-circle-fill'
      : retryable
        ? 'i-ph:arrow-clockwise-bold'
        : 'i-ph:rocket-launch-bold';

  /*
   * A settled success/failure stays clickable-to-retry (retryable) or clickable-to-promote-again (success
   * only re-enables when the gate says there's something new). While gated-disabled the reason shows why.
   */
  const clickDisabled = submitting || (!canPromote && !retryable);

  return (
    <button
      type="button"
      onClick={doPromote}
      disabled={clickDisabled}
      aria-disabled={clickDisabled}
      title={reason}
      aria-label={reason}
      data-testid="promote-header-control"
      className={classNames(PRIMARY_BTN, stateTint)}
    >
      <div className={classNames(icon, 'shrink-0')} aria-hidden="true" />
      {/* Reserve the widest label ("Promote" | "Publishing…") so the button never resizes. */}
      <span data-testid="promote-header-label" className="min-w-[9ch] text-center">
        {submitting ? 'Publishing…' : success ? 'Published' : retryable ? 'Retry publish' : 'Promote'}
      </span>
    </button>
  );
});

PromoteHeaderControl.displayName = 'PromoteHeaderControl';
