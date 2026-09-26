/**
 * Grounded "Ask your data" EVAL harness — the AI mandate's "compare EXECUTED answers vs expected, not
 * plausible-looking SQL." Each golden fixture is a { question, intent } pair (the intent is what a good
 * model SHOULD propose) run through the REAL deterministic pipeline: parseProposedIntent →
 * compileQueryIntent → EXECUTE against a real SQLite (node:sqlite via the d1_sqlite facade) seeded with a
 * two-tenant fixture → assert the COMPUTED rows. This proves the compiler + execution together (grouping,
 * filters, NULLs, dates, ordering), tenant ISOLATION (site_id scope), and the security refusals
 * (masked-PII select, injection-shaped values bound not executed) end-to-end — a canned-row mock can't.
 *
 * Deterministic + CI-safe: the model call is NOT made here (recorded golden intents). The live model
 * (question → intent) is exercised separately via ask.test.ts's mocked binding; a live-model quality run
 * is opt-in/out-of-loop. Bump PROMPT_VERSION when the ask prompt/intent contract changes so a regression
 * is attributable.
 *
 * Requires NODE_OPTIONS=--experimental-sqlite (the worker jest config sets it).
 */
import { createD1Sqlite } from '../../../../src/__tests__/helpers/d1_sqlite.js';
import {
  overviewTable,
  compileQueryIntent,
  parseProposedIntent,
  type QueryIntent,
} from '../handlers.js';

/** Bump when the ask prompt / intent contract changes, so an eval regression is attributable. */
const PROMPT_VERSION = 'ask-v1';
const SITE = 'site-A';
const OTHER = 'site-B'; // a DIFFERENT tenant — every result must exclude these rows

const spec = overviewTable('form_submissions')!; // cols: form_name/status/notes/email/created_at; email masked
const specForCompile = { columns: spec.columns, countSql: spec.countSql, maskedColumns: ['email'] };

/** Seed a real-SQLite form_submissions table with a two-tenant fixture; returns the harness (close it). */
function seedFixture() {
  const h = createD1Sqlite();
  h.exec(
    `CREATE TABLE form_submissions (
       id INTEGER PRIMARY KEY, site_id TEXT, form_name TEXT, status TEXT, notes TEXT, email TEXT, created_at TEXT
     );`,
  );
  const rows: Array<[string, string, string, string | null, string, string]> = [
    // site-A (the tenant under test)
    [SITE, 'contact', 'open', 'first', 'a@x.co', '2026-01-01'],
    [SITE, 'contact', 'open', null, 'b@x.co', '2026-01-02'],
    [SITE, 'quote', 'closed', 'third', 'c@x.co', '2026-01-03'],
    // site-B (a different tenant — MUST never appear in site-A's answers)
    [OTHER, 'contact', 'open', 'zzz', 'z@x.co', '2026-02-01'],
    [OTHER, 'contact', 'spam', 'junk', 's@x.co', '2026-02-02'],
  ];
  for (const [site_id, form_name, status, notes, email, created_at] of rows) {
    h.raw
      .prepare('INSERT INTO form_submissions (site_id, form_name, status, notes, email, created_at) VALUES (?,?,?,?,?,?)')
      .run(site_id, form_name, status, notes, email, created_at);
  }
  return h;
}

/** Compile + EXECUTE an intent for SITE against the seeded fixture; returns the computed rows. */
async function run(h: ReturnType<typeof seedFixture>, intent: QueryIntent): Promise<Record<string, unknown>[]> {
  const parsed = parseProposedIntent(intent);
  if (!parsed) throw new Error('intent did not parse');

  const compiled = compileQueryIntent(parsed, specForCompile);
  if (!compiled.ok) throw new Error(`intent rejected: ${compiled.error}`);

  const res = await h.db.prepare(compiled.sql).bind(SITE, ...compiled.params).all();
  return (res.results ?? []) as Record<string, unknown>[];
}

describe(`Ask-your-data eval [${PROMPT_VERSION}] — executed answers vs expected`, () => {
  it('COUNT BY STATUS: grouped counts, ordered n DESC, this-tenant only (cross-tenant excluded)', async () => {
    const h = seedFixture();
    try {
      const rows = await run(h, { select: [{ agg: 'count' }], groupBy: 'status' });
      // site-A has open×2, closed×1 — site-B's open + spam must NOT appear.
      expect(rows).toEqual([
        { grp: 'open', n: 2 },
        { grp: 'closed', n: 1 },
      ]);
      expect(rows.some((r) => r.grp === 'spam')).toBe(false); // site-B-only status never leaks
    } finally {
      h.close();
    }
  });

  it('FILTER: only open submissions (whole-table, this tenant)', async () => {
    const h = seedFixture();
    try {
      const rows = await run(h, {
        select: [{ col: 'status' }, { col: 'created_at' }],
        filters: [{ col: 'status', op: 'eq', val: 'open' }],
      });
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.status === 'open')).toBe(true);
    } finally {
      h.close();
    }
  });

  it('NULLS: notes IS NULL matches only the genuinely-null row', async () => {
    const h = seedFixture();
    try {
      const rows = await run(h, { select: [{ col: 'created_at' }], filters: [{ col: 'notes', op: 'null' }] });
      expect(rows).toHaveLength(1);
      expect(rows[0].created_at).toBe('2026-01-02');
    } finally {
      h.close();
    }
  });

  it('DATES/ORDER: newest-first ordering is honored', async () => {
    const h = seedFixture();
    try {
      const rows = await run(h, { select: [{ col: 'created_at' }], orderBy: [{ col: 'created_at', dir: 'desc' }] });
      expect(rows.map((r) => r.created_at)).toEqual(['2026-01-03', '2026-01-02', '2026-01-01']);
    } finally {
      h.close();
    }
  });

  it('TENANT ISOLATION: a broad projection returns only this site\'s rows', async () => {
    const h = seedFixture();
    try {
      const rows = await run(h, { select: [{ col: 'form_name' }, { col: 'status' }] });
      expect(rows).toHaveLength(3); // site-A has 3; site-B's 2 are excluded by the site_id scope
      expect(rows.some((r) => r.status === 'spam')).toBe(false);
    } finally {
      h.close();
    }
  });

  it('PROMPT-INJECTION (masked PII): a proposal to select `email` is REJECTED — never executed', () => {
    // A model tricked into "show every email" proposes select email; the compiler refuses (no leak).
    const parsed = parseProposedIntent({ select: [{ col: 'email' }] });
    expect(parsed).not.toBeNull();
    expect(compileQueryIntent(parsed!, specForCompile).ok).toBe(false);
    // groupBy email is likewise refused.
    const g = parseProposedIntent({ select: [{ agg: 'count' }], groupBy: 'email' });
    expect(compileQueryIntent(g!, specForCompile).ok).toBe(false);
  });

  it('INJECTION-SHAPED VALUE: a hostile filter value is BOUND (0 rows) — the table survives intact', async () => {
    const h = seedFixture();
    try {
      const rows = await run(h, {
        select: [{ col: 'status' }],
        filters: [{ col: 'status', op: 'eq', val: "open'; DROP TABLE form_submissions;--" }],
      });
      expect(rows).toHaveLength(0); // no status literally equals the injection string
      // The table is untouched — the value was bound, not executed.
      const still = h.raw.prepare('SELECT COUNT(*) AS n FROM form_submissions').get() as { n: number };
      expect(still.n).toBe(5);
    } finally {
      h.close();
    }
  });
});
