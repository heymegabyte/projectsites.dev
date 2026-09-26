/**
 * @file Unit tests for the data-overview pure helpers + the per-table
 * safe-column security invariant. No D1 mocking — these guard the boundary that
 * keeps PII (form payloads/IP) and encrypted MCP tokens out of the browse rows.
 */
import {
  SITE_DATA_OVERVIEW_TABLES,
  overviewTable,
  clampBrowseLimit,
  maskEmailValue,
  buildDataSearch,
  buildColumnFilter,
  buildColumnFilters,
  parseFilterConditions,
  MAX_FILTER_CONDITIONS,
  composeBrowseFilter,
  MAX_EXPORT_ROWS,
  validateViewName,
  normalizeSortDir,
  serializeGridView,
  normalizeGridViewType,
  parseGridViewConfig,
  parseGridViewLayout,
  MAX_LAYOUT_ENTRIES,
  buildGroupCountSql,
  buildGroupAggregateSql,
  buildColumnAggregatesSql,
  normalizeGroupAgg,
  MAX_KANBAN_GROUPS,
  MAX_GRID_VIEWS_PER_TABLE,
  deletableTableName,
  DELETABLE_OVERVIEW_TABLES,
  editableTableName,
  editableColumn,
  validateEditableValue,
  EDITABLE_OVERVIEW_COLUMNS,
} from '../handlers';

describe('data-overview registry', () => {
  it('exposes the five real site-scoped tables', () => {
    expect(SITE_DATA_OVERVIEW_TABLES.map((t) => t.key)).toEqual([
      'visitor_events',
      'form_submissions',
      'site_snapshots',
      'mcp_connections',
      'site_data',
    ]);
  });

  it('NEVER selects PII or token columns in any browse query (security boundary)', () => {
    const FORBIDDEN = [
      'payload',
      'ip_address',
      'user_agent',
      'access_token_encrypted',
      'refresh_token_encrypted',
      'reply_body',
    ];
    for (const t of SITE_DATA_OVERVIEW_TABLES) {
      for (const bad of FORBIDDEN) {
        expect(t.browseSql.includes(bad)).toBe(false);
      }
    }
  });

  it('every browse query is read-only (SELECT), site-scoped, and limited', () => {
    for (const t of SITE_DATA_OVERVIEW_TABLES) {
      expect(t.browseSql.trim().startsWith('SELECT')).toBe(true);
      expect(t.browseSql).toContain('WHERE site_id = ?');
      expect(t.browseSql).toContain('LIMIT ?');
      expect(t.countSql).toContain('WHERE site_id = ?');
    }
  });

  it('every last-activity query is a site-scoped MAX(ts), matching the browse soft-delete filter', () => {
    for (const t of SITE_DATA_OVERVIEW_TABLES) {
      expect(t.lastActivitySql.trim().startsWith('SELECT MAX(')).toBe(true);
      expect(t.lastActivitySql).toContain('AS ts');
      expect(t.lastActivitySql).toContain('WHERE site_id = ?');
      // A table whose browse hides soft-deleted rows must exclude them from freshness too.
      expect(t.lastActivitySql.includes('deleted_at IS NULL')).toBe(
        t.browseSql.includes('deleted_at IS NULL'),
      );
    }
  });

  it('flags form_submissions for email masking', () => {
    expect(overviewTable('form_submissions')?.maskEmail).toBe(true);
    // Tables without PII do not carry the mask flag.
    expect(overviewTable('visitor_events')?.maskEmail).toBeUndefined();
  });

  it('only form_submissions is deletable, and its browse selects the stable `id` delete key', () => {
    // Exactly ONE table is owner-deletable (a tenant-owned lead row).
    expect(overviewTable('form_submissions')?.deletable).toBe(true);
    for (const key of ['visitor_events', 'site_snapshots', 'mcp_connections', 'site_data']) {
      expect(overviewTable(key)?.deletable).toBeFalsy();
    }
    // A deletable table MUST select `id` (the delete key); read-only ones need not.
    expect(overviewTable('form_submissions')?.browseSql).toContain('SELECT id,');
  });
});

describe('deletableTableName (owner-delete allowlist — the killswitch boundary)', () => {
  it('resolves ONLY form_submissions to a real table name', () => {
    expect(deletableTableName('form_submissions')).toBe('form_submissions');
  });
  it('returns undefined (read-only) for every other / unknown / hostile key', () => {
    for (const key of [
      'visitor_events',
      'site_snapshots',
      'mcp_connections',
      'site_data',
      'users',
      'sqlite_master',
      '',
      'form_submissions; DROP TABLE sites',
    ]) {
      expect(deletableTableName(key)).toBeUndefined();
    }
  });
  it('every allowlist value is a plain identifier (no interpolation risk)', () => {
    for (const real of Object.values(DELETABLE_OVERVIEW_TABLES)) {
      expect(real).toMatch(/^[a-z_][a-z0-9_]*$/);
    }
  });
});

describe('editable-column allowlist (owner edit boundary — the killswitch)', () => {
  it('resolves ONLY form_submissions as an editable table', () => {
    expect(editableTableName('form_submissions')).toBe('form_submissions');
    for (const key of [
      'visitor_events',
      'site_snapshots',
      'mcp_connections',
      'site_data',
      'users',
      '',
    ]) {
      expect(editableTableName(key)).toBeUndefined();
    }
  });

  it('exposes ONLY form_submissions.status (an enum) as editable; PII/structural columns are not', () => {
    expect(editableColumn('form_submissions', 'status')?.type).toBe('enum');
    // PII + structural + unknown columns are read-only (undefined → caller 400s).
    for (const col of [
      'email',
      'payload',
      'id',
      'site_id',
      'form_name',
      'created_at',
      'DROP TABLE sites',
    ]) {
      expect(editableColumn('form_submissions', col)).toBeUndefined();
    }
    // Non-editable table → every column undefined.
    expect(editableColumn('visitor_events', 'status')).toBeUndefined();
  });

  it('the status enum mirrors the D1 CHECK constraint exactly', () => {
    expect(editableColumn('form_submissions', 'status')?.options).toEqual([
      'received',
      'forwarded',
      'partial',
      'failed',
    ]);
  });

  it('every editable column name + table key is a plain identifier (no interpolation risk)', () => {
    for (const [table, cols] of Object.entries(EDITABLE_OVERVIEW_COLUMNS)) {
      expect(table).toMatch(/^[a-z_][a-z0-9_]*$/);
      for (const col of Object.keys(cols)) expect(col).toMatch(/^[a-z_][a-z0-9_]*$/);
    }
  });
});

describe('validateEditableValue (enum bound — the value gate)', () => {
  const status = editableColumn('form_submissions', 'status')!;

  it('accepts an in-enum value and returns the string to bind', () => {
    expect(validateEditableValue(status, 'forwarded')).toEqual({ ok: true, value: 'forwarded' });
  });

  it('REJECTS an out-of-enum value (never written)', () => {
    const r = validateEditableValue(status, 'deleted');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('one of');
  });

  it('REJECTS injection-shaped + empty + non-string values', () => {
    for (const bad of ["received' OR '1'='1", '', null, undefined, 42, {}]) {
      expect(validateEditableValue(status, bad).ok).toBe(false);
    }
  });
});

describe('overviewTable', () => {
  it('resolves a known key', () => {
    expect(overviewTable('visitor_events')?.label).toBe('Visitor Events');
  });
  it('returns undefined for an unknown key (allowlist reject)', () => {
    expect(overviewTable('users')).toBeUndefined();
    expect(overviewTable('sqlite_master')).toBeUndefined();
    expect(overviewTable('')).toBeUndefined();
  });
});

describe('clampBrowseLimit', () => {
  it('defaults to 25 for missing/invalid input', () => {
    expect(clampBrowseLimit(undefined)).toBe(25);
    expect(clampBrowseLimit(null)).toBe(25);
    expect(clampBrowseLimit('abc')).toBe(25);
    expect(clampBrowseLimit('0')).toBe(25);
    expect(clampBrowseLimit('-5')).toBe(25);
  });
  it('passes through valid values and caps at 100', () => {
    expect(clampBrowseLimit('10')).toBe(10);
    expect(clampBrowseLimit('100')).toBe(100);
    expect(clampBrowseLimit('9999')).toBe(100);
  });
});

describe('maskEmailValue', () => {
  it('masks the local part of a normal address', () => {
    expect(maskEmailValue('brian@megabyte.space')).toBe('b***@megabyte.space');
  });
  it('fully masks a one-char local part', () => {
    expect(maskEmailValue('a@x.com')).toBe('*@x.com');
  });
  it('returns empty string for non-email / non-string input (never leaks raw)', () => {
    expect(maskEmailValue('notanemail')).toBe('');
    expect(maskEmailValue(null)).toBe('');
    expect(maskEmailValue(123)).toBe('');
    expect(maskEmailValue('@nolocal.com')).toBe('');
  });
});

describe('buildDataSearch (browse text filter)', () => {
  const cols = ['event_type', 'path', 'referrer', 'created_at'];

  it('returns an empty clause for absent/blank search (no filter)', () => {
    expect(buildDataSearch(cols, undefined)).toEqual({ clause: '', params: [] });
    expect(buildDataSearch(cols, null)).toEqual({ clause: '', params: [] });
    expect(buildDataSearch(cols, '   ')).toEqual({ clause: '', params: [] });
  });

  it('builds a parameterized OR-LIKE over the non-timestamp safe columns (excludes *_at)', () => {
    const { clause, params } = buildDataSearch(cols, 'hello');
    expect(clause).toBe(' AND ("event_type" LIKE ? OR "path" LIKE ? OR "referrer" LIKE ?)');
    expect(clause).not.toContain('created_at'); // timestamp column excluded
    expect(params).toEqual(['%hello%', '%hello%', '%hello%']); // one bound param per column
  });

  it('STRIPS LIKE wildcards from user input so % / _ can never act as metacharacters', () => {
    const { params } = buildDataSearch(['path'], 'a%b_c');
    expect(params).toEqual(['%abc%']); // % and _ removed, not escaped
  });

  it('bounds the search to 100 chars (query-cost guard)', () => {
    const { params } = buildDataSearch(['path'], 'x'.repeat(200));
    expect(params[0]).toBe(`%${'x'.repeat(100)}%`);
  });
});

describe('buildColumnFilter (browse per-column exact-match filter)', () => {
  const cols = ['event_type', 'status', 'path', 'created_at'];

  it('builds a parameterized single-column `= ?` for an allowlisted column', () => {
    expect(buildColumnFilter(cols, 'status', 'new')).toEqual({
      clause: ' AND "status" = ?',
      params: ['new'],
    });
  });

  it('REJECTS a column outside the allowlist (the injection boundary) — no clause', () => {
    expect(buildColumnFilter(cols, 'password', 'x')).toEqual({ clause: '', params: [] });
    expect(buildColumnFilter(cols, 'status; DROP TABLE sites', 'x')).toEqual({
      clause: '',
      params: [],
    });
    expect(buildColumnFilter(cols, '"status"', 'x')).toEqual({ clause: '', params: [] });
  });

  it('returns no clause for an absent column or value', () => {
    expect(buildColumnFilter(cols, undefined, 'new')).toEqual({ clause: '', params: [] });
    expect(buildColumnFilter(cols, 'status', undefined)).toEqual({ clause: '', params: [] });
    expect(buildColumnFilter(cols, 'status', '   ')).toEqual({ clause: '', params: [] });
  });

  it('parameterizes the value (never concatenated) and bounds it to 200 chars', () => {
    const inject = "new' OR '1'='1";
    expect(buildColumnFilter(cols, 'status', inject)).toEqual({
      clause: ' AND "status" = ?',
      params: [inject], // the value is a bound param — harmless, never interpolated
    });
    expect(buildColumnFilter(cols, 'status', 'y'.repeat(500)).params[0]).toBe('y'.repeat(200));
  });

  it('maps each comparison operator to a fixed, parameterized clause (operators are never user text)', () => {
    expect(buildColumnFilter(cols, 'status', 'new', 'eq')).toEqual({
      clause: ' AND "status" = ?',
      params: ['new'],
    });
    expect(buildColumnFilter(cols, 'status', 'new', 'ne')).toEqual({
      clause: ' AND "status" != ?',
      params: ['new'],
    });
    expect(buildColumnFilter(cols, 'status', '5', 'gt')).toEqual({
      clause: ' AND "status" > ?',
      params: ['5'],
    });
    expect(buildColumnFilter(cols, 'status', '5', 'lt')).toEqual({
      clause: ' AND "status" < ?',
      params: ['5'],
    });
    expect(buildColumnFilter(cols, 'status', '5', 'gte')).toEqual({
      clause: ' AND "status" >= ?',
      params: ['5'],
    });
    expect(buildColumnFilter(cols, 'status', '5', 'lte')).toEqual({
      clause: ' AND "status" <= ?',
      params: ['5'],
    });
  });

  it('contains → LIKE %needle% with wildcards STRIPPED from user input (% / _ never metacharacters)', () => {
    expect(buildColumnFilter(cols, 'status', 'pen', 'contains')).toEqual({
      clause: ' AND "status" LIKE ?',
      params: ['%pen%'],
    });
    expect(buildColumnFilter(cols, 'status', 'a%b_c', 'contains').params).toEqual(['%abc%']);
    // a value that is ENTIRELY wildcards collapses to empty → no clause (never a bare LIKE %%)
    expect(buildColumnFilter(cols, 'status', '%_%', 'contains')).toEqual({
      clause: '',
      params: [],
    });
  });

  it('null / notnull are value-free IS [NOT] NULL clauses (no bound params, value ignored)', () => {
    expect(buildColumnFilter(cols, 'status', '', 'null')).toEqual({
      clause: ' AND "status" IS NULL',
      params: [],
    });
    expect(buildColumnFilter(cols, 'status', 'ignored', 'notnull')).toEqual({
      clause: ' AND "status" IS NOT NULL',
      params: [],
    });
  });

  it('defaults an absent / unknown / mixed-case operator to `eq` (backward-compatible, injection-safe)', () => {
    expect(buildColumnFilter(cols, 'status', 'new', undefined)).toEqual({
      clause: ' AND "status" = ?',
      params: ['new'],
    });
    expect(buildColumnFilter(cols, 'status', 'new', 'sqlgibberish')).toEqual({
      clause: ' AND "status" = ?',
      params: ['new'],
    });
    expect(buildColumnFilter(cols, 'status', 'new', 'EQ')).toEqual({
      clause: ' AND "status" = ?',
      params: ['new'],
    });
    expect(buildColumnFilter(cols, 'status', 'new', '; DROP TABLE sites')).toEqual({
      clause: ' AND "status" = ?',
      params: ['new'],
    });
  });

  it('still enforces the column allowlist for every operator (the injection boundary is the column)', () => {
    expect(buildColumnFilter(cols, 'password', '', 'notnull')).toEqual({ clause: '', params: [] });
    expect(buildColumnFilter(cols, 'password', 'x', 'contains')).toEqual({
      clause: '',
      params: [],
    });
  });

  it('a value-requiring operator with a blank value yields no clause (null/notnull are the only value-free ops)', () => {
    expect(buildColumnFilter(cols, 'status', '   ', 'gt')).toEqual({ clause: '', params: [] });
    expect(buildColumnFilter(cols, 'status', '', 'contains')).toEqual({ clause: '', params: [] });
  });
});

describe('buildColumnFilters (multi-condition AND/OR filter group)', () => {
  const cols = ['event_type', 'status', 'age', 'note', 'created_at'];

  it('joins multiple active conditions with AND, wrapped in parens, ANDed onto the base WHERE', () => {
    expect(
      buildColumnFilters(
        cols,
        [
          { col: 'status', op: 'eq', val: 'new' },
          { col: 'age', op: 'gte', val: '18' },
        ],
        'AND',
      ),
    ).toEqual({ clause: ' AND ("status" = ? AND "age" >= ?)', params: ['new', '18'] });
  });

  it('joins with OR when the combinator is OR (chosen by key, case-insensitive)', () => {
    expect(
      buildColumnFilters(
        cols,
        [
          { col: 'status', op: 'eq', val: 'new' },
          { col: 'note', op: 'null' },
        ],
        'or',
      ),
    ).toEqual({ clause: ' AND ("status" = ? OR "note" IS NULL)', params: ['new'] });
  });

  it('defaults an unknown/absent combinator to AND (never interpolates user text)', () => {
    const twoConds = [
      { col: 'status', op: 'eq', val: 'a' },
      { col: 'event_type', op: 'eq', val: 'b' },
    ];
    expect(buildColumnFilters(cols, twoConds, 'XOR); DROP TABLE x--').clause).toBe(
      ' AND ("status" = ? AND "event_type" = ?)',
    );
    expect(buildColumnFilters(cols, twoConds, undefined).clause).toBe(
      ' AND ("status" = ? AND "event_type" = ?)',
    );
  });

  it('a single active condition emits NO needless parens (identical to buildColumnFilter)', () => {
    expect(buildColumnFilters(cols, [{ col: 'status', op: 'eq', val: 'new' }], 'AND')).toEqual({
      clause: ' AND "status" = ?',
      params: ['new'],
    });
  });

  it('drops inactive conditions (bad column, value-op with no value) but keeps the active ones', () => {
    expect(
      buildColumnFilters(
        cols,
        [
          { col: 'password', op: 'eq', val: 'x' }, // not allowlisted → dropped
          { col: 'status', op: 'gt', val: '' }, // value-op, blank → dropped
          { col: 'age', op: 'lt', val: '65' }, // kept
        ],
        'AND',
      ),
    ).toEqual({ clause: ' AND "age" < ?', params: ['65'] });
  });

  it('an empty / all-inactive list yields no clause', () => {
    expect(buildColumnFilters(cols, [], 'AND')).toEqual({ clause: '', params: [] });
    expect(buildColumnFilters(cols, null, 'AND')).toEqual({ clause: '', params: [] });
    expect(buildColumnFilters(cols, [{ col: 'nope', op: 'eq', val: 'x' }], 'OR')).toEqual({
      clause: '',
      params: [],
    });
  });

  it('every leaf stays allowlist-gated + parameterized + wildcard-stripped (injection boundary holds per condition)', () => {
    const { clause, params } = buildColumnFilters(
      cols,
      [
        { col: 'note', op: 'contains', val: "a%_b' OR 1=1" },
        { col: 'status; DROP TABLE sites', op: 'eq', val: 'x' }, // hostile column → dropped
      ],
      'OR',
    );
    expect(clause).toBe(' AND "note" LIKE ?'); // hostile column gone; single survivor → no parens
    expect(params).toEqual(["%ab' OR 1=1%"]); // % and _ stripped; value bound, never interpolated
  });

  it('bounds the number of conditions to MAX_FILTER_CONDITIONS (query-cost guard)', () => {
    const many = Array.from({ length: MAX_FILTER_CONDITIONS + 10 }, () => ({
      col: 'status',
      op: 'eq' as const,
      val: 'x',
    }));
    const { params } = buildColumnFilters(cols, many, 'AND');
    expect(params.length).toBe(MAX_FILTER_CONDITIONS);
  });
});

describe('parseFilterConditions (?filters= JSON → shape-hardened conditions, never throws)', () => {
  it('parses a valid JSON array of {col,op,val}', () => {
    expect(
      parseFilterConditions(
        '[{"col":"status","op":"eq","val":"new"},{"col":"age","op":"gt","val":"18"}]',
      ),
    ).toEqual([
      { col: 'status', op: 'eq', val: 'new' },
      { col: 'age', op: 'gt', val: '18' },
    ]);
  });

  it('returns [] for absent / malformed / non-array JSON (fail-soft → no filter, never a throw)', () => {
    expect(parseFilterConditions(undefined)).toEqual([]);
    expect(parseFilterConditions('')).toEqual([]);
    expect(parseFilterConditions('{not json')).toEqual([]);
    expect(parseFilterConditions('{"col":"status"}')).toEqual([]); // object, not array
    expect(parseFilterConditions('"just a string"')).toEqual([]);
  });

  it('coerces missing/non-string fields to safe defaults (col/val → "", op → "eq")', () => {
    expect(parseFilterConditions('[{"col":"status"},{"op":"gt","val":5},{"foo":1}]')).toEqual([
      { col: 'status', val: '', op: 'eq' },
      { col: '', val: '', op: 'gt' }, // numeric val dropped to ''
      { col: '', val: '', op: 'eq' },
    ]);
  });

  it('drops non-object items and bounds to MAX_FILTER_CONDITIONS', () => {
    const arr = JSON.stringify([
      ...Array.from({ length: MAX_FILTER_CONDITIONS + 5 }, () => ({
        col: 'status',
        op: 'eq',
        val: 'x',
      })),
    ]);
    expect(parseFilterConditions(arr).length).toBe(MAX_FILTER_CONDITIONS);
    expect(parseFilterConditions('[1,"two",null,{"col":"status","op":"eq","val":"x"}]')).toEqual([
      { col: 'status', op: 'eq', val: 'x' },
    ]);
  });

  it('round-trips through buildColumnFilters to a safe parameterized clause', () => {
    const cols = ['status', 'age'];
    const conds = parseFilterConditions(
      '[{"col":"status","op":"eq","val":"new"},{"col":"age","op":"gte","val":"21"}]',
    );
    expect(buildColumnFilters(cols, conds, 'AND')).toEqual({
      clause: ' AND ("status" = ? AND "age" >= ?)',
      params: ['new', '21'],
    });
  });
});

describe('validateViewName (saved-view name boundary)', () => {
  it('trims + accepts a 1–80 char name', () => {
    expect(validateViewName('  Active leads ')).toBe('Active leads');
    expect(validateViewName('x')).toBe('x');
  });

  it('bounds to 80 chars', () => {
    expect(validateViewName('y'.repeat(200))).toBe('y'.repeat(80));
  });

  it('rejects blank / non-string → null', () => {
    expect(validateViewName('   ')).toBeNull();
    expect(validateViewName('')).toBeNull();
    expect(validateViewName(undefined)).toBeNull();
    expect(validateViewName(42)).toBeNull();
    expect(validateViewName(null)).toBeNull();
  });
});

describe('normalizeSortDir (saved-view sort direction)', () => {
  it('accepts asc/desc case-insensitively, else null', () => {
    expect(normalizeSortDir('asc')).toBe('asc');
    expect(normalizeSortDir('DESC')).toBe('desc');
    expect(normalizeSortDir(' Asc ')).toBe('asc');
    expect(normalizeSortDir('sideways')).toBeNull();
    expect(normalizeSortDir('')).toBeNull();
    expect(normalizeSortDir(undefined)).toBeNull();
  });
});

describe('serializeGridView (stored row → client view; hardens filters, hides bookkeeping)', () => {
  it('parses filters_json back through the shape-hardener + re-whitelists combinator/sort', () => {
    const view = serializeGridView({
      id: 'v1',
      table_key: 'form_submissions',
      name: 'New this week',
      filters_json: '[{"col":"status","op":"eq","val":"new"},{"bad":1}]',
      combinator: 'or',
      sort_col: 'created_at',
      sort_dir: 'DESC',
      search: 'ada',
      type: 'gallery',
      config_json: '{"titleField":"email","junk":1}',
      updated_at: '2026-09-26T00:00:00Z',
      org_id: 'org_secret', // must NOT surface
      created_by: 'org_secret',
    });
    expect(view).toEqual({
      id: 'v1',
      table: 'form_submissions',
      name: 'New this week',
      conditions: [
        { col: 'status', op: 'eq', val: 'new' },
        { col: '', op: 'eq', val: '' }, // the malformed leaf is hardened, not dropped, by parseFilterConditions
      ],
      combinator: 'OR',
      sortCol: 'created_at',
      sortDir: 'desc',
      search: 'ada',
      type: 'gallery', // whitelisted
      config: { titleField: 'email' }, // shape-hardened (junk key dropped)
      updatedAt: '2026-09-26T00:00:00Z',
    });
    // bookkeeping columns never leak into the client object
    expect(view).not.toHaveProperty('org_id');
    expect(view).not.toHaveProperty('created_by');
  });

  it('degrades a corrupt filters_json to [] (never throws) + defaults combinator/sort', () => {
    const view = serializeGridView({
      id: 'v2',
      table_key: 'visitor_events',
      name: 'All',
      filters_json: '{not json',
      combinator: 'bogus',
      sort_col: null,
      sort_dir: 'nonsense',
      search: null,
    });
    expect(view.conditions).toEqual([]);
    expect(view.combinator).toBe('AND');
    expect(view.sortCol).toBeNull();
    expect(view.sortDir).toBeNull();
    expect(view.search).toBe('');
    expect(view.type).toBe('grid'); // absent type → default grid
    expect(view.config).toEqual({}); // absent config → {}
  });

  it('exposes a sane per-table cap constant', () => {
    expect(MAX_GRID_VIEWS_PER_TABLE).toBeGreaterThan(0);
    expect(MAX_GRID_VIEWS_PER_TABLE).toBeLessThanOrEqual(200);
  });
});

describe('normalizeGridViewType (grid | gallery | kanban | chart | calendar, default grid)', () => {
  it('whitelists grid/gallery/kanban/chart/calendar (case-insensitive), defaults everything else to grid', () => {
    expect(normalizeGridViewType('gallery')).toBe('gallery');
    expect(normalizeGridViewType('GRID')).toBe('grid');
    expect(normalizeGridViewType(' Gallery ')).toBe('gallery');
    expect(normalizeGridViewType('kanban')).toBe('kanban');
    expect(normalizeGridViewType('chart')).toBe('chart');
    expect(normalizeGridViewType(' KANBAN ')).toBe('kanban');
    expect(normalizeGridViewType('calendar')).toBe('calendar');
    expect(normalizeGridViewType(' Calendar ')).toBe('calendar');
    expect(normalizeGridViewType('timeline')).toBe('grid'); // unknown → default
    expect(normalizeGridViewType('')).toBe('grid');
    expect(normalizeGridViewType(undefined)).toBe('grid');
    expect(normalizeGridViewType(null)).toBe('grid');
    expect(normalizeGridViewType(42)).toBe('grid');
  });
});

describe('parseGridViewConfig (view display config; string OR object; never throws)', () => {
  it('parses a stored JSON string, keeping only a bounded titleField', () => {
    expect(parseGridViewConfig('{"titleField":"email"}')).toEqual({ titleField: 'email' });
    expect(parseGridViewConfig('{"titleField":"  name  ","junk":1}')).toEqual({
      titleField: 'name',
    });
    expect(parseGridViewConfig(`{"titleField":"${'x'.repeat(200)}"}`).titleField).toBe(
      'x'.repeat(64),
    );
  });

  it('accepts an incoming config OBJECT (the POST body), not just a stored string', () => {
    expect(parseGridViewConfig({ titleField: 'status' })).toEqual({ titleField: 'status' });
    expect(parseGridViewConfig({ titleField: 5 })).toEqual({}); // non-string dropped
  });

  it('honors a bounded kanban groupField alongside titleField', () => {
    expect(parseGridViewConfig('{"titleField":"email","groupField":"status"}')).toEqual({
      titleField: 'email',
      groupField: 'status',
    });
    expect(parseGridViewConfig({ groupField: '  status  ' })).toEqual({ groupField: 'status' });
    expect(parseGridViewConfig(`{"groupField":"${'g'.repeat(200)}"}`).groupField).toBe(
      'g'.repeat(64),
    );
    expect(parseGridViewConfig({ groupField: 7 })).toEqual({}); // non-string dropped
  });

  it('honors a bounded calendar dateField alongside title/group', () => {
    expect(parseGridViewConfig('{"dateField":"created_at"}')).toEqual({ dateField: 'created_at' });
    expect(parseGridViewConfig({ titleField: 'name', dateField: '  due_on  ' })).toEqual({
      titleField: 'name',
      dateField: 'due_on',
    });
    expect(parseGridViewConfig(`{"dateField":"${'d'.repeat(200)}"}`).dateField).toBe(
      'd'.repeat(64),
    );
    expect(parseGridViewConfig({ dateField: 9 })).toEqual({}); // non-string dropped
  });

  it('shape-hardens a full column layout sub-object (hidden/order/widths/pinned/summaries/density)', () => {
    const layout = parseGridViewConfig({
      layout: {
        hidden: ['a', '', 5, 'b'], // non-strings/empties dropped
        order: ['b', 'a'],
        widths: { a: 200, bad: 'x', neg: -1 }, // only positive numbers kept
        pinned: ['a'],
        summaries: { a: 'sum', b: 42 }, // non-string value dropped
        density: 'compact',
        junk: 'ignored',
      },
    }).layout;
    expect(layout).toEqual({
      hidden: ['a', 'b'],
      order: ['b', 'a'],
      widths: { a: 200 },
      pinned: ['a'],
      summaries: { a: 'sum' },
      density: 'compact',
    });
  });

  it('drops an empty/invalid layout (→ no layout key) + bounds array length', () => {
    expect(parseGridViewConfig({ layout: {} }).layout).toBeUndefined();
    expect(parseGridViewConfig({ layout: 'nope' }).layout).toBeUndefined();
    expect(parseGridViewConfig({ layout: { hidden: [] } }).layout).toBeUndefined();
    const many = Array.from({ length: MAX_LAYOUT_ENTRIES + 50 }, (_, i) => `c${i}`);
    expect(parseGridViewConfig({ layout: { order: many } }).layout?.order?.length).toBe(
      MAX_LAYOUT_ENTRIES,
    );
  });

  it('parseGridViewLayout keeps title/group/date + layout coexisting', () => {
    const cfg = parseGridViewConfig({ titleField: 'name', layout: { pinned: ['id'] } });
    expect(cfg.titleField).toBe('name');
    expect(cfg.layout).toEqual({ pinned: ['id'] });
  });

  it('returns {} for malformed / empty / non-object / array (never throws)', () => {
    expect(parseGridViewConfig('{not json')).toEqual({});
    expect(parseGridViewConfig('')).toEqual({});
    expect(parseGridViewConfig(undefined)).toEqual({});
    expect(parseGridViewConfig(null)).toEqual({});
    expect(parseGridViewConfig('[1,2,3]')).toEqual({});
    expect(parseGridViewConfig('"a string"')).toEqual({});
    expect(parseGridViewConfig({ titleField: '   ' })).toEqual({}); // blank → dropped
  });
});

describe('composeBrowseFilter (shared browse+export WHERE-suffix)', () => {
  const spec = { columns: ['status', 'age', 'note', 'created_at'] };
  const q =
    (m: Record<string, string>) =>
    (k: string): string | undefined =>
      m[k];

  it('returns an empty clause when neither search nor filter is set', () => {
    expect(composeBrowseFilter(spec, q({}))).toEqual({ clause: '', params: [] });
  });

  it('combines the search OR-of-LIKE with the AND/OR filter group (both parameterized)', () => {
    const { clause, params } = composeBrowseFilter(
      spec,
      q({
        search: 'ada',
        filters: '[{"col":"status","op":"eq","val":"new"},{"col":"age","op":"gte","val":"18"}]',
        filterCombinator: 'AND',
      }),
    );
    // search clause first, then the ANDed filter group
    expect(clause).toContain('LIKE ?');
    expect(clause).toContain('"status" = ?');
    expect(clause).toContain('"age" >= ?');
    expect(params).toEqual(['%ada%', '%ada%', '%ada%', 'new', '18']);
  });

  it('falls back to the single-column filter when no `filters` JSON is present', () => {
    expect(
      composeBrowseFilter(spec, q({ filterCol: 'status', filterVal: 'live', filterOp: 'ne' })),
    ).toEqual({
      clause: ' AND "status" != ?',
      params: ['live'],
    });
  });

  it('drops a non-allowlisted column (the injection boundary holds through the shared path)', () => {
    expect(
      composeBrowseFilter(spec, q({ filters: '[{"col":"password","op":"eq","val":"x"}]' })),
    ).toEqual({
      clause: '',
      params: [],
    });
  });
});

describe('buildGroupCountSql (whole-query kanban lane counts)', () => {
  it('derives a GROUP BY count from countSql, injecting the filter clause + a LIMIT', () => {
    const spec = { countSql: 'SELECT COUNT(*) AS n FROM form_submissions WHERE site_id = ?' };
    expect(buildGroupCountSql(spec, 'status', ' AND "status" = ?')).toBe(
      'SELECT "status" AS value, COUNT(*) AS n FROM form_submissions WHERE site_id = ? AND "status" = ? GROUP BY "status" ORDER BY n DESC LIMIT ?',
    );
  });

  it('preserves a soft-delete filter (extra clause is injected AFTER `WHERE site_id = ?`)', () => {
    const spec = {
      countSql: 'SELECT COUNT(*) AS n FROM site_snapshots WHERE site_id = ? AND deleted_at IS NULL',
    };
    expect(buildGroupCountSql(spec, 'build_version', '')).toBe(
      'SELECT "build_version" AS value, COUNT(*) AS n FROM site_snapshots WHERE site_id = ? AND deleted_at IS NULL GROUP BY "build_version" ORDER BY n DESC LIMIT ?',
    );
  });

  it('exposes a sane group cap', () => {
    expect(MAX_KANBAN_GROUPS).toBeGreaterThan(0);
    expect(MAX_KANBAN_GROUPS).toBeLessThanOrEqual(200);
  });
});

describe('normalizeGroupAgg (chart measure aggregate whitelist)', () => {
  it('accepts sum/avg/min/max case-insensitively, rejects everything else', () => {
    expect(normalizeGroupAgg('sum')).toBe('sum');
    expect(normalizeGroupAgg(' AVG ')).toBe('avg');
    expect(normalizeGroupAgg('MIN')).toBe('min');
    expect(normalizeGroupAgg('max')).toBe('max');
    expect(normalizeGroupAgg('count')).toBeNull(); // count is the default path, not an agg here
    expect(normalizeGroupAgg('median')).toBeNull(); // not a SQLite core aggregate we allow
    expect(normalizeGroupAgg('sum(x)')).toBeNull(); // no raw SQL smuggling
    expect(normalizeGroupAgg('')).toBeNull();
    expect(normalizeGroupAgg(undefined)).toBeNull();
    expect(normalizeGroupAgg(null)).toBeNull();
  });
});

describe('buildGroupAggregateSql (whole-query chart measure: SUM/AVG/MIN/MAX per group)', () => {
  it('adds <AGG>("measure") AS agg + orders by the aggregate desc, then count', () => {
    const spec = { countSql: 'SELECT COUNT(*) AS n FROM orders WHERE site_id = ?' };
    expect(buildGroupAggregateSql(spec, 'status', 'sum', 'amount', ' AND "status" = ?')).toBe(
      'SELECT "status" AS value, COUNT(*) AS n, SUM("amount") AS agg FROM orders WHERE site_id = ? AND "status" = ? GROUP BY "status" ORDER BY agg DESC, n DESC LIMIT ?',
    );
  });

  it('maps each whitelisted agg to its uppercase SQL keyword (never raw input)', () => {
    const spec = { countSql: 'SELECT COUNT(*) AS n FROM orders WHERE site_id = ?' };
    expect(buildGroupAggregateSql(spec, 'g', 'avg', 'm', '')).toContain('AVG("m") AS agg');
    expect(buildGroupAggregateSql(spec, 'g', 'min', 'm', '')).toContain('MIN("m") AS agg');
    expect(buildGroupAggregateSql(spec, 'g', 'max', 'm', '')).toContain('MAX("m") AS agg');
  });

  it('preserves a soft-delete filter (extra clause injected AFTER `WHERE site_id = ?`)', () => {
    const spec = {
      countSql: 'SELECT COUNT(*) AS n FROM site_snapshots WHERE site_id = ? AND deleted_at IS NULL',
    };
    expect(buildGroupAggregateSql(spec, 'build_version', 'sum', 'bytes', '')).toBe(
      'SELECT "build_version" AS value, COUNT(*) AS n, SUM("bytes") AS agg FROM site_snapshots WHERE site_id = ? AND deleted_at IS NULL GROUP BY "build_version" ORDER BY agg DESC, n DESC LIMIT ?',
    );
  });
});

describe('buildColumnAggregatesSql (whole-query per-column footer summaries; one ungrouped row)', () => {
  it('emits COUNT(*) + per-column filled/sum/avg/min/max with positional aliases', () => {
    const spec = { countSql: 'SELECT COUNT(*) AS n FROM orders WHERE site_id = ?' };
    expect(buildColumnAggregatesSql(spec, ['amount', 'qty'], '')).toBe(
      'SELECT COUNT(*) AS n, ' +
        'COUNT("amount") AS c0, SUM("amount") AS s0, AVG("amount") AS v0, MIN("amount") AS mn0, MAX("amount") AS mx0, ' +
        'COUNT("qty") AS c1, SUM("qty") AS s1, AVG("qty") AS v1, MIN("qty") AS mn1, MAX("qty") AS mx1 ' +
        'FROM orders WHERE site_id = ?',
    );
  });

  it('with no columns → just COUNT(*) (a bare whole-query count)', () => {
    const spec = { countSql: 'SELECT COUNT(*) AS n FROM orders WHERE site_id = ?' };
    expect(buildColumnAggregatesSql(spec, [], '')).toBe(
      'SELECT COUNT(*) AS n FROM orders WHERE site_id = ?',
    );
  });

  it('injects the search/filter clause AFTER `WHERE site_id = ?` (preserving soft-delete)', () => {
    const spec = {
      countSql: 'SELECT COUNT(*) AS n FROM site_snapshots WHERE site_id = ? AND deleted_at IS NULL',
    };
    expect(buildColumnAggregatesSql(spec, ['bytes'], ' AND "status" = ?')).toBe(
      'SELECT COUNT(*) AS n, COUNT("bytes") AS c0, SUM("bytes") AS s0, AVG("bytes") AS v0, MIN("bytes") AS mn0, MAX("bytes") AS mx0 ' +
        'FROM site_snapshots WHERE site_id = ? AND "status" = ? AND deleted_at IS NULL',
    );
  });
});

describe('MAX_EXPORT_ROWS (bounded whole-query export)', () => {
  it('is a sane bound for a client-side CSV/JSON download', () => {
    expect(MAX_EXPORT_ROWS).toBeGreaterThanOrEqual(1000);
    expect(MAX_EXPORT_ROWS).toBeLessThanOrEqual(100000);
  });
});
