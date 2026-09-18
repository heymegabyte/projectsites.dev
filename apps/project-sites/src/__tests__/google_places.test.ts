/**
 * Tests for src/services/google_places.ts — Google Places API client
 * used to enrich business data during the site-generation pipeline.
 *
 * Covers: no-key short-circuit, Text Search query/key build, success
 * field mapping (name/address/phone/hours/rating/geo/photos/reviews),
 * empty results, non-200 + API-error status, network-throw resilience,
 * field defaults/coercion, and time-format edge cases.
 *
 * Convergence r16 — additive only.
 */

import { lookupBusiness, formatBusinessHours } from '../services/google_places';
import type { PlacesResult } from '../services/google_places';

const originalFetch = global.fetch;
const mockFetch = jest.fn();

/** Build a Fetch-like Response stub. */
function res(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** A minimal happy-path Text Search response. */
function searchOk(placeId = 'place-123') {
  return {
    status: 'OK',
    results: [
      {
        place_id: placeId,
        name: 'Vitos Mens Salon',
        formatted_address: '74 N Beverwyck Rd, Lake Hiawatha, NJ 07034',
        geometry: { location: { lat: 40.88, lng: -74.38 } },
      },
    ],
  };
}

/** A full Place Details response with every optional field present. */
function detailsFull() {
  return {
    status: 'OK',
    result: {
      name: 'Vitos Mens Salon',
      formatted_address: '74 N Beverwyck Rd, Lake Hiawatha, NJ 07034',
      formatted_phone_number: '(973) 555-0100',
      international_phone_number: '+1 973-555-0100',
      website: 'https://vitos.example',
      rating: 4.7,
      user_ratings_total: 212,
      opening_hours: {
        periods: [
          // Monday (day 1) 09:00 → 17:30
          { open: { day: 1, time: '0900' }, close: { day: 1, time: '1730' } },
          // Sunday (day 0) open with no close (24h-style)
          { open: { day: 0, time: '0000' } },
        ],
        weekday_text: ['Monday: 9:00 AM – 5:30 PM'],
      },
      geometry: { location: { lat: 40.88, lng: -74.38 } },
      photos: [
        {
          photo_reference: 'ref-1',
          width: 800,
          height: 600,
          html_attributions: ['<a>Photographer</a>'],
        },
      ],
      types: ['hair_care', 'point_of_interest'],
      price_level: 2,
      reviews: [
        {
          text: 'Great cut',
          author_name: 'Jane D',
          rating: 5,
          relative_time_description: 'a week ago',
        },
      ],
      url: 'https://maps.google.com/?cid=123',
      business_status: 'OPERATIONAL',
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('lookupBusiness — short-circuit + guards', () => {
  it('returns null when the API key is undefined (no network call)', async () => {
    const result = await lookupBusiness(undefined, 'Vitos', 'NJ');
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns null when the API key is an empty string', async () => {
    const result = await lookupBusiness('', 'Vitos', 'NJ');
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('lookupBusiness — Text Search request build', () => {
  it('builds the search URL with an encoded "name address" query + the key', async () => {
    mockFetch.mockResolvedValueOnce(res(searchOk())).mockResolvedValueOnce(res(detailsFull()));

    await lookupBusiness('KEY-XYZ', 'Vitos Mens Salon', '74 N Beverwyck Rd, NJ');

    const searchUrl = mockFetch.mock.calls[0][0] as string;
    expect(searchUrl).toContain('place/textsearch/json');
    expect(searchUrl).toContain('key=KEY-XYZ');
    // Space between name and address is URL-encoded.
    expect(searchUrl).toContain(
      `query=${encodeURIComponent('Vitos Mens Salon 74 N Beverwyck Rd, NJ')}`,
    );
  });

  it('trims a query when the address is empty', async () => {
    mockFetch.mockResolvedValueOnce(res(searchOk())).mockResolvedValueOnce(res(detailsFull()));

    await lookupBusiness('KEY', 'Vitos', '');

    const searchUrl = mockFetch.mock.calls[0][0] as string;
    expect(searchUrl).toContain(`query=${encodeURIComponent('Vitos')}`);
  });
});

describe('lookupBusiness — Place Details request build', () => {
  it('uses the first result place_id and requests the full field mask', async () => {
    mockFetch
      .mockResolvedValueOnce(res(searchOk('THE-PLACE-ID')))
      .mockResolvedValueOnce(res(detailsFull()));

    await lookupBusiness('KEY', 'Vitos', 'NJ');

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const detailsUrl = mockFetch.mock.calls[1][0] as string;
    expect(detailsUrl).toContain('place/details/json');
    expect(detailsUrl).toContain('place_id=THE-PLACE-ID');
    expect(detailsUrl).toContain('fields=');
    expect(detailsUrl).toContain('opening_hours');
    expect(detailsUrl).toContain('key=KEY');
  });
});

describe('lookupBusiness — success parse + field mapping', () => {
  it('maps the full Places result into the normalized envelope', async () => {
    mockFetch
      .mockResolvedValueOnce(res(searchOk('place-abc')))
      .mockResolvedValueOnce(res(detailsFull()));

    const result = await lookupBusiness('KEY', 'Vitos', 'NJ');

    expect(result).not.toBeNull();
    expect(result!.place_id).toBe('place-abc');
    expect(result!.name).toBe('Vitos Mens Salon');
    expect(result!.formatted_address).toContain('Beverwyck');
    // international phone preferred over formatted.
    expect(result!.phone).toBe('+1 973-555-0100');
    expect(result!.website).toBe('https://vitos.example');
    expect(result!.rating).toBe(4.7);
    expect(result!.review_count).toBe(212);
    expect(result!.geo).toEqual({ lat: 40.88, lng: -74.38 });
    expect(result!.maps_url).toBe('https://maps.google.com/?cid=123');
    expect(result!.types).toEqual(['hair_care', 'point_of_interest']);
    expect(result!.price_level).toBe(2);
    expect(result!.business_status).toBe('OPERATIONAL');
  });

  it('falls back to formatted_phone_number when international is absent', async () => {
    const details = detailsFull();
    delete (details.result as { international_phone_number?: string }).international_phone_number;
    mockFetch.mockResolvedValueOnce(res(searchOk())).mockResolvedValueOnce(res(details));

    const result = await lookupBusiness('KEY', 'Vitos', 'NJ');
    expect(result!.phone).toBe('(973) 555-0100');
  });

  it('parses 7-day hours with closed days, formatted times, and null close', async () => {
    mockFetch.mockResolvedValueOnce(res(searchOk())).mockResolvedValueOnce(res(detailsFull()));

    const result = await lookupBusiness('KEY', 'Vitos', 'NJ');
    const hours = result!.hours!;
    expect(hours).toHaveLength(7);

    const sunday = hours.find((h) => h.day === 'Sunday')!;
    expect(sunday.closed).toBe(false);
    expect(sunday.open).toBe('12:00 AM'); // "0000" → 12:00 AM
    expect(sunday.close).toBeNull(); // no close period provided

    const monday = hours.find((h) => h.day === 'Monday')!;
    expect(monday.closed).toBe(false);
    expect(monday.open).toBe('9:00 AM'); // "0900"
    expect(monday.close).toBe('5:30 PM'); // "1730"

    // A day with no period at all → closed with null open/close.
    const tuesday = hours.find((h) => h.day === 'Tuesday')!;
    expect(tuesday.closed).toBe(true);
    expect(tuesday.open).toBeNull();
    expect(tuesday.close).toBeNull();
  });

  it('builds photo media URLs from photo_reference (capped at 10)', async () => {
    const details = detailsFull();
    details.result.photos = Array.from({ length: 12 }, (_, i) => ({
      photo_reference: `ref-${i}`,
      width: 640,
      height: 480,
      html_attributions: [`<a>Author ${i}</a>`],
    }));
    mockFetch.mockResolvedValueOnce(res(searchOk())).mockResolvedValueOnce(res(details));

    const result = await lookupBusiness('KEY-PHOTO', 'Vitos', 'NJ');
    expect(result!.photos).toHaveLength(10); // capped
    expect(result!.photos[0].url).toContain('place/photo');
    expect(result!.photos[0].url).toContain('photo_reference=ref-0');
    expect(result!.photos[0].url).toContain('key=KEY-PHOTO');
    expect(result!.photos[0].attribution).toBe('<a>Author 0</a>');
    expect(result!.photos[0].width).toBe(640);
  });

  it('maps reviews (capped at 5) with author_name → author', async () => {
    const details = detailsFull();
    details.result.reviews = Array.from({ length: 8 }, (_, i) => ({
      text: `review ${i}`,
      author_name: `Author ${i}`,
      rating: 4,
      relative_time_description: `${i} days ago`,
    }));
    mockFetch.mockResolvedValueOnce(res(searchOk())).mockResolvedValueOnce(res(details));

    const result = await lookupBusiness('KEY', 'Vitos', 'NJ');
    expect(result!.reviews).toHaveLength(5); // capped
    expect(result!.reviews[0]).toEqual({
      text: 'review 0',
      author: 'Author 0',
      rating: 4,
      time: '0 days ago',
    });
  });
});

describe('lookupBusiness — defaults + coercion', () => {
  it('coerces missing optional fields to null / empty defaults', async () => {
    mockFetch.mockResolvedValueOnce(res(searchOk())).mockResolvedValueOnce(
      res({
        status: 'OK',
        result: {
          name: 'Bare Co',
          formatted_address: '1 Main St',
          // everything else omitted
        },
      }),
    );

    const result = await lookupBusiness('KEY', 'Bare Co', 'NJ');
    expect(result!.phone).toBeNull();
    expect(result!.website).toBeNull();
    expect(result!.rating).toBeNull();
    expect(result!.review_count).toBeNull();
    expect(result!.hours).toBeNull(); // no opening_hours.periods
    expect(result!.geo).toBeNull();
    expect(result!.maps_url).toBeNull();
    expect(result!.photos).toEqual([]);
    expect(result!.types).toEqual([]);
    expect(result!.price_level).toBeNull();
    expect(result!.reviews).toEqual([]);
    expect(result!.business_status).toBeNull();
  });

  it('treats rating 0 and price_level 0 as present (not null)', async () => {
    const details = detailsFull();
    details.result.rating = 0;
    details.result.price_level = 0;
    mockFetch.mockResolvedValueOnce(res(searchOk())).mockResolvedValueOnce(res(details));

    const result = await lookupBusiness('KEY', 'Vitos', 'NJ');
    expect(result!.rating).toBe(0);
    expect(result!.price_level).toBe(0);
  });

  it('uses empty-string attribution when html_attributions is missing', async () => {
    const details = detailsFull();
    details.result.photos = [
      { photo_reference: 'r', width: 100, height: 100, html_attributions: [] },
    ];
    mockFetch.mockResolvedValueOnce(res(searchOk())).mockResolvedValueOnce(res(details));

    const result = await lookupBusiness('KEY', 'Vitos', 'NJ');
    expect(result!.photos[0].attribution).toBe('');
  });
});

describe('lookupBusiness — empty + error branches', () => {
  it('returns null when Text Search status is not OK', async () => {
    mockFetch.mockResolvedValueOnce(res({ status: 'ZERO_RESULTS', results: [] }));
    const result = await lookupBusiness('KEY', 'Nobody', 'Nowhere');
    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1); // never reached Details
  });

  it('returns null when Text Search returns an empty results array', async () => {
    mockFetch.mockResolvedValueOnce(res({ status: 'OK', results: [] }));
    const result = await lookupBusiness('KEY', 'Nobody', 'Nowhere');
    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns null when the Text Search response is non-200', async () => {
    mockFetch.mockResolvedValueOnce(res({}, false, 403));
    const result = await lookupBusiness('KEY', 'Vitos', 'NJ');
    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns null when the Place Details response is non-200', async () => {
    mockFetch.mockResolvedValueOnce(res(searchOk())).mockResolvedValueOnce(res({}, false, 500));
    const result = await lookupBusiness('KEY', 'Vitos', 'NJ');
    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('returns null when Place Details status is not OK', async () => {
    mockFetch
      .mockResolvedValueOnce(res(searchOk()))
      .mockResolvedValueOnce(res({ status: 'NOT_FOUND', result: {} }));
    const result = await lookupBusiness('KEY', 'Vitos', 'NJ');
    expect(result).toBeNull();
  });
});

describe('lookupBusiness — network resilience', () => {
  it('returns null and does not throw when fetch rejects on Text Search', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(lookupBusiness('KEY', 'Vitos', 'NJ')).resolves.toBeNull();
  });

  it('returns null and does not throw when fetch rejects on Place Details', async () => {
    mockFetch
      .mockResolvedValueOnce(res(searchOk()))
      .mockRejectedValueOnce(new Error('socket hang up'));
    await expect(lookupBusiness('KEY', 'Vitos', 'NJ')).resolves.toBeNull();
  });

  it('returns null and does not throw when json() rejects', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('Unexpected token < in JSON');
      },
    } as unknown as Response);
    await expect(lookupBusiness('KEY', 'Vitos', 'NJ')).resolves.toBeNull();
  });
});

// ── formatBusinessHours — Places hours → seedable multi-line string ──
// Guards the create-from-search enrichment that fixes empty Contact hours
// (russ-and-daughters shipped blank because Places hours were never formatted +
// passed to the workflow). null → '' (fallback stays byte-identical); a full
// week contains named days + times; closed days render "Closed".
describe('formatBusinessHours', () => {
  const fullWeek: PlacesResult['hours'] = [
    { day: 'Sunday', open: null, close: null, closed: true },
    { day: 'Monday', open: '8:00 AM', close: '4:00 PM', closed: false },
    { day: 'Tuesday', open: '8:00 AM', close: '4:00 PM', closed: false },
    { day: 'Wednesday', open: '8:00 AM', close: '4:00 PM', closed: false },
    { day: 'Thursday', open: '8:00 AM', close: '4:00 PM', closed: false },
    { day: 'Friday', open: '8:00 AM', close: '5:00 PM', closed: false },
    { day: 'Saturday', open: '9:00 AM', close: '2:00 PM', closed: false },
  ];

  it('returns empty string for null (no Places hours)', () => {
    expect(formatBusinessHours(null)).toBe('');
  });

  it('returns empty string for an empty array', () => {
    expect(formatBusinessHours([])).toBe('');
  });

  it('formats a full week with named days and times', () => {
    const out = formatBusinessHours(fullWeek);
    expect(out).toContain('Monday');
    expect(out).toContain('8:00');
    expect(out).toContain('Friday: 8:00 AM – 5:00 PM');
  });

  it('renders closed days as "Closed"', () => {
    const out = formatBusinessHours(fullWeek);
    expect(out).toContain('Sunday: Closed');
    // One line per day, newline-separated (workflow seeds this into _brand.json.hours).
    expect(out.split('\n')).toHaveLength(7);
  });

  it('surfaces an open time with no close (24h / open-ended)', () => {
    const out = formatBusinessHours([
      { day: 'Monday', open: '12:00 AM', close: null, closed: false },
    ]);
    expect(out).toBe('Monday: 12:00 AM');
  });

  it('skips a day missing both open and close rather than emitting undefined', () => {
    const out = formatBusinessHours([
      { day: 'Monday', open: null, close: null, closed: false },
      { day: 'Tuesday', open: '9:00 AM', close: '5:00 PM', closed: false },
    ]);
    expect(out).toBe('Tuesday: 9:00 AM – 5:00 PM');
    expect(out).not.toContain('undefined');
  });
});
