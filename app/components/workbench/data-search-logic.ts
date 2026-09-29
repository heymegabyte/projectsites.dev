/**
 * @file Pure logic for the Database ⌘K global data-search palette (Rev 9/10).
 *
 * @remarks
 * The palette REUSES the existing cross-table content-search endpoint `POST /api/sites/:siteId/db/search`
 * (bridge `requestDbSearch({ q, limit })` → `PS_SITEDB_SEARCH_REQUEST`/`_RESPONSE`) — NO new endpoint. The
 * worker returns `{ nameMatches: string[], contentMatches: [{ table, column, rowid, snippet }], truncated }`.
 * This module turns that raw reply into a single FLAT, keyboard-navigable result list (name-matches first,
 * then in-content matches) so the palette's ↑/↓/Enter selection is a simple index into one array. All pure —
 * unit-tested without a DOM or a bridge, so the palette component stays a thin shell over this logic.
 */

/** One in-content hit as the search endpoint returns it (table · column · stable rowid · snippet). */
export interface DataContentMatch {
  table: string;
  column: string;
  rowid: number;
  snippet: string;
}

/** The raw cross-table search reply shape (subset of `SiteDbSearchResponseMessage` this module reads). */
export interface DataSearchReply {
  ok?: boolean;
  enabled?: boolean;
  nameMatches?: string[];
  contentMatches?: DataContentMatch[];
  truncated?: boolean;
  error?: string;
}

/**
 * A single row in the flattened palette list. `kind` drives the icon + grouping label; `table` is always the
 * table to OPEN on activate; `rowid` is present only for a content hit (so the palette can ideally scroll to
 * the matched row). `key` is a stable React key + selection identity.
 */
export interface DataSearchResult {
  key: string;
  kind: 'table' | 'content';
  table: string;
  column?: string;
  snippet?: string;
  rowid?: number;
}

/**
 * Flatten a raw search reply into ONE ordered result list: every table NAME match first (kind:'table'), then
 * every in-CONTENT match (kind:'content'). A name-match whose table also appears in content is kept once as a
 * table row AND once per content hit — they open the same table but the content row carries the matched
 * column/snippet/rowid. De-dupes identical table-name entries. Order is stable for keyboard nav.
 */
export function flattenSearchResults(reply: DataSearchReply | null | undefined): DataSearchResult[] {
  if (!reply) {
    return [];
  }

  const out: DataSearchResult[] = [];
  const seenNames = new Set<string>();

  for (const name of reply.nameMatches ?? []) {
    const table = (name ?? '').trim();

    if (!table || seenNames.has(table)) {
      continue;
    }

    seenNames.add(table);
    out.push({ key: `t:${table}`, kind: 'table', table });
  }

  reply.contentMatches?.forEach((m, i) => {
    const table = (m?.table ?? '').trim();

    if (!table) {
      return;
    }

    out.push({
      key: `c:${table}:${m.column}:${m.rowid}:${i}`,
      kind: 'content',
      table,
      column: m.column,
      snippet: m.snippet,
      rowid: m.rowid,
    });
  });

  return out;
}

/** Total match count across both groups (drives the "N matches" summary + the honest "No matches" state). */
export function totalMatchCount(reply: DataSearchReply | null | undefined): number {
  if (!reply) {
    return 0;
  }

  return (reply.nameMatches?.length ?? 0) + (reply.contentMatches?.length ?? 0);
}

/**
 * Move the highlighted index for ↑/↓ with wrap-around over `count` results. Returns the next index; a
 * non-arrow key (or an empty list) returns the current index unchanged. Pure — the palette calls this from
 * its keydown handler and focuses/scrolls the resulting row.
 */
export function nextResultIndex(key: string, current: number, count: number): number {
  if (count <= 0) {
    return 0;
  }

  if (key === 'ArrowDown') {
    return (current + 1) % count;
  }

  if (key === 'ArrowUp') {
    return (current - 1 + count) % count;
  }

  return current;
}

/**
 * Is the query worth dispatching to the endpoint? The cross-table search LIKE-scan is bounded but not free —
 * require a trimmed length ≥ the minimum (default 2) so a single stray character never fans a whole-DB scan.
 * The palette shows a quiet hint below this threshold instead of searching. Pure.
 */
export function isSearchable(query: string, min = 2): boolean {
  return query.trim().length >= min;
}
