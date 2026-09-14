/**
 * Leads store — the shared dependency for the lead scanner (#9) and the
 * claimyour.site prefill (#1).
 *
 * @remarks
 * The scanner persists a researched {@link ClaimLeadProfile} (+ no-website /
 * score / priority meta) as a `scanned_leads` row; the claim flow reads it back to
 * prefill `/create`. The profile is stored as validated JSON (reusing
 * `ClaimLeadProfileSchema`), scoring signals as queryable columns. D1 via the
 * helper layer (mockable). Table: migration `0569_scanned_leads.sql`.
 *
 * @example
 * ```ts
 * const { leadId } = await createLead(env.DB, profile, { hasWebsite:false, leadScore:88, priority:true });
 * const lead = await getLead(env.DB, leadId); // → { leadId, profile }
 * ```
 */
import type { D1Database } from '@cloudflare/workers-types';
import { dbQueryOne, dbInsert, dbQuery, dbExecute } from './db.js';
import { ClaimLeadProfileSchema, type ClaimLeadProfile } from './claim_lead_profile.js';

const TABLE = 'scanned_leads';

/** Scoring / provenance meta stored alongside the profile (queryable columns). */
export interface LeadMeta {
  placeId?: string;
  hasWebsite?: boolean;
  leadScore?: number;
  priority?: boolean;
  email?: string;
  emailStatus?: string;
  source?: string;
  /** Contact phone (from OSM `contact:*` or enrichment). */
  phone?: string;
  /** Discovered website URL (a siteless lead with a site found elsewhere). */
  website?: string;
  /** Social profile URLs by network key (see `social_links.ts`). */
  socials?: Record<string, string>;
}

/** A retrieved lead. */
export interface Lead {
  leadId: string;
  profile: ClaimLeadProfile;
}

/**
 * Persist a researched lead. Validates the profile before writing (a profile
 * missing `businessName` throws — never store a junk lead).
 *
 * @param db - D1 binding.
 * @param profile - The researched {@link ClaimLeadProfile}.
 * @param meta - Optional scoring / provenance signals.
 * @returns The generated `leadId`.
 */
export async function createLead(
  db: D1Database,
  profile: ClaimLeadProfile,
  meta: LeadMeta = {},
): Promise<{ leadId: string; duplicate?: boolean }> {
  const validated = ClaimLeadProfileSchema.parse(profile); // throws on missing businessName
  const placeId = meta.placeId ?? null;
  // Cross-scan dedup (the honest counterpart to the intra-batch `seen` set in
  // scanResultsToLeads): scanned_leads.place_id carries a UNIQUE index, so a re-scanned
  // business's insert would FAIL → the caller's per-lead catch miscounts a HEALTHY re-scan
  // of an already-scanned area as `errors` (an operator reads "created 1 · errors 199" and
  // panics — AL-564). Detect the existing row here and report it as a benign duplicate so
  // the scan tallies `skippedDuplicate`, not `errors`. Only place_id-bearing leads dedupe;
  // a null place_id (manual/enriched lead) always inserts.
  if (placeId) {
    const existing = await dbQueryOne<{ id: string }>(
      db,
      `SELECT id FROM ${TABLE} WHERE place_id = ?`,
      [placeId],
    );
    if (existing) return { leadId: existing.id, duplicate: true };
  }
  const leadId = crypto.randomUUID();
  const socials = meta.socials ?? validated.socials;
  const { error } = await dbInsert(db, TABLE, {
    id: leadId,
    business_name: validated.businessName,
    profile_json: JSON.stringify(validated),
    place_id: placeId,
    has_website: meta.hasWebsite ? 1 : 0,
    lead_score: meta.leadScore ?? 0,
    priority: meta.priority ? 1 : 0,
    email: meta.email ?? validated.email ?? null,
    email_status: meta.emailStatus ?? null,
    source: meta.source ?? null,
    phone: meta.phone ?? validated.phone ?? null,
    website: meta.website ?? validated.existingWebsite ?? null,
    socials_json: socials && Object.keys(socials).length > 0 ? JSON.stringify(socials) : null,
  });
  // Surface a persist failure instead of a lying-success: scanResultsToLeads counts a
  // returned leadId as `created`, so a silently-dropped insert would inflate the scan
  // summary (created > actually-stored). Throw → the caller's per-lead catch counts it
  // as `errors`, consistent with the ClaimLeadProfileSchema.parse throw above.
  if (error) throw new Error(`createLead: failed to persist to ${TABLE}: ${error}`);
  return { leadId };
}

/**
 * Read a lead by id, parsing + validating its stored profile.
 *
 * @param db - D1 binding.
 * @param leadId - The lead id.
 * @returns The {@link Lead}, or `null` when absent OR the stored profile is
 *   corrupt/invalid (defensive — never throws on bad data).
 */
export async function getLead(db: D1Database, leadId: string): Promise<Lead | null> {
  const row = await dbQueryOne<{ id: string; profile_json: string }>(
    db,
    `SELECT id, profile_json FROM ${TABLE} WHERE id = ?`,
    [leadId],
  );
  if (!row) return null;
  try {
    const profile = ClaimLeadProfileSchema.parse(JSON.parse(row.profile_json));
    return { leadId: row.id, profile };
  } catch {
    return null;
  }
}

/** A lead row for the Super-Admin scanner list (queryable columns, no JSON parse). */
export interface LeadSummary {
  leadId: string;
  businessName: string;
  hasWebsite: boolean;
  leadScore: number;
  priority: boolean;
  email: string | null;
  emailStatus: string | null;
  source: string | null;
  createdAt: string;
  /** Contact phone (OSM/enrichment), or null. */
  phone: string | null;
  /** Website discovered for a nominally-siteless lead, or null. */
  website: string | null;
  /** network-key → profile URL (parsed from socials_json; `{}` when none). */
  socials: Record<string, string>;
  /** ISO timestamp of the last /enrich run, or null (never enriched). */
  enrichedAt: string | null;
}

/** Options for {@link listLeads}. */
export interface ListLeadsOptions {
  /** Page size, clamped to 1..200 (default 50). */
  limit?: number;
  /** Row offset, floored at 0 (default 0). */
  offset?: number;
  /** When true, return only leads with no website (the scanner's prime signal). */
  onlyNoWebsite?: boolean;
}

interface LeadRow {
  id: string;
  business_name: string;
  has_website: number;
  lead_score: number;
  priority: number;
  email: string | null;
  email_status: string | null;
  source: string | null;
  created_at: string;
  phone: string | null;
  website: string | null;
  socials_json: string | null;
  enriched_at: string | null;
}

/** Parse a stored socials_json blob into a safe network→url map (never throws). */
function parseSocials(json: string | null): Record<string, string> {
  if (!json) return {};
  try {
    const obj = JSON.parse(json) as unknown;
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (typeof v === 'string' && v.trim()) out[k] = v;
      }
      return out;
    }
  } catch {
    /* corrupt blob → empty (defensive; never break the list) */
  }
  return {};
}

/**
 * List scanned leads for the Super-Admin scanner UI, highest score first. Reads
 * only the queryable columns (no per-row profile JSON parse). `scanned_leads`
 * has no soft-delete column, so every row is live.
 *
 * @param db - D1 binding.
 * @param opts - {@link ListLeadsOptions} (limit clamped 1..200, offset floored 0).
 * @returns Typed {@link LeadSummary}[] (0/1 columns mapped to booleans).
 * @example
 * const leads = await listLeads(env.DB, { onlyNoWebsite: true, limit: 50 });
 */
export async function listLeads(
  db: D1Database,
  opts: ListLeadsOptions = {},
): Promise<LeadSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const websiteFilter = opts.onlyNoWebsite ? 'AND has_website = 0' : '';
  const { data } = await dbQuery<LeadRow>(
    db,
    `SELECT id, business_name, has_website, lead_score, priority, email, email_status, source, created_at,
            phone, website, socials_json, enriched_at
     FROM ${TABLE} WHERE 1 = 1 ${websiteFilter}
     ORDER BY lead_score DESC, created_at DESC
     LIMIT ? OFFSET ?`,
    [limit, offset],
  );
  return data.map((row) => ({
    leadId: row.id,
    businessName: row.business_name,
    hasWebsite: row.has_website === 1,
    leadScore: row.lead_score,
    priority: row.priority === 1,
    email: row.email,
    emailStatus: row.email_status,
    source: row.source,
    createdAt: row.created_at,
    phone: row.phone ?? null,
    website: row.website ?? null,
    socials: parseSocials(row.socials_json),
    enrichedAt: row.enriched_at ?? null,
  }));
}

/**
 * Persist a contact bundle discovered by the /enrich endpoint onto an existing
 * lead — updates the queryable columns AND folds the socials/website/phone/email
 * back into the stored `profile_json` (so the claim prefill sees them too). Never
 * throws; a corrupt stored profile is left as-is (columns still update).
 *
 * @param db      - D1 binding.
 * @param leadId  - The lead id.
 * @param contact - Discovered `{ website?, phone?, email?, socials? }`.
 * @param nowIso  - Injected ISO timestamp for `enriched_at` (testable clock).
 * @param leadScore - Optional recomputed intent-weighted score (from `scoreLead`
 *   over the enriched signals). When provided, re-ranks the lead in the list;
 *   omit to leave the existing score unchanged.
 * @returns `{ updated: boolean }` — false when the lead does not exist.
 */
export async function updateLeadContact(
  db: D1Database,
  leadId: string,
  contact: { website?: string; phone?: string; email?: string; socials?: Record<string, string> },
  nowIso: string,
  leadScore?: number,
): Promise<{ updated: boolean }> {
  const existing = await dbQueryOne<{
    id: string;
    profile_json: string;
    socials_json: string | null;
  }>(db, `SELECT id, profile_json, socials_json FROM ${TABLE} WHERE id = ?`, [leadId]);
  if (!existing) return { updated: false };

  // Union new socials over any already stored (new values win per key).
  const merged = { ...parseSocials(existing.socials_json), ...(contact.socials ?? {}) };
  const socialsJson = Object.keys(merged).length > 0 ? JSON.stringify(merged) : null;

  // Fold contact back into profile_json so the claim prefill stays consistent.
  let profileJson = existing.profile_json;
  try {
    const profile = ClaimLeadProfileSchema.parse(JSON.parse(existing.profile_json));
    if (contact.phone) profile.phone = contact.phone;
    if (contact.email) profile.email = contact.email;
    if (contact.website) profile.existingWebsite = contact.website;
    if (Object.keys(merged).length > 0) profile.socials = merged;
    profileJson = JSON.stringify(profile);
  } catch {
    /* corrupt stored profile → leave profile_json untouched, still update columns */
  }

  await dbExecute(
    db,
    `UPDATE ${TABLE}
       SET phone = COALESCE(?, phone),
           email = COALESCE(?, email),
           website = COALESCE(?, website),
           socials_json = ?,
           lead_score = COALESCE(?, lead_score),
           profile_json = ?,
           enriched_at = ?
     WHERE id = ?`,
    [
      contact.phone ?? null,
      contact.email ?? null,
      contact.website ?? null,
      socialsJson,
      leadScore ?? null,
      profileJson,
      nowIso,
      leadId,
    ],
  );
  return { updated: true };
}
