/**
 * @module libs/features/data_resource_registry/r2_presign
 * @description Short-lived, SCOPED presigned R2 URL minting for the per-site R2 file browser (FIRE 5).
 *
 * The R2 browser's download + upload paths need a URL the BROWSER can hit directly (never routing large
 * object bytes through the Worker), but SECURITY-INVARIANTS INV-6 forbids ever sending an account
 * credential to the browser. This module resolves that tension the CF-native way:
 *
 *   1. Mint SHORT-LIVED SCOPED S3 credentials via CF's `POST /accounts/{acct}/r2/temp-access-credentials`
 *      — the temp creds are locked to ONE bucket + ONE permission (`object-read-only` for a download,
 *      `object-read-write` for an upload) + a small TTL (default 15 min). They are the minimum-privilege
 *      key material; they can address nothing but that one bucket, and they expire fast.
 *   2. Presign a single-object, single-verb S3 URL (SigV4 query-string presign) with those temp creds,
 *      server-side. The presigned URL embeds a signature + expiry — NOT the credentials.
 *   3. Return ONLY the presigned URL (+ its TTL) to the caller. The temp creds NEVER leave the Worker
 *      and are discarded after signing.
 *
 * The result is a scoped, time-boxed, single-object, single-verb handle — never an account credential,
 * never even the temp S3 credential (INV-6 satisfied by construction). If temp-credential minting is not
 * available on the deployment (no `CF_API_TOKEN`, global-key auth which the temp-creds API rejects, or a
 * transient CF failure), this returns an HONEST `not_available` with the reason — never a fabricated URL.
 *
 * @packageDocumentation
 */
import { AwsClient } from 'aws4fetch';

import type { CfAuth } from '../../../src/services/cf_credentials.js';

/** CF REST API base (mirrors the adapters). */
const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

/** Default lifetime of a minted presigned URL — short-lived by construction (INV-6). */
const DEFAULT_TTL_SECONDS = 15 * 60;
/** Hard ceiling on the TTL a caller may request (temp creds themselves are capped at 1h by CF). */
const MAX_TTL_SECONDS = 60 * 60;

/** The verb a presigned URL is scoped to — a download (GET) or an upload (PUT). One URL, one verb. */
export type R2PresignVerb = 'download' | 'upload';

/** Input to {@link mintScopedR2Url}: which object + which verb (a CF id is server-resolved upstream). */
export interface R2PresignInput {
  /** The S3 bucket name the object lives in — resolved server-side from the registry (never the caller). */
  readonly bucket: string;
  /** The exact object key to sign a URL for. */
  readonly key: string;
  /** `download` → a GET url (object-read-only creds); `upload` → a PUT url (object-read-write creds). */
  readonly verb: R2PresignVerb;
  /** Requested lifetime in seconds; clamped to `[60, 3600]`, default 900. */
  readonly ttlSeconds?: number;
  /** For an upload: the content-type the client will send (signed into the URL so the PUT matches). */
  readonly contentType?: string;
}

/**
 * The outcome of minting a scoped presigned URL. Honest by construction:
 *  - `available:false` + `reason` when minting is not wired/possible (never a fabricated URL).
 *  - a `url` is present ONLY when a genuinely scoped, short-lived, single-object handle was minted — it is
 *    NEVER an account credential and NEVER the temp S3 credential (INV-6).
 */
export type R2PresignResult =
  | {
      readonly available: true;
      readonly verb: R2PresignVerb;
      /** The short-lived SCOPED presigned URL (single object, single verb). NEVER a credential. */
      readonly url: string;
      /** Seconds until the URL expires. */
      readonly expiresInSeconds: number;
    }
  | {
      readonly available: false;
      /** Honest reason minting could not happen (surfaced to the owner verbatim). */
      readonly reason: string;
    };

/** Clamp a requested TTL into `[60, 3600]`, defaulting to 900 for a missing/invalid value. */
function clampTtl(ttl: number | undefined): number {
  if (typeof ttl !== 'number' || !Number.isFinite(ttl)) return DEFAULT_TTL_SECONDS;
  return Math.min(MAX_TTL_SECONDS, Math.max(60, Math.floor(ttl)));
}

/**
 * The temp-access-credentials API requires a BEARER token (`CF_API_TOKEN` kind) — it does NOT accept the
 * legacy global-key (`X-Auth-Email`/`X-Auth-Key`) header pair. So we can only mint scoped S3 creds when the
 * resolved auth is token-based. Global-key auth → honest `not_available` (never fabricate a URL). This is
 * an INV-6-preserving limitation, not a fallback to a broader credential.
 */
function bearerTokenOrNull(auth: CfAuth): string | null {
  return auth.kind === 'token' ? auth.token : null;
}

/**
 * Mint short-lived SCOPED S3 credentials for ONE bucket + ONE permission via CF's temp-access-credentials
 * API, then presign a single-object, single-verb S3 URL and return ONLY that URL. The temp creds never
 * leave this function. Returns an honest `not_available` on any failure — never a fabricated URL.
 *
 * @param auth - the resolved CF auth; MUST be token-based (the temp-creds API rejects global-key auth)
 * @param accountId - the CF account id (server-resolved, never the caller)
 * @param input - {@link R2PresignInput}: bucket + key + verb (+ optional ttl / content-type)
 */
export async function mintScopedR2Url(
  auth: CfAuth,
  accountId: string,
  input: R2PresignInput,
): Promise<R2PresignResult> {
  const bucket = (input.bucket ?? '').trim();
  const key = input.key ?? '';
  if (!bucket) return { available: false, reason: 'No bucket is resolved for this site.' };
  if (typeof key !== 'string' || key.length === 0) {
    return { available: false, reason: 'Object key is missing or empty.' };
  }

  const token = bearerTokenOrNull(auth);
  if (!token) {
    return {
      available: false,
      reason:
        'Short-lived scoped R2 URLs require a Cloudflare API token on the Worker (the temp-credentials API does not accept the legacy global key). Downloads/uploads fall back to a server-streamed proxy until a token is configured.',
    };
  }

  const ttl = clampTtl(input.ttlSeconds);
  const permission = input.verb === 'upload' ? 'object-read-write' : 'object-read-only';

  // 1. Mint the scoped temp S3 credentials — locked to this ONE bucket + this ONE permission + this TTL.
  let credRes: Response;
  try {
    credRes = await fetch(`${CF_API_BASE}/accounts/${accountId}/r2/temp-access-credentials`, {
      body: JSON.stringify({
        bucket,
        // Scope the credential to the single object where the API allows it (defence-in-depth); a
        // prefix equal to the full key restricts the temp cred to that one object path.
        objects: [key],
        permission,
        ttlSeconds: ttl,
      }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
  } catch (err) {
    return {
      available: false,
      reason: `Could not mint scoped R2 credentials: ${err instanceof Error ? err.message : 'network error'}.`,
    };
  }

  const credJson = (await credRes.json().catch(() => null)) as {
    success?: boolean;
    result?: { accessKeyId?: string; secretAccessKey?: string; sessionToken?: string };
    errors?: unknown;
  } | null;

  if (!credRes.ok || !credJson?.success || !credJson.result?.accessKeyId || !credJson.result.secretAccessKey) {
    const detail = credJson?.errors ? JSON.stringify(credJson.errors) : `HTTP ${credRes.status}`;
    return {
      available: false,
      reason: `Cloudflare declined to mint scoped R2 credentials (${detail}). A server-streamed proxy is used instead.`,
    };
  }

  const { accessKeyId, secretAccessKey, sessionToken } = credJson.result;

  // 2. Presign a single-object, single-verb S3 URL with the SCOPED temp creds (SigV4 query presign). The
  //    signature + expiry ride in the query string; the creds themselves are NOT in the URL.
  const endpoint = `https://${accountId}.r2.cloudflarestorage.com/${encodeURIComponent(bucket)}/${key
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')}`;

  const client = new AwsClient({
    accessKeyId,
    region: 'auto',
    secretAccessKey,
    service: 's3',
    ...(sessionToken ? { sessionToken } : {}),
  });

  let signed: Request;
  try {
    const url = new URL(endpoint);
    url.searchParams.set('X-Amz-Expires', String(ttl));
    signed = await client.sign(url.toString(), {
      aws: { signQuery: true },
      method: input.verb === 'upload' ? 'PUT' : 'GET',
      // For an upload we sign the content-type header so the client's PUT must match it (tamper-evident).
      ...(input.verb === 'upload' && input.contentType
        ? { headers: { 'content-type': input.contentType } }
        : {}),
    });
  } catch (err) {
    return {
      available: false,
      reason: `Could not presign the R2 URL: ${err instanceof Error ? err.message : 'signing error'}.`,
    };
  }

  return {
    available: true,
    expiresInSeconds: ttl,
    url: signed.url,
    verb: input.verb,
  };
}
