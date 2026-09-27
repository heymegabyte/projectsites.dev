/**
 * Unit tests for the SQL navigator's "Ask" (AI SQL assistant) pure logic.
 *
 * These cover the three pure helpers that ground the model on the site's OWN schema and robustly extract a
 * runnable statement from the model reply — the logic that lets the recycled Ask feature run generated SQL
 * through the per-site exec path safely.
 */
import { describe, expect, it } from 'vitest';

import {
  buildAskSystemPrompt,
  extractSqlFromModel,
  formatSchemaForPrompt,
  type AskTableSchema,
} from './sql-ask-logic';

describe('formatSchemaForPrompt', () => {
  it('reports an empty database honestly (so the model never invents tables)', () => {
    expect(formatSchemaForPrompt([])).toBe('(the database has no tables yet)');
  });

  it('renders each table as a CREATE-TABLE-ish outline with column flags', () => {
    const tables: AskTableSchema[] = [
      {
        name: 'orders',
        columns: [
          { name: 'id', type: 'INTEGER', notnull: 1, pk: 1 },
          { name: 'total', type: 'REAL', notnull: 0, pk: 0 },
        ],
      },
    ];

    const out = formatSchemaForPrompt(tables);
    expect(out).toContain('TABLE orders (');
    expect(out).toContain('id INTEGER PRIMARY KEY NOT NULL');
    expect(out).toContain('total REAL');
  });

  it('lists a table by name when its columns could not be read (better than omitting it)', () => {
    const tables: AskTableSchema[] = [{ name: 'mystery', columns: [] }];
    expect(formatSchemaForPrompt(tables)).toContain('TABLE mystery ( … columns unknown … )');
  });

  it('defaults a blank column type to TEXT', () => {
    const tables: AskTableSchema[] = [{ name: 't', columns: [{ name: 'c', type: '', notnull: 0, pk: 0 }] }];
    expect(formatSchemaForPrompt(tables)).toContain('c TEXT');
  });
});

describe('buildAskSystemPrompt', () => {
  it('embeds the schema outline and constrains the model to SQL-only over real identifiers', () => {
    const prompt = buildAskSystemPrompt('TABLE orders ( id INTEGER )');
    expect(prompt).toContain('SQLite');
    expect(prompt).toContain('Return ONLY the SQL statement');
    expect(prompt).toContain('Never invent a table or column');
    expect(prompt).toContain('TABLE orders ( id INTEGER )');
  });
});

describe('extractSqlFromModel', () => {
  it('prefers an explicit ```sql fenced block', () => {
    const raw = 'Here you go:\n```sql\nSELECT * FROM orders LIMIT 10;\n```\nHope that helps!';
    expect(extractSqlFromModel(raw)).toBe('SELECT * FROM orders LIMIT 10;');
  });

  it('handles a generic ``` fenced block', () => {
    const raw = '```\nSELECT count(*) FROM users;\n```';
    expect(extractSqlFromModel(raw)).toBe('SELECT count(*) FROM users;');
  });

  it('strips leading prose and takes from the first SQL keyword', () => {
    const raw = 'Sure — the query is: SELECT name FROM products WHERE price > 10;';
    expect(extractSqlFromModel(raw)).toBe('SELECT name FROM products WHERE price > 10;');
  });

  it('extracts write statements too (the runner confirm-gates them)', () => {
    const raw = 'UPDATE orders SET status = \'shipped\' WHERE id = 5;';
    expect(extractSqlFromModel(raw)).toBe("UPDATE orders SET status = 'shipped' WHERE id = 5;");
  });

  it('returns empty string for empty input', () => {
    expect(extractSqlFromModel('')).toBe('');
  });

  it('returns the trimmed text when nothing SQL-like is present (caller surfaces an honest error)', () => {
    expect(extractSqlFromModel('I cannot help with that.')).toBe('I cannot help with that.');
  });
});
