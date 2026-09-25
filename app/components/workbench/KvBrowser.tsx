/**
 * @module components/workbench/KvBrowser
 *
 * KV resource browser for the Data panel — a read-only inspector for the platform's Cloudflare KV
 * namespaces, symmetric with the super-admin SQL console (both target shared platform resources).
 *
 * The embedded editor has no cross-origin session, so — exactly like the D1 Tables/SQL tabs — it
 * asks the Angular admin parent to proxy the read via the postMessage bridge:
 *   child → parent  `PS_KV_REQUEST`  { op:'namespaces'|'keys'|'value', binding?, prefix?, cursor?, key? }
 *   parent → child  `PS_KV_RESPONSE` { ok, data?, error? }   (parent calls GET /api/admin/kv/* )
 *
 * The worker enforces super-admin + a binding allowlist server-side and exposes NO writes, so this
 * surface is deliberately read-only. Values are 64 KiB-capped by the worker; KV list() is eventually
 * consistent (a just-written key may not appear immediately) — both are surfaced honestly in the UI.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  KvKeyDescriptor,
  KvKeysData,
  KvNamespacesData,
  KvRequestMessage,
  KvResponseMessage,
  KvValueData,
} from '../../lib/embed/embedded-mode';
import { formatKvExpiration, parseMaybeJson } from './kv-browser-logic';

export interface KvBrowserProps {
  /** Post a bridge request to the admin parent (DataPanel's existing helper). */
  readonly postToParent: (msg: KvRequestMessage) => void;
}

/** A pending bridge round-trip keyed by correlationId. */
type Pending = (res: KvResponseMessage) => void;

/**
 * Read-only Cloudflare KV browser: namespace picker → key list (prefix search + cursor paging) →
 * value viewer (JSON pretty-print, metadata, expiration). Self-manages the PS_KV_RESPONSE listener.
 */
export const KvBrowser = memo(function KvBrowser({ postToParent }: KvBrowserProps) {
  const pending = useRef<Map<string, Pending>>(new Map());

  const [namespaces, setNamespaces] = useState<string[] | null>(null);
  const [binding, setBinding] = useState<string>('');
  const [keys, setKeys] = useState<KvKeyDescriptor[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [prefix, setPrefix] = useState<string>('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [value, setValue] = useState<KvValueData | null>(null);

  const [nsError, setNsError] = useState<string | null>(null);
  const [keysError, setKeysError] = useState<string | null>(null);
  const [valueError, setValueError] = useState<string | null>(null);
  const [keysLoading, setKeysLoading] = useState(false);
  const [valueLoading, setValueLoading] = useState(false);

  // Resolve pending bridge requests by correlationId.
  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      const data = e.data as Partial<KvResponseMessage> | undefined;
      if (!data || data.type !== 'PS_KV_RESPONSE' || typeof data.correlationId !== 'string') return;
      const resolve = pending.current.get(data.correlationId);
      if (resolve) {
        pending.current.delete(data.correlationId);
        resolve(data as KvResponseMessage);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  /** Post a PS_KV_REQUEST and resolve with the matching PS_KV_RESPONSE (30s timeout → error). */
  const request = useCallback(
    (msg: Omit<KvRequestMessage, 'type' | 'correlationId'>): Promise<KvResponseMessage> => {
      const correlationId = crypto.randomUUID();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (pending.current.delete(correlationId)) {
            resolve({ type: 'PS_KV_RESPONSE', correlationId, ok: false, error: 'Request timed out' });
          }
        }, 30_000);
        pending.current.set(correlationId, (res) => {
          clearTimeout(timer);
          resolve(res);
        });
        postToParent({ type: 'PS_KV_REQUEST', correlationId, ...msg });
      });
    },
    [postToParent],
  );

  // Load namespaces on mount.
  useEffect(() => {
    let live = true;
    void request({ op: 'namespaces' }).then((res) => {
      if (!live) return;
      if (res.ok && res.data && 'namespaces' in res.data) {
        const list = (res.data as KvNamespacesData).namespaces;
        setNamespaces(list);
        if (list.length > 0) setBinding((b) => b || list[0]);
      } else {
        setNsError(res.error ?? 'KV inspector not available');
        setNamespaces([]);
      }
    });
    return () => {
      live = false;
    };
  }, [request]);

  const loadKeys = useCallback(
    async (reset: boolean): Promise<void> => {
      if (!binding) return;
      setKeysLoading(true);
      setKeysError(null);
      const res = await request({
        op: 'keys',
        binding,
        prefix: prefix || undefined,
        cursor: reset ? undefined : cursor,
      });
      setKeysLoading(false);
      if (res.ok && res.data && 'keys' in res.data) {
        const data = res.data as KvKeysData;
        setKeys((prev) => (reset ? data.keys : [...prev, ...data.keys]));
        setCursor(data.cursor);
      } else {
        setKeysError(res.error ?? 'Could not list keys');
        if (reset) setKeys([]);
      }
    },
    [binding, prefix, cursor, request],
  );

  // (Re)load keys whenever the binding changes; reset paging + selection.
  useEffect(() => {
    if (!binding) return;
    setSelectedKey(null);
    setValue(null);
    setCursor(undefined);
    void loadKeys(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally binding-only; prefix search is manual
  }, [binding]);

  const openKey = useCallback(
    async (key: string): Promise<void> => {
      setSelectedKey(key);
      setValue(null);
      setValueError(null);
      setValueLoading(true);
      const res = await request({ op: 'value', binding, key });
      setValueLoading(false);
      if (res.ok && res.data && 'value' in res.data) {
        setValue(res.data as KvValueData);
      } else {
        setValueError(res.error ?? 'Could not load value');
      }
    },
    [binding, request],
  );

  const parsed = useMemo(() => (value ? parseMaybeJson(value.value) : null), [value]);
  const nowSeconds = useMemo(() => Math.floor(Date.now() / 1000), [value]);

  return (
    <div className="flex flex-col gap-3 p-3" data-testid="data-kv-browser" style={{ colorScheme: 'dark' }}>
      {/* Namespace picker + honest read-only note */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-[11px] text-bolt-elements-textSecondary" htmlFor="kv-namespace">
          KV namespace
        </label>
        <select
          id="kv-namespace"
          data-testid="data-kv-namespace"
          value={binding}
          disabled={!namespaces || namespaces.length === 0}
          onChange={(e) => setBinding(e.target.value)}
          className="rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-2 py-1 text-[12px] text-bolt-elements-textPrimary focus:outline-none focus:border-bolt-elements-item-contentAccent/50"
        >
          {(namespaces ?? []).map((ns) => (
            <option key={ns} value={ns}>
              {ns}
            </option>
          ))}
        </select>
        <span
          className="text-[10px] text-bolt-elements-textTertiary"
          title="The worker exposes read-only KV access; KV list is eventually consistent, so a just-written key may not appear immediately."
        >
          Read-only · eventually consistent
        </span>
      </div>

      {nsError && (
        <div
          className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300"
          data-testid="data-kv-unavailable"
          role="note"
        >
          {nsError}
        </div>
      )}

      {namespaces && namespaces.length === 0 && !nsError && (
        <div className="rounded-md border border-bolt-elements-borderColor/40 bg-bolt-elements-background-depth-2 px-3 py-6 text-center text-[11px] text-bolt-elements-textTertiary">
          No KV namespaces are bound.
        </div>
      )}

      {binding && (
        <div className="flex flex-col gap-2 md:flex-row md:items-start">
          {/* Key list */}
          <div className="md:w-1/2 min-w-0">
            <div className="mb-2 flex items-center gap-2">
              <input
                type="text"
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void loadKeys(true);
                }}
                placeholder="Prefix filter (press Enter)"
                data-testid="data-kv-prefix"
                className="min-w-0 flex-1 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-2 py-1 text-[12px] text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:outline-none focus:border-bolt-elements-item-contentAccent/50"
              />
              <button
                type="button"
                onClick={() => void loadKeys(true)}
                className="rounded border border-bolt-elements-item-contentAccent/40 px-2 py-1 text-[11px] text-bolt-elements-item-contentAccent hover:bg-bolt-elements-item-contentAccent/10 cursor-pointer"
              >
                Search
              </button>
            </div>

            {keysError && (
              <div className="mb-2 rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-400">
                {keysError}
              </div>
            )}

            <ul className="max-h-80 overflow-auto rounded-md border border-bolt-elements-borderColor/40 modern-scrollbar">
              {keys.length === 0 && !keysLoading && (
                <li className="px-3 py-4 text-center text-[11px] text-bolt-elements-textTertiary">No keys.</li>
              )}
              {keys.map((k) => (
                <li key={k.name}>
                  <button
                    type="button"
                    data-testid="data-kv-key"
                    onClick={() => void openKey(k.name)}
                    className={
                      'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[11px] font-mono cursor-pointer border-b border-bolt-elements-borderColor/20 ' +
                      (selectedKey === k.name
                        ? 'bg-bolt-elements-item-contentAccent/15 text-bolt-elements-textPrimary'
                        : 'text-bolt-elements-textSecondary hover:bg-bolt-elements-background-depth-2')
                    }
                  >
                    <span className="truncate">{k.name}</span>
                    <span className="shrink-0 text-[9px] text-bolt-elements-textTertiary">
                      {formatKvExpiration(k.expiration, nowSeconds)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            {keysLoading && (
              <div className="px-3 py-2 text-[11px] text-bolt-elements-textTertiary">Loading keys…</div>
            )}
            {cursor && !keysLoading && (
              <button
                type="button"
                onClick={() => void loadKeys(false)}
                data-testid="data-kv-load-more"
                className="mt-2 w-full rounded border border-bolt-elements-borderColor px-2 py-1 text-[11px] text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary hover:border-bolt-elements-item-contentAccent/40 cursor-pointer"
              >
                Load more
              </button>
            )}
          </div>

          {/* Value viewer */}
          <div className="md:w-1/2 min-w-0">
            {!selectedKey && (
              <div className="rounded-md border border-bolt-elements-borderColor/40 bg-bolt-elements-background-depth-2 px-3 py-6 text-center text-[11px] text-bolt-elements-textTertiary">
                Select a key to view its value.
              </div>
            )}
            {selectedKey && (
              <div className="rounded-md border border-bolt-elements-borderColor/40 bg-bolt-elements-background-depth-2">
                <div className="flex items-center justify-between gap-2 border-b border-bolt-elements-borderColor/30 px-3 py-1.5">
                  <span className="truncate font-mono text-[11px] text-bolt-elements-textPrimary" title={selectedKey}>
                    {selectedKey}
                  </span>
                  {parsed?.isJson && (
                    <span className="shrink-0 rounded px-1 text-[9px] font-mono uppercase text-[#00E5FF]">json</span>
                  )}
                </div>
                {valueLoading && <div className="px-3 py-3 text-[11px] text-bolt-elements-textTertiary">Loading…</div>}
                {valueError && <div className="px-3 py-3 text-[11px] text-red-400">{valueError}</div>}
                {value && !valueLoading && (
                  <div className="flex flex-col gap-2 p-3">
                    <pre
                      data-testid="data-kv-value"
                      className="max-h-72 overflow-auto modern-scrollbar whitespace-pre-wrap break-words rounded bg-bolt-elements-background-depth-1 p-2 text-[11px] font-mono text-bolt-elements-textPrimary"
                    >
                      {parsed?.pretty}
                    </pre>
                    {value.metadata != null && (
                      <div>
                        <div className="mb-1 text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary">
                          Metadata
                        </div>
                        <pre className="max-h-40 overflow-auto modern-scrollbar whitespace-pre-wrap break-words rounded bg-bolt-elements-background-depth-1 p-2 text-[10px] font-mono text-bolt-elements-textSecondary">
                          {JSON.stringify(value.metadata, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});
