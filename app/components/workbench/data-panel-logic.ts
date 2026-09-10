/**
 * @file Pure logic for the workbench Data tab. No React / no DOM — everything
 * here is unit-tested by `data-panel-logic.spec.ts`. The panel itself
 * (`DataPanel.tsx`) is a thin view over these helpers + the PS_ admin bridge.
 */
import type { DataOverviewTable } from '~/lib/embed/embedded-mode';

/** Phosphor icon per known table key; a sensible default for anything new. */
const TABLE_ICONS: Record<string, string> = {
  visitor_events: 'i-ph:chart-line-duotone',
  form_submissions: 'i-ph:envelope-duotone',
  site_snapshots: 'i-ph:camera-duotone',
  mcp_connections: 'i-ph:plugs-connected-duotone',
  site_data: 'i-ph:database-duotone',
};

/**
 * Icon class for a table key.
 *
 * @param key - the table key (e.g. `visitor_events`)
 * @returns a UnoCSS phosphor icon class
 * @example iconForTable('form_submissions') // 'i-ph:envelope-duotone'
 */
export function iconForTable(key: string): string {
  return TABLE_ICONS[key] ?? 'i-ph:table-duotone';
}

/**
 * Format a raw cell value for display. Null/undefined → em-dash, objects →
 * compact JSON, everything else → its string form. Never throws.
 *
 * @param value - the raw value from a browse row
 * @returns a display-safe string
 * @example formatCellValue(null) // '—' ; formatCellValue({a:1}) // '{"a":1}'
 */
export function formatCellValue(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '—';
  }

  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  return String(value);
}

/**
 * Summarize the overview table list into headline counts.
 *
 * @param tables - the data-overview table list (may be undefined)
 * @returns `{ total, populated }` — total tables and how many have rows
 * @example summarizeTables([{row_count:0},{row_count:5}]) // { total: 2, populated: 1 }
 */
export function summarizeTables(tables: readonly DataOverviewTable[] | undefined | null): {
  total: number;
  populated: number;
} {
  const list = tables ?? [];
  return { total: list.length, populated: list.filter((t) => (t?.row_count ?? 0) > 0).length };
}

/**
 * Generate a correlation id for a PS_DATA_REQUEST round-trip. Uses Web Crypto
 * when available, else a timestamp+counter fallback (id uniqueness only needs to
 * hold within one panel session, not globally).
 *
 * @remarks Impure — reads `crypto`. `seed` makes the fallback deterministic in tests.
 * @param seed - optional deterministic suffix for the non-crypto fallback
 * @returns a unique-enough correlation id string
 * @example newCorrelationId('t1') // 'data-...-t1' when crypto is absent
 */
export function newCorrelationId(seed?: string): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;

  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }

  return `data-${seed ?? String(Date.now())}`;
}

/** Column header label: snake_case → Title Case. */
export function columnLabel(col: string): string {
  return col
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** CSV-escape one value: objects → JSON, null/undefined → empty, quote when needed. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  const s = typeof value === 'object' ? safeJson(value) : String(value);

  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Serialize browse rows to an RFC-4180-ish CSV string (header = column labels,
 * CRLF line breaks, embedded quotes doubled). Empty rows → header line only.
 *
 * @param columns - column keys in display order
 * @param rows - the browse rows
 * @returns a CSV string ready for a Blob download
 * @example toCsv(['form_name'], [{ form_name: 'Contact' }]) // 'Form Name\r\nContact'
 */
export function toCsv(columns: readonly string[], rows: readonly Record<string, unknown>[]): string {
  const head = columns.map((c) => csvCell(columnLabel(c))).join(',');
  const body = rows.map((r) => columns.map((c) => csvCell(r[c])).join(',')).join('\r\n');

  return body ? `${head}\r\n${body}` : head;
}

/**
 * Filter browse rows by a case-insensitive substring matched across ALL columns.
 * A blank query returns every row (a fresh copy). Pure — never mutates input.
 *
 * @param rows - the browse rows
 * @param columns - columns to search within
 * @param query - the search text (trimmed + lowercased internally)
 * @returns the matching subset
 * @example filterRows([{ email: 'A@x.com' }], ['email'], 'a@x') // [{ email: 'A@x.com' }]
 */
export function filterRows(
  rows: readonly Record<string, unknown>[],
  columns: readonly string[],
  query: string,
): Record<string, unknown>[] {
  const q = (query ?? '').trim().toLowerCase();

  if (!q) {
    return rows.slice();
  }

  return rows.filter((r) => columns.some((c) => formatCellValue(r[c]).toLowerCase().includes(q)));
}

/**
 * Ordered `[label, displayValue]` pairs for a single row's detail drill-down —
 * pretty (2-space) JSON for objects, `formatCellValue` for scalars.
 *
 * @param row - one browse row
 * @param columns - columns in display order
 * @returns label/value pairs for a definition-list detail view
 * @example detailEntries({ path: '/' }, ['path']) // [['Path', '/']]
 */
export function detailEntries(row: Record<string, unknown>, columns: readonly string[]): Array<[string, string]> {
  return columns.map((c) => {
    const v = row[c];
    const val =
      v !== null && v !== undefined && typeof v === 'object'
        ? (() => {
            try {
              return JSON.stringify(v, null, 2);
            } catch {
              return String(v);
            }
          })()
        : formatCellValue(v);

    return [columnLabel(c), val];
  });
}
