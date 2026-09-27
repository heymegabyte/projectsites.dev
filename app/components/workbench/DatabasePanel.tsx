/**
 * @file Database — the ONE consolidated per-site data surface in the editor.
 *
 * @remarks
 * Brian's 2026-09-27 directive (FIRE 1): the editor's three data tabs (`Data` → the shared-platform-D1
 * `DataPanel`, `Database` → the per-site `SiteTablesPanel`, `Resources` → the per-site resource console)
 * collapse into ONE **Database** tab. Its sub-nav is a segmented BUTTON bar — **Table-view · SQL
 * navigator · KV manager** — and EVERYTHING targets the site's OWN dedicated per-site Cloudflare D1
 * (+ its KV), NEVER the shared platform DB and NEVER another site's. The shared-platform-D1 surface
 * (Visitor Events / Snapshots / form_submissions / `/data-overview`) is REMOVED from the editor.
 *
 * Sub-views:
 *  - **Table-view** — the read/edit grid over the site's OWN D1 ({@link SiteTablesPanel}, `PS_SITEDB_*`).
 *  - **Schema builder** — a guided, visual DDL builder ({@link SchemaBuilder}): create table / add · rename ·
 *    drop column (drop is confirm-gated) / create index. Compiles SAFE statements via the pure `schema-ddl`
 *    generators and runs them through the SAME per-site exec rail (`PS_RES_MUTATE { kind:'d1', action:'exec' }`)
 *    with the SQL previewed first. No SQL knowledge required (embarrassingly-easy bar).
 *  - **Import** (FIRE 6) — CSV/JSON → the site's OWN D1 ({@link ImportPanel}): drop/paste a file, auto-detect
 *    columns + types, map them to a new or existing table, preview, then a chunked PARAMETERIZED batch INSERT
 *    through the SAME per-site exec rail. Values are BOUND (never concatenated); the safety keystone lives in the
 *    pure, unit-tested `data-ingest-logic`.
 *  - **Seed with AI** (FIRE 6) — fill a table with realistic sample rows ({@link AiSeedPanel}): pick a table, the
 *    platform AI (`/api/llmcall`, DeepSeek) generates rows matching the real schema, previewed then confirm-inserted
 *    through the per-site rail (param-bound).
 *  - **Forms** (FIRE 6) — a simple form builder ({@link FormBuilder}): define fields → create a backing table +
 *    store a form definition in the site's OWN D1 (the public-render + submit endpoint is a documented follow-up).
 *  - **History** — D1 Time-Travel restore ({@link TimeTravelPanel}): see the live bookmark, label a point, and
 *    RESTORE the whole database to a bookmark or a chosen date-time (confirm-gated, honest "restores to <time>").
 *    Uses `PS_RES_MUTATE { kind:'d1', action:'time_travel_info' | 'restore' }` → the worker's REAL CF REST
 *    Time-Travel calls; an honest "not available" state when Cloudflare can't expose it.
 *  - **SQL navigator** — the RICH per-site D1 SQL workspace ({@link SqlNavigator}), tucked behind a
 *    remembered **Advanced/Developer** toggle (SQL is NOT hidden, it's tucked — 2026-09-26 override).
 *    Recycles the proven editor from `DataPanel` (syntax-highlighted + schema-completing editor, query
 *    history, saved queries, EXPLAIN cost hint, typed result grid) RE-POINTED at the site's OWN D1 via
 *    the per-site adapter (`PS_RES_MUTATE { kind:'d1', action:'exec' }` → `data_d1_exec`), NEVER the
 *    super-admin shared-D1 `/sql/*` path. Mutating statements are confirm-gated; `rowsWritten` is truth.
 *  - **KV manager** — the site's OWN KV, a **$10/mo Stripe add-on**. Until unlocked this is an honest
 *    LOCKED-UPSELL card (never a dead/mock control); once unlocked it renders the REAL per-site KV browser
 *    ({@link KvBrowser}, `PS_RES_DETAIL/MUTATE { kind:'kv' }`) — list/get/put/delete keys against the
 *    site's OWN server-resolved KV namespace, DARK behind `per_site_kv` (a 404 → honest "not enabled yet",
 *    never a dead control). The Stripe checkout + provision-on-purchase backend is FIRE 3's wiring; this
 *    fire recycles the honest gate + the real UI behind it.
 *
 * Isolation is SERVER-resolved for every sub-view: the worker resolves the site's CF ids from the
 * registry for the OWNED site+environment; this panel never sees or sends a CF id it could tamper with
 * (SECURITY-INVARIANTS INV-1/INV-2). Dark flags surface as friendly "not enabled yet" states (404 →
 * disabled), never scary errors (INV-3). Style matches the editor conventions exactly (UnoCSS
 * `bolt-elements-*` tokens, phosphor `i-ph:*` icons).
 */
import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { classNames } from '~/utils/classNames';
import { postToParent } from '~/lib/embed/embedded-mode';
import { SiteTablesPanel } from './SiteTablesPanel';
import { SchemaBuilder } from './SchemaBuilder';
import { TimeTravelPanel } from './TimeTravelPanel';
import { SqlNavigator } from './SqlNavigator';
import { KvBrowser } from './KvBrowser';
import { ImportPanel } from './ImportPanel';
import { AiSeedPanel } from './AiSeedPanel';
import { FormBuilder } from './FormBuilder';
import { DangerZone } from './DangerZone';

// ── Sub-nav model ────────────────────────────────────────────────────────────

type SubView = 'table' | 'schema' | 'import' | 'seed' | 'forms' | 'history' | 'sql' | 'kv';

interface SubNavItem {
  value: SubView;
  label: string;
  icon: string;

  /** When true this item only appears while the Advanced/Developer toggle is on. */
  advanced?: boolean;
}

const SUB_NAV: readonly SubNavItem[] = [
  { value: 'table', label: 'Table-view', icon: 'i-ph:table-duotone' },
  { value: 'schema', label: 'Schema', icon: 'i-ph:blueprint-duotone' },
  { value: 'import', label: 'Import', icon: 'i-ph:upload-simple-duotone' },
  { value: 'seed', label: 'Seed with AI', icon: 'i-ph:sparkle-duotone' },
  { value: 'forms', label: 'Forms', icon: 'i-ph:list-checks-duotone' },
  { value: 'history', label: 'History', icon: 'i-ph:clock-counter-clockwise-duotone' },
  { value: 'sql', label: 'SQL navigator', icon: 'i-ph:terminal-window-duotone', advanced: true },
  { value: 'kv', label: 'KV manager', icon: 'i-ph:key-duotone' },
];

/** localStorage key remembering the user's Advanced/Developer preference (per 2026-09-26 override). */
const ADVANCED_KEY = 'ps_database_advanced';

function readAdvancedPref(): boolean {
  try {
    return localStorage.getItem(ADVANCED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeAdvancedPref(on: boolean): void {
  try {
    localStorage.setItem(ADVANCED_KEY, on ? '1' : '0');
  } catch {
    // localStorage unavailable (private mode) — the toggle still works for the session
  }
}

// ── Container ────────────────────────────────────────────────────────────────

export const DatabasePanel = memo(() => {
  const [advanced, setAdvanced] = useState<boolean>(() => readAdvancedPref());
  const [subView, setSubView] = useState<SubView>('table');

  // If SQL is the active view and Advanced gets turned OFF, fall back to Table-view (never a blank body).
  useEffect(() => {
    if (!advanced && subView === 'sql') {
      setSubView('table');
    }
  }, [advanced, subView]);

  const toggleAdvanced = useCallback(() => {
    setAdvanced((cur) => {
      const next = !cur;
      writeAdvancedPref(next);

      return next;
    });
  }, []);

  const visibleNav = useMemo(() => SUB_NAV.filter((item) => !item.advanced || advanced), [advanced]);

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

  return (
    <div
      className="h-full flex flex-col bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary"
      data-testid="database-panel"
    >
      {/* Sub-nav button bar + Advanced/Developer toggle */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-bolt-elements-borderColor shrink-0">
        <div
          role="tablist"
          aria-label="Database views"
          onKeyDown={onNavKeyDown}
          className="flex items-center gap-1 rounded-lg bg-bolt-elements-background-depth-2 p-0.5"
        >
          {visibleNav.map((item) => {
            const active = subView === item.value;
            return (
              <button
                key={item.value}
                type="button"
                role="tab"
                aria-selected={active}
                aria-pressed={active}
                tabIndex={active ? 0 : -1}
                data-testid={`database-subnav-${item.value}`}
                onClick={() => setSubView(item.value)}
                className={classNames(
                  'min-h-[24px] flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer',
                  active
                    ? 'bg-bolt-elements-item-contentAccent text-bolt-elements-background-depth-1 shadow-sm'
                    : 'text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3',
                )}
              >
                <div className={classNames(item.icon, 'text-sm')} aria-hidden />
                {item.label}
              </button>
            );
          })}
        </div>

        {/* Advanced/Developer toggle — tucks the SQL navigator until asked for; remembered. */}
        <button
          type="button"
          role="switch"
          aria-checked={advanced}
          data-testid="database-advanced-toggle"
          onClick={toggleAdvanced}
          title={advanced ? 'Hide the SQL navigator' : 'Show the SQL navigator (advanced)'}
          className={classNames(
            'ml-auto min-h-[24px] flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded-md border transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer',
            advanced
              ? 'border-bolt-elements-item-contentAccent/60 bg-bolt-elements-item-backgroundAccent/10 text-bolt-elements-item-contentAccent'
              : 'border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3',
          )}
        >
          <div className={classNames(advanced ? 'i-ph:code-duotone' : 'i-ph:code', 'text-sm')} aria-hidden />
          <span className="min-w-[6ch] text-center">{advanced ? 'Developer' : 'Advanced'}</span>
        </button>
      </div>

      {/* Active sub-view — each stays lightweight; only the mounted view holds a live bridge. */}
      <div className="relative flex-1 overflow-hidden">
        {subView === 'table' && (
          // Table-view is a vertical column: the tables browser scrolls, and the collapsed-by-default
          // Danger Zone (per-site greenfield reset, FIRE 8) sits at the very bottom — reachable without
          // disturbing the browser's own scroll. It targets the site's OWN dedicated D1/KV/R2 only.
          <div className="h-full flex flex-col overflow-y-auto">
            <div className="flex-1 min-h-0">
              <SiteTablesPanel onCreateTable={() => setSubView('schema')} />
            </div>
            <div className="shrink-0 px-3 pb-4">
              <DangerZone postToParent={postToParent} />
            </div>
          </div>
        )}
        {subView === 'schema' && <SchemaBuilder />}
        {subView === 'import' && <ImportPanel />}
        {subView === 'seed' && <AiSeedPanel />}
        {subView === 'forms' && <FormBuilder />}
        {subView === 'history' && <TimeTravelPanel />}
        {subView === 'sql' && advanced && <SqlNavigator />}
        {subView === 'kv' && <KvManager />}
      </div>
    </div>
  );
});

DatabasePanel.displayName = 'DatabasePanel';

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
 * model). Until unlocked this renders an HONEST locked-upsell card — never a dead/mock control
 * (SECURITY-INVARIANTS INV-3). Once unlocked it mounts the REAL {@link KvBrowser}, which manages the
 * site's OWN server-resolved KV namespace (`PS_RES_DETAIL/MUTATE { kind:'kv' }`) and itself renders an
 * honest "not enabled yet" state while `per_site_kv` is dark. This fire recycles the gate + the real UI
 * behind it; the Stripe checkout + provision-on-purchase backend is FIRE 3.
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
        className="min-h-[24px] text-[13px] font-semibold px-5 py-2.5 rounded-lg bg-bolt-elements-item-contentAccent text-bolt-elements-background-depth-1 hover:opacity-90 transition-opacity flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-bolt-elements-background-depth-1 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
      >
        <div className="i-ph:lock-key-open" /> Unlock KV storage
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
