/**
 * @file Regression lock for the contacts CRM upsert (fire-61).
 *
 * THE DEFECT (observed live in the long-trail Phase E journey): `contacts` is a
 * DEDUPE table — `uniq_contacts_org_email` UNIQUE (org_id, lower(email)) WHERE
 * email IS NOT NULL AND deleted_at IS NULL, plus first_seen_at/last_seen_at
 * lifecycle columns — but BOTH writers (libs/features/contact_newsletter/
 * handlers.ts and src/services/contact.ts handleContactForm) did a BLIND
 * `dbInsert`. A REPEAT submitter (same org + email) hit the unique index, the
 * error was swallowed into a log line, and the CRM write was silently LOST:
 * last_seen_at never advanced, the latest message never landed, and in
 * handleContactForm `persisted` stayed false (so a coincident email-rail
 * failure hard-errored an innocent visitor).
 *
 * THE CONTRACT (this lock): `upsertContact` honors the table's own design —
 * first touch inserts; repeat touch UPDATES the existing row (latest metadata,
 * advanced last_seen_at, enriched-not-erased identity fields) and NEVER errors
 * on the dedupe conflict. Runs against REAL SQLite (node:sqlite harness) so the
 * actual ON CONFLICT SQL executes — a mock double cannot catch a bad conflict
 * target against the PARTIAL unique index.
 */
import { createD1Sqlite, type D1SqliteHarness } from './helpers/d1_sqlite.js';
import { upsertContact } from '../services/contacts.js';

/** Prod-faithful contacts DDL (mirrors the live table + the partial unique index). */
const CONTACTS_DDL = `
CREATE TABLE contacts (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  site_id         TEXT,
  email           TEXT,
  phone           TEXT,
  name            TEXT,
  source          TEXT NOT NULL DEFAULT 'manual',
  tags            TEXT,
  metadata        TEXT,
  consent_email   INTEGER,
  consent_sms     INTEGER,
  first_seen_at   TEXT,
  last_seen_at    TEXT,
  created_at      TEXT,
  updated_at      TEXT,
  deleted_at      TEXT
);
CREATE UNIQUE INDEX uniq_contacts_org_email
  ON contacts (org_id, lower(email))
  WHERE email IS NOT NULL AND deleted_at IS NULL;
`;

interface ContactRow {
  id: string;
  org_id: string;
  site_id: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  source: string;
  metadata: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
}

function allContacts(h: D1SqliteHarness): ContactRow[] {
  return h.raw.prepare('SELECT * FROM contacts ORDER BY created_at').all() as unknown as ContactRow[];
}

describe('upsertContact — dedupe-honoring CRM write', () => {
  let h: D1SqliteHarness;

  beforeEach(() => {
    h = createD1Sqlite();
    h.exec(CONTACTS_DDL);
  });
  afterEach(() => h.close());

  test('first touch inserts a full lifecycle row', async () => {
    const { error } = await upsertContact(h.db, {
      id: 'c-1',
      org_id: 'org-a',
      site_id: 'site-1',
      name: 'Visitor One',
      email: 'Lead@Example.com',
      phone: null,
      source: 'form',
      metadata: JSON.stringify({ message: 'first message' }),
    });
    expect(error).toBeNull();
    const rows = allContacts(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.email).toBe('Lead@Example.com');
    expect(rows[0]!.first_seen_at).toBeTruthy();
    expect(rows[0]!.last_seen_at).toBeTruthy();
    expect(rows[0]!.metadata).toContain('first message');
  });

  test('REPEAT submitter updates the SAME row (the fire-61 silent-loss regression)', async () => {
    await upsertContact(h.db, {
      id: 'c-1',
      org_id: 'org-a',
      site_id: 'site-1',
      name: 'Visitor One',
      email: 'lead@example.com',
      phone: null,
      source: 'form',
      metadata: JSON.stringify({ message: 'first message' }),
    });
    const first = allContacts(h)[0]!;

    // Same org + same email (different CASE — lower(email) dedupe) + new message.
    const { error } = await upsertContact(h.db, {
      id: 'c-2', // new id must NOT create a second identity
      org_id: 'org-a',
      site_id: 'site-1',
      name: 'Visitor One Renamed',
      email: 'LEAD@example.com',
      phone: '+12015550123',
      source: 'form',
      metadata: JSON.stringify({ message: 'second message — must land' }),
    });
    expect(error).toBeNull();

    const rows = allContacts(h);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe('c-1');
    expect(row.metadata).toContain('second message — must land');
    expect(row.name).toBe('Visitor One Renamed');
    expect(row.phone).toBe('+12015550123');
    expect(row.first_seen_at).toBe(first.first_seen_at);
    expect(String(row.last_seen_at) >= String(first.last_seen_at)).toBe(true);
  });

  test('repeat with missing name/phone enriches, never erases', async () => {
    await upsertContact(h.db, {
      id: 'c-1',
      org_id: 'org-a',
      site_id: 'site-1',
      name: 'Named Visitor',
      email: 'lead@example.com',
      phone: '+12015550123',
      source: 'form',
      metadata: '{"message":"first"}',
    });
    const { error } = await upsertContact(h.db, {
      id: 'c-2',
      org_id: 'org-a',
      site_id: null,
      name: null,
      email: 'lead@example.com',
      phone: null,
      source: 'form',
      metadata: '{"message":"second"}',
    });
    expect(error).toBeNull();
    const row = allContacts(h)[0]!;
    expect(row.name).toBe('Named Visitor');
    expect(row.phone).toBe('+12015550123');
    expect(row.site_id).toBe('site-1');
    expect(row.metadata).toContain('second');
  });

  test('same email under a DIFFERENT org is a separate identity (org-scoped dedupe)', async () => {
    await upsertContact(h.db, {
      id: 'c-1',
      org_id: 'org-a',
      site_id: null,
      name: 'A',
      email: 'lead@example.com',
      phone: null,
      source: 'form',
      metadata: '{}',
    });
    const { error } = await upsertContact(h.db, {
      id: 'c-2',
      org_id: 'org-b',
      site_id: null,
      name: 'B',
      email: 'lead@example.com',
      phone: null,
      source: 'form',
      metadata: '{}',
    });
    expect(error).toBeNull();
    expect(allContacts(h)).toHaveLength(2);
  });
});
