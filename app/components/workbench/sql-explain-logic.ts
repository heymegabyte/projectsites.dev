/**
 * @file "Explain this" — compose a plain-English AI-explanation prompt from a SQL query + its result
 * rows, and shape the bridge payload that hands it to the EXISTING editor AI chat.
 *
 * @remarks
 * Rev 7 of the editor Data Platform (docs/database-tab-enhancements.md item 8, "AI explain this"): a
 * one-click, natural-language explanation of the query the user just ran AND what its rows mean. This
 * slice adds NO new AI endpoint and calls NO model directly — it REUSES the editor's own AI chat by
 * posting a {@link SubmitPromptMessage} (`PS_SUBMIT_PROMPT`) to the parent admin, which round-trips it
 * straight back into `Chat.client.tsx`'s `append({ role:'user', ... })` (the same bridge the parent uses
 * to auto-submit a generation prompt). The SqlNavigator lives in the SAME editor iframe as the chat, so
 * the message flows child → parent → child and lands in the existing conversation — no direct AI call.
 *
 * These helpers are PURE (no React, no bridge, no fetch) so they unit-test in isolation: prompt text
 * construction (query + a compact JSON sample of the first N rows) and the disabled-with-reason gate
 * (never a dead control — you can only explain a query that has actually run). The component
 * ({@link module:app/components/workbench/SqlNavigator}) owns only the button + the `postToParent` call.
 */

/** How many result rows to sample into the prompt — enough to be illustrative, small enough to stay cheap. */
export const EXPLAIN_SAMPLE_ROWS = 5;

/** The result shape Explain reads — a subset of the SQL console's own `SqlExecData` (query + its rows). */
export interface ExplainInput {
  /** The SQL statement that was run (verbatim, as typed). */
  sql: string;

  /** The rows the statement returned (may be empty for a write / no-match read). */
  rows?: Record<string, unknown>[];
}

/**
 * Compact-JSON-serialize up to {@link EXPLAIN_SAMPLE_ROWS} rows for embedding in the prompt. Values that
 * can't serialize (bigint, circular, functions) degrade to `String(value)` per key so a single odd cell
 * never throws — the explanation is best-effort context, never a hard dependency. Returns `''` when there
 * are no rows (a write, or a read that matched nothing) so the prompt cleanly omits the "Sample rows"
 * block instead of showing an empty array.
 */
export function sampleRowsJson(rows: readonly Record<string, unknown>[] | undefined, limit = EXPLAIN_SAMPLE_ROWS): string {
  const list = Array.isArray(rows) ? rows.slice(0, Math.max(0, limit)) : [];

  if (list.length === 0) {
    return '';
  }

  const safe = list.map((row) => {
    const out: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(row ?? {})) {
      try {
        JSON.stringify(value);
        out[key] = value;
      } catch {
        out[key] = String(value);
      }
    }

    return out;
  });

  try {
    return JSON.stringify(safe, null, 2);
  } catch {
    return '';
  }
}

/**
 * Compose the natural-language prompt sent to the editor AI chat. Asks for a plain-English explanation of
 * BOTH the query and what its results mean; embeds the SQL and (when present) a compact sample of the
 * returned rows so the model grounds its answer on the ACTUAL data, not a guess. Returns `''` when there's
 * no SQL to explain (the caller gates on this — {@link canExplain}).
 *
 * @example
 * composeExplainPrompt({ sql: 'SELECT id FROM t', rows: [{ id: 1 }] })
 * // "Explain this SQL query and what its results mean, in plain English:\n\nSELECT id FROM t\n\nSample rows:\n[\n  {\n    \"id\": 1\n  }\n]"
 */
export function composeExplainPrompt(input: ExplainInput): string {
  const sql = (input?.sql ?? '').trim();

  if (!sql) {
    return '';
  }

  const sample = sampleRowsJson(input.rows);
  const head = 'Explain this SQL query and what its results mean, in plain English:';
  const query = `${head}\n\n${sql}`;

  return sample ? `${query}\n\nSample rows:\n${sample}` : query;
}

/** True when there is a query to explain — the ONLY precondition. Drives the disabled-with-reason gate. */
export function canExplain(input: Pick<ExplainInput, 'sql'>): boolean {
  return (input?.sql ?? '').trim().length > 0;
}

/**
 * The reason Explain is disabled, or `null` when it's enabled — surfaced as the button's `title`/tooltip
 * so the control is never a silent dead end (per embarrassingly-easy-to-use: a doomed control states the
 * reason). Only one precondition: something must have run.
 */
export function explainDisabledReason(input: Pick<ExplainInput, 'sql'>): string | null {
  return canExplain(input) ? null : 'Run a query first, then explain it';
}

/** The `PS_SUBMIT_PROMPT` payload minus the transport-owned `correlationId` (the caller mints that). */
export interface ExplainDispatch {
  type: 'PS_SUBMIT_PROMPT';
  prompt: string;
  siteId: string;
  slug: string;
}

/**
 * Build the bridge payload that hands the composed prompt to the EXISTING editor AI chat. The caller adds
 * a `correlationId` and posts it via `postToParent` — the parent admin relays it back into the chat's
 * `PS_SUBMIT_PROMPT` handler (`append({ role:'user', ... })`). `siteId`/`slug` default to `''` (the chat's
 * handler tolerates an absent slug — it only reads `prompt`); pass them through when known. Returns `null`
 * when there's nothing to explain, so the caller no-ops instead of posting an empty prompt.
 */
export function buildExplainDispatch(input: ExplainInput, siteId = '', slug = ''): ExplainDispatch | null {
  const prompt = composeExplainPrompt(input);

  if (!prompt) {
    return null;
  }

  return { type: 'PS_SUBMIT_PROMPT', prompt, siteId, slug };
}
