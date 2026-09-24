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
  deletableTableName,
  DELETABLE_OVERVIEW_TABLES,
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
    for (const key of ['visitor_events', 'site_snapshots', 'mcp_connections', 'site_data', 'users', 'sqlite_master', '', 'form_submissions; DROP TABLE sites']) {
      expect(deletableTableName(key)).toBeUndefined();
    }
  });
  it('every allowlist value is a plain identifier (no interpolation risk)', () => {
    for (const real of Object.values(DELETABLE_OVERVIEW_TABLES)) {
      expect(real).toMatch(/^[a-z_][a-z0-9_]*$/);
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
    expect(buildColumnFilter(cols, 'status; DROP TABLE sites', 'x')).toEqual({ clause: '', params: [] });
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
});
