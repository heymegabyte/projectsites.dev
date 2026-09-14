import { dbQueryOne, dbInsert, dbQuery, dbExecute } from '../services/db.js';
import { createLead, getLead, listLeads, updateLeadContact } from '../services/lead_store';

/**
 * #9/#1 shared dependency — the leads store. The scanner (#9) persists a
 * researched ClaimLeadProfile + scoring meta; the claim flow (#1) reads it back
 * to prefill /create. D1 mocked (established pattern). Reuses ClaimLeadProfileSchema.
 */
jest.mock('../services/db.js', () => ({
  dbQueryOne: jest.fn(),
  dbInsert: jest.fn().mockResolvedValue({ error: null }),
  dbQuery: jest.fn(),
  dbExecute: jest.fn().mockResolvedValue({ error: null }),
}));

const mockQueryOne = dbQueryOne as jest.Mock;
const mockInsert = dbInsert as jest.Mock;
const mockQuery = dbQuery as jest.Mock;
const mockExecute = dbExecute as jest.Mock;
const db = {} as never;

beforeEach(() => {
  mockQueryOne.mockReset();
  mockInsert.mockReset().mockResolvedValue({ error: null });
  mockQuery.mockReset().mockResolvedValue({ data: [] });
  mockExecute.mockReset().mockResolvedValue({ error: null });
});

describe('createLead', () => {
  it('inserts the profile (as JSON) + scoring meta, returns a generated leadId', async () => {
    const r = await createLead(
      db,
      { businessName: 'Acme Roofing', phone: '555' },
      { hasWebsite: false, leadScore: 88, priority: true, source: 'google_places' },
    );
    expect(r.leadId).toMatch(/[0-9a-f-]{8,}/i);
    expect(mockInsert).toHaveBeenCalledTimes(1);
    const [, table, record] = mockInsert.mock.calls[0];
    expect(table).toBe('scanned_leads');
    expect(record).toEqual(
      expect.objectContaining({
        id: r.leadId,
        business_name: 'Acme Roofing',
        has_website: 0,
        lead_score: 88,
        priority: 1,
        source: 'google_places',
      }),
    );
    expect(JSON.parse(record.profile_json)).toEqual(
      expect.objectContaining({ businessName: 'Acme Roofing', phone: '555' }),
    );
  });

  it('rejects a profile missing the required businessName (ZodError)', async () => {
    await expect(createLead(db, { phone: '555' } as never)).rejects.toBeDefined();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('dedupes a re-scanned place_id: returns the existing leadId + duplicate:true, NO insert', async () => {
    // AL-563b root fix: a re-scan hits the scanned_leads.place_id UNIQUE index. createLead
    // pre-checks and reports the existing row as a benign duplicate instead of letting the
    // insert throw (which the scanner would miscount as `errors`).
    mockQueryOne.mockResolvedValueOnce({ id: 'lead_existing' });
    const r = await createLead(
      db,
      { businessName: 'Acme Roofing', phone: '555' },
      { placeId: 'place_xyz', source: 'osm' },
    );
    expect(r).toEqual({ leadId: 'lead_existing', duplicate: true });
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('inserts a fresh place_id (pre-check finds nothing) with a new leadId', async () => {
    mockQueryOne.mockResolvedValueOnce(undefined); // no existing row for this place_id
    const r = await createLead(
      db,
      { businessName: 'New Cafe' },
      { placeId: 'place_new', source: 'osm' },
    );
    expect(r.duplicate).toBeUndefined();
    expect(r.leadId).toMatch(/[0-9a-f-]{8,}/i);
    expect(mockInsert).toHaveBeenCalledTimes(1);
    const [, , record] = mockInsert.mock.calls[0];
    expect(record.place_id).toBe('place_new');
  });
});

describe('getLead', () => {
  it('parses + validates the stored profile_json back into a ClaimLeadProfile', async () => {
    mockQueryOne.mockResolvedValue({
      id: 'lead_1',
      business_name: 'Acme',
      profile_json: JSON.stringify({ businessName: 'Acme', city: 'Newark', services: ['roofing'] }),
    });
    const r = await getLead(db, 'lead_1');
    expect(r?.leadId).toBe('lead_1');
    expect(r?.profile.businessName).toBe('Acme');
    expect(r?.profile.services).toEqual(['roofing']);
  });

  it('returns null when there is no row', async () => {
    mockQueryOne.mockResolvedValue(null);
    expect(await getLead(db, 'nope')).toBeNull();
  });

  it('returns null on a corrupt profile_json (defensive, never throws)', async () => {
    mockQueryOne.mockResolvedValue({
      id: 'lead_1',
      business_name: 'Acme',
      profile_json: '{not json',
    });
    expect(await getLead(db, 'lead_1')).toBeNull();
  });
});

describe('listLeads', () => {
  const row = {
    id: 'lead_1',
    business_name: 'Acme Roofing',
    has_website: 0,
    lead_score: 88,
    priority: 1,
    email: 'owner@acme.test',
    email_status: 'enriched',
    source: 'google_places',
    created_at: '2026-06-19T00:00:00Z',
    phone: '+19735550100',
    website: null,
    socials_json: '{"facebook":"https://facebook.com/acme"}',
    enriched_at: null,
  };

  it('maps rows to typed summaries (0/1 → boolean + parsed socials) ordered by score', async () => {
    mockQuery.mockResolvedValue({ data: [row] });
    const out = await listLeads(db);
    expect(out).toEqual([
      {
        leadId: 'lead_1',
        businessName: 'Acme Roofing',
        hasWebsite: false,
        leadScore: 88,
        priority: true,
        email: 'owner@acme.test',
        emailStatus: 'enriched',
        source: 'google_places',
        createdAt: '2026-06-19T00:00:00Z',
        phone: '+19735550100',
        website: null,
        socials: { facebook: 'https://facebook.com/acme' },
        enrichedAt: null,
      },
    ]);
    const [, sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/ORDER BY lead_score DESC/i);
    expect(sql).toMatch(/socials_json/i); // new contact columns selected
    expect(sql).not.toMatch(/deleted_at/i); // table has no soft-delete column
  });

  it('coerces a corrupt socials_json blob to an empty object (never throws)', async () => {
    mockQuery.mockResolvedValue({ data: [{ ...row, socials_json: '{not json' }] });
    const out = await listLeads(db);
    expect(out[0].socials).toEqual({});
  });

  it('clamps limit to 1..200 and floors offset at 0', async () => {
    await listLeads(db, { limit: 9999, offset: -5 });
    const [, , params] = mockQuery.mock.calls[0];
    expect(params).toEqual([200, 0]);
    mockQuery.mockClear();
    await listLeads(db, { limit: 0 });
    expect(mockQuery.mock.calls[0][2]).toEqual([1, 0]);
  });

  it('filters to no-website leads when onlyNoWebsite is set', async () => {
    await listLeads(db, { onlyNoWebsite: true });
    const [, sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/has_website\s*=\s*0/i);
  });

  it('does NOT filter by website by default', async () => {
    await listLeads(db);
    const [, sql] = mockQuery.mock.calls[0];
    expect(sql).not.toMatch(/has_website\s*=\s*0/i);
  });

  it('returns an empty array when there are no leads', async () => {
    mockQuery.mockResolvedValue({ data: [] });
    expect(await listLeads(db)).toEqual([]);
  });
});

describe('updateLeadContact', () => {
  it('returns { updated: false } when the lead does not exist (no write)', async () => {
    mockQueryOne.mockResolvedValue(null);
    const r = await updateLeadContact(db, 'nope', { phone: '555' }, '2026-09-05T00:00:00Z');
    expect(r).toEqual({ updated: false });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('unions new socials over stored, folds contact into profile_json, stamps enriched_at', async () => {
    mockQueryOne.mockResolvedValue({
      id: 'lead_1',
      profile_json: JSON.stringify({ businessName: 'Acme' }),
      socials_json: '{"facebook":"https://facebook.com/acme"}',
    });
    const r = await updateLeadContact(
      db,
      'lead_1',
      {
        phone: '+19735550100',
        email: 'o@acme.test',
        website: 'https://acme.test',
        socials: { instagram: 'https://instagram.com/acme' },
      },
      '2026-09-05T12:00:00Z',
    );
    expect(r).toEqual({ updated: true });
    const [, sql, params] = mockExecute.mock.calls[0];
    expect(sql).toMatch(/UPDATE scanned_leads/i);
    expect(sql).toMatch(/enriched_at\s*=\s*\?/i);
    // params: [phone, email, website, socials_json, lead_score, profile_json, enriched_at, id]
    const socialsJson = JSON.parse(params[3] as string);
    expect(socialsJson).toEqual({
      facebook: 'https://facebook.com/acme',
      instagram: 'https://instagram.com/acme',
    });
    expect(params[4]).toBeNull(); // leadScore omitted → COALESCE keeps existing
    const profile = JSON.parse(params[5] as string);
    expect(profile).toEqual(
      expect.objectContaining({
        businessName: 'Acme',
        phone: '+19735550100',
        email: 'o@acme.test',
        existingWebsite: 'https://acme.test',
        socials: expect.objectContaining({ instagram: 'https://instagram.com/acme' }),
      }),
    );
    expect(params[6]).toBe('2026-09-05T12:00:00Z');
    expect(params[7]).toBe('lead_1');
  });

  it('persists a recomputed leadScore via COALESCE when provided (re-rank on enrich)', async () => {
    mockQueryOne.mockResolvedValue({
      id: 'lead_1',
      profile_json: JSON.stringify({ businessName: 'Acme' }),
      socials_json: null,
    });
    await updateLeadContact(
      db,
      'lead_1',
      { socials: { facebook: 'a', instagram: 'b' } },
      '2026-09-05T12:00:00Z',
      75,
    );
    const [, sql, params] = mockExecute.mock.calls[0];
    expect(sql).toMatch(/lead_score\s*=\s*COALESCE\(\?, lead_score\)/i);
    expect(params[4]).toBe(75); // the recomputed intent-weighted score
  });

  it('leaves profile_json untouched when the stored profile is corrupt (columns still update)', async () => {
    mockQueryOne.mockResolvedValue({
      id: 'lead_1',
      profile_json: '{not json',
      socials_json: null,
    });
    const r = await updateLeadContact(db, 'lead_1', { phone: '555' }, '2026-09-05T00:00:00Z');
    expect(r).toEqual({ updated: true });
    const [, , params] = mockExecute.mock.calls[0];
    expect(params[5]).toBe('{not json'); // profile_json (index shifted by lead_score) passed through unchanged
  });
});
