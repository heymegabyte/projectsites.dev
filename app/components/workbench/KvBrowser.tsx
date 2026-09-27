/**
 * @file KV manager — the site's OWN dedicated Cloudflare KV, for the editor Database tab.
 *
 * @remarks
 * Recycled from the proven KV browser that lived in the (now-retired) `DataPanel`, RE-POINTED at the
 * customer's OWN per-site KV namespace — NEVER the shared platform KV and NEVER another site's. This is
 * the "editor KV UI" the Data Platform ledger tracked as the last remaining KV slice; the backend
 * (list/get/put/delete + bulk, `data_kv_*`) is already live behind the `per_site_kv` flag.
 *
 * Isolation (SECURITY-INVARIANTS INV-1/INV-2/INV-9): every op goes through the SAME server-resolved
 * per-site adapter the SQL navigator + Table-view use — reads via
 * `PS_RES_DETAIL_REQUEST  { kind:'kv', action:'list'|'get' }` → `GET /api/sites/:siteId/resources/kv/detail`,
 * writes via `PS_RES_MUTATE_REQUEST { kind:'kv', action:'put'|'delete' }` →
 * `POST /api/sites/:siteId/resources/kv/mutate`. The caller NEVER supplies a CF id; the worker resolves the
 * site's OWN KV namespace for the OWNED site+environment and isolates every key to it. A per-site KV is a
 * SINGLE namespace, so there is no namespace picker — keys list directly. Destructive writes (delete /
 * overwrite) send `confirm:true` after the editor's own confirm affordance; the adapter is fail-closed.
 *
 * DARK behind `per_site_kv`: a 404 whose message includes "not enabled" becomes a friendly disabled state
 * (INV-3), never a scary error. Style follows the editor conventions (UnoCSS `bolt-elements-*` tokens,
 * phosphor `i-ph:*` icons, black + cyan, honest states, WCAG 2.2 AA — ≥24px targets, focus-visible rings).
 */
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  isEmbedded,
  postToParent,
  onParentMessage,
  type ParentToChildMessage,
  type ResDetailResponseMessage,
  type ResMutateResponseMessage,
} from '~/lib/embed/embedded-mode';
import { formatKvExpiration, parseMaybeJson, decideKvExpiry } from './kv-browser-logic';
import { classNames } from '~/utils/classNames';

// ── Constants ──────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 30_000;
const DISABLED_404 = 'not enabled';

/** How many keys to request per page from the per-site KV adapter (cursor-paginated). */
const KEYS_PAGE_SIZE = 100;

// ── Bridge plumbing ────────────────────────────────────────────────────────

function nextCorrelationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `kv_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

/** A promise pending a bridge reply, resolved by correlationId when the parent answers. */
interface Pending {
  resolve: (msg: ParentToChildMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** One KV key descriptor as the per-site `kv` adapter's `list` returns it. */
interface KvKeyRow {
  name: string;
  expiration?: number;
  metadata?: unknown;
}

/** The `kv` adapter's `list` success payload (mirrors the worker `data_kv_list` result). */
interface KvListData {
  keys?: KvKeyRow[];
  cursor?: string;
  listComplete?: boolean;
}

/** The `kv` adapter's `get` success payload (mirrors the worker `data_kv_get` result). */
interface KvGetData {
  key?: string;
  value?: string | null;
  metadata?: unknown;
  /** True when the reader size-capped the value → editing is disabled (can't round-trip). */
  truncated?: boolean;
}

// ── Component ──────────────────────────────────────────────────────────────

/**
 * The site's OWN KV: prefix-filtered + cursor-paged key list → value viewer (JSON pretty-print,
 * metadata, expiration) with guarded EDIT + DELETE, all through the per-site adapter. Self-manages the
 * `PS_RES_DETAIL_RESPONSE` / `PS_RES_MUTATE_RESPONSE` listener; resolves by correlationId via a live ref.
 */
export const KvBrowser = memo(() => {
  const [keys, setKeys] = useState<KvKeyRow[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [listComplete, setListComplete] = useState(true);
  const [prefix, setPrefix] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [value, setValue] = useState<KvGetData | null>(null);

  const [disabled, setDisabled] = useState(false);
  const [keysError, setKeysError] = useState<string | null>(null);
  const [valueError, setValueError] = useState<string | null>(null);
  const [keysLoading, setKeysLoading] = useState(false);
  const [valueLoading, setValueLoading] = useState(false);

  // Write path (per-site, guarded server-side).
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [writeBusy, setWriteBusy] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [delConfirm, setDelConfirm] = useState('');
  const [editTtl, setEditTtl] = useState('');
  const [editClearExpiry, setEditClearExpiry] = useState(false);

  // Add-key path (create a new key from scratch).
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');

  const pendingRef = useRef<Map<string, Pending>>(new Map());

  // ── ONE parent-message listener; resolve by correlationId via the live ref (empty-deps stale-ref safe) ──
  useEffect(() => {
    const unsubscribe = onParentMessage((msg) => {
      if (msg.type !== 'PS_RES_DETAIL_RESPONSE' && msg.type !== 'PS_RES_MUTATE_RESPONSE') {
        return;
      }

      const correlationId = msg.correlationId;

      if (!correlationId) {
        return;
      }

      const pending = pendingRef.current.get(correlationId);

      if (!pending) {
        return;
      }

      clearTimeout(pending.timer);
      pendingRef.current.delete(correlationId);
      pending.resolve(msg);
    });

    return () => {
      unsubscribe();

      for (const [, pending] of pendingRef.current) {
        clearTimeout(pending.timer);
        pending.reject(new Error('cancelled'));
      }

      pendingRef.current.clear();
    };
  }, []);

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

  /** True when a reply is a dark-flag 404 → the surface renders the disabled state (INV-3). */
  const isDark = useCallback(
    (reply: ResDetailResponseMessage | ResMutateResponseMessage): boolean =>
      reply.enabled === false || (!!reply.error && reply.error.includes(DISABLED_404)),
    [],
  );

  // ── List keys (reset = new prefix/first page; else append next cursor page) ──
  const loadKeys = useCallback(
    async (reset: boolean): Promise<void> => {
      if (!isEmbedded) {
        setKeysError('Open this from the ProjectSites admin to manage KV.');

        return;
      }

      setKeysLoading(true);
      setKeysError(null);

      try {
        const reply = (await request({
          type: 'PS_RES_DETAIL_REQUEST',
          correlationId: nextCorrelationId(),
          kind: 'kv',
          action: 'list',
          params: {
            prefix: prefix || undefined,
            cursor: reset ? undefined : cursor,
            limit: KEYS_PAGE_SIZE,
          },
        })) as ResDetailResponseMessage;

        setKeysLoading(false);

        if (isDark(reply)) {
          setDisabled(true);

          return;
        }

        if (reply.error) {
          setKeysError(reply.error);

          if (reset) {
            setKeys([]);
          }

          return;
        }

        const result = reply.result;

        if (!result) {
          setKeysError('No response from KV. Retry in a moment.');

          return;
        }

        if (!result.ok) {
          setKeysError(result.error?.message ?? 'Could not list keys.');

          if (reset) {
            setKeys([]);
          }

          return;
        }

        const data = (result.data ?? {}) as KvListData;
        const page = data.keys ?? [];
        setKeys((prev) => (reset ? page : [...prev, ...page]));
        setCursor(data.cursor);
        setListComplete(data.listComplete ?? !data.cursor);
      } catch (err) {
        setKeysLoading(false);
        setKeysError(err instanceof Error ? err.message : 'Could not list keys.');

        if (reset) {
          setKeys([]);
        }
      }
    },
    [request, prefix, cursor, isDark],
  );

  // Load the first page on mount.
  useEffect(() => {
    void loadKeys(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only; prefix search + paging are explicit
  }, []);

  // ── Read one key's value ────────────────────────────────────────────────────
  const openKey = useCallback(
    async (key: string): Promise<void> => {
      setSelectedKey(key);
      setValue(null);
      setValueError(null);
      setValueLoading(true);
      setEditing(false);
      setAdding(false);
      setDelConfirm('');
      setWriteError(null);

      try {
        const reply = (await request({
          type: 'PS_RES_DETAIL_REQUEST',
          correlationId: nextCorrelationId(),
          kind: 'kv',
          action: 'get',
          params: { key },
        })) as ResDetailResponseMessage;

        setValueLoading(false);

        if (isDark(reply)) {
          setDisabled(true);

          return;
        }

        if (reply.error) {
          setValueError(reply.error);

          return;
        }

        const result = reply.result;

        if (!result || !result.ok) {
          setValueError(result?.error?.message ?? 'Could not load value.');

          return;
        }

        setValue((result.data ?? {}) as KvGetData);
      } catch (err) {
        setValueLoading(false);
        setValueError(err instanceof Error ? err.message : 'Could not load value.');
      }
    },
    [request, isDark],
  );

  const selectedExpiration = useMemo(
    () => (selectedKey ? keys.find((k) => k.name === selectedKey)?.expiration : undefined),
    [keys, selectedKey],
  );

  const beginEdit = useCallback((): void => {
    setEditValue(value?.value ?? '');
    setEditTtl('');
    setEditClearExpiry(false);
    setWriteError(null);
    setEditing(true);
  }, [value]);

  // ── Write a value (put), preserving/clearing/setting the TTL per the controls ──
  const saveValue = useCallback(
    async (key: string, val: string, isNew: boolean): Promise<void> => {
      const expiry = decideKvExpiry({ clearExpiration: editClearExpiry, ttlInput: editTtl });

      if (expiry.kind === 'invalid') {
        setWriteError(expiry.message);

        return;
      }

      setWriteBusy(true);
      setWriteError(null);

      try {
        const reply = (await request({
          type: 'PS_RES_MUTATE_REQUEST',
          correlationId: nextCorrelationId(),
          kind: 'kv',
          action: 'put',
          input: {
            key,
            value: val,
            ...(expiry.kind === 'ttl' ? { expirationTtl: expiry.expirationTtl } : {}),
            ...(expiry.kind === 'clear' ? { clearExpiration: true } : {}),
          },
          // Overwriting an existing key is confirm-gated server-side; a brand-new key is not.
          confirm: !isNew,
        })) as ResMutateResponseMessage;

        setWriteBusy(false);

        if (isDark(reply)) {
          setDisabled(true);

          return;
        }

        if (reply.error) {
          setWriteError(reply.error);

          return;
        }

        const result = reply.result;

        if (!result || !result.ok) {
          setWriteError(result?.error?.message ?? 'The write failed.');

          return;
        }

        setEditing(false);
        setAdding(false);

        if (isNew) {
          setNewKey('');
          setNewValue('');
          void loadKeys(true);
          void openKey(key);
        } else {
          void openKey(key); // re-read so the viewer shows the written value
        }
      } catch (err) {
        setWriteBusy(false);
        setWriteError(err instanceof Error ? err.message : 'The write failed.');
      }
    },
    [editClearExpiry, editTtl, request, isDark, loadKeys, openKey],
  );

  // ── Delete a key (type-to-confirm) ──────────────────────────────────────────
  const deleteKey = useCallback(async (): Promise<void> => {
    if (!selectedKey || delConfirm !== selectedKey) {
      return;
    }

    setWriteBusy(true);
    setWriteError(null);

    try {
      const reply = (await request({
        type: 'PS_RES_MUTATE_REQUEST',
        correlationId: nextCorrelationId(),
        kind: 'kv',
        action: 'delete',
        input: { key: selectedKey },
        confirm: true, // destructive
      })) as ResMutateResponseMessage;

      setWriteBusy(false);

      if (isDark(reply)) {
        setDisabled(true);

        return;
      }

      if (reply.error) {
        setWriteError(reply.error);

        return;
      }

      const result = reply.result;

      if (!result || !result.ok) {
        setWriteError(result?.error?.message ?? 'The delete failed.');

        return;
      }

      // Drop the deleted key locally — instant + avoids a stale reload (KV list is eventually consistent).
      setKeys((prev) => prev.filter((k) => k.name !== selectedKey));
      setDelConfirm('');
      setSelectedKey(null);
      setValue(null);
    } catch (err) {
      setWriteBusy(false);
      setWriteError(err instanceof Error ? err.message : 'The delete failed.');
    }
  }, [selectedKey, delConfirm, request, isDark]);

  const beginAdd = useCallback((): void => {
    setAdding(true);
    setSelectedKey(null);
    setValue(null);
    setEditing(false);
    setNewKey('');
    setNewValue('');
    setEditTtl('');
    setEditClearExpiry(false);
    setWriteError(null);
  }, []);

  const parsed = useMemo(() => (value ? parseMaybeJson(value.value ?? null) : null), [value]);
  const nowSeconds = useMemo(() => Math.floor(Date.now() / 1000), [value]);

  // ── Disabled (dark flag) — honest "not enabled yet", never a scary error ──
  if (disabled) {
    return (
      <div
        className="h-full flex flex-col items-center justify-center gap-3 p-8 text-center"
        data-testid="database-kv-disabled"
      >
        <div className="i-ph:lock-key text-3xl text-bolt-elements-textTertiary" />
        <p className="text-sm font-medium text-bolt-elements-textSecondary">Key-value storage isn&rsquo;t enabled yet</p>
        <p className="text-[11px] text-bolt-elements-textTertiary max-w-[260px]">
          Your site&rsquo;s own KV is on the way. Once it&rsquo;s turned on, you can browse, add, and edit keys here —
          nothing to set up.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" data-testid="database-kv-browser" style={{ colorScheme: 'dark' }}>
      {/* Toolbar — prefix search + add-key */}
      <div className="flex flex-wrap items-center gap-2 border-b border-bolt-elements-borderColor/60 p-3 shrink-0">
        <div className="i-ph:key-duotone text-lg text-bolt-elements-item-contentAccent" aria-hidden />
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-tight text-bolt-elements-textPrimary">KV manager</h2>
          <p className="text-[10px] text-bolt-elements-textTertiary truncate">
            Your site&rsquo;s own key-value store — eventually consistent (~60s to propagate)
          </p>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <input
            type="text"
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setCursor(undefined);
                void loadKeys(true);
              }
            }}
            placeholder="Prefix filter (Enter)"
            data-testid="database-kv-prefix"
            aria-label="Filter keys by prefix"
            className="min-h-[24px] w-40 rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-2.5 py-1 text-[12px] text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:outline-none focus:border-bolt-elements-item-contentAccent/50"
          />
          <button
            type="button"
            onClick={() => {
              setCursor(undefined);
              void loadKeys(true);
            }}
            data-testid="database-kv-search"
            title="Search keys by prefix"
            className="min-h-[24px] rounded-md border border-bolt-elements-borderColor px-2.5 py-1 text-[11px] text-bolt-elements-textSecondary hover:border-bolt-elements-item-contentAccent/40 hover:text-bolt-elements-textPrimary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
          >
            Search
          </button>
          <button
            type="button"
            onClick={beginAdd}
            data-testid="database-kv-add"
            title="Add a new key to your site's KV"
            className="min-h-[24px] rounded-md border border-bolt-elements-item-contentAccent/40 px-2.5 py-1 text-[11px] font-medium text-bolt-elements-item-contentAccent hover:bg-bolt-elements-item-contentAccent/10 transition-colors flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
          >
            <div className="i-ph:plus" /> Add key
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 p-3 md:flex-row md:items-start">
        {/* Key list */}
        <div className="flex min-h-0 flex-col md:w-1/2">
          {keysError && (
            <div
              className="mb-2 rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-400"
              role="alert"
            >
              {keysError}
            </div>
          )}

          <ul className="max-h-full flex-1 overflow-auto modern-scrollbar rounded-md border border-bolt-elements-borderColor/40">
            {keys.length === 0 && !keysLoading && (
              <li
                className="flex flex-col items-center gap-2 px-3 py-8 text-center text-[11px] text-bolt-elements-textTertiary"
                data-testid="database-kv-empty"
              >
                <div className="i-ph:key text-2xl" />
                <span>No keys yet. Add your first key to get started.</span>
              </li>
            )}
            {keys.map((k) => (
              <li key={k.name}>
                <button
                  type="button"
                  data-testid="database-kv-key"
                  onClick={() => void openKey(k.name)}
                  className={classNames(
                    'flex w-full items-center justify-between gap-2 border-b border-bolt-elements-borderColor/20 px-3 py-1.5 text-left text-[11px] font-mono transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer',
                    selectedKey === k.name
                      ? 'bg-bolt-elements-item-contentAccent/15 text-bolt-elements-textPrimary'
                      : 'text-bolt-elements-textSecondary hover:bg-bolt-elements-background-depth-2',
                  )}
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
            <div className="px-3 py-2 text-[11px] text-bolt-elements-textTertiary" role="status">
              Loading keys…
            </div>
          )}
          {!listComplete && !keysLoading && (
            <button
              type="button"
              onClick={() => void loadKeys(false)}
              data-testid="database-kv-load-more"
              className="mt-2 min-h-[24px] w-full rounded border border-bolt-elements-borderColor px-2 py-1 text-[11px] text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary hover:border-bolt-elements-item-contentAccent/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
            >
              Load more
            </button>
          )}
        </div>

        {/* Value viewer / editor / add-key */}
        <div className="flex min-h-0 flex-col md:w-1/2">
          {adding ? (
            <div
              className="rounded-md border border-bolt-elements-borderColor/40 bg-bolt-elements-background-depth-2 p-3"
              data-testid="database-kv-add-form"
            >
              <div className="mb-2 text-[11px] font-semibold text-bolt-elements-textPrimary">Add a key</div>
              <label className="mb-1 block text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary">
                Key
              </label>
              <input
                type="text"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                spellCheck={false}
                placeholder="e.g. feature:new-hero"
                data-testid="database-kv-new-key"
                aria-label="New key name"
                className="mb-2 w-full rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-2 py-1 text-[11px] font-mono text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:outline-none focus:border-bolt-elements-item-contentAccent/50"
              />
              <label className="mb-1 block text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary">
                Value
              </label>
              <textarea
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                spellCheck={false}
                data-testid="database-kv-new-value"
                aria-label="New value"
                className="h-40 w-full resize-y rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-2 text-[11px] font-mono text-bolt-elements-textPrimary focus:outline-none focus:border-bolt-elements-item-contentAccent/50"
              />
              {writeError && (
                <div className="mt-2 text-[10px] text-red-400" role="alert" data-testid="database-kv-write-error">
                  {writeError}
                </div>
              )}
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void saveValue(newKey.trim(), newValue, true)}
                  disabled={writeBusy || !newKey.trim()}
                  data-testid="database-kv-create"
                  className={classNames(
                    'min-h-[24px] flex items-center gap-1 rounded px-3 py-1 text-[11px] font-semibold transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent',
                    writeBusy || !newKey.trim()
                      ? 'cursor-not-allowed bg-bolt-elements-background-depth-3 text-bolt-elements-textTertiary'
                      : 'cursor-pointer bg-bolt-elements-item-contentAccent text-bolt-elements-background-depth-1 hover:opacity-90',
                  )}
                >
                  <div className={writeBusy ? 'i-ph:circle-notch animate-spin' : 'i-ph:check'} />
                  Create key
                </button>
                <button
                  type="button"
                  onClick={() => setAdding(false)}
                  data-testid="database-kv-add-cancel"
                  className="min-h-[24px] rounded px-3 py-1 text-[11px] text-bolt-elements-textTertiary hover:text-bolt-elements-textSecondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : !selectedKey ? (
            <div className="rounded-md border border-bolt-elements-borderColor/40 bg-bolt-elements-background-depth-2 px-3 py-8 text-center text-[11px] text-bolt-elements-textTertiary">
              Select a key to view its value.
            </div>
          ) : (
            <div className="rounded-md border border-bolt-elements-borderColor/40 bg-bolt-elements-background-depth-2">
              <div className="flex items-center justify-between gap-2 border-b border-bolt-elements-borderColor/30 px-3 py-1.5">
                <span className="truncate font-mono text-[11px] text-bolt-elements-textPrimary" title={selectedKey}>
                  {selectedKey}
                </span>
                {parsed?.isJson && (
                  <span className="shrink-0 rounded px-1 text-[9px] font-mono uppercase text-[#00E5FF]">json</span>
                )}
              </div>
              {valueLoading && (
                <div className="px-3 py-3 text-[11px] text-bolt-elements-textTertiary" role="status">
                  Loading…
                </div>
              )}
              {valueError && (
                <div className="px-3 py-3 text-[11px] text-red-400" role="alert">
                  {valueError}
                </div>
              )}
              {value && !valueLoading && !editing && (
                <div className="flex flex-col gap-2 p-3">
                  <pre
                    data-testid="database-kv-value"
                    className="max-h-72 overflow-auto modern-scrollbar whitespace-pre-wrap break-words rounded bg-bolt-elements-background-depth-1 p-2 text-[11px] font-mono text-bolt-elements-textPrimary"
                  >
                    {parsed?.pretty}
                  </pre>
                  <div className="text-[10px] text-bolt-elements-textTertiary" data-testid="database-kv-expiration">
                    {selectedExpiration === undefined
                      ? 'No expiration (permanent)'
                      : `Expires ${formatKvExpiration(selectedExpiration, nowSeconds)}`}
                  </div>
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
                    <div className="text-[10px] text-red-400" role="alert" data-testid="database-kv-write-error">
                      {writeError}
                    </div>
                  )}
                  {/* Write actions. Edit is disabled for a truncated read (can't round-trip). */}
                  <div className="flex flex-wrap items-center gap-2 border-t border-bolt-elements-borderColor/30 pt-2">
                    <button
                      type="button"
                      onClick={beginEdit}
                      disabled={value.value == null || value.truncated === true}
                      data-testid="database-kv-edit"
                      title={
                        value.truncated
                          ? 'This value was truncated for display — it is too large to edit safely here.'
                          : 'Edit this value'
                      }
                      className={classNames(
                        'min-h-[24px] flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent',
                        value.value == null || value.truncated === true
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
                        data-testid="database-kv-del-confirm"
                        aria-label="Type the key name to confirm deletion"
                        className="w-32 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-1.5 py-0.5 text-[10px] font-mono text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:outline-none focus:border-red-400/50"
                      />
                      <button
                        type="button"
                        onClick={() => void deleteKey()}
                        disabled={writeBusy || delConfirm !== selectedKey}
                        data-testid="database-kv-delete"
                        title="Delete this key — type the exact key name to confirm"
                        className={classNames(
                          'min-h-[24px] flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent',
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
                <div className="flex flex-col gap-2 p-3" data-testid="database-kv-editor">
                  <textarea
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    spellCheck={false}
                    data-testid="database-kv-edit-value"
                    aria-label="New value"
                    className="h-48 w-full resize-y rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-2 text-[11px] font-mono text-bolt-elements-textPrimary focus:outline-none focus:border-bolt-elements-item-contentAccent/50"
                  />
                  {/* Expiration controls: blank + unchecked PRESERVES the existing TTL. */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-bolt-elements-textSecondary">
                    <span className="text-bolt-elements-textTertiary">
                      {selectedExpiration === undefined
                        ? 'Currently: no expiry'
                        : `Currently expires ${formatKvExpiration(selectedExpiration, nowSeconds)}`}
                    </span>
                    <label className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={editClearExpiry}
                        onChange={(e) => setEditClearExpiry(e.target.checked)}
                        data-testid="database-kv-clear-expiry"
                        className="h-3 w-3 accent-[#00e5ff]"
                      />
                      Remove expiration (make permanent)
                    </label>
                    <label className={classNames('flex items-center gap-1', editClearExpiry ? 'opacity-40' : '')}>
                      Set new expiry (s)
                      <input
                        type="number"
                        min={60}
                        value={editTtl}
                        disabled={editClearExpiry}
                        onChange={(e) => setEditTtl(e.target.value)}
                        placeholder="≥60 · blank keeps"
                        data-testid="database-kv-ttl"
                        className="w-28 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-1.5 py-0.5 font-mono text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:outline-none focus:border-bolt-elements-item-contentAccent/50 disabled:opacity-40"
                      />
                    </label>
                  </div>
                  {writeError && (
                    <div className="text-[10px] text-red-400" role="alert">
                      {writeError}
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => selectedKey && void saveValue(selectedKey, editValue, false)}
                      disabled={writeBusy}
                      data-testid="database-kv-save"
                      className={classNames(
                        'min-h-[24px] flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent',
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
                      data-testid="database-kv-cancel"
                      className="min-h-[24px] rounded px-2 py-0.5 text-[10px] text-bolt-elements-textTertiary hover:text-bolt-elements-textSecondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
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
    </div>
  );
});

KvBrowser.displayName = 'KvBrowser';
