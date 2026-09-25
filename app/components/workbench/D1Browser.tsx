/**
 * @module components/workbench/D1Browser
 *
 * D1 resource browser for the Data panel — a read-only inspector for the account's Cloudflare D1
 * databases (resource discovery + Overview metadata), symmetric with the KV/R2/Vectorize/Queues
 * browsers (all target shared platform resources at super-admin scope). Sibling of
 * {@link ./QueuesBrowser}.
 *
 * The embedded editor has no cross-origin session, so — like the other Data tabs — it asks the
 * Angular admin parent to proxy the read via the postMessage bridge:
 *   child → parent  `PS_D1_REQUEST`  { op:'databases'|'overview', databaseId? }
 *   parent → child  `PS_D1_RESPONSE` { ok, data?, error? }   (parent calls GET /api/admin/d1/* )
 *
 * The worker enforces super-admin server-side and exposes ONLY list + Overview metadata (file size,
 * table count, region, read-replication, version) — no query / write / restore. `available:false` /
 * `found:false` distinguish a credential/API failure from a genuinely empty account, surfaced
 * honestly (never a fabricated 0 or empty list).
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  D1DatabaseSummary,
  D1DatabasesData,
  D1OverviewData,
  D1RequestMessage,
  D1ResponseMessage,
} from '../../lib/embed/embedded-mode';
import { dbLabel, formatBytes, formatCount } from './d1-browser-logic';

export interface D1BrowserProps {
  /** Post a bridge request to the admin parent (DataPanel's existing helper). */
  readonly postToParent: (msg: D1RequestMessage) => void;
}

/** A pending bridge round-trip keyed by correlationId. */
type Pending = (res: D1ResponseMessage) => void;

/**
 * Read-only Cloudflare D1 browser: database list → Overview metadata (size, table count, region,
 * read-replication, version). Self-manages the PS_D1_RESPONSE listener.
 */
export const D1Browser = memo(function D1Browser({ postToParent }: D1BrowserProps) {
  const pending = useRef<Map<string, Pending>>(new Map());

  const [databases, setDatabases] = useState<D1DatabaseSummary[] | null>(null);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [overview, setOverview] = useState<D1OverviewData | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Resolve pending bridge requests by correlationId.
  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      const data = e.data as Partial<D1ResponseMessage> | undefined;
      if (!data || data.type !== 'PS_D1_RESPONSE' || typeof data.correlationId !== 'string') return;
      const resolve = pending.current.get(data.correlationId);
      if (resolve) {
        pending.current.delete(data.correlationId);
        resolve(data as D1ResponseMessage);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  /** Post a PS_D1_REQUEST and resolve with the matching PS_D1_RESPONSE (30s timeout → error). */
  const request = useCallback(
    (msg: Omit<D1RequestMessage, 'type' | 'correlationId'>): Promise<D1ResponseMessage> => {
      const correlationId = crypto.randomUUID();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (pending.current.delete(correlationId)) {
            resolve({ type: 'PS_D1_RESPONSE', correlationId, ok: false, error: 'Request timed out' });
          }
        }, 30_000);
        pending.current.set(correlationId, (res) => {
          clearTimeout(timer);
          resolve(res);
        });
        postToParent({ type: 'PS_D1_REQUEST', correlationId, ...msg });
      });
    },
    [postToParent],
  );

  // Load databases on mount.
  useEffect(() => {
    let live = true;
    void request({ op: 'databases' }).then((res) => {
      if (!live) return;
      if (res.ok && res.data && 'databases' in res.data) {
        const data = res.data as D1DatabasesData;
        setDatabases(data.databases);
        setUnavailableReason(data.available ? null : (data.reason ?? 'D1 not available'));
      } else {
        setDatabases([]);
        setUnavailableReason(res.error ?? 'D1 manager not available');
      }
    });
    return () => {
      live = false;
    };
  }, [request]);

  const openDatabase = useCallback(
    async (id: string): Promise<void> => {
      setSelectedId(id);
      setOverview(null);
      setDetailError(null);
      setDetailLoading(true);
      const res = await request({ op: 'overview', databaseId: id });
      setDetailLoading(false);
      if (res.ok && res.data && 'found' in res.data) {
        setOverview(res.data as D1OverviewData);
      } else {
        setDetailError(res.error ?? 'Could not load database overview');
      }
    },
    [request],
  );

  const isEmpty = useMemo(
    () => databases !== null && databases.length === 0 && !unavailableReason,
    [databases, unavailableReason],
  );

  return (
    <div className="flex flex-col gap-3 p-3" data-testid="data-d1-browser" style={{ colorScheme: 'dark' }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium text-bolt-elements-textSecondary">D1 databases</span>
        <span
          className="text-[10px] text-bolt-elements-textTertiary"
          title="The worker exposes read-only D1 access — list + Overview metadata (size, table count, region, read-replication). No query, write, or restore."
        >
          Read-only · overview
        </span>
      </div>

      {unavailableReason && (
        <div
          className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300"
          data-testid="data-d1-unavailable"
          role="note"
        >
          D1 not available ({unavailableReason}).
        </div>
      )}

      {isEmpty && (
        <div className="rounded-md border border-bolt-elements-borderColor/40 bg-bolt-elements-background-depth-2 px-3 py-6 text-center text-[11px] text-bolt-elements-textTertiary">
          No D1 databases on this account.
        </div>
      )}

      {databases && databases.length > 0 && (
        <div className="flex flex-col gap-2 md:flex-row md:items-start">
          {/* Database list */}
          <div className="md:w-1/2 min-w-0">
            <ul className="max-h-80 overflow-auto rounded-md border border-bolt-elements-borderColor/40 modern-scrollbar">
              {databases.map((d) => (
                <li key={d.id}>
                  <button
                    type="button"
                    data-testid="data-d1-database"
                    onClick={() => void openDatabase(d.id)}
                    className={
                      'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[11px] cursor-pointer border-b border-bolt-elements-borderColor/20 ' +
                      (selectedId === d.id
                        ? 'bg-bolt-elements-item-contentAccent/15 text-bolt-elements-textPrimary'
                        : 'text-bolt-elements-textSecondary hover:bg-bolt-elements-background-depth-2')
                    }
                  >
                    <span className="truncate font-mono">{dbLabel(d)}</span>
                    {d.version && (
                      <span className="shrink-0 text-[9px] text-bolt-elements-textTertiary">{d.version}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {/* Database overview */}
          <div className="md:w-1/2 min-w-0">
            {!selectedId && (
              <div className="rounded-md border border-bolt-elements-borderColor/40 bg-bolt-elements-background-depth-2 px-3 py-6 text-center text-[11px] text-bolt-elements-textTertiary">
                Select a database to view its metadata.
              </div>
            )}
            {selectedId && (
              <div
                className="rounded-md border border-bolt-elements-borderColor/40 bg-bolt-elements-background-depth-2"
                data-testid="data-d1-overview"
              >
                <div className="border-b border-bolt-elements-borderColor/30 px-3 py-1.5">
                  <span className="truncate font-mono text-[11px] text-bolt-elements-textPrimary" title={selectedId}>
                    {overview?.name || selectedId}
                  </span>
                </div>
                {detailLoading && <div className="px-3 py-3 text-[11px] text-bolt-elements-textTertiary">Loading…</div>}
                {detailError && <div className="px-3 py-3 text-[11px] text-red-400">{detailError}</div>}
                {overview && !detailLoading && !overview.found && (
                  <div className="px-3 py-3 text-[11px] text-bolt-elements-textTertiary">Database not found.</div>
                )}
                {overview && !detailLoading && overview.found && (
                  <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1.5 p-3 text-[11px]">
                    <dt className="text-bolt-elements-textTertiary">Size</dt>
                    <dd className="font-mono text-bolt-elements-textPrimary tabular-nums">
                      {formatBytes(overview.fileSize ?? null)}
                    </dd>
                    <dt className="text-bolt-elements-textTertiary">Tables</dt>
                    <dd className="font-mono text-bolt-elements-textPrimary tabular-nums">
                      {formatCount(overview.numTables ?? null)}
                    </dd>
                    <dt className="text-bolt-elements-textTertiary">Region</dt>
                    <dd className="font-mono text-bolt-elements-textSecondary">{overview.region ?? '—'}</dd>
                    <dt className="text-bolt-elements-textTertiary">Read replication</dt>
                    <dd className="font-mono text-bolt-elements-textSecondary">{overview.readReplication ?? '—'}</dd>
                    <dt className="text-bolt-elements-textTertiary">Version</dt>
                    <dd className="font-mono text-bolt-elements-textSecondary break-all">{overview.version ?? '—'}</dd>
                    <dt className="text-bolt-elements-textTertiary">Database id</dt>
                    <dd className="font-mono text-bolt-elements-textTertiary break-all text-[10px]">{overview.id}</dd>
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
