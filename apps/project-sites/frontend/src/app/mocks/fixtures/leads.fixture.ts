/**
 * @module mocks/fixtures/leads
 *
 * @description
 * Mock fixture for the Super-Admin Lead Scanner (`GET /api/admin/leads`). Typed to
 * the EXACT worker response contract — `{ leads: LeadSummary[]; count; total }`
 * (see `src/routes/admin_leads.ts` + `services/lead_store.ts`) — so when the real
 * endpoint later serves the data it's a provider SWAP, not a rewrite. The mock and
 * the real worker satisfy the same shape.
 *
 * @remarks
 * - Believable data, not lorem: real-looking US small-business names / owner emails /
 *   mixed statuses / recent dates / partial socials, enough rows (54) to EXERCISE the
 *   `#26` "Load more" pagination (worker default page = 50 → page 2 holds the tail).
 * - Honors `offset`/`limit` query params exactly like the worker: returns the right
 *   SLICE plus the TRUE `total` (54), so the UI's "N of TOTAL" + Load-more are real.
 * - `state` variants: `empty` (0 rows), `error` (throws a 500 via the interceptor),
 *   `populated` (54 rows), `loading` (served after the interceptor's delay, like
 *   populated). Every state is reachable with `?mock=1&state=…`.
 */
import type { FixtureFactory, MockState } from './index';

/**
 * A scanned-lead row — mirrors the worker's `LeadSummary` (`services/lead_store.ts`)
 * AND the admin component's local interface (`leads.component.ts`). Kept in the
 * fixture module so the fixture is self-typed against the real contract.
 */
export interface LeadSummaryFixture {
  leadId: string;
  businessName: string;
  hasWebsite: boolean;
  leadScore: number;
  priority: boolean;
  email: string | null;
  emailStatus: string | null;
  source: string | null;
  createdAt: string;
  phone: string | null;
  website: string | null;
  /** network-key → profile URL (worker always emits an object, `{}` when none). */
  socials: Record<string, string>;
  enrichedAt: string | null;
}

/** The `GET /api/admin/leads` envelope — `count` = page length, `total` = store total. */
export interface LeadsListResponse {
  leads: LeadSummaryFixture[];
  count: number;
  total: number;
}

/** Default page size — mirrors the worker's `LEADS_PAGE_LIMIT` (and the UI's). */
const PAGE_LIMIT = 50;

/**
 * 54 believable siteless-business leads, highest score first (the worker orders
 * `lead_score DESC, created_at DESC`). The spread of contact completeness —
 * some with socials, some email-only, some bare — makes every column + the
 * "Reach via" best-channel chip render with real variety.
 */
const LEADS: readonly LeadSummaryFixture[] = buildLeads();

/**
 * The leads fixture factory. Reads the request's `offset`/`limit` (if any) and
 * returns the matching slice + the true total, so pagination behaves exactly like
 * the worker. `empty` → 0 rows; `error` is handled by the interceptor (it throws a
 * 500 before calling this). `populated`/`loading`/default → the full store.
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 * @param query - Parsed query params from the request URL (for offset/limit).
 */
export const leadsFixture: FixtureFactory<LeadsListResponse> = (
  state: MockState,
  query: URLSearchParams,
): LeadsListResponse => {
  const rows = state === 'empty' ? [] : LEADS;
  const total = rows.length;

  // Honor offset/limit the same way the worker's listLeads does: a fresh load
  // sends no offset (→ first PAGE_LIMIT rows); "Load more" sends offset + limit.
  const offset = clampInt(query.get('offset'), 0, 0, total);
  const limit = clampInt(query.get('limit'), PAGE_LIMIT, 1, 200);
  const slice = rows.slice(offset, offset + limit);

  return { leads: slice, count: slice.length, total };
};

/** Parse a query-param int with a default + clamp; non-numeric → the default. */
function clampInt(raw: string | null, dflt: number, min: number, max: number): number {
  const n = raw == null ? dflt : Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(n, min), max);
}

/** Build the 54-row believable lead store (pure; deterministic). */
function buildLeads(): LeadSummaryFixture[] {
  // [name, city, score, priority, email|null, socials, phone|null, website|null, enriched]
  type Seed = [
    string,
    string,
    number,
    boolean,
    string | null,
    Record<string, string>,
    string | null,
    string | null,
    boolean,
  ];
  const seeds: Seed[] = [
    ['Beverwyck Barber Co.', 'Lake Hiawatha, NJ', 96, true, 'book@beverwyckbarber.test', { instagram: 'https://instagram.com/beverwyckbarber', facebook: 'https://facebook.com/beverwyckbarber' }, '+1 973-555-0148', null, true],
    ['Sunset Grove Landscaping', 'Montclair, NJ', 94, true, 'hello@sunsetgrove.test', { instagram: 'https://instagram.com/sunsetgrove' }, '+1 973-555-0192', null, true],
    ['Harbor Point Plumbing', 'Hoboken, NJ', 93, true, null, { facebook: 'https://facebook.com/harborpointplumbing' }, '+1 201-555-0113', null, false],
    ['Maple & Main Bakery', 'Summit, NJ', 91, true, 'orders@mapleandmain.test', { instagram: 'https://instagram.com/mapleandmain', tiktok: 'https://tiktok.com/@mapleandmain' }, '+1 908-555-0176', null, true],
    ['Ironbound Auto Detailing', 'Newark, NJ', 90, true, 'detail@ironboundauto.test', {}, '+1 973-555-0121', null, false],
    ['Riverside Yoga Studio', 'Jersey City, NJ', 89, true, 'namaste@riversideyoga.test', { instagram: 'https://instagram.com/riversideyoga' }, '+1 201-555-0198', null, true],
    ['Copper Kettle Catering', 'Morristown, NJ', 88, true, null, { facebook: 'https://facebook.com/copperkettle' }, '+1 973-555-0134', null, false],
    ['Alpine Peak Roofing', 'Wayne, NJ', 87, false, 'quote@alpinepeakroofing.test', {}, '+1 973-555-0155', null, false],
    ['The Clay Pot Florist', 'Westfield, NJ', 86, false, 'blooms@claypotflorist.test', { instagram: 'https://instagram.com/claypotflorist' }, null, null, true],
    ['Northside Electric', 'Clifton, NJ', 85, false, null, {}, '+1 973-555-0167', null, false],
    ['Brookdale Family Dental', 'Bloomfield, NJ', 84, false, 'smile@brookdaledental.test', { facebook: 'https://facebook.com/brookdaledental' }, '+1 973-555-0189', null, false],
    ['Luna Nail Lounge', 'Hackensack, NJ', 83, false, 'book@lunanaillounge.test', { instagram: 'https://instagram.com/lunanaillounge', tiktok: 'https://tiktok.com/@lunanaillounge' }, '+1 201-555-0142', null, true],
    ['Summit Strength Gym', 'Paramus, NJ', 82, false, null, { instagram: 'https://instagram.com/summitstrength' }, '+1 201-555-0119', null, false],
    ['Old Mill Coffee House', 'Cranford, NJ', 81, false, 'hello@oldmillcoffee.test', { instagram: 'https://instagram.com/oldmillcoffee', facebook: 'https://facebook.com/oldmillcoffee' }, '+1 908-555-0103', null, true],
    ['Greenleaf Tree Service', 'Livingston, NJ', 80, false, 'info@greenleaftree.test', {}, '+1 973-555-0127', null, false],
    ['Bella Vista Pizzeria', 'Nutley, NJ', 79, false, null, { facebook: 'https://facebook.com/bellavistapizza' }, '+1 973-555-0151', null, false],
    ['Harmony House Cleaning', 'Union, NJ', 78, false, 'clean@harmonyhouse.test', {}, '+1 908-555-0138', null, false],
    ['Tidewater Boat Repair', 'Perth Amboy, NJ', 77, false, 'service@tidewaterboat.test', { facebook: 'https://facebook.com/tidewaterboat' }, '+1 732-555-0164', null, false],
    ['Silver Spoon Diner', 'Edison, NJ', 76, false, null, { instagram: 'https://instagram.com/silverspoondiner' }, '+1 732-555-0172', null, false],
    ['Pinewood Pet Grooming', 'Woodbridge, NJ', 75, false, 'woof@pinewoodpet.test', { instagram: 'https://instagram.com/pinewoodpet', tiktok: 'https://tiktok.com/@pinewoodpet' }, '+1 732-555-0116', null, true],
    ['Castle Rock Masonry', 'Bridgewater, NJ', 74, false, null, {}, '+1 908-555-0145', null, false],
    ['Velvet Chair Salon', 'Somerville, NJ', 73, false, 'style@velvetchair.test', { instagram: 'https://instagram.com/velvetchairsalon' }, '+1 908-555-0159', null, false],
    ['Brightside HVAC', 'Piscataway, NJ', 72, false, 'comfort@brightsidehvac.test', {}, '+1 732-555-0128', null, false],
    ['The Reading Room Books', 'Princeton, NJ', 71, false, null, { facebook: 'https://facebook.com/readingroombooks' }, null, null, false],
    ['Coastal Breeze Tanning', 'Toms River, NJ', 70, false, 'glow@coastalbreeze.test', { instagram: 'https://instagram.com/coastalbreezetan' }, '+1 732-555-0183', null, false],
    ['Hometown Hardware', 'Red Bank, NJ', 69, false, null, {}, '+1 732-555-0137', null, false],
    ['Lily Pad Daycare', 'Freehold, NJ', 68, false, 'care@lilypaddaycare.test', { facebook: 'https://facebook.com/lilypaddaycare' }, '+1 732-555-0191', null, false],
    ['Granite Ridge Countertops', 'Marlboro, NJ', 67, false, 'quote@graniteridge.test', {}, '+1 732-555-0124', null, false],
    ['The Spotted Owl Pub', 'Asbury Park, NJ', 66, false, null, { instagram: 'https://instagram.com/spottedowlpub', facebook: 'https://facebook.com/spottedowlpub' }, '+1 732-555-0168', null, false],
    ['Evergreen Pest Control', 'Howell, NJ', 65, false, 'bugs@evergreenpest.test', {}, '+1 732-555-0152', null, false],
    ['Sundial Watch Repair', 'Rahway, NJ', 64, false, null, {}, '+1 732-555-0146', null, false],
    ['Moonlight Bakeshop', 'Metuchen, NJ', 63, false, 'cakes@moonlightbakeshop.test', { instagram: 'https://instagram.com/moonlightbakeshop' }, '+1 732-555-0179', null, false],
    ['Anchor & Oar Seafood', 'Point Pleasant, NJ', 62, false, null, { facebook: 'https://facebook.com/anchorandoar' }, '+1 732-555-0133', null, false],
    ['Willow Creek Vet Clinic', 'Manalapan, NJ', 61, false, 'pets@willowcreekvet.test', {}, '+1 732-555-0187', null, false],
    ['Crimson Leaf Tea Co.', 'New Brunswick, NJ', 60, false, null, { instagram: 'https://instagram.com/crimsonleaftea' }, null, null, false],
    ['Patriot Fence & Deck', 'Old Bridge, NJ', 59, false, 'build@patriotfence.test', {}, '+1 732-555-0141', null, false],
    ['Golden Hour Photography', 'Spring Lake, NJ', 58, false, 'shoot@goldenhourphoto.test', { instagram: 'https://instagram.com/goldenhourphoto', tiktok: 'https://tiktok.com/@goldenhourphoto' }, null, null, true],
    ['Stone Harbor Ice Cream', 'Belmar, NJ', 57, false, null, { instagram: 'https://instagram.com/stoneharboric' }, '+1 732-555-0175', null, false],
    ['Twin Oaks Carpentry', 'Wall Township, NJ', 56, false, 'work@twinoakscarpentry.test', {}, '+1 732-555-0129', null, false],
    ['Lavender Lane Spa', 'Rumson, NJ', 55, false, 'relax@lavenderlane.test', { instagram: 'https://instagram.com/lavenderlanespa' }, '+1 732-555-0163', null, false],
    ['Rusty Anchor Bar & Grill', 'Keansburg, NJ', 54, false, null, { facebook: 'https://facebook.com/rustyanchorgrill' }, '+1 732-555-0157', null, false],
    ['Maplewood Music Lessons', 'Maplewood, NJ', 53, false, 'play@maplewoodmusic.test', {}, null, null, false],
    ['Cedar Point Locksmith', 'Sayreville, NJ', 52, false, null, {}, '+1 732-555-0144', null, false],
    ['Blue Heron Kayak Rentals', 'Brick, NJ', 51, false, 'paddle@blueheronkayak.test', { instagram: 'https://instagram.com/blueheronkayak' }, '+1 732-555-0178', null, false],
    ['Firefly Toy Shop', 'Haddonfield, NJ', 50, false, null, { facebook: 'https://facebook.com/fireflytoyshop' }, '+1 856-555-0132', null, false],
    ['Oakwood Chiropractic', 'Cherry Hill, NJ', 49, false, 'align@oakwoodchiro.test', {}, '+1 856-555-0186', null, false],
    ['The Painted Door Antiques', 'Collingswood, NJ', 48, false, null, { instagram: 'https://instagram.com/painteddoorantiques' }, null, null, false],
    ['Sunrise Surf School', 'Ocean City, NJ', 47, false, 'surf@sunrisesurf.test', { instagram: 'https://instagram.com/sunrisesurfschool', tiktok: 'https://tiktok.com/@sunrisesurfschool' }, '+1 609-555-0171', null, true],
    ['Keystone Appliance Repair', 'Vineland, NJ', 46, false, null, {}, '+1 856-555-0126', null, false],
    ['Lantern Lane Bistro', 'Moorestown, NJ', 45, false, 'dine@lanternlane.test', { facebook: 'https://facebook.com/lanternlanebistro' }, '+1 856-555-0162', null, false],
    ['Willow Bend Nursery', 'Medford, NJ', 44, false, null, { instagram: 'https://instagram.com/willowbendnursery' }, '+1 609-555-0154', null, false],
    ['Compass Rose Travel', 'Mount Laurel, NJ', 43, false, 'trips@compassrosetravel.test', {}, null, null, false],
    ['Driftwood Beach Rentals', 'Wildwood, NJ', 42, false, null, { facebook: 'https://facebook.com/driftwoodrentals' }, '+1 609-555-0169', null, false],
    ['Hickory Smoke BBQ', 'Pennsauken, NJ', 41, false, 'smoke@hickorysmokebbq.test', { instagram: 'https://instagram.com/hickorysmokebbq' }, '+1 856-555-0147', null, false],
  ];

  // Dates descend from a recent anchor so the newest-first ordering looks organic.
  const anchor = Date.parse('2026-10-05T14:30:00Z');
  return seeds.map((s, i) => {
    const [businessName, city, leadScore, priority, email, socials, phone, website, enriched] = s;
    const createdAt = new Date(anchor - i * 36 * 60 * 1000).toISOString();
    return {
      leadId: `lead-${String(i + 1).padStart(3, '0')}`,
      businessName: `${businessName} — ${city}`,
      hasWebsite: false,
      leadScore,
      priority,
      email,
      emailStatus: email ? 'verified' : null,
      source: i % 3 === 0 ? 'google_places' : 'osm',
      createdAt,
      phone,
      website,
      socials,
      enrichedAt: enriched ? new Date(anchor - i * 36 * 60 * 1000 + 5 * 60 * 1000).toISOString() : null,
    };
  });
}
