/**
 * sql-explain-logic.spec.ts
 *
 * Unit tests for the PURE "Explain this" logic (Rev 7 of the editor Data Platform — AI explanation of a
 * SQL query + its results, REUSING the existing editor AI chat via `PS_SUBMIT_PROMPT`, NO new endpoint).
 *
 * The component posts the {@link buildExplainDispatch} payload to the parent via `postToParent`; the parent
 * relays it back into `Chat.client.tsx`'s `PS_SUBMIT_PROMPT` handler. These tests pin the prompt text and
 * the dispatch shape so the chat contract can't drift.
 */
import { describe, expect, it } from 'vitest';
import {
  EXPLAIN_SAMPLE_ROWS,
  buildExplainDispatch,
  canExplain,
  composeExplainPrompt,
  explainDisabledReason,
  sampleRowsJson,
} from '../sql-explain-logic';

describe('sql-explain-logic — compose + gate + dispatch', () => {
  it('composes a plain-English prompt from the query AND a JSON sample of the rows', () => {
    const prompt = composeExplainPrompt({
      sql: 'SELECT id, name FROM users LIMIT 2;',
      rows: [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ],
    });

    expect(prompt).toContain('Explain this SQL query and what its results mean, in plain English:');
    expect(prompt).toContain('SELECT id, name FROM users LIMIT 2;');
    expect(prompt).toContain('Sample rows:');

    // The rows are embedded as compact JSON the model can read.
    expect(prompt).toContain('"name": "Alice"');
    expect(prompt).toContain('"id": 2');
  });

  it('samples at most EXPLAIN_SAMPLE_ROWS rows into the prompt', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ id: i }));
    const json = sampleRowsJson(rows);
    const parsed = JSON.parse(json) as unknown[];

    expect(parsed).toHaveLength(EXPLAIN_SAMPLE_ROWS);
    expect(EXPLAIN_SAMPLE_ROWS).toBe(5);
  });

  it('omits the "Sample rows" block for a write / no-match read (no rows)', () => {
    const write = composeExplainPrompt({ sql: 'INSERT INTO t VALUES (1);', rows: [] });

    expect(write).toContain('INSERT INTO t VALUES (1);');
    expect(write).not.toContain('Sample rows:');
    expect(sampleRowsJson([])).toBe('');
    expect(sampleRowsJson(undefined)).toBe('');
  });

  it('degrades an unserializable cell to a string instead of throwing', () => {
    const json = sampleRowsJson([{ big: 10n as unknown as number, ok: 'x' }]);
    const parsed = JSON.parse(json) as Record<string, unknown>[];

    expect(parsed[0].ok).toBe('x');
    expect(parsed[0].big).toBe('10'); // String(10n)
  });

  it('gates on "a query has run": canExplain + disabled reason', () => {
    expect(canExplain({ sql: 'SELECT 1' })).toBe(true);
    expect(canExplain({ sql: '   ' })).toBe(false);

    expect(explainDisabledReason({ sql: 'SELECT 1' })).toBeNull();
    expect(explainDisabledReason({ sql: '' })).toBe('Run a query first, then explain it');
  });

  it('builds the PS_SUBMIT_PROMPT dispatch that reuses the existing chat', () => {
    const dispatch = buildExplainDispatch({ sql: 'SELECT * FROM orders', rows: [{ total: 42 }] }, 'site_123', 'acme');

    expect(dispatch).not.toBeNull();
    expect(dispatch!.type).toBe('PS_SUBMIT_PROMPT'); // the EXISTING chat auto-submit message — no new endpoint
    expect(dispatch!.siteId).toBe('site_123');
    expect(dispatch!.slug).toBe('acme');
    expect(dispatch!.prompt).toContain('SELECT * FROM orders');
    expect(dispatch!.prompt).toContain('"total": 42');
  });

  it('returns null dispatch when there is nothing to explain (never posts an empty prompt)', () => {
    expect(buildExplainDispatch({ sql: '', rows: [] })).toBeNull();
    expect(composeExplainPrompt({ sql: '   ' })).toBe('');
  });
});
