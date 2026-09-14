import { scanResultsToLeads } from '../services/lead_scan';

/**
 * #9 lead scanner — the pure orchestration over Google Places results: score each,
 * keep the no-website leads (the scanner's purpose), createLead via the injected
 * dep, dedupe within the batch. No network/D1 (createLead is mocked).
 */
const place = (over: Partial<Record<string, unknown>> = {}) => ({
  place_id: 'p1',
  name: 'Acme Roofing',
  formatted_address: '1 Main St, Newark, NJ',
  phone: '555-1212',
  website: null,
  rating: 4.6,
  review_count: 40,
  hours: null,
  geo: null,
  maps_url: 'https://maps.google/acme',
  photos: [],
  types: ['roofing_contractor'],
  price_level: null,
  reviews: [],
  business_status: 'OPERATIONAL',
  ...over,
});

describe('scanResultsToLeads', () => {
  it('stores a no-website lead with profile + scoring meta', async () => {
    const createLead = jest.fn().mockResolvedValue({ leadId: 'lead_1' });
    const summary = await scanResultsToLeads([place()] as never, { createLead });
    expect(summary).toEqual(
      expect.objectContaining({ scanned: 1, created: 1, skippedHasWebsite: 0 }),
    );
    expect(createLead).toHaveBeenCalledTimes(1);
    const [profile, meta] = createLead.mock.calls[0];
    expect(profile).toEqual(
      expect.objectContaining({
        businessName: 'Acme Roofing',
        address: '1 Main St, Newark, NJ',
        phone: '555-1212',
        mapsUrl: 'https://maps.google/acme',
      }),
    );
    expect(meta).toEqual(
      expect.objectContaining({ placeId: 'p1', hasWebsite: false, source: 'google_places' }),
    );
    expect(meta.leadScore).toBeGreaterThan(0);
  });

  it('skips a result that already has a website (default onlyNoWebsite)', async () => {
    const createLead = jest.fn().mockResolvedValue({ leadId: 'x' });
    const summary = await scanResultsToLeads([place({ website: 'https://has.site' })] as never, {
      createLead,
    });
    expect(summary).toEqual(
      expect.objectContaining({ scanned: 1, created: 0, skippedHasWebsite: 1 }),
    );
    expect(createLead).not.toHaveBeenCalled();
  });

  it('dedupes repeated place_id within the batch', async () => {
    const createLead = jest.fn().mockResolvedValue({ leadId: 'x' });
    const summary = await scanResultsToLeads([place(), place()] as never, { createLead });
    expect(summary.created).toBe(1);
    expect(summary.skippedDuplicate).toBe(1);
    expect(createLead).toHaveBeenCalledTimes(1);
  });

  it('onlyNoWebsite:false stores every result (with has_website meta)', async () => {
    const createLead = jest.fn().mockResolvedValue({ leadId: 'x' });
    const summary = await scanResultsToLeads(
      [place({ place_id: 'a' }), place({ place_id: 'b', website: 'https://has.site' })] as never,
      { createLead },
      { onlyNoWebsite: false },
    );
    expect(summary.created).toBe(2);
    expect(createLead).toHaveBeenCalledTimes(2);
  });

  it('continues past a createLead failure (counts it as an error, not a throw)', async () => {
    const createLead = jest
      .fn()
      .mockRejectedValueOnce(new Error('dup'))
      .mockResolvedValue({ leadId: 'ok' });
    const summary = await scanResultsToLeads(
      [place({ place_id: 'a' }), place({ place_id: 'b' })] as never,
      { createLead },
    );
    expect(summary.created).toBe(1);
    expect(summary.errors).toBe(1);
  });

  it('counts a cross-scan duplicate (createLead → duplicate:true) as skippedDuplicate, NOT errors', async () => {
    // A re-scan of an already-scanned area: createLead detects the existing place_id and
    // returns { duplicate: true } instead of throwing on the UNIQUE index. The scan must
    // tally it as a benign skip — regression for AL-564 (was miscounted as `errors`, so a
    // healthy re-scan read "created 1 · errors 199").
    const createLead = jest
      .fn()
      .mockResolvedValueOnce({ leadId: 'new', duplicate: false })
      .mockResolvedValue({ leadId: 'existing', duplicate: true });
    const summary = await scanResultsToLeads(
      [place({ place_id: 'a' }), place({ place_id: 'b' }), place({ place_id: 'c' })] as never,
      { createLead },
    );
    expect(summary.created).toBe(1);
    expect(summary.skippedDuplicate).toBe(2);
    expect(summary.errors).toBe(0);
  });
});
