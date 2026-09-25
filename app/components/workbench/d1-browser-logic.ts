/**
 * @file Pure helper functions for the D1 Overview Data panel tab.
 *
 * @remarks
 * Zero external dependencies — only the Web standard library. All functions are pure so they can be
 * tested with Vitest without mocking. Sibling of the other resource-browser logic modules
 * (kv / r2 / vectorize / queues).
 */
import type {
  D1ColumnInfo,
  D1DatabaseSummary,
  D1ExportData,
  D1ResponseMessage,
  D1SchemaObjectSummary,
} from '~/lib/embed/embedded-mode';

// ── formatBytes ───────────────────────────────────────────────────────────────

/**
 * Format a byte count (D1 `file_size`) as a short human string. `null` (metric unavailable) →
 * `"—"`, never a fabricated `0`. Uses binary units (KiB/MiB/GiB) to match Cloudflare's D1 sizing.
 *
 * @param bytes - The size in bytes, or `null` when the CF API omitted it.
 * @returns e.g. `"—"`, `"0 B"`, `"512 B"`, `"1.5 KB"`, `"31.5 MB"`, `"2.1 GB"`.
 *
 * @example formatBytes(33067008) // → "31.5 MB"
 * @example formatBytes(0)        // → "0 B"
 * @example formatBytes(null)     // → "—"
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }

  if (bytes < 1024) {
    return `${Math.trunc(bytes)} B`;
  }

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  // One decimal, but drop a trailing ".0" for whole values.
  const rounded = Math.round(value * 10) / 10;

  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} ${units[unit]}`;
}

// ── formatCount ───────────────────────────────────────────────────────────────

/**
 * Format an integer metric (D1 `num_tables`) with thousands separators. `null` → `"—"`, never a
 * fabricated `0` (a real `0` is shown as `"0"`).
 *
 * @param n - The count, or `null` when unavailable.
 * @returns e.g. `"—"`, `"0"`, `"42"`, `"1,024"`.
 *
 * @example formatCount(1024) // → "1,024"
 * @example formatCount(0)    // → "0"
 * @example formatCount(null) // → "—"
 */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) {
    return '—';
  }

  return Math.trunc(n).toLocaleString('en-US');
}

// ── dbLabel ───────────────────────────────────────────────────────────────────

/**
 * Human label for a database row — its name, falling back to the id when unnamed.
 *
 * @param db - The database summary.
 * @returns The trimmed name, or the id when the name is blank.
 *
 * @example dbLabel({ id: 'ea3e…', name: 'prod-db' }) // → "prod-db"
 * @example dbLabel({ id: 'ea3e…', name: '' })        // → "ea3e…"
 */
export function dbLabel(db: D1DatabaseSummary): string {
  const name = db.name?.trim();
  return name ? name : db.id;
}

// ── classifyExportResponse ────────────────────────────────────────────────────

/** The next action for the export poll loop, derived purely from a bridge response. */
export type ExportAction =
  | { kind: 'done'; data: D1ExportData }
  | { kind: 'processing'; bookmark?: string }
  | { kind: 'error'; message: string };

/**
 * Classify an export `PS_D1_RESPONSE` into the next UI action — the pure core of the poll loop
 * (the component just acts on the result). NEVER treats a `complete` without a `signedUrl`, or an
 * `error`/`unavailable` status, as success — so a fabricated/absent URL can't leak into a download.
 *
 * @param res - a bridge response (`{ ok, data?, error? }`).
 * @returns `done` (URL present), `processing` (resume with `bookmark`), or `error` (human message).
 *
 * @example classifyExportResponse({ ok: true, data: { status: 'complete', signedUrl: 'u', note: '' } })
 *   // → { kind: 'done', data: {…} }
 * @example classifyExportResponse({ ok: true, data: { status: 'processing', bookmark: 'b', note: '' } })
 *   // → { kind: 'processing', bookmark: 'b' }
 * @example classifyExportResponse({ ok: false, error: 'timed out' }) // → { kind: 'error', message: 'timed out' }
 */
export function classifyExportResponse(res: Pick<D1ResponseMessage, 'ok' | 'data' | 'error'>): ExportAction {
  if (!res.ok || !res.data || typeof res.data !== 'object' || !('status' in res.data)) {
    return { kind: 'error', message: res.error ?? 'Export failed' };
  }

  const data = res.data as D1ExportData;

  if (data.status === 'complete' && data.signedUrl) {
    return { kind: 'done', data };
  }

  if (data.status === 'processing') {
    return { kind: 'processing', bookmark: data.bookmark };
  }

  return {
    kind: 'error',
    message: data.reason ?? (data.status === 'unavailable' ? 'D1 not available' : 'Export failed'),
  };
}

// ── Schema-browser helpers ──────────────────────────────────────────────────────

/**
 * Case-insensitive name filter for the schema-object catalog. A blank/whitespace query returns the
 * list unchanged; otherwise it keeps objects whose name contains the trimmed query.
 *
 * @example filterSchemaObjects([{name:'users',…},{name:'orders',…}], 'ORD') // → [orders]
 * @example filterSchemaObjects(objs, '   ') // → objs (unchanged)
 */
export function filterSchemaObjects(objects: D1SchemaObjectSummary[], query: string): D1SchemaObjectSummary[] {
  const q = query.trim().toLowerCase();

  if (!q) {
    return objects;
  }

  return objects.filter((o) => o.name.toLowerCase().includes(q));
}

/**
 * Human summary of the per-type object counts — e.g. `"12 tables · 3 views · 8 indexes"`. Zero-count
 * types are omitted; plurals are correct (`index → indexes`). `undefined`/all-zero → `""`.
 *
 * @example schemaCountsLabel({ table: 12, view: 3, index: 8, trigger: 0 }) // → "12 tables · 3 views · 8 indexes"
 * @example schemaCountsLabel({ table: 1, view: 0, index: 0, trigger: 0 })  // → "1 table"
 */
export function schemaCountsLabel(counts?: { table: number; view: number; index: number; trigger: number }): string {
  if (!counts) {
    return '';
  }

  const parts: string[] = [];
  const push = (n: number, singular: string, plural: string): void => {
    if (n > 0) {
      parts.push(`${n} ${n === 1 ? singular : plural}`);
    }
  };
  push(counts.table, 'table', 'tables');
  push(counts.view, 'view', 'views');
  push(counts.index, 'index', 'indexes');
  push(counts.trigger, 'trigger', 'triggers');

  return parts.join(' · ');
}

/**
 * Only tables and views have inspectable columns (parsed from their CREATE SQL); indexes and triggers
 * do not — the UI shows their DDL instead.
 *
 * @example isBrowsableObject('table') // → true
 * @example isBrowsableObject('index') // → false
 */
export function isBrowsableObject(type: D1SchemaObjectSummary['type']): boolean {
  return type === 'table' || type === 'view';
}

/**
 * Nullability label for a column. `NOT NULL` when the constraint is set, else `NULL`.
 *
 * @example columnNullLabel({ notNull: true } as D1ColumnInfo)  // → "NOT NULL"
 * @example columnNullLabel({ notNull: false } as D1ColumnInfo) // → "NULL"
 */
export function columnNullLabel(col: Pick<D1ColumnInfo, 'notNull'>): string {
  return col.notNull ? 'NOT NULL' : 'NULL';
}

/**
 * Declared SQLite type for display — an empty type (untyped column) renders as `"—"`, never blank.
 *
 * @example columnTypeLabel('TEXT') // → "TEXT"
 * @example columnTypeLabel('')     // → "—"
 */
export function columnTypeLabel(type: string): string {
  return type.trim() ? type : '—';
}

/*
 * ── parseCreateTableColumns ─────────────────────────────────────────────────────
 *
 * The CF D1 REST `/query` authorizer BLOCKS `PRAGMA table_info` (SQLITE_AUTH — verified against prod
 * D1, 2026-09-25), so a table's columns are parsed from its CREATE SQL (the DDL the catalog already
 * returns). Best-effort by design: for DDL it can't confidently parse (views, virtual/FTS tables,
 * exotic constraints) it returns `[]` and the UI falls back to showing the raw CREATE SQL — never a
 * fabricated column set.
 */

/** Strip surrounding SQLite identifier quotes: `"x"` / `[x]` / `` `x` `` / `x` → `x`. */
function unquoteIdent(raw: string): string {
  const t = raw.trim();

  if (t.length >= 2) {
    const a = t[0];
    const b = t[t.length - 1];

    if (a === '"' && b === '"') {
      return t.slice(1, -1).replace(/""/g, '"');
    }

    if (a === '`' && b === '`') {
      return t.slice(1, -1).replace(/``/g, '`');
    }

    if (a === '[' && b === ']') {
      return t.slice(1, -1);
    }
  }

  return t;
}

/** Split a CREATE-TABLE body on TOP-LEVEL commas — commas inside parens or quotes are ignored. */
function splitTopLevelCommas(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  let closeQuote = '';

  for (const ch of body) {
    if (closeQuote) {
      cur += ch;

      if (ch === closeQuote) {
        closeQuote = '';
      }

      continue;
    }

    if (ch === '"' || ch === '`' || ch === "'") {
      closeQuote = ch;
      cur += ch;
      continue;
    }

    if (ch === '[') {
      closeQuote = ']';
      cur += ch;
      continue;
    }

    if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
    } else if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }

    cur += ch;
  }

  if (cur.trim()) {
    out.push(cur);
  }

  return out;
}

/** Column-level keyword that terminates the declared TYPE portion of a column definition. */
const COL_TYPE_TERMINATOR = /\b(NOT\s+NULL|NULL|PRIMARY\s+KEY|DEFAULT|UNIQUE|CHECK|REFERENCES|COLLATE|GENERATED|AS)\b/i;

/**
 * Parse a `CREATE TABLE` statement's columns from its DDL — name, declared type, nullability, default,
 * and PRIMARY-KEY position (inline `PRIMARY KEY` ⇒ pk 1; a table-level `PRIMARY KEY (a,b)` ⇒ 1-based
 * composite positions). Returns `[]` for anything that is not a `CREATE TABLE` (views, virtual/FTS
 * tables) — the caller shows the raw DDL instead. Best-effort; never throws, never fabricates.
 *
 * @param sql - The object's CREATE SQL (`sqlite_master.sql`), or null.
 * @returns Parsed columns in declaration order (`cid` 0-based), or `[]` when not parseable.
 *
 * @example
 * parseCreateTableColumns('CREATE TABLE t (id TEXT PRIMARY KEY, n INT NOT NULL DEFAULT 0)')
 * // → [{cid:0,name:'id',type:'TEXT',notNull:true,defaultValue:null,pk:1},
 * //    {cid:1,name:'n',type:'INT',notNull:true,defaultValue:'0',pk:0}]
 */
export function parseCreateTableColumns(sql: string | null): D1ColumnInfo[] {
  if (!sql || !/^\s*CREATE\s+TABLE\b/i.test(sql)) {
    return [];
  } // tables only (excludes VIEW + VIRTUAL TABLE)

  const open = sql.indexOf('(');

  if (open < 0) {
    return [];
  }

  let depth = 0;
  let end = -1;

  for (let i = open; i < sql.length; i += 1) {
    if (sql[i] === '(') {
      depth += 1;
    } else if (sql[i] === ')') {
      depth -= 1;

      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  if (end < 0) {
    return [];
  }

  const columns: D1ColumnInfo[] = [];
  const compositePk: string[] = [];
  let cid = 0;

  for (const part of splitTopLevelCommas(sql.slice(open + 1, end))) {
    const item = part.trim();

    if (!item) {
      continue;
    }

    // Table-level constraints — not columns. Capture a composite PRIMARY KEY column list.
    if (/^(CONSTRAINT\b|PRIMARY\s+KEY\b|FOREIGN\s+KEY\b|UNIQUE\s*\(|CHECK\s*\()/i.test(item)) {
      const pk = /PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(item);

      if (pk) {
        for (const c of pk[1].split(',')) {
          const n = unquoteIdent(c);

          if (n) {
            compositePk.push(n);
          }
        }
      }

      continue;
    }

    // Column definition: first token is the (possibly quoted) name.
    const nameMatch = /^\s*("(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[A-Za-z_][\w$]*)/.exec(item);

    if (!nameMatch) {
      continue;
    }

    const name = unquoteIdent(nameMatch[1]);

    if (!name) {
      continue;
    }

    const rest = item.slice(nameMatch[0].length).trim();
    const term = COL_TYPE_TERMINATOR.exec(rest);
    const type = (term ? rest.slice(0, term.index) : rest).trim().replace(/\s+/g, ' ');
    const inlinePk = /\bPRIMARY\s+KEY\b/i.test(rest);
    const def = /\bDEFAULT\s+('(?:[^']|'')*'|\([^)]*\)|[^\s,]+)/i.exec(rest);

    columns.push({
      cid,
      name,
      type,
      notNull: /\bNOT\s+NULL\b/i.test(rest) || inlinePk,
      defaultValue: def ? def[1].trim() : null,
      pk: inlinePk ? 1 : 0,
    });
    cid += 1;
  }

  compositePk.forEach((pkName, idx) => {
    const col = columns.find((c) => c.name === pkName);

    if (col && col.pk === 0) {
      col.pk = idx + 1;
    }
  });

  return columns;
}
