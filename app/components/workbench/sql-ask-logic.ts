/**
 * @file Pure logic for the SQL navigator's "Ask" (AI SQL assistant) mode.
 *
 * @remarks
 * Recycled from the (retired) `DataPanel` AskPanel's grounded NL→answer idea, RE-SHAPED for the per-site
 * SQL navigator: the assistant grounds the model STRICTLY on the site's OWN D1 schema (tables + columns,
 * gathered over the per-site bridge), asks the platform AI (`/api/llmcall` → ProjectSites AI when
 * `PS_BOLT_AI=true`) for a single SQLite statement, and drops the generated SQL into the editor for the
 * user to REVIEW and run through the SAME per-site exec path (`PS_RES_MUTATE { kind:'d1', action:'exec' }`)
 * — never auto-run, always confirm-gated for writes by the runner.
 *
 * These helpers are PURE (no React, no bridge) so they unit-test in isolation: prompt construction, schema
 * formatting, and robust SQL extraction from a model reply (which may wrap SQL in prose or a ```sql fence).
 */

/** One column of a per-site table, as `PRAGMA table_info` reports it (via `PS_SITEDB_ROWS_RESPONSE`). */
export interface AskColumn {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

/** One table's schema for grounding the model. */
export interface AskTableSchema {
  name: string;
  columns: AskColumn[];
}

/**
 * Format the site's OWN schema as a compact `CREATE TABLE`-ish outline the model can ground on. Only real
 * tables + columns are listed, so the model can never invent an identifier that doesn't exist. A table
 * whose columns couldn't be read is still listed by name (better than omitting it).
 */
export function formatSchemaForPrompt(tables: readonly AskTableSchema[]): string {
  if (tables.length === 0) {
    return '(the database has no tables yet)';
  }

  return tables
    .map((t) => {
      if (!t.columns || t.columns.length === 0) {
        return `TABLE ${t.name} ( … columns unknown … )`;
      }

      const cols = t.columns
        .map((c) => {
          const flags = [c.pk ? 'PRIMARY KEY' : '', c.notnull ? 'NOT NULL' : ''].filter(Boolean).join(' ');

          return `  ${c.name} ${c.type || 'TEXT'}${flags ? ' ' + flags : ''}`;
        })
        .join(',\n');

      return `TABLE ${t.name} (\n${cols}\n)`;
    })
    .join('\n\n');
}

/**
 * Build the system prompt that grounds the model on the site's OWN schema and constrains it to emit a
 * single, safe SQLite statement. The model is told the exact dialect (SQLite/D1), given the real schema,
 * and instructed to return ONLY SQL (no prose) so {@link extractSqlFromModel} can drop it straight into the
 * editor. Writes are allowed (the user reviews + the runner confirm-gates them), but the model is told to
 * prefer a single statement and never to touch unknown tables/columns.
 */
export function buildAskSystemPrompt(schemaOutline: string): string {
  return [
    "You are a careful SQLite assistant embedded in a website builder's database console.",
    "The user asks a question in plain English about THEIR OWN site database; you translate it into ONE SQLite statement that runs against Cloudflare D1 (SQLite dialect).",
    '',
    "RULES:",
    '- Use ONLY the tables and columns in the schema below. Never invent a table or column that is not listed.',
    '- Return ONLY the SQL statement — no explanation, no markdown, no comments, no trailing prose.',
    '- Prefer a single statement. For a read, prefer SELECT with a sensible LIMIT (e.g. LIMIT 100) unless the user asks for an aggregate or a specific count.',
    '- Writes (INSERT/UPDATE/DELETE/CREATE/ALTER/DROP) are allowed when the user clearly asks for one; the user will review the SQL and confirm before it runs.',
    '- If the question cannot be answered from the schema, return: SELECT \'Cannot answer from the current schema\' AS note;',
    '',
    'SCHEMA (the site\'s OWN database — these are the only tables/columns that exist):',
    schemaOutline,
  ].join('\n');
}

/**
 * Extract a runnable SQL statement from a model reply. Handles the common shapes: a ```sql fenced block, a
 * generic ``` fenced block, or a bare statement possibly wrapped in prose. Returns the trimmed SQL (without
 * fences), or an empty string when nothing SQL-like is found.
 */
export function extractSqlFromModel(raw: string): string {
  if (!raw) {
    return '';
  }

  const text = raw.trim();

  // 1. Prefer an explicit ```sql fenced block.
  const sqlFence = /```sql\s*([\s\S]*?)```/i.exec(text);

  if (sqlFence && sqlFence[1].trim()) {
    return sqlFence[1].trim();
  }

  // 2. Any generic ``` fenced block.
  const anyFence = /```\s*([\s\S]*?)```/.exec(text);

  if (anyFence && anyFence[1].trim()) {
    return anyFence[1].trim();
  }

  /*
   * 3. No fence — find a SQL statement at a STATEMENT position: the start of the text, the start of a line,
   * or right after a label colon (e.g. "the query is: SELECT …"). This deliberately does NOT match a bare
   * keyword surrounded by prose (so "help with that" never matches WITH — the #1 false positive). The
   * leading group captures the allowed prefix (start / newline+ws / colon+ws) so we can slice from the
   * keyword itself.
   */
  const KEYWORDS = 'SELECT|WITH|INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|PRAGMA|EXPLAIN';
  const stmt = new RegExp(`(^\\s*|\\n\\s*|:\\s+)(${KEYWORDS})\\b`, 'i').exec(text);

  if (stmt && typeof stmt.index === 'number') {
    // Slice from the keyword itself (skip the matched leading prefix — start / newline / colon).
    const kwOffset = stmt.index + stmt[1].length;
    return text.slice(kwOffset).replace(/^\s+/, '').trim();
  }

  // 4. Nothing SQL-like at a statement position — return the trimmed text so the caller surfaces an honest
  // "couldn't parse" (the runner would reject it anyway; we never fabricate SQL).
  return text;
}
