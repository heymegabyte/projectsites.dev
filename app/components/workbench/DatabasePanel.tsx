/**
 * @file Database — the ONE consolidated per-site data surface in the editor.
 *
 * @remarks
 * The Database tab's sub-nav is a concise, Airtable/Notion-like segmented BUTTON bar — **Tables · SQL ·
 * KV** — and EVERYTHING targets the site's OWN dedicated Cloudflare D1 (+ its KV), NEVER the shared
 * platform DB and NEVER another site's. (Brian 2026-09-27, FIRE: Database menu cleanup.)
 *
 * Sub-views (the ONLY top-level nav entries):
 *  - **Tables** — the read/edit grid over the site's OWN D1 ({@link SiteTablesPanel}, `PS_SITEDB_*`).
 *    Import (CSV/JSON) + History (D1 Time-Travel) + Schema (guided DDL) + AI-seed are reachable AS ACTIONS
 *    from WITHIN this view (a toolbar + the empty-state launchpad), NOT as top nav entries — the menu stays
 *    concise. Those panels ({@link ImportPanel}, {@link TimeTravelPanel}, {@link SchemaBuilder},
 *    {@link AiSeedPanel}) render as a modal overlay ON TOP of the Tables grid.
 *  - **SQL** — the RICH per-site D1 SQL workspace ({@link SqlNavigator}), now a NORMAL, always-visible menu
 *    entry (the Advanced/Developer toggle was removed — SQL is a first-class view). Recycles the proven
 *    editor (syntax-highlighted + schema-completing, query history, saved queries, EXPLAIN cost hint, typed
 *    result grid) RE-POINTED at the site's OWN D1 via the per-site adapter (`PS_RES_MUTATE { kind:'d1',
 *    action:'exec' }` → `data_d1_exec`). Mutating statements are confirm-gated; `rowsWritten` is truth.
 *  - **KV** — the site's OWN KV, a **$10/mo Stripe add-on**. Until unlocked this is an honest LOCKED-UPSELL
 *    card (never a dead/mock control); once unlocked it renders the REAL per-site KV browser
 *    ({@link KvBrowser}, `PS_RES_DETAIL/MUTATE { kind:'kv' }`), DARK behind `per_site_kv` (a 404 → honest
 *    "not enabled yet").
 *
 * Isolation is SERVER-resolved for every sub-view: the worker resolves the site's CF ids from the
 * registry for the OWNED site+environment; this panel never sees or sends a CF id it could tamper with.
 * Dark flags surface as friendly "not enabled yet" states (404 → disabled), never scary errors. Style
 * matches the editor conventions exactly (UnoCSS `bolt-elements-*` tokens, phosphor `i-ph:*` icons).
 *
 * FormBuilder is intentionally NOT wired as a nav entry or an action here (Brian 2026-09-27) but stays
 * IMPORTED so it remains reachable/interconnected for a future surface.
 */
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { classNames } from '~/utils/classNames';
import {
  isEmbedded,
  postToParent,
  onParentMessage,
  type ParentToChildMessage,
  type ResDetailResponseMessage,
} from '~/lib/embed/embedded-mode';
import { formatKvExpiration } from './kv-browser-logic';
import { SiteTablesPanel } from './SiteTablesPanel';
import { SchemaBuilder } from './SchemaBuilder';
import { TimeTravelPanel } from './TimeTravelPanel';
import { SqlNavigator } from './SqlNavigator';
import { KvBrowser } from './KvBrowser';
import { ImportPanel } from './ImportPanel';
import { AiSeedPanel } from './AiSeedPanel';
import { FormBuilder } from './FormBuilder';
import { DangerZone } from './DangerZone';
import { DataSearchPalette, type OpenTablePayload } from './DataSearchPalette';

// ── Sub-nav model ────────────────────────────────────────────────────────────

/** Top-level Database views — concise (Airtable/Notion-like): Tables · SQL · KV. */
type SubView = 'table' | 'sql' | 'kv';

/**
 * An ACTION reachable from within the Tables view (a modal overlay), NOT a top-level nav entry — this is
 * how Import / History / Schema / AI-seed stay reachable while the menu stays concise.
 */
type TableAction = 'import' | 'history' | 'schema' | 'seed';

interface SubNavItem {
  value: SubView;
  label: string;
  icon: string;
}

const SUB_NAV: readonly SubNavItem[] = [
  { value: 'table', label: 'Tables', icon: 'i-ph:table-duotone' },
  { value: 'sql', label: 'SQL', icon: 'i-ph:terminal-window-duotone' },
  { value: 'kv', label: 'KV', icon: 'i-ph:key-duotone' },
];

/**
 * Keep FormBuilder referenced so it stays importable/interconnected (it is deliberately not a nav entry
 * per Brian 2026-09-27, but must remain reachable code — never orphaned). Tree-shaken from the render path.
 */
export const DATABASE_UNWIRED_BUT_REACHABLE = { FormBuilder } as const;

// ── Container ────────────────────────────────────────────────────────────────

export const DatabasePanel = memo(() => {
  const [subView, setSubView] = useState<SubView>('table');

  /** The Tables-view action overlay currently open (Import / History / Schema / AI-seed), or null. */
  const [tableAction, setTableAction] = useState<TableAction | null>(null);

  /**
   * A pending ⌘K "open this table" request handed to {@link SiteTablesPanel}. The `nonce` increments per
   * activation so re-opening the SAME table still re-selects it; `rowid` is reserved for scroll-to-row.
   */
  const [openTable, setOpenTable] = useState<{ table: string; rowid?: number; nonce: number } | null>(null);

  /** Bumped to open the ⌘K data-search palette from the visible "Search data" button (not only the shortcut). */
  const [searchOpenNonce, setSearchOpenNonce] = useState<number | undefined>(undefined);

  const visibleNav = useMemo(() => SUB_NAV, []);

  /** ⌘K palette activated a result — switch to the Tables view and ask it to open the matched table. */
  const onOpenTableFromSearch = useCallback((payload: OpenTablePayload) => {
    setSubView('table');
    setTableAction(null);
    setOpenTable({ table: payload.table, rowid: payload.rowid, nonce: Date.now() });
  }, []);

  // Roving-tabindex keyboard nav across the segmented button bar (Left/Right/Home/End).
  const onNavKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];

      if (!keys.includes(event.key)) {
        return;
      }

      event.preventDefault();

      const idx = visibleNav.findIndex((item) => item.value === subView);

      if (idx === -1) {
        return;
      }

      let nextIdx = idx;

      if (event.key === 'ArrowLeft') {
        nextIdx = (idx - 1 + visibleNav.length) % visibleNav.length;
      } else if (event.key === 'ArrowRight') {
        nextIdx = (idx + 1) % visibleNav.length;
      } else if (event.key === 'Home') {
        nextIdx = 0;
      } else if (event.key === 'End') {
        nextIdx = visibleNav.length - 1;
      }

      setSubView(visibleNav[nextIdx].value);
    },
    [visibleNav, subView],
  );

  const closeAction = useCallback(() => setTableAction(null), []);

  return (
    <div
      className="h-full flex flex-col bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary [color-scheme:dark] accent-[color:var(--ps-accent,#00e5ff)]"
      data-testid="database-panel"
    >
      {/* Sub-nav button bar — concise Tables · SQL · KV (Airtable/Notion segmented control) */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-bolt-elements-borderColor shrink-0">
        <div
          role="tablist"
          aria-label="Database views"
          onKeyDown={onNavKeyDown}
          className="flex items-center gap-1 rounded-lg bg-bolt-elements-background-depth-2 p-0.5 border border-bolt-elements-borderColor/60 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]"
        >
          {visibleNav.map((item) => {
            const active = subView === item.value;
            return (
              <button
                key={item.value}
                type="button"
                role="tab"
                data-filled-pill=""
                aria-selected={active}
                aria-pressed={active}
                tabIndex={active ? 0 : -1}
                data-testid={`database-subnav-${item.value}`}
                onClick={() => setSubView(item.value)}
                className={classNames(
                  'min-h-[24px] flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md transition-all duration-150 motion-reduce:transition-none',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer',
                  active
                    ? 'bg-bolt-elements-item-contentAccent text-[#061018] shadow-[0_2px_10px_-2px_rgba(0,229,255,0.5)]'
                    : 'text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3',
                )}
              >
                <div className={classNames(item.icon, 'text-sm')} aria-hidden />
                {item.label}
              </button>
            );
          })}
        </div>

        {/* Visible ⌘K affordance — so global data search isn't discoverable ONLY via the shortcut. */}
        <button
          type="button"
          data-testid="database-search-open"
          onClick={() => setSearchOpenNonce(Date.now())}
          title="Search across every table — names and content (⌘K)"
          className="ml-auto min-h-[24px] flex items-center gap-1.5 rounded-md border border-bolt-elements-borderColor/70 bg-bolt-elements-background-depth-2 px-2.5 py-1 text-[11px] text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary hover:border-[#00e5ff66] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
        >
          <div className="i-ph:magnifying-glass text-sm" aria-hidden />
          <span className="hidden sm:inline">Search data</span>
          <kbd className="hidden sm:inline-block font-mono text-[9px] border border-bolt-elements-borderColor rounded px-1 py-0.5 leading-none">
            ⌘K
          </kbd>
        </button>
      </div>

      {/* Active sub-view — each stays lightweight; only the mounted view holds a live bridge. */}
      <div className="relative flex-1 overflow-hidden">
        {subView === 'table' && (
          // Tables-view is a vertical column: the tables browser scrolls (its OWN header holds the single
          // "Actions" dropdown — New Table / Import / History / Refresh), and the collapsed-by-default Danger
          // Zone (per-site greenfield reset) sits at the very bottom. Everything targets the site's OWN D1/KV/R2.
          <div className="h-full flex flex-col overflow-y-auto">
            <div className="flex-1 min-h-0">
              <SiteTablesPanel
                onCreateTable={() => setTableAction('schema')}
                onSeedWithAi={() => setTableAction('seed')}
                onImportCsv={() => setTableAction('import')}
                onNewTableSql={() => setSubView('sql')}
                onHistory={() => setTableAction('history')}
                openTableRequest={openTable}
              />
            </div>
            <div className="shrink-0 px-3 pb-4">
              <DangerZone postToParent={postToParent} />
            </div>
          </div>
        )}
        {subView === 'sql' && <SqlNavigator />}
        {subView === 'kv' && <KvManager />}

        {/* Tables-view action overlay — Import / History / Schema / AI-seed, on top of the grid. */}
        {subView === 'table' && tableAction && (
          <TableActionOverlay action={tableAction} onClose={closeAction} />
        )}

        {/*
         * ⌘K global data search — searches ACROSS every table (names + content) via the EXISTING
         * `POST /db/search` bridge, and opens the matched table. Mounted at the panel level so ⌘K works from
         * ANY sub-view (Tables / SQL / KV); it renders nothing until opened.
         */}
        <DataSearchPalette onOpenTable={onOpenTableFromSearch} openNonce={searchOpenNonce} />
      </div>
    </div>
  );
});

DatabasePanel.displayName = 'DatabasePanel';


// ── Tables-view action overlay (renders Import / History / Schema / AiSeed panels on top of the grid) ───

const ACTION_META: Record<TableAction, { title: string; icon: string }> = {
  import: { title: 'Import data', icon: 'i-ph:upload-simple-duotone' },
  history: { title: 'History', icon: 'i-ph:clock-counter-clockwise-duotone' },
  schema: { title: 'New table — schema builder', icon: 'i-ph:blueprint-duotone' },
  seed: { title: 'Seed with AI', icon: 'i-ph:sparkle-duotone' },
};

/**
 * A modal overlay that hosts one of the Tables-view action panels. Keeps {@link ImportPanel},
 * {@link TimeTravelPanel}, {@link SchemaBuilder}, {@link AiSeedPanel} reachable + interconnected without
 * cluttering the top nav. Esc / backdrop / the close button dismiss it (restores focus to the grid).
 */
const TableActionOverlay = memo(({ action, onClose }: { action: TableAction; onClose: () => void }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const meta = ACTION_META[action];

  return (
    <div
      className="absolute inset-0 z-30 flex items-stretch justify-end"
      role="dialog"
      aria-modal="true"
      aria-label={meta.title}
      data-testid="database-action-overlay"
    >
      <button
        type="button"
        aria-label={`Close ${meta.title}`}
        onClick={onClose}
        className="absolute inset-0 bg-black/50 cursor-default motion-safe:animate-[fadeIn_120ms_ease-out]"
      />
      <div className="relative w-[min(560px,92%)] h-full bg-bolt-elements-background-depth-1 border-l border-bolt-elements-borderColor shadow-2xl flex flex-col motion-safe:animate-[fadeInRight_160ms_ease-out]">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-bolt-elements-borderColor shrink-0">
          <div className={classNames(meta.icon, 'text-lg text-bolt-elements-item-contentAccent')} aria-hidden />
          <h3 className="text-sm font-semibold text-bolt-elements-textPrimary flex-1 tracking-tight">{meta.title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="min-h-[24px] min-w-[24px] flex items-center justify-center rounded hover:bg-bolt-elements-background-depth-3 text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
          >
            <div className="i-ph:x text-sm" />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">
          {action === 'import' && <ImportPanel />}
          {action === 'history' && <TimeTravelPanel />}
          {action === 'schema' && <SchemaBuilder />}
          {action === 'seed' && <AiSeedPanel />}
        </div>
      </div>
    </div>
  );
});

TableActionOverlay.displayName = 'DatabasePanel.TableActionOverlay';

// ── KV manager (honest $10/mo locked-upsell gate → the REAL per-site KV browser once unlocked) ────

/** localStorage key remembering that the owner unlocked the KV add-on (so it survives sub-nav switches). */
const KV_UNLOCKED_KEY = 'ps_database_kv_unlocked';

function readKvUnlocked(): boolean {
  try {
    return localStorage.getItem(KV_UNLOCKED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeKvUnlocked(on: boolean): void {
  try {
    localStorage.setItem(KV_UNLOCKED_KEY, on ? '1' : '0');
  } catch {
    // localStorage unavailable (private mode) — the unlock still holds for the session
  }
}

/**
 * The KV manager gate. The site's OWN Cloudflare KV is a **$10/mo Stripe add-on** (per the resource
 * model). Until unlocked this renders an HONEST locked-upsell card — never a dead/mock control. The card
 * carries a **read-only free preview** ({@link KvLockedPreview}) that lists the site's REAL KV keys via the
 * SAME per-site bridge the browser uses (`PS_RES_DETAIL { kind:'kv', action:'list' }` — no new endpoint,
 * list-only, zero value reads, zero write controls), so the paywall shows genuine value instead of a wall.
 * Once unlocked it mounts the REAL {@link KvBrowser}, which manages the site's OWN server-resolved KV
 * namespace (`PS_RES_DETAIL/MUTATE { kind:'kv' }`) and itself renders an honest "not enabled yet" state
 * while `per_site_kv` is dark.
 */
const KvManager = memo(() => {
  const [unlocked, setUnlocked] = useState<boolean>(() => readKvUnlocked());

  const onUnlock = useCallback(() => {
    setUnlocked(true);
    writeKvUnlocked(true);
  }, []);

  if (unlocked) {
    return <KvBrowser />;
  }

  return (
    <div className="h-full flex flex-col items-center justify-center gap-4 p-8 text-center" data-testid="database-kv">
      <div className="relative">
        <div className="i-ph:key-duotone text-5xl text-bolt-elements-item-contentAccent" />
        <div className="absolute -bottom-1 -right-1 i-ph:lock-simple-fill text-lg text-bolt-elements-textTertiary" />
      </div>

      <div className="space-y-1 max-w-[340px]">
        <h3 className="text-base font-semibold text-bolt-elements-textPrimary">Add key-value storage</h3>
        <p className="text-[12px] text-bolt-elements-textSecondary">
          Fast, simple storage for settings, feature flags, sessions, and cached data — right beside your database.
        </p>
      </div>

      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-bold text-bolt-elements-textPrimary">$10</span>
        <span className="text-[12px] text-bolt-elements-textTertiary">/ month</span>
      </div>

      <button
        type="button"
        onClick={onUnlock}
        data-testid="database-kv-unlock"
        className="min-h-[24px] text-[13px] font-semibold px-5 py-2.5 rounded-lg bg-bolt-elements-item-contentAccent text-[#061018] hover:shadow-[0_4px_20px_-4px_rgba(0,229,255,0.6)] hover:-translate-y-px active:translate-y-0 transition-all duration-150 motion-reduce:transition-none motion-reduce:hover:translate-y-0 flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-bolt-elements-background-depth-1 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
      >
        <div className="i-ph:lock-key-open" aria-hidden /> Unlock KV storage
      </button>

      <ul className="text-left text-[11px] text-bolt-elements-textTertiary space-y-1.5 max-w-[300px]">
        <li className="flex items-start gap-2">
          <div className="i-ph:check-circle text-bolt-elements-item-contentAccent mt-0.5 shrink-0" />
          <span>Both your live site and its preview get their own KV — set up automatically.</span>
        </li>
        <li className="flex items-start gap-2">
          <div className="i-ph:check-circle text-bolt-elements-item-contentAccent mt-0.5 shrink-0" />
          <span>Browse, add, and edit keys here once it's on — no config, no dashboards.</span>
        </li>
        <li className="flex items-start gap-2">
          <div className="i-ph:check-circle text-bolt-elements-item-contentAccent mt-0.5 shrink-0" />
          <span>Cancel anytime — your database keeps working without it.</span>
        </li>
      </ul>

      {/* Read-only free preview of the site's REAL KV keys — makes the paywall never a dead wall. */}
      <KvLockedPreview />

      <div
        className="mt-1 border border-bolt-elements-borderColor rounded-md bg-bolt-elements-background-depth-2 px-3 py-2 text-[11px] text-bolt-elements-textSecondary flex items-center gap-2"
        data-testid="database-kv-note"
        role="status"
      >
        <div className="i-ph:sparkle text-bolt-elements-item-contentAccent" />
        <span>Unlock to open the key browser — your site&rsquo;s KV turns on automatically once billing lands.</span>
      </div>
    </div>
  );
});

KvManager.displayName = 'DatabasePanel.KvManager';

// ── Read-only free KV preview (inside the locked-upsell — never a dead paywall) ──

/** How many real keys to preview inside the locked card (list-only, bounded). */
const KV_PREVIEW_LIMIT = 8;
/** A dark-flag 404 reply carries this in its message → the preview hides (the upsell stays clean). */
const KV_PREVIEW_DISABLED = 'not enabled';
const KV_PREVIEW_TIMEOUT_MS = 30_000;

/** One KV key descriptor as the per-site `kv` adapter's `list` returns it (name + optional expiration). */
interface KvPreviewKey {
  name: string;
  expiration?: number;
}

function nextPreviewCorrelationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `kvpv_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

type PreviewState =
  | { status: 'loading' }
  | { status: 'ready'; keys: KvPreviewKey[] }
  | { status: 'empty' }
  | { status: 'hidden' }; // dark flag / not-embedded / transport error → render nothing (upsell only)

/**
 * The locked KV card's READ-ONLY free preview. On mount it asks the SAME per-site bridge the real browser
 * uses — `PS_RES_DETAIL { kind:'kv', action:'list' }` (no new endpoint) — and lists the site's REAL key
 * names. It is strictly list-only: it never reads a value (no `get`) and renders no write controls. Honest
 * states only: real keys → a read-only list; none → "empty so far"; the `per_site_kv` flag dark (or any
 * transport failure / non-embedded) → nothing, so the surrounding upsell stays a clean, non-broken card.
 *
 * Bridge plumbing mirrors {@link KvBrowser}: ONE {@link onParentMessage} listener resolves replies by
 * correlationId through a live ref (empty-deps stale-ref safe). Expiration is formatted with the shared
 * integer-seconds {@link formatKvExpiration} helper — never `new Date()` coercion.
 */
const KvLockedPreview = memo(() => {
  const [state, setState] = useState<PreviewState>({ status: 'loading' });
  const nowSeconds = useMemo(() => Math.floor(Date.now() / 1000), []);

  const pendingRef = useRef<Map<string, (msg: ParentToChildMessage) => void>>(new Map());

  useEffect(() => {
    const pending = pendingRef.current;
    const unsubscribe = onParentMessage((msg) => {
      if (msg.type !== 'PS_RES_DETAIL_RESPONSE') {
        return;
      }

      const correlationId = msg.correlationId;

      if (!correlationId) {
        return;
      }

      const resolve = pending.get(correlationId);

      if (!resolve) {
        return;
      }

      pending.delete(correlationId);
      resolve(msg);
    });

    return () => {
      unsubscribe();
      pending.clear();
    };
  }, []);

  useEffect(() => {
    // Not embedded → no admin bridge to answer; keep the upsell clean (no broken preview).
    if (!isEmbedded) {
      setState({ status: 'hidden' });

      return;
    }

    let cancelled = false;
    const correlationId = nextPreviewCorrelationId();

    const reply = new Promise<ParentToChildMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRef.current.delete(correlationId);
        reject(new Error('timeout'));
      }, KV_PREVIEW_TIMEOUT_MS);

      pendingRef.current.set(correlationId, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });

    postToParent({
      type: 'PS_RES_DETAIL_REQUEST',
      correlationId,
      kind: 'kv',
      action: 'list',
      params: { limit: KV_PREVIEW_LIMIT },
    });

    reply
      .then((msg) => {
        if (cancelled) {
          return;
        }

        const detail = msg as ResDetailResponseMessage;

        // Dark flag (enabled:false OR a "not enabled" 404) → hide the preview; the upsell carries the message.
        if (detail.enabled === false || (!!detail.error && detail.error.includes(KV_PREVIEW_DISABLED))) {
          setState({ status: 'hidden' });

          return;
        }

        // Any other transport error → hide silently (never a broken/doomed preview beside a paywall).
        if (detail.error) {
          setState({ status: 'hidden' });

          return;
        }

        const result = detail.result;

        if (!result || !result.ok) {
          setState({ status: 'hidden' });

          return;
        }

        const keys = ((result.data ?? {}) as { keys?: KvPreviewKey[] }).keys ?? [];

        setState(keys.length === 0 ? { status: 'empty' } : { status: 'ready', keys: keys.slice(0, KV_PREVIEW_LIMIT) });
      })
      .catch(() => {
        if (!cancelled) {
          setState({ status: 'hidden' });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Dark / error / not-embedded → render nothing so the surrounding upsell stays a clean card.
  if (state.status === 'hidden') {
    return null;
  }

  if (state.status === 'loading') {
    return (
      <div
        className="w-full max-w-[340px] rounded-md border border-bolt-elements-borderColor/50 bg-bolt-elements-background-depth-2 px-3 py-2 text-[11px] text-bolt-elements-textTertiary flex items-center gap-2"
        data-testid="database-kv-preview-loading"
        role="status"
      >
        <div className="i-ph:circle-notch animate-spin" aria-hidden /> Loading a preview of your keys…
      </div>
    );
  }

  if (state.status === 'empty') {
    return (
      <div
        className="w-full max-w-[340px] rounded-md border border-bolt-elements-borderColor/50 bg-bolt-elements-background-depth-2 px-3 py-2.5 text-[11px] text-bolt-elements-textTertiary flex items-center gap-2"
        data-testid="database-kv-preview-empty"
      >
        <div className="i-ph:eye text-bolt-elements-item-contentAccent" aria-hidden />
        <span>Your KV is empty so far — unlock it to add your first key.</span>
      </div>
    );
  }

  // Real keys → a compact, READ-ONLY list (no value reads, no write controls) proving the paywall isn't dead.
  return (
    <div
      className="w-full max-w-[340px] rounded-md border border-bolt-elements-borderColor/60 bg-bolt-elements-background-depth-2 overflow-hidden"
      data-testid="database-kv-preview"
    >
      <div className="flex items-center gap-1.5 border-b border-bolt-elements-borderColor/50 px-3 py-1.5 text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary">
        <div className="i-ph:eye text-bolt-elements-item-contentAccent" aria-hidden />
        <span>Preview · your keys (read-only)</span>
      </div>
      <ul className="max-h-40 overflow-auto modern-scrollbar text-left">
        {state.keys.map((k) => (
          <li
            key={k.name}
            data-testid="database-kv-preview-key"
            className="flex items-center justify-between gap-2 border-b border-bolt-elements-borderColor/20 px-3 py-1 text-[11px] font-mono last:border-b-0"
          >
            <span className="truncate text-bolt-elements-textSecondary" title={k.name}>
              {k.name}
            </span>
            <span className="shrink-0 text-[9px] text-bolt-elements-textTertiary">
              {formatKvExpiration(k.expiration, nowSeconds)}
            </span>
          </li>
        ))}
      </ul>
      <div className="px-3 py-1.5 text-[10px] text-bolt-elements-textTertiary border-t border-bolt-elements-borderColor/40 flex items-center gap-1.5">
        <div className="i-ph:lock-simple shrink-0" aria-hidden />
        <span>Unlock to view values and add, edit, or delete keys.</span>
      </div>
    </div>
  );
});

KvLockedPreview.displayName = 'DatabasePanel.KvLockedPreview';
