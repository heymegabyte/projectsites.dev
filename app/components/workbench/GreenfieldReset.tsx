/**
 * @module components/workbench/GreenfieldReset
 *
 * The per-site GREENFIELD RESET flow (FIRE 8) — resets a site's OWN data to a clean slate. This is the
 * ONE destructive control in the Data tab, so it is heavily gated and unmistakably a danger zone.
 *
 * The editor has no cross-origin session, so (like the KV/R2/SQL/Ask panels) it asks the Angular admin
 * parent to proxy the authed call via the postMessage bridge:
 *   child → parent  `PS_RESET_REQUEST`  { op:'preview'|'execute', confirm?, confirmText? }
 *   parent → child  `PS_RESET_RESPONSE` { ok, op, data:{…delete-list / wipe result}, error }
 *     (parent calls POST /sites/:id/data/reset[/preview] — the worker resolves the site's OWN dedicated
 *      D1/KV/R2 server-side, NEVER the shared platform DB, and re-checks every gate.)
 *
 * The flow is deliberately multi-step:
 *   1. BACKUP + PREVIEW — one click loads the exact delete-list AND a D1 Time-Travel recovery bookmark.
 *   2. TYPE-TO-CONFIRM — the wipe button stays disabled until the owner types the site slug (or `RESET`).
 *   3. EXECUTE — backup-first wipe; the result shows what was removed + the recovery bookmark to undo.
 *
 * Honest states throughout: "nothing to reset" when the site has no dedicated resources; an unavailable
 * count is never shown as a fake 0; a failed backup ABORTS the wipe (surfaced from the worker's 424).
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import type { ResetRequestMessage, ResetResponseMessage } from '~/lib/embed/embedded-mode';
import { classNames } from '~/utils/classNames';
import { isResetConfirmed, isResetEmpty, summarizeResetImpact, RESET_KEYWORD } from './greenfield-reset-logic';

export interface GreenfieldResetProps {
  /** Post a bridge request to the admin parent (preview or execute). */
  readonly postToParent: (msg: ResetRequestMessage) => void;
}

type Pending = (res: ResetResponseMessage) => void;
type Phase = 'idle' | 'previewing' | 'preview' | 'confirming' | 'executing' | 'done' | 'error';

/** The Danger Zone reset flow. Collapsed by default (rendered inside {@link DangerZone}'s disclosure). */
export const GreenfieldReset = memo(({ postToParent }: GreenfieldResetProps) => {
  const pending = useRef<Map<string, Pending>>(new Map());
  const [phase, setPhase] = useState<Phase>('idle');
  const [preview, setPreview] = useState<NonNullable<ResetResponseMessage['data']> | null>(null);
  const [result, setResult] = useState<NonNullable<ResetResponseMessage['data']> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');

  // Resolve pending reset requests by correlationId.
  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      const data = e.data as { type?: string; correlationId?: string } | undefined;

      if (!data || typeof data.correlationId !== 'string') {
        return;
      }

      if (data.type === 'PS_RESET_RESPONSE') {
        const resolve = pending.current.get(data.correlationId);

        if (resolve) {
          pending.current.delete(data.correlationId);
          resolve(data as ResetResponseMessage);
        }
      }
    };
    window.addEventListener('message', onMessage);

    return () => window.removeEventListener('message', onMessage);
  }, []);

  /** Send a bridge request and resolve when its correlated response arrives (30s guard). */
  const request = useCallback(
    (msg: Omit<ResetRequestMessage, 'type' | 'correlationId'>): Promise<ResetResponseMessage> => {
      const cid = crypto.randomUUID();
      return new Promise<ResetResponseMessage>((resolve) => {
        pending.current.set(cid, resolve);
        postToParent({ type: 'PS_RESET_REQUEST', correlationId: cid, ...msg });
        setTimeout(() => {
          if (pending.current.has(cid)) {
            pending.current.delete(cid);
            resolve({ type: 'PS_RESET_RESPONSE', correlationId: cid, ok: false, error: 'Timed out' });
          }
        }, 30_000);
      });
    },
    [postToParent],
  );

  // Step 1 — backup + preview the exact delete-list.
  const loadPreview = useCallback(async (): Promise<void> => {
    setPhase('previewing');
    setError(null);
    setResult(null);

    const res = await request({ op: 'preview' });

    if (!res.ok) {
      setError(res.error ?? 'Could not load the reset preview.');
      setPhase('error');

      return;
    }

    setPreview(res.data ?? null);
    setPhase(res.data?.available === false ? 'preview' : 'confirming');
  }, [request]);

  // Step 3 — execute the wipe (only reachable once type-to-confirm passes; worker re-checks).
  const execute = useCallback(async (): Promise<void> => {
    setPhase('executing');
    setError(null);

    const res = await request({ op: 'execute', confirm: true, confirmText: typed.trim() });

    if (!res.ok) {
      setError(res.error ?? 'Reset failed.');
      setPhase('error');

      return;
    }

    setResult(res.data ?? null);
    setPhase('done');
  }, [request, typed]);

  const reset = useCallback((): void => {
    setPhase('idle');
    setPreview(null);
    setResult(null);
    setError(null);
    setTyped('');
  }, []);

  const impact = summarizeResetImpact(preview);
  const empty = phase !== 'idle' && phase !== 'previewing' && isResetEmpty(preview);
  const siteName = preview?.d1?.databaseName ?? null;

  // The confirm text the UI accepts (slug from the D1 name if present, else the RESET keyword).
  const confirmed = isResetConfirmed(typed, deriveSlug(siteName));

  return (
    <div data-testid="greenfield-reset" className="rounded-lg border border-red-500/40 bg-red-500/[0.04] p-3 space-y-3">
      <div className="flex items-start gap-2">
        <div className="i-ph:warning-octagon-fill text-red-400 text-lg shrink-0 mt-px" />
        <div className="min-w-0">
          <div className="text-sm font-semibold text-red-300">Reset this site&rsquo;s data</div>
          <p className="text-[11px] leading-relaxed text-bolt-elements-textSecondary">
            Wipes this site&rsquo;s <span className="font-medium">own</span> database, cache, and stored files back to a
            clean slate. A recovery backup is taken first. This never touches other sites or the platform.
          </p>
        </div>
      </div>

      {/* Step 1 — the one button that starts the flow. */}
      {phase === 'idle' && (
        <button
          type="button"
          onClick={loadPreview}
          data-testid="greenfield-reset-start"
          className="w-full rounded-md border border-red-500/50 bg-red-500/10 px-3 py-2 text-xs font-medium text-red-300 hover:bg-red-500/20 cursor-pointer transition-colors"
        >
          Review what will be deleted…
        </button>
      )}

      {phase === 'previewing' && (
        <div
          className="flex items-center gap-2 text-[11px] text-bolt-elements-textSecondary"
          data-testid="greenfield-reset-loading"
        >
          <div className="i-svg-spinners:90-ring-with-bg text-red-400" /> Taking a backup and reading the data…
        </div>
      )}

      {/* Honest empty — nothing dedicated to reset. */}
      {empty && (
        <div className="text-[11px] text-bolt-elements-textSecondary" data-testid="greenfield-reset-empty">
          {preview?.available === false
            ? 'This site has no dedicated data resources yet — nothing to reset.'
            : 'This site&rsquo;s data is already empty — nothing to reset.'}
          <button
            type="button"
            onClick={reset}
            className="ml-2 underline hover:text-bolt-elements-textPrimary cursor-pointer"
          >
            Close
          </button>
        </div>
      )}

      {/* Steps 2+3 — the honest delete-list, backup receipt, and type-to-confirm gate. */}
      {(phase === 'confirming' || phase === 'executing') && preview && !empty && (
        <div className="space-y-2.5" data-testid="greenfield-reset-confirm">
          <div className="rounded-md bg-bolt-elements-background-depth-1 border border-bolt-elements-borderColor/60 p-2.5 space-y-1.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-bolt-elements-textTertiary">
              This will permanently delete
            </div>
            <ul className="space-y-1 text-[11px] text-bolt-elements-textSecondary">
              <li className="flex items-center justify-between gap-2">
                <span>
                  <span className="i-ph:table text-bolt-elements-textTertiary mr-1 align-[-2px]" />
                  {impact.tableCount} {impact.tableCount === 1 ? 'table' : 'tables'} in the database
                </span>
                <span className="tabular-nums text-bolt-elements-textTertiary">
                  {preview.d1?.tablesAvailable === false ? 'count unknown' : `${impact.rowCount.toLocaleString()} rows`}
                </span>
              </li>
              <li className="flex items-center justify-between gap-2">
                <span>
                  <span className="i-ph:key text-bolt-elements-textTertiary mr-1 align-[-2px]" />
                  Cache keys
                </span>
                <span className="tabular-nums text-bolt-elements-textTertiary">
                  {preview.kv?.keysAvailable === false ? 'count unknown' : `${impact.kvKeyCount.toLocaleString()} keys`}
                </span>
              </li>
              <li className="flex items-center justify-between gap-2">
                <span>
                  <span className="i-ph:file-cloud text-bolt-elements-textTertiary mr-1 align-[-2px]" />
                  Stored files
                </span>
                <span className="tabular-nums text-bolt-elements-textTertiary">
                  {preview.r2?.objectsAvailable === false
                    ? 'count unknown'
                    : `${impact.r2ObjectCount.toLocaleString()} files`}
                </span>
              </li>
            </ul>
            {impact.hasUnknown && (
              <p className="text-[10px] text-amber-300/90">
                Some counts couldn&rsquo;t be read — the totals shown are a minimum.
              </p>
            )}
          </div>

          {/* The recovery receipt — surfaced BEFORE the wipe so the owner can copy it. */}
          {preview.backupBookmark && (
            <div
              className="rounded-md bg-emerald-500/[0.06] border border-emerald-500/30 p-2 text-[10px] text-emerald-300/90"
              data-testid="greenfield-reset-bookmark"
            >
              <span className="i-ph:shield-check mr-1 align-[-2px]" />
              Backup taken. Recovery bookmark:{' '}
              <code className="font-mono text-emerald-200 break-all">{preview.backupBookmark}</code>
            </div>
          )}

          <label className="block text-[11px] text-bolt-elements-textSecondary">
            Type <code className="font-mono text-red-300">{deriveSlug(siteName) ?? RESET_KEYWORD}</code> to confirm:
            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              disabled={phase === 'executing'}
              data-testid="greenfield-reset-confirm-input"
              autoComplete="off"
              spellCheck={false}
              className="mt-1 w-full rounded-md border border-red-500/40 bg-bolt-elements-background-depth-1 px-2.5 py-1.5 text-xs text-bolt-elements-textPrimary outline-none focus:border-red-500/70"
              placeholder={deriveSlug(siteName) ?? RESET_KEYWORD}
            />
          </label>

          {error && (
            <p className="text-[11px] text-red-400" role="alert" data-testid="greenfield-reset-error">
              {error}
            </p>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={execute}
              disabled={!confirmed || phase === 'executing'}
              data-testid="greenfield-reset-execute"
              className={classNames(
                'rounded-md px-3 py-1.5 text-xs font-semibold transition-colors',
                confirmed && phase !== 'executing'
                  ? 'bg-red-600 text-white hover:bg-red-500 cursor-pointer'
                  : 'bg-red-500/20 text-red-300/50 cursor-not-allowed',
              )}
            >
              <span className="inline-block min-w-[11ch] text-center">
                {phase === 'executing' ? 'Resetting…' : 'Reset site data'}
              </span>
            </button>
            <button
              type="button"
              onClick={reset}
              disabled={phase === 'executing'}
              className="text-[11px] text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary cursor-pointer disabled:opacity-40"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Result — what was removed + the recovery bookmark to undo. */}
      {phase === 'done' && result && (
        <div className="space-y-2" data-testid="greenfield-reset-result">
          <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-300">
            <div className="i-ph:check-circle-fill" /> Site data reset to a clean slate.
          </div>
          <ul className="text-[11px] text-bolt-elements-textSecondary space-y-0.5">
            <li>{result.droppedTables?.length ?? 0} tables dropped</li>
            <li>{(result.kvDeleted ?? 0).toLocaleString()} cache keys cleared</li>
            <li>{(result.r2Deleted ?? 0).toLocaleString()} files removed</li>
          </ul>
          {result.backupBookmark && (
            <div className="rounded-md bg-bolt-elements-background-depth-1 border border-bolt-elements-borderColor/60 p-2 text-[10px] text-bolt-elements-textSecondary">
              <span className="i-ph:arrow-counter-clockwise mr-1 align-[-2px]" />
              Undo by restoring this backup:{' '}
              <code className="font-mono text-bolt-elements-textPrimary break-all">{result.backupBookmark}</code>
            </div>
          )}
          {result.partialErrors?.length ? (
            <p className="text-[10px] text-amber-300/90">
              Some items could not be removed ({result.partialErrors.length}) — retry to finish.
            </p>
          ) : null}
          <button
            type="button"
            onClick={reset}
            className="text-[11px] underline text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary cursor-pointer"
          >
            Done
          </button>
        </div>
      )}

      {phase === 'error' && (
        <div className="space-y-2" data-testid="greenfield-reset-fatal">
          <p className="text-[11px] text-red-400" role="alert">
            {error ?? 'Something went wrong.'}
          </p>
          <button
            type="button"
            onClick={reset}
            className="text-[11px] underline text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary cursor-pointer"
          >
            Close
          </button>
        </div>
      )}
    </div>
  );
});

GreenfieldReset.displayName = 'GreenfieldReset';

/** Derive the site slug from the dedicated D1 name (`ps-site-<slug>`), for the confirm prompt. */
function deriveSlug(databaseName: string | null): string | null {
  if (!databaseName) {
    return null;
  }

  const m = /^ps-site-(.+)$/.exec(databaseName);

  return m ? m[1] : null;
}
