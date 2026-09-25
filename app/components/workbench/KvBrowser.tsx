/**
 * @module components/workbench/KvBrowser
 *
 * KV resource browser for the Data panel — inspect + MANAGE the platform's Cloudflare KV namespaces
 * (super-admin), symmetric with the super-admin SQL console (both target shared platform resources).
 *
 * The embedded editor has no cross-origin session, so — exactly like the D1 Tables/SQL tabs — it
 * asks the Angular admin parent to proxy the call via the postMessage bridge:
 *   child → parent  `PS_KV_REQUEST`  { op:'namespaces'|'keys'|'value'|'put'|'delete', binding?, key?, value?, … }
 *   parent → child  `PS_KV_RESPONSE` { ok, data?, error? }   (parent calls GET/PUT/DELETE /api/admin/kv/* )
 *
 * The worker enforces super-admin + a binding allowlist server-side. Reads are 64 KiB-capped; WRITES
 * are size-capped (edit is disabled for a truncated read) + logged with the actor/resource (never the
 * value). KV is eventually consistent (a just-written/deleted key may take ~60s to propagate, and
 * list() may lag) — surfaced honestly in the UI, never silently.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  KvKeyDescriptor,
  KvKeysData,
  KvNamespacesData,
  KvRequestMessage,
  KvResponseMessage,
  KvValueData,
} from '~/lib/embed/embedded-mode';
import { formatKvExpiration, parseMaybeJson } from './kv-browser-logic';
import { classNames } from '~/utils/classNames';

export interface KvBrowserProps {
  /** Post a bridge request to the admin parent (DataPanel's existing helper). */
  readonly postToParent: (msg: KvRequestMessage) => void;
}

/** A pending bridge round-trip keyed by correlationId. */
type Pending = (res: KvResponseMessage) => void;

/**
 * Cloudflare KV browser: namespace picker → key list (prefix search + cursor paging) → value viewer
 * (JSON pretty-print, metadata, expiration) with guarded EDIT + DELETE. Self-manages the
 * PS_KV_RESPONSE listener.
 */
export const KvBrowser = memo(({ postToParent }: KvBrowserProps) => {
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

      if (!data || data.type !== 'PS_KV_RESPONSE' || typeof data.correlationId !== 'string') {
        return;
      }

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
      if (!live) {
        return;
      }

      if (res.ok && res.data && 'namespaces' in res.data) {
        const list = (res.data as KvNamespacesData).namespaces;
        setNamespaces(list);

        if (list.length > 0) {
          setBinding((b) => b || list[0]);
        }
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
      if (!binding) {
        return;
      }

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

        if (reset) {
          setKeys([]);
        }
      }
    },
    [binding, prefix, cursor, request],
  );

  // (Re)load keys whenever the binding changes; reset paging + selection.
  useEffect(() => {
    if (!binding) {
      return;
    }

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
      setEditing(false);
      setDelConfirm('');
      setWriteError(null);

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

  /*
   * Write path (super-admin, guarded server-side): edit a value, delete a key. KV is eventually
   * consistent (≤~60s propagation) — surfaced to the user, never silently.
   */
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [writeBusy, setWriteBusy] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [delConfirm, setDelConfirm] = useState('');

  const beginEdit = useCallback((): void => {
    setEditValue(value?.value ?? '');
    setWriteError(null);
    setEditing(true);
  }, [value]);

  const saveValue = useCallback(async (): Promise<void> => {
    if (!selectedKey) {
      return;
    }

    setWriteBusy(true);
    setWriteError(null);

    const res = await request({ op: 'put', binding, key: selectedKey, value: editValue });
    setWriteBusy(false);

    if (res.ok) {
      setEditing(false);
      void openKey(selectedKey); // re-read so the viewer shows the written value
    } else {
      setWriteError(res.error ?? 'The write failed.');
    }
  }, [binding, selectedKey, editValue, request, openKey]);

  const deleteKey = useCallback(async (): Promise<void> => {
    if (!selectedKey || delConfirm !== selectedKey) {
      return;
    }

    setWriteBusy(true);
    setWriteError(null);

    const res = await request({ op: 'delete', binding, key: selectedKey });
    setWriteBusy(false);

    if (res.ok) {
      /*
       * Drop the deleted key from the list locally — instant + avoids a stale reload closure. (KV
       * list() is eventually consistent, so an immediate re-list could still show the key anyway.)
       */
      setKeys((prev) => prev.filter((k) => k.name !== selectedKey));
      setDelConfirm('');
      setSelectedKey(null);
      setValue(null);
    } else {
      setWriteError(res.error ?? 'The delete failed.');
    }
  }, [binding, selectedKey, delConfirm, request]);

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
                  if (e.key === 'Enter') {
                    void loadKeys(true);
                  }
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

            {keysLoading && <div className="px-3 py-2 text-[11px] text-bolt-elements-textTertiary">Loading keys…</div>}
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
                {value && !valueLoading && !editing && (
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
                    {writeError && (
                      <div className="text-[10px] text-red-400" role="alert" data-testid="data-kv-write-error">
                        {writeError}
                      </div>
                    )}
                    {/* Write actions (super-admin, guarded server-side). Edit is disabled for a
                        truncated read (can't safely round-trip). KV is eventually consistent. */}
                    <div className="flex flex-wrap items-center gap-2 border-t border-bolt-elements-borderColor/30 pt-2">
                      <button
                        type="button"
                        onClick={beginEdit}
                        disabled={value.value === null || value.truncated === true}
                        data-testid="data-kv-edit"
                        title={
                          value.truncated
                            ? 'This value was truncated for display — it is too large to edit safely here.'
                            : 'Edit this value'
                        }
                        className={classNames(
                          'flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]',
                          value.value === null || value.truncated === true
                            ? 'cursor-not-allowed text-bolt-elements-textTertiary'
                            : 'cursor-pointer text-bolt-elements-item-contentAccent hover:bg-bolt-elements-item-contentAccent/10',
                        )}
                      >
                        <div className="i-ph:pencil-simple" /> Edit
                      </button>
                      <span className="ml-auto flex items-center gap-1">
                        <input
                          type="text"
                          value={delConfirm}
                          onChange={(e) => setDelConfirm(e.target.value)}
                          placeholder="type key to delete"
                          data-testid="data-kv-del-confirm"
                          aria-label="Type the key name to confirm deletion"
                          className="w-32 rounded bg-bolt-elements-background-depth-1 border border-bolt-elements-borderColor px-1.5 py-0.5 text-[10px] font-mono text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary"
                        />
                        <button
                          type="button"
                          onClick={deleteKey}
                          disabled={writeBusy || delConfirm !== selectedKey}
                          data-testid="data-kv-delete"
                          title="Delete this key — type the exact key name to confirm"
                          className={classNames(
                            'flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]',
                            writeBusy || delConfirm !== selectedKey
                              ? 'cursor-not-allowed text-bolt-elements-textTertiary'
                              : 'cursor-pointer text-red-400 hover:bg-red-500/10',
                          )}
                        >
                          <div className="i-ph:trash" /> Delete key
                        </button>
                      </span>
                    </div>
                    <p className="text-[9px] italic text-bolt-elements-textTertiary">
                      KV is eventually consistent — a write or delete can take up to ~60 seconds to propagate globally.
                    </p>
                  </div>
                )}
                {value && !valueLoading && editing && (
                  <div className="flex flex-col gap-2 p-3" data-testid="data-kv-editor">
                    <textarea
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      spellCheck={false}
                      data-testid="data-kv-edit-value"
                      aria-label="New value"
                      className="h-48 w-full resize-y rounded bg-bolt-elements-background-depth-1 border border-bolt-elements-borderColor p-2 text-[11px] font-mono text-bolt-elements-textPrimary"
                    />
                    {writeError && (
                      <div className="text-[10px] text-red-400" role="alert">
                        {writeError}
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={saveValue}
                        disabled={writeBusy}
                        data-testid="data-kv-save"
                        className={classNames(
                          'flex items-center gap-1 rounded px-2 py-0.5 text-[10px] border',
                          writeBusy
                            ? 'cursor-not-allowed border-bolt-elements-borderColor text-bolt-elements-textTertiary'
                            : 'cursor-pointer border-bolt-elements-item-contentAccent/40 text-bolt-elements-item-contentAccent hover:bg-bolt-elements-item-contentAccent/10',
                        )}
                      >
                        <div className={writeBusy ? 'i-ph:circle-notch animate-spin' : 'i-ph:check'} />
                        {writeBusy ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditing(false)}
                        data-testid="data-kv-cancel"
                        className="cursor-pointer rounded px-2 py-0.5 text-[10px] text-bolt-elements-textTertiary hover:text-bolt-elements-textSecondary"
                      >
                        Cancel
                      </button>
                      <span className="ml-auto text-[9px] italic text-bolt-elements-textTertiary">
                        overwrites the value · eventually consistent (~60s)
                      </span>
                    </div>
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
