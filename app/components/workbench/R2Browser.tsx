/**
 * @module components/workbench/R2Browser
 *
 * R2 resource browser for the Data panel — a read-only inspector for the platform's Cloudflare R2
 * buckets, symmetric with the KV browser + super-admin SQL console (all target shared platform
 * resources). Sibling of {@link ./KvBrowser}.
 *
 * The embedded editor has no cross-origin session, so — like the D1/KV tabs — it asks the Angular
 * admin parent to proxy the read via the postMessage bridge:
 *   child → parent  `PS_R2_REQUEST`  { op:'buckets'|'objects'|'object', bucket?, prefix?, cursor?, key? }
 *   parent → child  `PS_R2_RESPONSE` { ok, data?, error? }   (parent calls GET /api/admin/r2/* )
 *
 * The worker enforces super-admin + a bucket allowlist server-side and NEVER returns object bodies —
 * only metadata (size, content-type, uploaded) — so this surface is deliberately read-only.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  R2BucketsData,
  R2ObjectData,
  R2ObjectDescriptor,
  R2ObjectsData,
  R2RequestMessage,
  R2ResponseMessage,
} from '../../lib/embed/embedded-mode';
import { formatBytes, formatUploaded, isPreviewableContentType } from './r2-browser-logic';

export interface R2BrowserProps {
  /** Post a bridge request to the admin parent (DataPanel's existing helper). */
  readonly postToParent: (msg: R2RequestMessage) => void;
}

/** A pending bridge round-trip keyed by correlationId. */
type Pending = (res: R2ResponseMessage) => void;

/**
 * Read-only Cloudflare R2 browser: bucket picker → object list (prefix search + cursor paging) →
 * object metadata (size, content-type, uploaded). Self-manages the PS_R2_RESPONSE listener.
 */
export const R2Browser = memo(function R2Browser({ postToParent }: R2BrowserProps) {
  const pending = useRef<Map<string, Pending>>(new Map());

  const [buckets, setBuckets] = useState<string[] | null>(null);
  const [bucket, setBucket] = useState<string>('');
  const [objects, setObjects] = useState<R2ObjectDescriptor[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [prefix, setPrefix] = useState<string>('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [meta, setMeta] = useState<R2ObjectData | null>(null);

  const [bucketsError, setBucketsError] = useState<string | null>(null);
  const [objectsError, setObjectsError] = useState<string | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [objectsLoading, setObjectsLoading] = useState(false);
  const [metaLoading, setMetaLoading] = useState(false);

  // Resolve pending bridge requests by correlationId.
  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      const data = e.data as Partial<R2ResponseMessage> | undefined;
      if (!data || data.type !== 'PS_R2_RESPONSE' || typeof data.correlationId !== 'string') return;
      const resolve = pending.current.get(data.correlationId);
      if (resolve) {
        pending.current.delete(data.correlationId);
        resolve(data as R2ResponseMessage);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  /** Post a PS_R2_REQUEST and resolve with the matching PS_R2_RESPONSE (30s timeout → error). */
  const request = useCallback(
    (msg: Omit<R2RequestMessage, 'type' | 'correlationId'>): Promise<R2ResponseMessage> => {
      const correlationId = crypto.randomUUID();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (pending.current.delete(correlationId)) {
            resolve({ type: 'PS_R2_RESPONSE', correlationId, ok: false, error: 'Request timed out' });
          }
        }, 30_000);
        pending.current.set(correlationId, (res) => {
          clearTimeout(timer);
          resolve(res);
        });
        postToParent({ type: 'PS_R2_REQUEST', correlationId, ...msg });
      });
    },
    [postToParent],
  );

  // Load buckets on mount.
  useEffect(() => {
    let live = true;
    void request({ op: 'buckets' }).then((res) => {
      if (!live) return;
      if (res.ok && res.data && 'buckets' in res.data) {
        const list = (res.data as R2BucketsData).buckets;
        setBuckets(list);
        if (list.length > 0) setBucket((b) => b || list[0]);
      } else {
        setBucketsError(res.error ?? 'R2 inspector not available');
        setBuckets([]);
      }
    });
    return () => {
      live = false;
    };
  }, [request]);

  const loadObjects = useCallback(
    async (reset: boolean): Promise<void> => {
      if (!bucket) return;
      setObjectsLoading(true);
      setObjectsError(null);
      const res = await request({
        op: 'objects',
        bucket,
        prefix: prefix || undefined,
        cursor: reset ? undefined : cursor,
      });
      setObjectsLoading(false);
      if (res.ok && res.data && 'objects' in res.data) {
        const data = res.data as R2ObjectsData;
        setObjects((prev) => (reset ? data.objects : [...prev, ...data.objects]));
        setCursor(data.cursor);
      } else {
        setObjectsError(res.error ?? 'Could not list objects');
        if (reset) setObjects([]);
      }
    },
    [bucket, prefix, cursor, request],
  );

  // (Re)load objects whenever the bucket changes; reset paging + selection.
  useEffect(() => {
    if (!bucket) return;
    setSelectedKey(null);
    setMeta(null);
    setCursor(undefined);
    void loadObjects(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally bucket-only; prefix search is manual
  }, [bucket]);

  const openObject = useCallback(
    async (key: string): Promise<void> => {
      setSelectedKey(key);
      setMeta(null);
      setMetaError(null);
      setMetaLoading(true);
      const res = await request({ op: 'object', bucket, key });
      setMetaLoading(false);
      if (res.ok && res.data && 'size' in res.data) {
        setMeta(res.data as R2ObjectData);
      } else {
        setMetaError(res.error ?? 'Could not load object metadata');
      }
    },
    [bucket, request],
  );

  const nowMs = useMemo(() => Date.now(), [objects, meta]);

  return (
    <div className="flex flex-col gap-3 p-3" data-testid="data-r2-browser" style={{ colorScheme: 'dark' }}>
      {/* Bucket picker + honest read-only note */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-[11px] text-bolt-elements-textSecondary" htmlFor="r2-bucket">
          R2 bucket
        </label>
        <select
          id="r2-bucket"
          data-testid="data-r2-bucket"
          value={bucket}
          disabled={!buckets || buckets.length === 0}
          onChange={(e) => setBucket(e.target.value)}
          className="rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-2 py-1 text-[12px] text-bolt-elements-textPrimary focus:outline-none focus:border-bolt-elements-item-contentAccent/50"
        >
          {(buckets ?? []).map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        <span
          className="text-[10px] text-bolt-elements-textTertiary"
          title="The worker exposes read-only R2 object metadata (size, content-type, upload time) — never object bodies (no downloads)."
        >
          Read-only · object metadata only (no downloads)
        </span>
      </div>

      {bucketsError && (
        <div
          className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300"
          data-testid="data-r2-unavailable"
          role="note"
        >
          {bucketsError}
        </div>
      )}

      {buckets && buckets.length === 0 && !bucketsError && (
        <div className="rounded-md border border-bolt-elements-borderColor/40 bg-bolt-elements-background-depth-2 px-3 py-6 text-center text-[11px] text-bolt-elements-textTertiary">
          No R2 buckets are bound.
        </div>
      )}

      {bucket && (
        <div className="flex flex-col gap-2 md:flex-row md:items-start">
          {/* Object list */}
          <div className="md:w-1/2 min-w-0">
            <div className="mb-2 flex items-center gap-2">
              <input
                type="text"
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void loadObjects(true);
                }}
                placeholder="Prefix filter (press Enter)"
                data-testid="data-r2-prefix"
                className="min-w-0 flex-1 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-2 py-1 text-[12px] text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:outline-none focus:border-bolt-elements-item-contentAccent/50"
              />
              <button
                type="button"
                onClick={() => void loadObjects(true)}
                className="rounded border border-bolt-elements-item-contentAccent/40 px-2 py-1 text-[11px] text-bolt-elements-item-contentAccent hover:bg-bolt-elements-item-contentAccent/10 cursor-pointer"
              >
                Search
              </button>
            </div>

            {objectsError && (
              <div className="mb-2 rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-400">
                {objectsError}
              </div>
            )}

            <ul className="max-h-80 overflow-auto rounded-md border border-bolt-elements-borderColor/40 modern-scrollbar">
              {objects.length === 0 && !objectsLoading && (
                <li className="px-3 py-4 text-center text-[11px] text-bolt-elements-textTertiary">No objects.</li>
              )}
              {objects.map((o) => (
                <li key={o.key}>
                  <button
                    type="button"
                    data-testid="data-r2-object"
                    onClick={() => void openObject(o.key)}
                    className={
                      'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[11px] font-mono cursor-pointer border-b border-bolt-elements-borderColor/20 ' +
                      (selectedKey === o.key
                        ? 'bg-bolt-elements-item-contentAccent/15 text-bolt-elements-textPrimary'
                        : 'text-bolt-elements-textSecondary hover:bg-bolt-elements-background-depth-2')
                    }
                  >
                    <span className="truncate">{o.key}</span>
                    <span className="shrink-0 text-[9px] text-bolt-elements-textTertiary tabular-nums">
                      {formatBytes(o.size)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            {objectsLoading && (
              <div className="px-3 py-2 text-[11px] text-bolt-elements-textTertiary">Loading objects…</div>
            )}
            {cursor && !objectsLoading && (
              <button
                type="button"
                onClick={() => void loadObjects(false)}
                data-testid="data-r2-load-more"
                className="mt-2 w-full rounded border border-bolt-elements-borderColor px-2 py-1 text-[11px] text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary hover:border-bolt-elements-item-contentAccent/40 cursor-pointer"
              >
                Load more
              </button>
            )}
          </div>

          {/* Object metadata viewer */}
          <div className="md:w-1/2 min-w-0">
            {!selectedKey && (
              <div className="rounded-md border border-bolt-elements-borderColor/40 bg-bolt-elements-background-depth-2 px-3 py-6 text-center text-[11px] text-bolt-elements-textTertiary">
                Select an object to view its metadata.
              </div>
            )}
            {selectedKey && (
              <div className="rounded-md border border-bolt-elements-borderColor/40 bg-bolt-elements-background-depth-2" data-testid="data-r2-meta">
                <div className="flex items-center justify-between gap-2 border-b border-bolt-elements-borderColor/30 px-3 py-1.5">
                  <span className="truncate font-mono text-[11px] text-bolt-elements-textPrimary" title={selectedKey}>
                    {selectedKey}
                  </span>
                  {meta && isPreviewableContentType(meta.contentType) && (
                    <span className="shrink-0 rounded px-1 text-[9px] font-mono uppercase text-[#00E5FF]">preview-safe</span>
                  )}
                </div>
                {metaLoading && <div className="px-3 py-3 text-[11px] text-bolt-elements-textTertiary">Loading…</div>}
                {metaError && <div className="px-3 py-3 text-[11px] text-red-400">{metaError}</div>}
                {meta && !metaLoading && (
                  <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1.5 p-3 text-[11px]">
                    <dt className="text-bolt-elements-textTertiary">Size</dt>
                    <dd className="font-mono text-bolt-elements-textPrimary tabular-nums">{formatBytes(meta.size)}</dd>
                    <dt className="text-bolt-elements-textTertiary">Content-Type</dt>
                    <dd className="font-mono text-bolt-elements-textPrimary break-all">{meta.contentType ?? '—'}</dd>
                    <dt className="text-bolt-elements-textTertiary">Uploaded</dt>
                    <dd className="font-mono text-bolt-elements-textSecondary">{formatUploaded(meta.uploaded, nowMs)}</dd>
                    <dt className="text-bolt-elements-textTertiary">Key</dt>
                    <dd className="font-mono text-bolt-elements-textSecondary break-all">{meta.key}</dd>
                    {meta.metadata != null && (
                      <>
                        <dt className="text-bolt-elements-textTertiary">Metadata</dt>
                        <dd>
                          <pre className="max-h-40 overflow-auto modern-scrollbar whitespace-pre-wrap break-words rounded bg-bolt-elements-background-depth-1 p-2 text-[10px] font-mono text-bolt-elements-textSecondary">
                            {JSON.stringify(meta.metadata, null, 2)}
                          </pre>
                        </dd>
                      </>
                    )}
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
