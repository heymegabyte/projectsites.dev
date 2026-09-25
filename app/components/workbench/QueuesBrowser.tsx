/**
 * @module components/workbench/QueuesBrowser
 *
 * Queues resource browser for the Data panel — a read-only inspector for the platform's Cloudflare
 * Queues (job pipelines / workflow queues), symmetric with the KV/R2/Vectorize browsers (all target
 * shared platform resources at super-admin scope). Sibling of {@link ./VectorizeBrowser}.
 *
 * The embedded editor has no cross-origin session, so — like the D1/KV/R2/Vectorize tabs — it asks
 * the Angular admin parent to proxy the read via the postMessage bridge:
 *   child → parent  `PS_QUEUE_REQUEST`  { op:'queues'|'queue', queueId? }
 *   parent → child  `PS_QUEUE_RESPONSE` { ok, data?, error? }   (parent calls GET /api/admin/queues/* )
 *
 * The worker enforces super-admin server-side and exposes ONLY list + describe (settings + producers/
 * consumers) — no send / purge / ack. `available:false` / `found:false` distinguish a credential/API
 * failure from a genuinely empty account, surfaced honestly.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  QueueDetailData,
  QueueRequestMessage,
  QueueResponseMessage,
  QueueSummary,
  QueuesData,
} from '../../lib/embed/embedded-mode';
import { endpointLabel, formatDuration } from './queues-browser-logic';

export interface QueuesBrowserProps {
  /** Post a bridge request to the admin parent (DataPanel's existing helper). */
  readonly postToParent: (msg: QueueRequestMessage) => void;
}

/** A pending bridge round-trip keyed by correlationId. */
type Pending = (res: QueueResponseMessage) => void;

/**
 * Read-only Cloudflare Queues browser: queue list → describe (settings + producers/consumers).
 * Self-manages the PS_QUEUE_RESPONSE listener.
 */
export const QueuesBrowser = memo(function QueuesBrowser({ postToParent }: QueuesBrowserProps) {
  const pending = useRef<Map<string, Pending>>(new Map());

  const [queues, setQueues] = useState<QueueSummary[] | null>(null);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<QueueDetailData | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Resolve pending bridge requests by correlationId.
  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      const data = e.data as Partial<QueueResponseMessage> | undefined;
      if (!data || data.type !== 'PS_QUEUE_RESPONSE' || typeof data.correlationId !== 'string') return;
      const resolve = pending.current.get(data.correlationId);
      if (resolve) {
        pending.current.delete(data.correlationId);
        resolve(data as QueueResponseMessage);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  /** Post a PS_QUEUE_REQUEST and resolve with the matching PS_QUEUE_RESPONSE (30s timeout → error). */
  const request = useCallback(
    (msg: Omit<QueueRequestMessage, 'type' | 'correlationId'>): Promise<QueueResponseMessage> => {
      const correlationId = crypto.randomUUID();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (pending.current.delete(correlationId)) {
            resolve({ type: 'PS_QUEUE_RESPONSE', correlationId, ok: false, error: 'Request timed out' });
          }
        }, 30_000);
        pending.current.set(correlationId, (res) => {
          clearTimeout(timer);
          resolve(res);
        });
        postToParent({ type: 'PS_QUEUE_REQUEST', correlationId, ...msg });
      });
    },
    [postToParent],
  );

  // Load queues on mount.
  useEffect(() => {
    let live = true;
    void request({ op: 'queues' }).then((res) => {
      if (!live) return;
      if (res.ok && res.data && 'queues' in res.data) {
        const data = res.data as QueuesData;
        setQueues(data.queues);
        setUnavailableReason(data.available ? null : (data.reason ?? 'Queues not available'));
      } else {
        setQueues([]);
        setUnavailableReason(res.error ?? 'Queues inspector not available');
      }
    });
    return () => {
      live = false;
    };
  }, [request]);

  const openQueue = useCallback(
    async (id: string): Promise<void> => {
      setSelectedId(id);
      setDetail(null);
      setDetailError(null);
      setDetailLoading(true);
      const res = await request({ op: 'queue', queueId: id });
      setDetailLoading(false);
      if (res.ok && res.data && 'found' in res.data) {
        setDetail(res.data as QueueDetailData);
      } else {
        setDetailError(res.error ?? 'Could not describe queue');
      }
    },
    [request],
  );

  const isEmpty = useMemo(
    () => queues !== null && queues.length === 0 && !unavailableReason,
    [queues, unavailableReason],
  );

  return (
    <div className="flex flex-col gap-3 p-3" data-testid="data-queues-browser" style={{ colorScheme: 'dark' }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium text-bolt-elements-textSecondary">Queues</span>
        <span
          className="text-[10px] text-bolt-elements-textTertiary"
          title="The worker exposes read-only Queues access — list + describe (settings, producers, consumers). No send, purge, or ack."
        >
          Read-only · list + describe
        </span>
      </div>

      {unavailableReason && (
        <div
          className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300"
          data-testid="data-queues-unavailable"
          role="note"
        >
          Queues not available ({unavailableReason}).
        </div>
      )}

      {isEmpty && (
        <div className="rounded-md border border-bolt-elements-borderColor/40 bg-bolt-elements-background-depth-2 px-3 py-6 text-center text-[11px] text-bolt-elements-textTertiary">
          No Queues on this account.
        </div>
      )}

      {queues && queues.length > 0 && (
        <div className="flex flex-col gap-2 md:flex-row md:items-start">
          {/* Queue list */}
          <div className="md:w-1/2 min-w-0">
            <ul className="max-h-80 overflow-auto rounded-md border border-bolt-elements-borderColor/40 modern-scrollbar">
              {queues.map((q) => (
                <li key={q.id}>
                  <button
                    type="button"
                    data-testid="data-queue"
                    onClick={() => void openQueue(q.id)}
                    className={
                      'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[11px] cursor-pointer border-b border-bolt-elements-borderColor/20 ' +
                      (selectedId === q.id
                        ? 'bg-bolt-elements-item-contentAccent/15 text-bolt-elements-textPrimary'
                        : 'text-bolt-elements-textSecondary hover:bg-bolt-elements-background-depth-2')
                    }
                  >
                    <span className="truncate font-mono">{q.name || q.id}</span>
                    <span className="shrink-0 text-[9px] text-bolt-elements-textTertiary tabular-nums">
                      {q.producers}P · {q.consumers}C
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {/* Queue detail */}
          <div className="md:w-1/2 min-w-0">
            {!selectedId && (
              <div className="rounded-md border border-bolt-elements-borderColor/40 bg-bolt-elements-background-depth-2 px-3 py-6 text-center text-[11px] text-bolt-elements-textTertiary">
                Select a queue to view its configuration.
              </div>
            )}
            {selectedId && (
              <div className="rounded-md border border-bolt-elements-borderColor/40 bg-bolt-elements-background-depth-2" data-testid="data-queue-detail">
                <div className="border-b border-bolt-elements-borderColor/30 px-3 py-1.5">
                  <span className="truncate font-mono text-[11px] text-bolt-elements-textPrimary" title={selectedId}>
                    {detail?.name || selectedId}
                  </span>
                </div>
                {detailLoading && <div className="px-3 py-3 text-[11px] text-bolt-elements-textTertiary">Loading…</div>}
                {detailError && <div className="px-3 py-3 text-[11px] text-red-400">{detailError}</div>}
                {detail && !detailLoading && !detail.found && (
                  <div className="px-3 py-3 text-[11px] text-bolt-elements-textTertiary">Queue not found.</div>
                )}
                {detail && !detailLoading && detail.found && (
                  <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1.5 p-3 text-[11px]">
                    <dt className="text-bolt-elements-textTertiary">Retention</dt>
                    <dd className="font-mono text-bolt-elements-textPrimary tabular-nums">
                      {formatDuration(detail.settings?.messageRetentionSeconds ?? null)}
                    </dd>
                    <dt className="text-bolt-elements-textTertiary">Delivery delay</dt>
                    <dd className="font-mono text-bolt-elements-textPrimary tabular-nums">
                      {formatDuration(detail.settings?.deliveryDelaySeconds ?? null)}
                    </dd>
                    <dt className="text-bolt-elements-textTertiary">Producers</dt>
                    <dd className="font-mono text-bolt-elements-textSecondary break-all">
                      {(detail.producers ?? []).length === 0
                        ? '—'
                        : (detail.producers ?? []).map((p) => endpointLabel(p)).join(', ')}
                    </dd>
                    <dt className="text-bolt-elements-textTertiary">Consumers</dt>
                    <dd className="font-mono text-bolt-elements-textSecondary break-all">
                      {(detail.consumers ?? []).length === 0
                        ? '—'
                        : (detail.consumers ?? []).map((c) => endpointLabel(c)).join(', ')}
                    </dd>
                    <dt className="text-bolt-elements-textTertiary">Created</dt>
                    <dd className="font-mono text-bolt-elements-textSecondary break-all">{detail.created ?? '—'}</dd>
                  </dl>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});
