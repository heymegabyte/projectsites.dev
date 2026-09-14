import {
  SITE_DATA_TABLES,
  resolveSiteDataTable,
  clampDataLimit,
  siteDataColumnsSql,
} from '../services/site_data_tables.js';

/**
 * AL-520 — the per-site Data-browser whitelist that backs `GET /api/sites/:id/data-overview`
 * (the bolt.diy Data tab's server leg). These lock the injection guard + the limit window.
 */
describe('site_data_tables — whitelist integrity + injection guard', () => {
  it('exposes the expected core per-site tables', () => {
    const keys = SITE_DATA_TABLES.map((t) => t.key);
    expect(keys).toEqual([
      'visitor_events',
      'form_submissions',
      'leads',
      'newsletter_subscribers',
      'booking_appointments',
      'site_snapshots',
    ]);
  });

  it('every spec has a label, description, and a safe column list ordered by created_at', () => {
    for (const t of SITE_DATA_TABLES) {
      expect(t.label.length).toBeGreaterThan(2);
      expect(t.description.length).toBeGreaterThan(5);
      expect(t.columns.length).toBeGreaterThanOrEqual(3);
      expect(t.columns).toContain('id');
      expect(t.columns).toContain('created_at'); // ORDER BY created_at is safe for every table
    }
  });

  it('every table + column name is a bare SQL identifier (no injection surface)', () => {
    const ident = /^[a-z_][a-z0-9_]*$/;
    for (const t of SITE_DATA_TABLES) {
      expect(t.table).toMatch(ident);
      for (const col of t.columns) {
        expect(col).toMatch(ident);
      }
    }
  });

  it('never selects a blob / PII-heavy column (payload, metadata, ip_address, user_agent)', () => {
    const banned = [
      'payload',
      'metadata',
      'metadata_json',
      'ip_address',
      'user_agent',
      'reply_body',
    ];
    for (const t of SITE_DATA_TABLES) {
      for (const b of banned) {
        expect(t.columns).not.toContain(b);
      }
    }
  });
});

describe('resolveSiteDataTable — the injection guard', () => {
  it('resolves a whitelisted key to its spec', () => {
    expect(resolveSiteDataTable('form_submissions')?.table).toBe('form_submissions');
    expect(resolveSiteDataTable('visitor_events')?.label).toBe('Visitor Events');
  });

  it('returns null for unknown / injection / nullish keys (handler MUST 404)', () => {
    expect(resolveSiteDataTable('users')).toBeNull();
    expect(resolveSiteDataTable('form_submissions; DROP TABLE sites')).toBeNull();
    expect(resolveSiteDataTable('sqlite_master')).toBeNull();
    expect(resolveSiteDataTable('')).toBeNull();
    expect(resolveSiteDataTable(undefined)).toBeNull();
    expect(resolveSiteDataTable(null)).toBeNull();
  });
});

describe('clampDataLimit — the browse window', () => {
  it('defaults to 25 and clamps to 1..100', () => {
    expect(clampDataLimit('25')).toBe(25);
    expect(clampDataLimit(undefined)).toBe(25);
    expect(clampDataLimit('')).toBe(25);
    expect(clampDataLimit('0')).toBe(25); // non-positive → default
    expect(clampDataLimit('-5')).toBe(25);
    expect(clampDataLimit('nope')).toBe(25);
    expect(clampDataLimit('9999')).toBe(100); // capped
    expect(clampDataLimit('50')).toBe(50);
    expect(clampDataLimit('7.9')).toBe(7); // floored
  });
});

describe('siteDataColumnsSql — trusted SELECT list', () => {
  it('joins the whitelist columns with no wildcard or statement terminator', () => {
    for (const t of SITE_DATA_TABLES) {
      const sql = siteDataColumnsSql(t);
      expect(sql).not.toContain('*');
      expect(sql).not.toContain(';');
      expect(sql).not.toContain('--');
      expect(sql.split(', ')).toEqual([...t.columns]);
    }
  });
});
