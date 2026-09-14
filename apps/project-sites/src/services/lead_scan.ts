/**
 * Lead scanner — Google Places results → scored, stored leads (#9).
 *
 * @remarks
 * Pure orchestration over a batch of {@link PlacesResult}s: score each
 * ({@link scoreLead}), keep the no-website businesses (the scanner's purpose),
 * build a {@link ClaimLeadProfile}, and persist via the injected `createLead`.
 * No network/D1 — the Places fetch + `createLead` binding live in the (deploy-
 * gated) Super-Admin scan route; this is the testable core. Dedupes repeated
 * `place_id` within the batch (the table's unique index dedupes across batches).
 *
 * @example
 * ```ts
 * const summary = await scanResultsToLeads(placesResults,
 *   { createLead: (p, m) => createLead(env.DB, p, m) });
 * ```
 */
import type { PlacesResult } from './google_places.js';
import { scoreLead } from './lead_scanner_score.js';
import type { ClaimLeadProfile } from './claim_lead_profile.js';
import type { LeadMeta } from './lead_store.js';

/** Injected persistence (db already bound). */
export interface ScanDeps {
  createLead: (
    profile: ClaimLeadProfile,
    meta: LeadMeta,
  ) => Promise<{ leadId: string; duplicate?: boolean }>;
}

/** Outcome tally of a scan batch. */
export interface ScanSummary {
  scanned: number;
  created: number;
  skippedHasWebsite: number;
  skippedDuplicate: number;
  errors: number;
}

/** Map a Places result to a ClaimLeadProfile (only present fields). */
function toProfile(r: PlacesResult): ClaimLeadProfile {
  const profile: ClaimLeadProfile = { businessName: r.name };
  if (r.formatted_address) profile.address = r.formatted_address;
  if (r.phone) profile.phone = r.phone;
  if (r.types[0]) profile.category = r.types[0];
  if (r.maps_url) profile.mapsUrl = r.maps_url;
  if (r.website) profile.existingWebsite = r.website;
  if (r.email) profile.email = r.email;
  if (r.socials && Object.keys(r.socials).length > 0) profile.socials = r.socials;
  return profile;
}

/**
 * Score + store a batch of Places results as leads.
 *
 * @param results - Raw Google Places results.
 * @param deps - Injected `createLead`.
 * @param opts - `onlyNoWebsite` (default true) keeps only the prime no-website leads;
 *   `source` tags the lead provenance (default 'google_places'; the OSM fallback passes 'osm').
 * @returns A {@link ScanSummary}; never throws (a per-lead failure counts as an error).
 */
export async function scanResultsToLeads(
  results: PlacesResult[],
  deps: ScanDeps,
  opts: { onlyNoWebsite?: boolean; source?: string } = {},
): Promise<ScanSummary> {
  const onlyNoWebsite = opts.onlyNoWebsite ?? true;
  const source = opts.source ?? 'google_places';
  const summary: ScanSummary = {
    scanned: 0,
    created: 0,
    skippedHasWebsite: 0,
    skippedDuplicate: 0,
    errors: 0,
  };
  const seen = new Set<string>();

  for (const r of results) {
    summary.scanned++;
    if (seen.has(r.place_id)) {
      summary.skippedDuplicate++;
      continue;
    }
    seen.add(r.place_id);

    const score = scoreLead({
      website: r.website,
      phone: r.phone,
      rating: r.rating,
      userRatingsTotal: r.review_count,
      types: r.types,
      // Intent signals captured from OSM contact:* tags (AL-029) — a siteless
      // business with an active social presence is the hottest lead.
      socials: r.socials,
      email: r.email,
    });

    if (onlyNoWebsite && score.hasWebsite) {
      summary.skippedHasWebsite++;
      continue;
    }

    try {
      const res = await deps.createLead(toProfile(r), {
        placeId: r.place_id,
        hasWebsite: score.hasWebsite,
        leadScore: score.leadScore,
        priority: score.priority,
        source,
        ...(r.phone ? { phone: r.phone } : {}),
        ...(r.email ? { email: r.email } : {}),
        ...(r.socials && Object.keys(r.socials).length > 0 ? { socials: r.socials } : {}),
      });
      // A cross-scan duplicate (place_id already stored) comes back flagged, NOT thrown —
      // tally it as skippedDuplicate so a re-scan reports honestly (never as `errors`).
      if (res.duplicate) summary.skippedDuplicate++;
      else summary.created++;
    } catch {
      summary.errors++;
    }
  }

  return summary;
}
