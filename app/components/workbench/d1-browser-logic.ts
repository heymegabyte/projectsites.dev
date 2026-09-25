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
  D1ForeignKey,
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

/** Return the substring INSIDE the first balanced `(...)` at/after `from`, or null when unbalanced. */
function balancedParenBody(sql: string, from = 0): string | null {
  const open = sql.indexOf('(', from);

  if (open < 0) {
    return null;
  }

  let depth = 0;

  for (let i = open; i < sql.length; i += 1) {
    if (sql[i] === '(') {
      depth += 1;
    } else if (sql[i] === ')') {
      depth -= 1;

      if (depth === 0) {
        return sql.slice(open + 1, i);
      }
    }
  }

  return null;
}

/**
 * A single SQLite identifier (quoted `"x"` / `` `x` `` / `[x]` or bare) as a regex-source string —
 * reused across the parsers via `new RegExp`. Derived from a regex LITERAL's `.source` so the
 * bracket/quote escaping is authored once, correctly (no hand-escaped string).
 */
const IDENT_RE = /"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[A-Za-z_][\w$]*/.source;

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

/** Leading-identifier matcher — a column name at the START of a clause (built once from `IDENT_RE`). */
const LEADING_IDENT_RE = new RegExp(`^\\s*(${IDENT_RE})`, 'i');

/**
 * Parse foreign-key relationships from a `CREATE TABLE` DDL — both the table-level
 * `FOREIGN KEY (a) REFERENCES t(x)` (composite-aware, pairs by position) and the inline
 * `a … REFERENCES t(x)` forms. `refColumn` is null when the DDL omits it (⇒ the referenced table's
 * PK). Returns `[]` for non-tables. Best-effort; never throws, never fabricates.
 *
 * @example parseForeignKeys('CREATE TABLE o (id TEXT, uid TEXT REFERENCES users(id))')
 *   // → [{ column: 'uid', refTable: 'users', refColumn: 'id' }]
 */
export function parseForeignKeys(sql: string | null): D1ForeignKey[] {
  if (!sql || !/^\s*CREATE\s+TABLE\b/i.test(sql)) {
    return [];
  }

  const body = balancedParenBody(sql);

  if (body === null) {
    return [];
  }

  const tableFkRe = new RegExp(
    `^(?:CONSTRAINT\\s+(?:${IDENT_RE})\\s+)?FOREIGN\\s+KEY\\s*\\(([^)]*)\\)\\s*REFERENCES\\s+(${IDENT_RE})\\s*(?:\\(([^)]*)\\))?`,
    'i',
  );
  const inlineRefRe = new RegExp(`\\bREFERENCES\\s+(${IDENT_RE})\\s*(?:\\(\\s*(${IDENT_RE})\\s*\\))?`, 'i');

  const fks: D1ForeignKey[] = [];

  for (const part of splitTopLevelCommas(body)) {
    const item = part.trim();

    if (!item) {
      continue;
    }

    const tableFk = tableFkRe.exec(item);

    if (tableFk) {
      const cols = tableFk[1].split(',').map(unquoteIdent).filter(Boolean);
      const refTable = unquoteIdent(tableFk[2]);
      const refCols = tableFk[3] ? tableFk[3].split(',').map(unquoteIdent).filter(Boolean) : [];
      cols.forEach((column, i) => fks.push({ column, refTable, refColumn: refCols[i] ?? null }));
      continue;
    }

    // Other table-level constraints are not FKs.
    if (/^(CONSTRAINT\b|PRIMARY\s+KEY\b|UNIQUE\s*\(|CHECK\s*\()/i.test(item)) {
      continue;
    }

    // Inline column-level reference: `<name> … REFERENCES other [(col)]`.
    const ref = inlineRefRe.exec(item);

    if (ref) {
      const nameMatch = LEADING_IDENT_RE.exec(item);
      const column = nameMatch ? unquoteIdent(nameMatch[1]) : '';

      if (column) {
        fks.push({ column, refTable: unquoteIdent(ref[1]), refColumn: ref[2] ? unquoteIdent(ref[2]) : null });
      }
    }
  }

  return fks;
}

/**
 * Parse an index's CREATE SQL into its UNIQUE flag + the indexed column names — `CREATE [UNIQUE]
 * INDEX name ON table (col1, col2)`. Best-effort: an expression term (`lower(x)`) yields its leading
 * identifier; a partial-index `WHERE` clause is ignored (only the first `(...)` after `ON` is read).
 *
 * @example parseIndexColumns('CREATE UNIQUE INDEX u ON users (email)')
 *   // → { unique: true, columns: ['email'] }
 */
export function parseIndexColumns(sql: string | null): { unique: boolean; columns: string[] } {
  if (!sql) {
    return { unique: false, columns: [] };
  }

  const unique = /\bCREATE\s+UNIQUE\s+INDEX\b/i.test(sql);
  const on = /\bON\b/i.exec(sql);

  if (!on) {
    return { unique, columns: [] };
  }

  const body = balancedParenBody(sql, on.index);

  if (body === null) {
    return { unique, columns: [] };
  }

  const columns = splitTopLevelCommas(body)
    .map((c) => {
      const m = LEADING_IDENT_RE.exec(c);
      return m ? unquoteIdent(m[1]) : '';
    })
    .filter(Boolean);

  return { unique, columns };
}

// ── timeTravelInfo (Backups & recovery) ─────────────────────────────────────────

/** Honest recovery facts for a D1 database — retention + the Wrangler restore command + the no-REST caveat. */
export interface TimeTravelInfo {
  retentionNote: string;
  restoreCommand: string;
  caveat: string;
}

/**
 * Honest, static Time-Travel (point-in-time recovery) info for a D1 database. Cloudflare exposes Time
 * Travel ONLY via the Wrangler CLI + the Worker binding — there is **NO REST API** (verified against CF
 * docs 2026-09-25) — so this surfaces the real recovery path (retention + the exact restore command)
 * WITHOUT a fake one-click restore button (which would be an attractive control backed by nothing).
 * Retention is ~30 days on a paid plan / 7 days on the free plan.
 *
 * @param dbNameOrId - the database name (preferred) or UUID, interpolated into the command.
 * @example timeTravelInfo('prod-db').restoreCommand
 *   // → "wrangler d1 time-travel restore prod-db --timestamp=<ISO-8601>"
 */
export function timeTravelInfo(dbNameOrId: string): TimeTravelInfo {
  const target = dbNameOrId.trim() || '<database>';
  return {
    retentionNote:
      'Cloudflare keeps point-in-time history for this database — about 30 days on a paid plan (7 days on the free plan) — so it can be restored to any moment in that window.',
    restoreCommand: `wrangler d1 time-travel restore ${target} --timestamp=<ISO-8601>`,
    caveat:
      'Time Travel has no REST API (Wrangler CLI only), so a one-click restore is not offered here. For a portable copy you can keep, use the SQL-dump export above.',
  };
}

// ── incomingForeignKeys (reverse relationships) ─────────────────────────────────

/** A foreign key POINTING AT a given table — the reverse of {@link parseForeignKeys} ("who references us"). */
export interface IncomingForeignKey {
  /** The table that holds the foreign key. */
  table: string;

  /** The column in that table that references us. */
  column: string;

  /** Our column it references, or null when the DDL omitted it. */
  refColumn: string | null;
}

/**
 * The tables that REFERENCE `tableName` (the incoming side of a relationship — complements
 * `parseForeignKeys`' outgoing side, together giving the "understandable relationship view" the
 * schema browser wants). Scans every table object's CREATE SQL for a FK whose target is `tableName`.
 * Pure; best-effort (same DDL parser); skips self + non-tables.
 *
 * @example incomingForeignKeys([usersDDL, ordersRefDDL], 'users')
 *   // → [{ table: 'orders', column: 'user_id', refColumn: 'id' }]
 */
export function incomingForeignKeys(
  objects: readonly D1SchemaObjectSummary[],
  tableName: string,
): IncomingForeignKey[] {
  const out: IncomingForeignKey[] = [];

  for (const o of objects) {
    if (o.type !== 'table' || o.name === tableName) {
      continue;
    }

    for (const fk of parseForeignKeys(o.sql)) {
      if (fk.refTable === tableName) {
        out.push({ table: o.name, column: fk.column, refColumn: fk.refColumn });
      }
    }
  }

  return out;
}

/** Facts for {@link buildDataInsights} — mirrors the worker's `D1InsightsData`. */
export interface D1InsightsInput {
  tables: Array<{ name: string; rows: number }>;
  counts: { table: number; view: number; index: number; trigger: number };
  totalRows: number;
  capped: boolean;
}

/**
 * Derive ≤5 plain-language overview takeaways from real database facts (per-table row counts +
 * structural counts) — the D1 analogue of the analytics Highlights strip. PRESENT-DATA-ONLY: a
 * takeaway is emitted only when its number exists, so it never says "0 of…". Pure + deterministic
 * (no AI): every line embeds a real count. Returns `[]` for an empty/absent database (the strip hides).
 *
 * @example buildDataInsights({ tables:[{name:'u',rows:12}], counts:{table:1,view:0,index:2,trigger:0}, totalRows:12, capped:false })
 *   // → ['1 table · 12 rows total', 'Largest: u (12 rows)', '2 indexes']
 */
export function buildDataInsights(d: D1InsightsInput | null | undefined): string[] {
  if (!d || d.counts.table === 0) {
    return [];
  }

  const out: string[] = [];
  const n = (v: number): string => v.toLocaleString();
  const nTables = d.counts.table;

  out.push(
    `${nTables} ${nTables === 1 ? 'table' : 'tables'} · ${n(d.totalRows)} ${d.totalRows === 1 ? 'row' : 'rows'} total${d.capped ? ' (first 40 tables)' : ''}`,
  );

  if (d.tables.length > 0) {
    const largest = d.tables.reduce((a, b) => (b.rows > a.rows ? b : a), d.tables[0]);

    if (largest.rows > 0) {
      out.push(`Largest: ${largest.name} (${n(largest.rows)} ${largest.rows === 1 ? 'row' : 'rows'})`);
    }
  }

  const empty = d.tables.filter((t) => t.rows === 0);

  if (empty.length === 1) {
    out.push(`1 empty table (${empty[0].name})`);
  } else if (empty.length > 1) {
    out.push(`${empty.length} empty tables`);
  }

  const struct: string[] = [];

  if (d.counts.view > 0) {
    struct.push(`${d.counts.view} ${d.counts.view === 1 ? 'view' : 'views'}`);
  }

  if (d.counts.index > 0) {
    struct.push(`${d.counts.index} ${d.counts.index === 1 ? 'index' : 'indexes'}`);
  }

  if (d.counts.trigger > 0) {
    struct.push(`${d.counts.trigger} ${d.counts.trigger === 1 ? 'trigger' : 'triggers'}`);
  }

  if (struct.length > 0) {
    out.push(struct.join(' · '));
  }

  return out.slice(0, 5);
}
