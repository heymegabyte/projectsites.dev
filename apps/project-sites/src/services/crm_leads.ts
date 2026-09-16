/**
 * CRM lead sink — pushes scanned, scored leads into Twenty CRM
 * (crm.projectsites.dev) instead of a bespoke D1 table.
 *
 * @remarks
 * AGPL ISOLATION: Twenty is AGPL-licensed. This module talks to it over an HTTP
 * boundary ONLY — no `@twenty/*` package, no shared SDK, no imported types. Every
 * request/response shape is declared LOCALLY here. The Worker env carries only
 * HTTP coordinates (`TWENTY_API_URL`, `TWENTY_API_KEY`). See rule
 * `agpl-isolation-via-http-boundary`.
 *
 * Mapped to Twenty's real Company REST shape (verified live 2026-06-28):
 * standard `name` + composite `address` ({addressStreet1,…}) + 11 custom fields
 * provisioned via the metadata API (leadScore/payTier/outreachChannel/leadSource/
 * externalId/workEmail/leadPhone/leadCategory/emailConfidence/addressConfidence/
 * hasWebsite). Create response is `{data:{createCompany:{id}}}`.
 *
 * {@link leadToCrmCompany} is PURE. {@link upsertLeadToCrm} is a thin, never-throw
 * client that dedupes on `externalId` (idempotent re-scans) and no-ops (skipped)
 * when the CRM is not configured.
 *
 * @packageDocumentation
 */

import type { Env } from '../types/env.js';
import type { LeadSignals, OutreachChannel, PropensityTier } from './lead_propensity.js';
import { payPropensity, contactConfidence } from './lead_propensity.js';

/** A discovered business (locally declared — never a Twenty type). */
export interface DiscoveredBusiness {
  businessName: string;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  category?: string | null;
  mapsUrl?: string | null;
  /** Stable external id (e.g. google place_id / osm:node/ID) for dedupe. */
  externalId?: string | null;
  socials?: Record<string, string> | null;
}

/** The local payload we POST to Twenty's REST `companies` resource. */
export interface CrmLeadPayload {
  /** Twenty Company.name (standard). */
  name: string;
  /** Twenty composite address (standard) — full line in addressStreet1. */
  address?: { addressStreet1: string };
  /** Custom scanner fields (provisioned on Company via the metadata API). */
  leadScore: number;
  payTier: PropensityTier;
  outreachChannel: OutreachChannel;
  leadSource: string;
  hasWebsite: boolean;
  emailConfidence: number;
  addressConfidence: number;
  externalId?: string;
  workEmail?: string;
  leadPhone?: string;
  leadCategory?: string;
}

/** Result of an upsert attempt — never throws. */
export interface CrmUpsertResult {
  ok: boolean;
  /** True when the CRM is not configured (dark) — not an error. */
  skipped: boolean;
  /** True when an existing company matched on externalId (no duplicate created). */
  deduped?: boolean;
  id?: string;
  status?: number;
  error?: string;
}

/** Whether the Twenty CRM HTTP coordinates are configured. */
export function isCrmConfigured(
  env: Env,
): env is Env & { TWENTY_API_URL: string; TWENTY_API_KEY: string } {
  return Boolean(env.TWENTY_API_URL && env.TWENTY_API_KEY);
}

/**
 * Map a discovered business + its scored signals into the Twenty Company payload.
 *
 * Pure: no env, no I/O. Optional fields are omitted (not sent as empty values)
 * so the CRM keeps clean records. Scoring is recomputed from `signals` so the
 * payload always carries a consistent score/tier/confidence triple.
 *
 * @param biz     - The discovered business.
 * @param signals - The scoring signals for {@link payPropensity}.
 * @param source  - Provenance label (e.g. 'google_places', 'osm', 'sos_oh').
 * @returns A {@link CrmLeadPayload} ready for {@link upsertLeadToCrm}.
 */
export function leadToCrmCompany(
  biz: DiscoveredBusiness,
  signals: LeadSignals,
  source: string,
): CrmLeadPayload {
  const prop = payPropensity(signals);
  const contact = contactConfidence(signals);

  const payload: CrmLeadPayload = {
    name: biz.businessName,
    leadScore: prop.score,
    payTier: prop.tier,
    outreachChannel: contact.channel,
    leadSource: source,
    hasWebsite: signals.hasWebsite,
    emailConfidence: contact.emailConfidence,
    addressConfidence: contact.addressConfidence,
  };
  if (biz.address) payload.address = { addressStreet1: biz.address };
  if (biz.email) payload.workEmail = biz.email;
  if (biz.phone) payload.leadPhone = biz.phone;
  if (biz.category) payload.leadCategory = biz.category;
  if (biz.externalId) payload.externalId = biz.externalId;
  return payload;
}

/** Build the auth headers for a Twenty REST call. */
function crmHeaders(env: Env): Record<string, string> {
  return {
    Authorization: `Bearer ${env.TWENTY_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Look up an existing company id by externalId (idempotent re-scans). Returns the
 * id when found, null when absent or on any error (fail-open → create proceeds).
 */
async function findByExternalId(
  base: string,
  env: Env,
  externalId: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  try {
    const url = `${base}/rest/companies?filter=externalId[eq]:${encodeURIComponent(externalId)}&limit=1`;
    const res = await fetchImpl(url, { headers: crmHeaders(env) });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as {
      data?: { companies?: Array<{ id?: string }> };
    };
    return body?.data?.companies?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Upsert a lead into Twenty CRM over the HTTP boundary.
 *
 * @remarks
 * Never throws. Returns `{ skipped: true }` when the CRM is unconfigured (dark
 * launch). Dedupes on `externalId` first — an existing match returns
 * `{ ok: true, deduped: true, id }` without creating a duplicate. Otherwise POSTs
 * to `/rest/companies` and reads `data.createCompany.id`.
 *
 * @param env     - Worker env (HTTP coordinates only).
 * @param payload - The local {@link CrmLeadPayload}.
 * @param fetchImpl - Injectable fetch (tests pass a stub); defaults to global fetch.
 * @returns A {@link CrmUpsertResult}.
 */
export async function upsertLeadToCrm(
  env: Env,
  payload: CrmLeadPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<CrmUpsertResult> {
  if (!isCrmConfigured(env)) {
    return { ok: false, skipped: true };
  }
  const base = env.TWENTY_API_URL.replace(/\/+$/, '');

  if (payload.externalId) {
    const existing = await findByExternalId(base, env, payload.externalId, fetchImpl);
    if (existing) return { ok: true, skipped: false, deduped: true, id: existing };
  }

  try {
    const res = await fetchImpl(`${base}/rest/companies`, {
      method: 'POST',
      headers: crmHeaders(env),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      return { ok: false, skipped: false, status: res.status, error: `HTTP ${res.status}` };
    }
    const body = (await res.json().catch(() => ({}))) as {
      data?: { createCompany?: { id?: string } };
    };
    const id = body?.data?.createCompany?.id;
    return id ? { ok: true, skipped: false, id } : { ok: true, skipped: false };
  } catch (err) {
    return {
      ok: false,
      skipped: false,
      error: err instanceof Error ? err.message : 'fetch failed',
    };
  }
}
