/**
 * @module components/workbench/VectorizeBrowser
 *
 * Vectorize resource browser for the Data panel — a read-only inspector for the platform's Cloudflare
 * Vectorize indexes (RAG / embeddings), symmetric with the KV + R2 browsers (all target shared
 * platform resources at super-admin scope). Sibling of {@link ./KvBrowser} + {@link ./R2Browser}.
 *
 * The embedded editor has no cross-origin session, so — like the D1/KV/R2 tabs — it asks the Angular
 * admin parent to proxy the read via the postMessage bridge:
 *   child → parent  `PS_VEC_REQUEST`  { op:'indexes'|'index', name? }
 *   parent → child  `PS_VEC_RESPONSE` { ok, data?, error? }   (parent calls GET /api/admin/vectorize/* )
 *
 * The worker enforces super-admin server-side and exposes ONLY list + describe (no query / insert /
 * delete), so this surface is deliberately read-only. `available:false` distinguishes a credential/
 * API failure from a genuinely empty account — surfaced honestly, never as a fabricated empty.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  VectorizeIndexData,
  VectorizeIndexSummary,
  VectorizeIndexesData,
  VectorizeRequestMessage,
  VectorizeResponseMessage,
} from '../../lib/embed/embedded-mode';
import { formatDimensions, formatMetric, formatVectorCount } from './vectorize-browser-logic';

export interface VectorizeBrowserProps {
  /** Post a bridge request to the admin parent (DataPanel's existing helper). */
  readonly postToParent: (msg: VectorizeRequestMessage) => void;
}

/** A pending bridge round-trip keyed by correlationId. */
type Pending = (res: VectorizeResponseMessage) => void;

/**
 * Read-only Cloudflare Vectorize browser: index list → describe (dimensions, metric, vector count,
 * last-processed mutation). Self-manages the PS_VEC_RESPONSE listener.
 */
export const VectorizeBrowser = memo(function VectorizeBrowser({ postToParent }: VectorizeBrowserProps) {
  const pending = useRef<Map<string, Pending>>(new Map());

  const [indexes, setIndexes] = useState<VectorizeIndexSummary[] | null>(null);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [detail, setDetail] = useState<VectorizeIndexData | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Resolve pending bridge requests by correlationId.
  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      const data = e.data as Partial<VectorizeResponseMessage> | undefined;
      if (!data || data.type !== 'PS_VEC_RESPONSE' || typeof data.correlationId !== 'string') return;
      const resolve = pending.current.get(data.correlationId);
      if (resolve) {
        pending.current.delete(data.correlationId);
        resolve(data as VectorizeResponseMessage);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  /** Post a PS_VEC_REQUEST and resolve with the matching PS_VEC_RESPONSE (30s timeout → error). */
  const request = useCallback(
    (msg: Omit<VectorizeRequestMessage, 'type' | 'correlationId'>): Promise<VectorizeResponseMessage> => {
      const correlationId = crypto.randomUUID();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (pending.current.delete(correlationId)) {
            resolve({ type: 'PS_VEC_RESPONSE', correlationId, ok: false, error: 'Request timed out' });
          }
        }, 30_000);
        pending.current.set(correlationId, (res) => {
          clearTimeout(timer);
          resolve(res);
        });
        postToParent({ type: 'PS_VEC_REQUEST', correlationId, ...msg });
      });
    },
    [postToParent],
  );

  // Load indexes on mount.
  useEffect(() => {
    let live = true;
    void request({ op: 'indexes' }).then((res) => {
      if (!live) return;
      if (res.ok && res.data && 'indexes' in res.data) {
        const data = res.data as VectorizeIndexesData;
        setIndexes(data.indexes);
        setUnavailableReason(data.available ? null : (data.reason ?? 'Vectorize not available'));
      } else {
        setIndexes([]);
        setUnavailableReason(res.error ?? 'Vectorize inspector not available');
      }
    });
    return () => {
      live = false;
    };
  }, [request]);

  const openIndex = useCallback(
    async (name: string): Promise<void> => {
      setSelectedName(name);
      setDetail(null);
      setDetailError(null);
      setDetailLoading(true);
      const res = await request({ op: 'index', name });
      setDetailLoading(false);
      if (res.ok && res.data && 'found' in res.data) {
        setDetail(res.data as VectorizeIndexData);
      } else {
        setDetailError(res.error ?? 'Could not describe index');
      }
    },
    [request],
  );

  const isEmpty = useMemo(() => indexes !== null && indexes.length === 0 && !unavailableReason, [indexes, unavailableReason]);

  return (
    <div className="flex flex-col gap-3 p-3" data-testid="data-vec-browser" style={{ colorScheme: 'dark' }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium text-bolt-elements-textSecondary">Vectorize indexes</span>
        <span
          className="text-[10px] text-bolt-elements-textTertiary"
          title="The worker exposes read-only Vectorize access — list indexes + describe config/vector-count. No query, insert, or delete."
        >
          Read-only · list + describe
        </span>
      </div>

      {unavailableReason && (
        <div
          className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300"
          data-testid="data-vec-unavailable"
          role="note"
        >
          Vectorize not available ({unavailableReason}).
        </div>
      )}

      {isEmpty && (
        <div className="rounded-md border border-bolt-elements-borderColor/40 bg-bolt-elements-background-depth-2 px-3 py-6 text-center text-[11px] text-bolt-elements-textTertiary">
          No Vectorize indexes on this account.
        </div>
      )}

      {indexes && indexes.length > 0 && (
        <div className="flex flex-col gap-2 md:flex-row md:items-start">
          {/* Index list */}
          <div className="md:w-1/2 min-w-0">
            <ul className="max-h-80 overflow-auto rounded-md border border-bolt-elements-borderColor/40 modern-scrollbar">
              {indexes.map((ix) => (
                <li key={ix.name}>
                  <button
                    type="button"
                    data-testid="data-vec-index"
                    onClick={() => void openIndex(ix.name)}
                    className={
                      'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[11px] cursor-pointer border-b border-bolt-elements-borderColor/20 ' +
                      (selectedName === ix.name
                        ? 'bg-bolt-elements-item-contentAccent/15 text-bolt-elements-textPrimary'
                        : 'text-bolt-elements-textSecondary hover:bg-bolt-elements-background-depth-2')
                    }
                  >
                    <span className="truncate font-mono">{ix.name}</span>
                    <span className="shrink-0 text-[9px] text-bolt-elements-textTertiary tabular-nums">
                      {formatDimensions(ix.dimensions)} · {formatMetric(ix.metric)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {/* Index detail */}
          <div className="md:w-1/2 min-w-0">
            {!selectedName && (
              <div className="rounded-md border border-bolt-elements-borderColor/40 bg-bolt-elements-background-depth-2 px-3 py-6 text-center text-[11px] text-bolt-elements-textTertiary">
                Select an index to view its configuration.
              </div>
            )}
            {selectedName && (
              <div className="rounded-md border border-bolt-elements-borderColor/40 bg-bolt-elements-background-depth-2" data-testid="data-vec-detail">
                <div className="border-b border-bolt-elements-borderColor/30 px-3 py-1.5">
                  <span className="truncate font-mono text-[11px] text-bolt-elements-textPrimary" title={selectedName}>
                    {selectedName}
                  </span>
                </div>
                {detailLoading && <div className="px-3 py-3 text-[11px] text-bolt-elements-textTertiary">Loading…</div>}
                {detailError && <div className="px-3 py-3 text-[11px] text-red-400">{detailError}</div>}
                {detail && !detailLoading && !detail.found && (
                  <div className="px-3 py-3 text-[11px] text-bolt-elements-textTertiary">Index not found.</div>
                )}
                {detail && !detailLoading && detail.found && (
                  <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1.5 p-3 text-[11px]">
                    <dt className="text-bolt-elements-textTertiary">Dimensions</dt>
                    <dd className="font-mono text-bolt-elements-textPrimary tabular-nums">{formatDimensions(detail.dimensions)}</dd>
                    <dt className="text-bolt-elements-textTertiary">Metric</dt>
                    <dd className="font-mono text-bolt-elements-textPrimary">{formatMetric(detail.metric)}</dd>
                    <dt className="text-bolt-elements-textTertiary">Vectors</dt>
                    <dd className="font-mono text-bolt-elements-textPrimary tabular-nums">{formatVectorCount(detail.vectorCount)}</dd>
                    <dt className="text-bolt-elements-textTertiary">Last mutation</dt>
                    <dd className="font-mono text-bolt-elements-textSecondary break-all">{detail.processedUpToMutation ?? '—'}</dd>
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
