/**
 * @file Time-Travel — point-in-time recovery UI for a site's OWN dedicated Cloudflare D1.
 *
 * @remarks
 * The Database tab's "History" sub-view. Cloudflare D1 Time Travel keeps a rolling 30-day window of the
 * database's history; this panel lets an owner:
 *   • see the LIVE current bookmark (read via `time_travel_info`),
 *   • SAVE a labelled point (a friendly name over the current live bookmark — stored locally, per site),
 *   • RESTORE the whole database to a saved bookmark OR a chosen date-time (via `restore`, confirm-gated).
 *
 * Every call runs through the SAME per-site resource-mutate rail the grid uses:
 * `PS_RES_MUTATE { kind:'d1', action:'time_travel_info' | 'restore' }` → the worker's REAL CF REST Time-Travel
 * calls (`GET/POST …/time_travel/bookmark|restore`) bound to the site's SERVER-RESOLVED D1 id (this panel never
 * sees a DB id it could tamper with — SECURITY-INVARIANTS INV-1). Restore is DESTRUCTIVE (whole-DB revert) and
 * is BOTH type-confirmed in the UI AND sent with `confirm:true`; the honest "restores your entire database to
 * <time>" copy names the exact target so it's never a blind click (INV-9/INV-11). If Cloudflare can't expose the
 * bookmark (a rare CF error, or the surface's `per_site_data` flag is dark), the panel shows an honest
 * "not available" state — never a fabricated bookmark, never a scary error.
 *
 * Style matches the editor conventions exactly (UnoCSS `bolt-elements-*` tokens, phosphor `i-ph:*` icons).
 */
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { classNames } from '~/utils/classNames';
import {
  isEmbedded,
  onParentMessage,
  postToParent,
  type ParentToChildMessage,
  type ResMutateResponseMessage,
} from '~/lib/embed/embedded-mode';
import {
  datetimeLocalToIso,
  formatInstant,
  isWithinWindow,
  restoreConfirmMessage,
  type SavedBookmark,
  shortBookmark,
  TIME_TRAVEL_RETENTION_DAYS,
  toDatetimeLocalValue,
  windowStartIso,
} from './time-travel-logic';

// ── Bridge plumbing (mirrors SiteTablesPanel's proven correlationId request pattern) ─────────────────

const REQUEST_TIMEOUT_MS = 20_000;
const DISABLED_404 = 'Per-site data is not enabled';

interface Pending {
  resolve: (msg: ParentToChildMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let correlationCounter = 0;

function nextCorrelationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `tt_${++correlationCounter}`;
}

/** Result of a `time_travel_info` read. */
interface InfoResult {
  ok: boolean;
  available?: boolean;
  bookmark?: string;
  retentionDays?: number;
  error?: string;
  disabled?: boolean;
}

/** Result of a `restore`. */
interface RestoreResult {
  ok: boolean;
  restored?: boolean;
  bookmark?: string;
  previousBookmark?: string;
  message?: string;
  error?: string;
  disabled?: boolean;
}

/** localStorage key for the owner's saved labelled bookmarks (per site would need siteId; the editor holds one site per session, so a single key is honest here — the labels are just a convenience over the LIVE bookmark). */
const SAVED_KEY = 'ps_timetravel_saved';

function readSaved(): SavedBookmark[] {
  try {
    const raw = localStorage.getItem(SAVED_KEY);

    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(
      (b): b is SavedBookmark =>
        typeof b === 'object' &&
        b !== null &&
        typeof (b as SavedBookmark).bookmark === 'string' &&
        typeof (b as SavedBookmark).label === 'string',
    );
  } catch {
    return [];
  }
}

function writeSaved(list: SavedBookmark[]): void {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(list.slice(0, 50)));
  } catch {
    // localStorage unavailable (private mode) — labels hold for the session via state only
  }
}

type RestoreTarget = { kind: 'bookmark'; bookmark: string; label?: string } | { kind: 'timestamp'; timestamp: string };

// ── Component ──────────────────────────────────────────────────────────────

export const TimeTravelPanel = memo(() => {
  const [info, setInfo] = useState<InfoResult>({ ok: false });
  const [infoLoading, setInfoLoading] = useState(true);

  const [saved, setSaved] = useState<SavedBookmark[]>(() => readSaved());
  const [newLabel, setNewLabel] = useState('');

  // Restore-by-timestamp picker (native datetime-local, LOCAL wall-clock).
  const [restoreAt, setRestoreAt] = useState('');

  // The pending restore (opens the confirm modal); null → closed.
  const [pending, setPending] = useState<RestoreTarget | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [restoreResult, setRestoreResult] = useState<{
    ok: boolean;
    message: string;
    previousBookmark?: string;
  } | null>(null);

  const pendingRef = useRef<Map<string, Pending>>(new Map());

  const request = useCallback((message: Parameters<typeof postToParent>[0]): Promise<ParentToChildMessage> => {
    return new Promise<ParentToChildMessage>((resolve, reject) => {
      const correlationId = (message as { correlationId: string }).correlationId;
      const timer = setTimeout(() => {
        pendingRef.current.delete(correlationId);
        reject(new Error('The request timed out. Check the admin connection and retry.'));
      }, REQUEST_TIMEOUT_MS);
      pendingRef.current.set(correlationId, { resolve, reject, timer });
      postToParent(message);
    });
  }, []);

  useEffect(() => {
    const unsubscribe = onParentMessage((msg) => {
      if (msg.type !== 'PS_RES_MUTATE_RESPONSE') {
        return;
      }

      const correlationId = msg.correlationId;

      if (!correlationId) {
        return;
      }

      const p = pendingRef.current.get(correlationId);

      if (!p) {
        return;
      }

      clearTimeout(p.timer);
      pendingRef.current.delete(correlationId);
      p.resolve(msg);
    });

    return () => {
      unsubscribe();

      for (const [, p] of pendingRef.current) {
        clearTimeout(p.timer);
        p.reject(new Error('cancelled'));
      }
      pendingRef.current.clear();
    };
  }, []);

  const loadInfo = useCallback(async () => {
    setInfoLoading(true);

    if (!isEmbedded) {
      setInfo({ ok: false, error: 'Open this from the ProjectSites admin to manage your database history.' });
      setInfoLoading(false);

      return;
    }

    try {
      const reply = (await request({
        type: 'PS_RES_MUTATE_REQUEST',
        correlationId: nextCorrelationId(),
        kind: 'd1',
        action: 'time_travel_info',
        input: {},
        confirm: false,
      })) as ResMutateResponseMessage;

      if (reply.enabled === false || (reply.error && reply.error.includes(DISABLED_404))) {
        setInfo({ ok: false, disabled: true });
        setInfoLoading(false);

        return;
      }

      if (reply.error) {
        setInfo({ ok: false, error: reply.error });
        setInfoLoading(false);

        return;
      }

      const result = reply.result;

      if (!result || !result.ok) {
        setInfo({ ok: false, error: result?.error?.message ?? 'Time Travel is not available right now.' });
        setInfoLoading(false);

        return;
      }

      const data = (result.data ?? {}) as { available?: boolean; bookmark?: string; retentionDays?: number };
      setInfo({
        ok: true,
        available: data.available !== false,
        bookmark: data.bookmark,
        retentionDays: data.retentionDays ?? TIME_TRAVEL_RETENTION_DAYS,
      });
    } catch (err) {
      setInfo({ ok: false, error: err instanceof Error ? err.message : 'Time Travel is not available right now.' });
    } finally {
      setInfoLoading(false);
    }
  }, [request]);

  useEffect(() => {
    void loadInfo();
  }, [loadInfo]);

  const saveCurrentPoint = useCallback(() => {
    if (!info.ok || !info.bookmark) {
      return;
    }

    const label = newLabel.trim() || `Saved ${formatInstant(new Date().toISOString())}`;
    const entry: SavedBookmark = { label, bookmark: info.bookmark, savedAt: new Date().toISOString() };
    const next = [entry, ...saved].slice(0, 50);
    setSaved(next);
    writeSaved(next);
    setNewLabel('');
  }, [info, newLabel, saved]);

  const deleteSaved = useCallback(
    (bookmark: string) => {
      const next = saved.filter((s) => s.bookmark !== bookmark);
      setSaved(next);
      writeSaved(next);
    },
    [saved],
  );

  const openRestore = useCallback((target: RestoreTarget) => {
    setConfirmText('');
    setRestoreResult(null);
    setPending(target);
  }, []);

  const doRestore = useCallback(async () => {
    if (!pending) {
      return;
    }

    setRestoring(true);
    setRestoreResult(null);

    const input: Record<string, unknown> =
      pending.kind === 'bookmark' ? { bookmark: pending.bookmark } : { timestamp: pending.timestamp };

    let reply: ResMutateResponseMessage;

    try {
      reply = (await request({
        type: 'PS_RES_MUTATE_REQUEST',
        correlationId: nextCorrelationId(),
        kind: 'd1',
        action: 'restore',
        input,
        confirm: true,
      })) as ResMutateResponseMessage;
    } catch (err) {
      setRestoring(false);
      setRestoreResult({
        ok: false,
        message: err instanceof Error ? err.message : 'The restore could not be reached.',
      });

      return;
    }

    setRestoring(false);

    const norm: RestoreResult =
      reply.enabled === false
        ? { ok: false, disabled: true, error: DISABLED_404 }
        : reply.error
          ? { ok: false, error: reply.error }
          : !reply.result || !reply.result.ok
            ? { ok: false, error: reply.result?.error?.message ?? 'The restore did not run.' }
            : (() => {
                const d = (reply.result!.data ?? {}) as {
                  restored?: boolean;
                  bookmark?: string;
                  previousBookmark?: string;
                  message?: string;
                };
                return {
                  ok: true,
                  restored: d.restored,
                  bookmark: d.bookmark,
                  previousBookmark: d.previousBookmark,
                  message: d.message,
                };
              })();

    if (!norm.ok) {
      setRestoreResult({
        ok: false,
        message: norm.disabled ? 'Your site database isn’t enabled yet.' : norm.error || 'The restore did not run.',
      });
      return;
    }

    setRestoreResult({
      ok: true,
      message: norm.message || 'Your database was restored to the selected point.',
      previousBookmark: norm.previousBookmark,
    });
    setPending(null);

    // Refresh the live bookmark (it changed).
    void loadInfo();
  }, [pending, request, loadInfo]);

  // datetime picker bounds — restrict to the recoverable window.
  const nowLocal = useMemo(() => toDatetimeLocalValue(Date.now()), []);
  const minLocal = useMemo(() => toDatetimeLocalValue(Date.parse(windowStartIso())), []);
  const restoreIso = useMemo(() => datetimeLocalToIso(restoreAt), [restoreAt]);
  const restoreAtValid = restoreIso !== null && isWithinWindow(restoreIso);

  return (
    <div
      className="h-full flex flex-col bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary"
      data-testid="time-travel-panel"
    >
      <Header retentionDays={info.retentionDays ?? TIME_TRAVEL_RETENTION_DAYS} onRefresh={() => void loadInfo()} />

      {info.disabled ? (
        <DisabledState />
      ) : infoLoading ? (
        <div
          className="flex-1 flex flex-col items-center justify-center gap-2 p-8 text-center"
          data-testid="tt-loading"
        >
          <div className="i-ph:circle-notch text-2xl text-bolt-elements-item-contentAccent animate-spin" />
          <p className="text-xs text-bolt-elements-textSecondary">Reading your database history…</p>
        </div>
      ) : !info.ok || info.available === false ? (
        <NotAvailableState message={info.error} onRetry={() => void loadInfo()} />
      ) : (
        <div className="flex-1 overflow-auto modern-scrollbar p-4 space-y-5 max-w-[640px]">
          {/* Current point */}
          <section className="space-y-2">
            <div className="text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary flex items-center gap-1.5">
              <div className="i-ph:map-pin" /> Current point
            </div>
            <div
              className="rounded-lg border border-bolt-elements-item-contentAccent/30 bg-bolt-elements-item-contentAccent/[0.05] p-3 flex items-center gap-3 shadow-[inset_2px_0_0_var(--bolt-elements-item-contentAccent)]"
              data-testid="tt-current"
            >
              <div className="i-ph:git-commit-duotone text-lg text-bolt-elements-item-contentAccent shrink-0" aria-hidden />
              <div className="min-w-0">
                <p className="text-[12px] text-bolt-elements-textPrimary font-mono truncate">
                  {shortBookmark(info.bookmark)}
                </p>
                <p className="text-[10px] text-bolt-elements-textTertiary">
                  Live database bookmark · {info.retentionDays ?? TIME_TRAVEL_RETENTION_DAYS}-day recovery window
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="Label this point (e.g. before big import)"
                data-testid="tt-label-input"
                className="flex-1 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-2 py-1.5 text-[12px] text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent"
              />
              <button
                type="button"
                onClick={saveCurrentPoint}
                disabled={!info.bookmark}
                data-testid="tt-save-point"
                className="min-h-[24px] text-[12px] font-semibold px-3 py-1.5 rounded-lg bg-bolt-elements-item-contentAccent text-bolt-elements-background-depth-1 enabled:hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity flex items-center gap-1.5 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
              >
                <div className="i-ph:bookmark-simple" /> Save point
              </button>
            </div>
          </section>

          {/* Saved points */}
          <section className="space-y-2">
            <div className="text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary flex items-center gap-1.5">
              <div className="i-ph:bookmarks" /> Saved points ({saved.length})
            </div>
            {saved.length === 0 ? (
              <p className="text-[11px] text-bolt-elements-textTertiary">
                No saved points yet. Label the current point above before a big change, so you can jump back to it.
              </p>
            ) : (
              <div className="space-y-1.5" data-testid="tt-saved-list">
                {saved.map((b) => (
                  <div
                    key={b.bookmark}
                    className="rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-2.5 flex items-center gap-2"
                    data-testid="tt-saved-row"
                  >
                    <div className="i-ph:bookmark-simple-duotone text-bolt-elements-item-contentAccent shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[12px] text-bolt-elements-textPrimary truncate">{b.label}</p>
                      <p className="text-[10px] text-bolt-elements-textTertiary font-mono truncate">
                        {shortBookmark(b.bookmark)} · {formatInstant(b.savedAt)}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => openRestore({ kind: 'bookmark', bookmark: b.bookmark, label: b.label })}
                      data-testid="tt-restore-saved"
                      className="min-h-[24px] text-[11px] font-medium px-2.5 py-1 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-3 text-bolt-elements-item-contentAccent hover:opacity-90 transition-opacity flex items-center gap-1 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
                    >
                      <div className="i-ph:clock-counter-clockwise" /> Restore
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteSaved(b.bookmark)}
                      aria-label={`Delete saved point ${b.label}`}
                      className="min-h-[24px] min-w-[24px] flex items-center justify-center rounded hover:bg-bolt-elements-background-depth-3 text-bolt-elements-textTertiary hover:text-red-400 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 cursor-pointer"
                    >
                      <div className="i-ph:x text-xs" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Restore to a date-time */}
          <section className="space-y-2">
            <div className="text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary flex items-center gap-1.5">
              <div className="i-ph:calendar-blank" /> Restore to a date &amp; time
            </div>
            <p className="text-[11px] text-bolt-elements-textTertiary">
              Pick any moment in the last {info.retentionDays ?? TIME_TRAVEL_RETENTION_DAYS} days. Your database returns
              to exactly how it was then.
            </p>
            <div className="flex items-center gap-2">
              <input
                type="datetime-local"
                value={restoreAt}
                min={minLocal}
                max={nowLocal}
                onChange={(e) => setRestoreAt(e.target.value)}
                data-testid="tt-restore-datetime"
                className="flex-1 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-2 py-1.5 text-[12px] text-bolt-elements-textPrimary focus:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent"
              />
              <button
                type="button"
                onClick={() => restoreIso && openRestore({ kind: 'timestamp', timestamp: restoreIso })}
                disabled={!restoreAtValid}
                data-testid="tt-restore-at"
                className="min-h-[24px] text-[12px] font-semibold px-3 py-1.5 rounded-lg border border-amber-400/50 bg-amber-400/10 text-amber-300 enabled:hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity flex items-center gap-1.5 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 cursor-pointer"
              >
                <div className="i-ph:clock-counter-clockwise" /> Restore to this time
              </button>
            </div>
            {restoreAt && !restoreAtValid && (
              <p className="text-[10px] text-amber-400" role="status">
                That time is outside the {info.retentionDays ?? TIME_TRAVEL_RETENTION_DAYS}-day recovery window.
              </p>
            )}
          </section>

          {/* Last restore result (with undo handle) */}
          {restoreResult && (
            <div
              className={classNames(
                'rounded-lg border p-3 text-[11px] flex items-start gap-2',
                restoreResult.ok
                  ? 'border-emerald-400/40 bg-emerald-400/5 text-emerald-300'
                  : 'border-red-400/40 bg-red-400/5 text-red-300',
              )}
              role="status"
              data-testid="tt-restore-result"
            >
              <div
                className={classNames(
                  restoreResult.ok ? 'i-ph:check-circle' : 'i-ph:warning-circle',
                  'mt-0.5 shrink-0',
                )}
              />
              <div className="min-w-0">
                <p>{restoreResult.message}</p>
                {restoreResult.ok && restoreResult.previousBookmark && (
                  <button
                    type="button"
                    onClick={() =>
                      openRestore({
                        kind: 'bookmark',
                        bookmark: restoreResult.previousBookmark!,
                        label: 'the point just before this restore',
                      })
                    }
                    data-testid="tt-undo-restore"
                    className="mt-1 text-[11px] font-semibold underline text-bolt-elements-item-contentAccent hover:opacity-90 cursor-pointer"
                  >
                    Undo this restore
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Confirm modal */}
      {pending && (
        <RestoreConfirm
          target={pending}
          confirmText={confirmText}
          onConfirmText={setConfirmText}
          restoring={restoring}
          onCancel={() => setPending(null)}
          onConfirm={() => void doRestore()}
        />
      )}
    </div>
  );
});

TimeTravelPanel.displayName = 'TimeTravelPanel';

// ── Header ─────────────────────────────────────────────────────────────────

const Header = memo(({ retentionDays, onRefresh }: { retentionDays: number; onRefresh: () => void }) => (
  <div className="flex items-center gap-3 px-4 py-3 border-b border-bolt-elements-borderColor shrink-0">
    <div className="i-ph:clock-counter-clockwise-duotone text-xl text-bolt-elements-textSecondary" />
    <div className="min-w-0">
      <h2 className="text-sm font-semibold text-bolt-elements-textPrimary">History &amp; restore</h2>
      <p className="text-[10px] text-bolt-elements-textTertiary truncate">
        Jump your database back to any point in the last {retentionDays} days · your database
      </p>
    </div>
    <button
      type="button"
      onClick={onRefresh}
      aria-label="Refresh"
      title="Refresh"
      className="ml-auto min-h-[24px] min-w-[24px] flex items-center justify-center rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-item-contentAccent hover:bg-bolt-elements-background-depth-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer shrink-0"
    >
      <div className="i-ph:arrows-clockwise text-sm" />
    </button>
  </div>
));

Header.displayName = 'TimeTravelPanel.Header';

const DisabledState = memo(() => (
  <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center" data-testid="tt-disabled">
    <div className="i-ph:lock-key text-3xl text-bolt-elements-textTertiary" />
    <p className="text-sm font-medium text-bolt-elements-textSecondary">Per-site data isn't enabled yet</p>
    <p className="text-[11px] text-bolt-elements-textTertiary max-w-[260px]">
      Once your site's own database is turned on, its history and one-click restore show up here.
    </p>
  </div>
));

DisabledState.displayName = 'TimeTravelPanel.DisabledState';

const NotAvailableState = memo(({ message, onRetry }: { message?: string; onRetry: () => void }) => (
  <div
    className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center"
    data-testid="tt-not-available"
  >
    <div className="i-ph:clock-afternoon text-3xl text-bolt-elements-textTertiary" />
    <p className="text-sm font-medium text-bolt-elements-textSecondary">History isn't available right now</p>
    <p className="text-[11px] text-bolt-elements-textTertiary max-w-[300px]">
      {message ||
        'Cloudflare Time Travel could not be reached for your database. It usually becomes available shortly after your database is first used.'}
    </p>
    <button
      type="button"
      onClick={onRetry}
      className="min-h-[24px] mt-1 text-[11px] font-medium px-3 py-1.5 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-item-contentAccent hover:bg-bolt-elements-background-depth-3 transition-colors flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
    >
      <div className="i-ph:arrow-clockwise" /> Try again
    </button>
  </div>
));

NotAvailableState.displayName = 'TimeTravelPanel.NotAvailableState';

// ── Restore confirm modal ────────────────────────────────────────────────────

const RestoreConfirm = memo(
  ({
    target,
    confirmText,
    onConfirmText,
    restoring,
    onCancel,
    onConfirm,
  }: {
    target: RestoreTarget;
    confirmText: string;
    onConfirmText: (v: string) => void;
    restoring: boolean;
    onCancel: () => void;
    onConfirm: () => void;
  }) => {
    const message = restoreConfirmMessage(
      target.kind === 'bookmark' ? { bookmark: target.bookmark, label: target.label } : { timestamp: target.timestamp },
    );
    const gateOk = confirmText.trim().toUpperCase() === 'RESTORE';

    // Esc cancels.
    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape' && !restoring) {
          onCancel();
        }
      };
      window.addEventListener('keydown', onKey);

      return () => window.removeEventListener('keydown', onKey);
    }, [onCancel, restoring]);

    return (
      <div
        className="absolute inset-0 z-30 flex items-center justify-center p-4"
        role="dialog"
        aria-modal="true"
        aria-label="Confirm restore"
      >
        <button
          type="button"
          aria-label="Cancel"
          onClick={() => !restoring && onCancel()}
          className="absolute inset-0 bg-black/50 cursor-default"
        />
        <div
          className="relative w-[min(460px,92%)] rounded-xl bg-bolt-elements-background-depth-2 border border-red-400/40 shadow-2xl p-5 space-y-4"
          data-testid="tt-confirm"
        >
          <div className="flex items-center gap-2">
            <div className="i-ph:warning-octagon-duotone text-2xl text-red-400" />
            <h3 className="text-sm font-semibold text-bolt-elements-textPrimary">Restore your database?</h3>
          </div>
          <p className="text-[12px] text-bolt-elements-textSecondary leading-relaxed">{message}</p>
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary mb-1">
              Type <span className="font-mono font-semibold">RESTORE</span> to confirm
            </label>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => onConfirmText(e.target.value)}
              placeholder="RESTORE"
              autoFocus
              data-testid="tt-confirm-input"
              className="w-full rounded border border-red-400/40 bg-bolt-elements-background-depth-1 px-2 py-1.5 text-[13px] font-mono text-bolt-elements-textPrimary focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
            />
          </div>
          <div className="flex items-center gap-2 justify-end">
            <button
              type="button"
              onClick={onCancel}
              disabled={restoring}
              data-testid="tt-confirm-cancel"
              className="min-h-[24px] text-[12px] font-medium px-3 py-1.5 rounded text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={!gateOk || restoring}
              data-testid="tt-confirm-restore"
              className="min-h-[24px] text-[12px] font-semibold px-4 py-1.5 rounded-lg bg-red-500 text-white enabled:hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-bolt-elements-background-depth-2 focus-visible:ring-red-400 cursor-pointer"
            >
              <div className={restoring ? 'i-ph:circle-notch animate-spin' : 'i-ph:clock-counter-clockwise'} />
              <span className="min-w-[9ch] text-center">{restoring ? 'Restoring…' : 'Restore now'}</span>
            </button>
          </div>
        </div>
      </div>
    );
  },
);

RestoreConfirm.displayName = 'TimeTravelPanel.RestoreConfirm';
