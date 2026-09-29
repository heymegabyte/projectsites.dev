/**
 * @file Database ⌘K global data-search palette (Rev 9/10 — Global data search).
 *
 * @remarks
 * A keyboard-first command palette that searches ACROSS every table in the site's OWN per-site D1 — table
 * NAMES + row CONTENT — and jumps to the matching table (ideally the matched row). It REUSES the EXISTING
 * cross-table content-search endpoint `POST /api/sites/:siteId/db/search` through the `requestDbSearch`
 * bridge (message `PS_SITEDB_SEARCH_REQUEST` → `PS_SITEDB_SEARCH_RESPONSE`) — it adds NO new endpoint. The
 * worker resolves the site's OWN `d1_database_id` server-side (shared-platform ids denylisted); the palette
 * only ever sends `{ q, limit }`, never a CF id.
 *
 * Interaction (embarrassingly-easy, WCAG 2.2 AA):
 *  - ⌘K / Ctrl+K opens the overlay + focuses the input from ANY Database sub-view (a global listener).
 *  - Typing searches after a short debounce; ↑/↓ move the highlighted result (wrap), Enter opens it, Esc
 *    closes. Clicking a result opens it too.
 *  - Results group by table: table-NAME matches first, then in-CONTENT matches (table · column · a snippet
 *    with the query stylized). Opening a content match passes its `rowid` so the grid can scroll to it.
 *  - Empty / too-short query → a quiet hint; a zero-result reply → an honest "No matches" (never a dead
 *    overlay); a dark-flag (`enabled:false`) reply → a friendly "not enabled yet" line (INV-3).
 *
 * Behind `per_site_data` (its data source is the flag-gated per-site D1): when the endpoint 404s dark, the
 * search simply returns nothing and the palette says so — it never throws a scary error. Pure list/keyboard
 * logic lives in `./data-search-logic` for unit testing; this component is a thin shell over it. Dark brand
 * tokens throughout (`bolt-elements-*` + `--ps-accent`), matching the SqlNavigator / SiteTablesPanel style.
 */
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { classNames } from '~/utils/classNames';
import { isEmbedded, requestDbSearch } from '~/lib/embed/embedded-mode';
import {
  flattenSearchResults,
  isSearchable,
  nextResultIndex,
  totalMatchCount,
  type DataSearchReply,
  type DataSearchResult,
} from './data-search-logic';

// ── Constants ────────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 300;
const MAX_RESULTS = 50;
const MIN_QUERY = 2;
const DISABLED_404 = 'not enabled';

/** What the palette hands back when a result is activated: the table to open (+ the matched row, if any). */
export interface OpenTablePayload {
  table: string;
  rowid?: number;
}

interface DataSearchPaletteProps {
  /**
   * Open the matched table in the Tables view. The container switches to Tables and selects `table`; `rowid`
   * (present only for a content match) lets the grid ideally scroll to the matched row.
   */
  onOpenTable: (payload: OpenTablePayload) => void;

  /**
   * Optional: a changing value opens the palette from an explicit trigger (the visible "Search data" button
   * in the Database sub-nav) — so ⌘K isn't the ONLY way in (embarrassingly-easy discoverability). Increment
   * it (e.g. `Date.now()`) to open; the palette ignores its initial value so it stays closed on mount.
   */
  openNonce?: number;
}

type SearchState =
  | { status: 'idle' } // empty/too-short query — show the quiet hint
  | { status: 'searching' }
  | { status: 'disabled' } // dark flag — friendly "not enabled yet"
  | { status: 'error'; message: string }
  | { status: 'ready'; results: DataSearchResult[]; total: number; truncated: boolean };

// ── Snippet highlighter (stylize the matched query inside a content snippet) ──

/**
 * Split a snippet around case-insensitive occurrences of `query` so the matched run can render highlighted.
 * Pure + XSS-safe (returns text segments, never HTML). Falls back to the whole snippet when the query isn't
 * present (the DB match may be on a normalized form).
 */
function highlightParts(snippet: string, query: string): { text: string; hit: boolean }[] {
  const q = query.trim();

  if (!q) {
    return [{ text: snippet, hit: false }];
  }

  const parts: { text: string; hit: boolean }[] = [];
  const lower = snippet.toLowerCase();
  const needle = q.toLowerCase();
  let i = 0;

  while (i < snippet.length) {
    const at = lower.indexOf(needle, i);

    if (at === -1) {
      parts.push({ text: snippet.slice(i), hit: false });
      break;
    }

    if (at > i) {
      parts.push({ text: snippet.slice(i, at), hit: false });
    }

    parts.push({ text: snippet.slice(at, at + needle.length), hit: true });
    i = at + needle.length;
  }

  return parts.length > 0 ? parts : [{ text: snippet, hit: false }];
}

// ── Component ────────────────────────────────────────────────────────────────

export const DataSearchPalette = memo(({ onOpenTable, openNonce }: DataSearchPaletteProps) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [state, setState] = useState<SearchState>({ status: 'idle' });
  const [active, setActive] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchSeq = useRef(0);

  const results = state.status === 'ready' ? state.results : [];

  // ── Global ⌘K / Ctrl+K to open + focus (works from any Database sub-view) ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOpen(true);
      }
    };

    document.addEventListener('keydown', onKey);

    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Explicit-trigger open (the visible "Search data" button). Skip the initial value so it stays closed on mount.
  const didMountNonce = useRef(false);
  useEffect(() => {
    if (!didMountNonce.current) {
      didMountNonce.current = true;
      return;
    }

    if (openNonce !== undefined) {
      setOpen(true);
    }
  }, [openNonce]);

  // Focus the input whenever the overlay opens; reset selection when results change.
  useEffect(() => {
    if (open) {
      // rAF-free: the input is mounted in the same paint, so focus synchronously after open.
      inputRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [state]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setState({ status: 'idle' });

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
  }, []);

  // ── Debounced search — reuses the EXISTING cross-table `requestDbSearch` bridge ──
  const runSearch = useCallback(async (q: string) => {
    const seq = ++searchSeq.current;

    if (!isEmbedded) {
      // Standalone editor (no admin parent) — nothing to search against.
      setState({ status: 'disabled' });
      return;
    }

    setState({ status: 'searching' });

    try {
      const reply = (await requestDbSearch({ q, limit: MAX_RESULTS })) as DataSearchReply;

      // A newer keystroke superseded this search — drop the stale reply.
      if (seq !== searchSeq.current) {
        return;
      }

      if (reply.enabled === false || (reply.error && reply.error.includes(DISABLED_404))) {
        setState({ status: 'disabled' });
        return;
      }

      if (reply.ok === false || reply.error) {
        setState({ status: 'error', message: reply.error || 'Search is unavailable right now.' });
        return;
      }

      setState({
        status: 'ready',
        results: flattenSearchResults(reply),
        total: totalMatchCount(reply),
        truncated: !!reply.truncated,
      });
    } catch (err) {
      if (seq !== searchSeq.current) {
        return;
      }

      setState({ status: 'error', message: err instanceof Error ? err.message : 'Search failed. Try again.' });
    }
  }, []);

  const onQueryChange = useCallback(
    (value: string) => {
      setQuery(value);

      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      if (!isSearchable(value, MIN_QUERY)) {
        // Below the threshold — quiet hint, no scan (never fan a whole-DB LIKE on one stray char).
        setState({ status: 'idle' });
        return;
      }

      debounceRef.current = setTimeout(() => void runSearch(value.trim()), DEBOUNCE_MS);
    },
    [runSearch],
  );

  const activate = useCallback(
    (result: DataSearchResult | undefined) => {
      if (!result) {
        return;
      }

      onOpenTable({ table: result.table, rowid: result.rowid });
      close();
    },
    [onOpenTable, close],
  );

  const onInputKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const next = nextResultIndex(e.key, active, results.length);
        setActive(next);
        rowRefs.current[next]?.scrollIntoView({ block: 'nearest' });
        return;
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        activate(results[active]);
      }
    },
    [active, results, close, activate],
  );

  // Partition for the grouped render (name matches vs in-content matches), preserving flat indices.
  const grouped = useMemo(() => {
    const tables: { result: DataSearchResult; index: number }[] = [];
    const content: { result: DataSearchResult; index: number }[] = [];

    results.forEach((result, index) => {
      (result.kind === 'table' ? tables : content).push({ result, index });
    });

    return { tables, content };
  }, [results]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="absolute inset-0 z-[60] flex items-start justify-center pt-[8vh] px-4 bg-black/60 backdrop-blur-sm motion-safe:animate-[fadeIn_120ms_ease-out]"
      data-testid="data-search-overlay"
      role="presentation"
      onMouseDown={(e) => {
        // Click the scrim (not the panel) to dismiss.
        if (e.target === e.currentTarget) {
          close();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search your data"
        className="w-full max-w-xl rounded-xl border border-[#00e5ff33] bg-bolt-elements-background-depth-1 shadow-[0_24px_80px_-12px_rgba(0,0,0,0.7),0_0_0_1px_rgba(0,229,255,0.08)] overflow-hidden [color-scheme:dark] accent-[color:var(--ps-accent,#00e5ff)]"
      >
        {/* Search input row */}
        <div className="flex items-center gap-2 px-3.5 py-3 border-b border-bolt-elements-borderColor/60">
          <div className="i-ph:magnifying-glass text-bolt-elements-item-contentAccent text-base shrink-0" aria-hidden />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search every table — names and content…"
            data-testid="data-search-input"
            aria-label="Search across every table in your database"
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent text-sm text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:outline-none"
          />
          {state.status === 'searching' && (
            <div className="i-ph:circle-notch animate-spin text-bolt-elements-textTertiary shrink-0" aria-hidden />
          )}
          <kbd className="hidden sm:inline-block text-[9px] font-mono text-bolt-elements-textTertiary border border-bolt-elements-borderColor rounded px-1 py-0.5 shrink-0">
            Esc
          </kbd>
        </div>

        {/* Body */}
        <div className="max-h-[56vh] overflow-auto modern-scrollbar">
          {/* Quiet hint — empty / too-short query */}
          {state.status === 'idle' && (
            <div
              className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center"
              data-testid="data-search-hint"
            >
              <div className="i-ph:keyboard-duotone text-2xl text-bolt-elements-textTertiary" aria-hidden />
              <p className="text-xs text-bolt-elements-textSecondary">
                Type at least {MIN_QUERY} characters to search every table&rsquo;s names and content.
              </p>
              <p className="text-[10px] text-bolt-elements-textTertiary">↑ ↓ to move · Enter to open · Esc to close</p>
            </div>
          )}

          {/* Friendly disabled (dark flag) */}
          {state.status === 'disabled' && (
            <div
              className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center"
              data-testid="data-search-disabled"
            >
              <div className="i-ph:lock-key text-2xl text-bolt-elements-textTertiary" aria-hidden />
              <p className="text-xs text-bolt-elements-textSecondary">
                Data search isn&rsquo;t enabled yet — your site&rsquo;s own database is on the way.
              </p>
            </div>
          )}

          {/* Error — retryable, never scary */}
          {state.status === 'error' && (
            <div
              className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center"
              data-testid="data-search-error"
              role="alert"
            >
              <div className="i-ph:warning-circle text-2xl text-red-400" aria-hidden />
              <p className="text-xs text-bolt-elements-textSecondary max-w-[320px] break-words">{state.message}</p>
            </div>
          )}

          {/* No matches — honest, never a dead overlay */}
          {state.status === 'ready' && state.total === 0 && (
            <div
              className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center"
              data-testid="data-search-empty"
            >
              <div className="i-ph:magnifying-glass-minus text-2xl text-bolt-elements-textTertiary" aria-hidden />
              <p className="text-xs text-bolt-elements-textSecondary">
                No matches for &ldquo;<span className="text-bolt-elements-textPrimary">{query.trim()}</span>&rdquo;.
              </p>
              <p className="text-[10px] text-bolt-elements-textTertiary">Try a different word, name, or value.</p>
            </div>
          )}

          {/* Results — grouped by table (names first, then in-content) */}
          {state.status === 'ready' && state.total > 0 && (
            <div data-testid="data-search-results" className="py-1.5">
              {grouped.tables.length > 0 && (
                <div className="px-2 pb-1">
                  <div className="px-2 pt-1.5 pb-1 text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary">
                    Tables
                  </div>
                  {grouped.tables.map(({ result, index }) => (
                    <ResultRow
                      key={result.key}
                      ref={(el) => (rowRefs.current[index] = el)}
                      result={result}
                      query={query}
                      active={index === active}
                      onHover={() => setActive(index)}
                      onActivate={() => activate(result)}
                    />
                  ))}
                </div>
              )}

              {grouped.content.length > 0 && (
                <div className="px-2 pb-1">
                  <div className="px-2 pt-1.5 pb-1 text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary">
                    In content
                  </div>
                  {grouped.content.map(({ result, index }) => (
                    <ResultRow
                      key={result.key}
                      ref={(el) => (rowRefs.current[index] = el)}
                      result={result}
                      query={query}
                      active={index === active}
                      onHover={() => setActive(index)}
                      onActivate={() => activate(result)}
                    />
                  ))}
                </div>
              )}

              {state.truncated && (
                <div className="px-4 py-2 text-[10px] text-amber-200/80 border-t border-bolt-elements-borderColor/40">
                  Showing the first {results.length} matches — refine your search to narrow it.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

DataSearchPalette.displayName = 'DataSearchPalette';

// ── One result row ─────────────────────────────────────────────────────────

const ResultRow = React.forwardRef<
  HTMLButtonElement,
  {
    result: DataSearchResult;
    query: string;
    active: boolean;
    onHover: () => void;
    onActivate: () => void;
  }
>(({ result, query, active, onHover, onActivate }, ref) => {
  const isContent = result.kind === 'content';

  return (
    <button
      ref={ref}
      type="button"
      data-testid="data-search-result"
      aria-selected={active}
      onMouseMove={onHover}
      onClick={onActivate}
      className={classNames(
        'w-full text-left rounded-md px-2.5 py-1.5 flex items-center gap-2.5 transition-colors motion-reduce:transition-none cursor-pointer focus-visible:outline-none',
        active
          ? 'bg-[#00e5ff1f] ring-1 ring-[#00e5ff55]'
          : 'hover:bg-bolt-elements-background-depth-3',
      )}
    >
      <div
        className={classNames(
          isContent ? 'i-ph:text-aa-duotone' : 'i-ph:table-duotone',
          'text-sm shrink-0',
          active ? 'text-bolt-elements-item-contentAccent' : 'text-bolt-elements-textTertiary',
        )}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[12px]">
          <span className="font-medium text-bolt-elements-textPrimary truncate">{result.table}</span>
          {isContent && result.column && (
            <>
              <span className="text-bolt-elements-textTertiary" aria-hidden>
                ·
              </span>
              <span className="font-mono text-[10px] text-bolt-elements-textTertiary truncate">{result.column}</span>
            </>
          )}
        </div>
        {isContent && result.snippet && (
          <div className="mt-0.5 text-[11px] text-bolt-elements-textSecondary truncate">
            {highlightParts(result.snippet, query).map((part, i) =>
              part.hit ? (
                <mark key={i} className="bg-[#00e5ff33] text-bolt-elements-item-contentAccent rounded-sm px-0.5">
                  {part.text}
                </mark>
              ) : (
                <span key={i}>{part.text}</span>
              ),
            )}
          </div>
        )}
      </div>
      <div
        className={classNames(
          'i-ph:arrow-elbow-down-left text-xs shrink-0 transition-opacity',
          active ? 'opacity-70 text-bolt-elements-item-contentAccent' : 'opacity-0',
        )}
        aria-hidden
      />
    </button>
  );
});

ResultRow.displayName = 'DataSearchPalette.ResultRow';
