/**
 * @module app/components/workbench/LifecycleActions
 * @description Resource LIFECYCLE action strip for the editor Resources tab (Data & Resource Platform,
 * FIRE 5). Renders the first-class lifecycle controls for a provisionable resource (d1/kv/r2) — beneath the
 * generic write controls in {@link ./ResourceDetailPanel}:
 *
 *   - **Promote** (preview → production): copy/point the preview resource to production. Confirm-gated
 *     (it may create a real, billable production resource).
 *   - **Teardown** (delete): permanently delete the per-site CF resource. Confirm-gated + honest about
 *     IRREVERSIBILITY; a protected resource (e.g. the site's own D1) surfaces the server's honest refusal.
 *   - **Clone** (duplicate within the site): surfaced honestly — the server reports `not_available` per
 *     CAPABILITY-MATRIX (the per-site registry keys one dedicated resource per (site, env, kind); CF has no
 *     server-side deep-copy). The button explains this rather than being hidden (never a doomed control).
 *
 * Every action rides the SAME uniform `mutate` the panel already owns (`PS_RES_MUTATE_REQUEST` →
 * `POST /api/sites/:siteId/resources/:kind/mutate`) — NO new bridge message, NO CF id ever named. A
 * destructive/billable action opens a confirm dialog, then sends `confirm:true`; the classified outcome
 * renders inline (honest: `confirmation_required` / `not_available` / typed error, never a faked success).
 *
 * The environment-assignment grid ({@link ./EnvAssignmentGrid}) is passed in as `children` and rendered at
 * the bottom of the strip.
 *
 * @packageDocumentation
 */
import React, { memo, useCallback, useState } from 'react';

import { classNames } from '~/utils/classNames';
import { ConfirmationDialog } from '~/components/ui/Dialog';

import type { MutateOutcome, ResourceMutateFn } from './ResourceDetailPanel';

/** A human title for a `resource_kind` (mirrors ResourceDetailPanel's `titleForKind`, kept local + tiny). */
function titleForKind(kind: string): string {
  const raw = (kind || 'Resource').replace(/[_-]+/g, ' ').trim();

  if (!raw) {
    return 'Resource';
  }

  return raw
    .split(/\s+/)
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/** One lifecycle action's presentation + copy (drives the button + its confirm dialog). */
interface LifecycleActionSpec {
  readonly action: 'promote' | 'teardown' | 'clone';
  readonly label: string;
  readonly icon: string;
  readonly hint: string;

  /** True → opens a confirm dialog before running (destructive/billable). */
  readonly confirmFirst: boolean;

  /** True → the confirm dialog + button render in the destructive (red) style. */
  readonly destructive: boolean;
}

/** The lifecycle actions this strip can render, in display order. Filtered by the kind's `mutations`. */
const LIFECYCLE_SPECS: readonly LifecycleActionSpec[] = [
  {
    action: 'promote',
    confirmFirst: true,
    destructive: false,
    hint: 'Copy this resource from preview to production.',
    icon: 'i-ph:rocket-launch-duotone',
    label: 'Promote to production',
  },
  {
    action: 'clone',
    confirmFirst: false,
    destructive: false,
    hint: 'Duplicate this resource within the site.',
    icon: 'i-ph:copy-duotone',
    label: 'Clone',
  },
  {
    action: 'teardown',
    confirmFirst: true,
    destructive: true,
    hint: 'Permanently delete this resource and all its data.',
    icon: 'i-ph:trash-duotone',
    label: 'Delete resource',
  },
];

/** Human-readable summary of a successful lifecycle result (honest — reads the note/what-changed). */
function summarizeSuccess(action: string, result: Record<string, unknown>): string {
  const note = typeof result.note === 'string' ? result.note : undefined;

  if (action === 'promote') {
    return note ?? 'Production resource ensured.';
  }

  if (action === 'teardown') {
    const deleted = result.deletedCfResource === true;
    return deleted ? 'Resource deleted.' : 'Resource removed from your site.';
  }

  if (action === 'clone') {
    return note ?? 'Cloned.';
  }

  return 'Done.';
}

export interface LifecycleActionsProps {
  /** The resource kind (`d1` | `kv` | `r2`). */
  kind: string;

  /** The kind's declared mutations (mirrors the adapter's `supports.mutations`) — filters which actions show. */
  mutations: readonly string[];

  /** The uniform mutate function the panel owns (rides `PS_RES_MUTATE_REQUEST`; never names a CF id). */
  mutate: ResourceMutateFn;

  /** Called after a successful lifecycle mutation so the detail refetches. */
  onMutated: () => void;

  /** The environment-assignment grid, rendered at the bottom of the strip. */
  children?: React.ReactNode;
}

/**
 * The lifecycle action strip. Renders promote/teardown/clone buttons for the kind's declared lifecycle
 * mutations, each confirm-gated where destructive/billable, plus the env-assignment grid (`children`).
 */
export const LifecycleActions = memo(({ kind, mutations, mutate, onMutated, children }: LifecycleActionsProps) => {
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<MutateOutcome | null>(null);
  const [confirming, setConfirming] = useState<LifecycleActionSpec | null>(null);

  const specs = LIFECYCLE_SPECS.filter((s) => mutations.includes(s.action));

  /** Run a lifecycle mutation (already confirmed if needed): set busy, send, classify, refetch on success. */
  const run = useCallback(
    async (action: string, confirm?: boolean) => {
      setBusy(action);
      setOutcome(null);

      const result = await mutate(action, undefined, confirm);
      setBusy(null);
      setOutcome(result);

      if (result.kind === 'success') {
        onMutated();
      }
    },
    [mutate, onMutated],
  );

  /** Route an action: confirm-first actions open the dialog; the rest run immediately. */
  const dispatch = useCallback(
    (spec: LifecycleActionSpec) => {
      if (spec.confirmFirst) {
        setConfirming(spec);
        return;
      }

      void run(spec.action);
    },
    [run],
  );

  if (specs.length === 0) {
    return null;
  }

  return (
    <div
      className="shrink-0 border-b border-bolt-elements-borderColor bg-bolt-elements-background-depth-2/40 px-4 py-3 space-y-3"
      data-testid="resource-lifecycle"
    >
      <div className="flex items-center gap-1.5">
        <div
          className="i-ph:arrows-clockwise-duotone text-sm text-bolt-elements-item-contentAccent"
          aria-hidden="true"
        />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-bolt-elements-textSecondary">
          Lifecycle
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {specs.map((spec) => (
          <button
            key={spec.action}
            type="button"
            data-testid={`resource-lifecycle-${spec.action}`}
            disabled={busy !== null}
            title={spec.hint}
            aria-label={`${spec.label} (${titleForKind(kind)})`}
            onClick={() => dispatch(spec)}
            className={classNames(
              'min-h-[32px] inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed',
              spec.destructive
                ? 'border border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20 focus-visible:ring-red-400'
                : 'border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-textSecondary hover:bg-bolt-elements-background-depth-3 focus-visible:ring-bolt-elements-item-contentAccent',
            )}
          >
            <div
              className={classNames(
                busy === spec.action ? 'i-ph:circle-notch animate-spin motion-reduce:animate-none' : spec.icon,
                'text-sm',
              )}
            />
            {/* Reserve the widest label so the button never resizes while busy (buttons-accommodate-largest-text). */}
            <span className="inline-block text-center">{spec.label}</span>
          </button>
        ))}
      </div>

      {outcome && <LifecycleOutcomeCard outcome={outcome} onDismiss={() => setOutcome(null)} />}

      {children}

      {confirming && (
        <ConfirmationDialog
          isOpen={true}
          title={
            confirming.action === 'teardown'
              ? `Delete this ${titleForKind(kind)}?`
              : `Promote this ${titleForKind(kind)} to production?`
          }
          description={
            confirming.action === 'teardown'
              ? `This PERMANENTLY deletes the ${titleForKind(
                  kind,
                )} and all data in it. This cannot be undone. Continue?`
              : `This ensures a production ${titleForKind(
                  kind,
                )} exists (a real, billable resource may be created) and copies preview data into it where supported. Continue?`
          }
          confirmLabel={confirming.action === 'teardown' ? 'Delete' : 'Promote'}
          cancelLabel="Cancel"
          variant={confirming.destructive ? 'destructive' : 'default'}
          isLoading={busy === confirming.action}
          onClose={() => setConfirming(null)}
          onConfirm={() => {
            const pending = confirming;
            setConfirming(null);
            void run(pending.action, true);
          }}
        />
      )}
    </div>
  );
});

/** Inline honest outcome card for a lifecycle mutation (success / confirmation / not_available / error). */
const LifecycleOutcomeCard = memo(({ outcome, onDismiss }: { outcome: MutateOutcome; onDismiss: () => void }) => {
  const tone =
    outcome.kind === 'success'
      ? {
          border: 'border-emerald-500/40',
          bg: 'bg-emerald-500/10',
          text: 'text-emerald-300',
          icon: 'i-ph:check-circle-duotone',
        }
      : outcome.kind === 'not_available'
        ? { border: 'border-amber-500/40', bg: 'bg-amber-500/10', text: 'text-amber-300', icon: 'i-ph:info-duotone' }
        : outcome.kind === 'confirmation'
          ? {
              border: 'border-amber-500/40',
              bg: 'bg-amber-500/10',
              text: 'text-amber-300',
              icon: 'i-ph:warning-duotone',
            }
          : { border: 'border-red-500/40', bg: 'bg-red-500/10', text: 'text-red-300', icon: 'i-ph:x-circle-duotone' };

  const message = outcome.kind === 'success' ? summarizeSuccess(outcome.action, outcome.result) : outcome.message;

  return (
    <div
      className={classNames('flex items-start gap-2 rounded-lg border px-3 py-2', tone.border, tone.bg)}
      data-testid="resource-lifecycle-outcome"
      role="status"
    >
      <div className={classNames(tone.icon, 'text-base shrink-0 mt-0.5', tone.text)} aria-hidden="true" />
      <p className={classNames('text-xs leading-relaxed min-w-0 flex-1', tone.text)}>{message}</p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="i-ph:x text-sm shrink-0 text-bolt-elements-textTertiary hover:text-bolt-elements-textSecondary cursor-pointer"
      />
    </div>
  );
});
