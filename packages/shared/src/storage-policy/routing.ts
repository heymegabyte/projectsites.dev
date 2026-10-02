/**
 * @module storage-policy
 * @description
 * The ONE shared, server-enforced file-storage-routing policy behind EVERY
 * managed-file write boundary (Cloudflare Artifacts three-bucket architecture,
 * Cycle 1 foundation). Every managed file strictly larger than 30,000,000 bytes
 * (decimal, NOT 30 MiB) belongs in the protected per-account Media R2 bucket,
 * regardless of extension or MIME type; everything else stays on the ordinary
 * Preview/Production source/draft/deployment path.
 *
 * Route on the ACTUAL uncompressed byte length — never compressed Git size,
 * multipart part size, or MIME type. Apply this ONE policy at EVERY write
 * boundary: uploads, Save/Save All, drag-and-drop, replacements, agent + MCP
 * writes, remote imports, template copies, full-IDE sync, generated files,
 * extracted archive members, and build-output ingestion. `'ordinary'` means the
 * existing eligible source/draft/deployment path — NOT an unconditional Git
 * write (existing binary policy + repo quota checks still apply upstream).
 *
 * See `README.md` in this directory for the consumption contract.
 */
import { z } from 'zod';

/**
 * The large-file routing threshold, in BYTES. Defined as 30,000,000 decimal
 * bytes — deliberately NOT 30 MiB (31,457,280). A file whose actual byte length
 * is `> LARGE_FILE_THRESHOLD_BYTES` routes to Media; `<=` stays ordinary. This
 * product policy sits below Artifacts' documented 32 MB single-blob ceiling; it
 * does not remove repository/history quotas.
 */
export const LARGE_FILE_THRESHOLD_BYTES = 30_000_000;

/** The two physical storage tiers a managed file can resolve to. */
export const StorageRoleSchema = z.enum(['ordinary', 'media']);
export type StorageRole = z.infer<typeof StorageRoleSchema>;

/**
 * A validated file byte length: a non-negative safe integer. Browser-declared
 * sizes, archive-member sizes, and streamed byte counts MUST clear this before
 * they drive a routing decision — a dishonest or invalid numeric size fails
 * validation rather than silently publishing a file to the wrong tier.
 */
export const fileByteLengthSchema = z
  .number()
  .int('File byte length must be an integer.')
  .nonnegative('File byte length must be nonnegative.')
  .refine(Number.isSafeInteger, { message: 'File byte length must be a safe integer.' });

/**
 * Select the storage tier for a managed file from its actual uncompressed byte
 * length. This is THE single routing authority — every managed-file write
 * boundary calls it; the client can never choose a tier or bypass the policy.
 *
 * @param byteLength - Actual uncompressed file size in bytes.
 * @returns `'media'` when `byteLength > LARGE_FILE_THRESHOLD_BYTES`, else `'ordinary'`.
 * @throws {RangeError} When `byteLength` is not a non-negative safe integer.
 * @example
 * ```ts
 * selectFileStorage(30_000_000); // 'ordinary' — exactly at the threshold
 * selectFileStorage(30_000_001); // 'media'    — one byte over
 * selectFileStorage(31_457_280); // 'media'    — 30 MiB is above 30 decimal MB
 * ```
 */
export function selectFileStorage(byteLength: number): StorageRole {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new RangeError('File byte length must be a nonnegative safe integer.');
  }
  return byteLength > LARGE_FILE_THRESHOLD_BYTES ? 'media' : 'ordinary';
}

/**
 * Non-throwing variant for untrusted input: validate the declared size with
 * {@link fileByteLengthSchema}, then route. Returns a discriminated result so
 * callers at a trust boundary (upload finalize, declared-size preflight) can
 * reject an invalid size without a try/catch.
 *
 * @param byteLength - Possibly-untrusted declared size in bytes.
 */
export function safeSelectFileStorage(
  byteLength: unknown,
): { ok: true; role: StorageRole } | { ok: false; error: string } {
  const parsed = fileByteLengthSchema.safeParse(byteLength);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid file byte length.' };
  }
  return { ok: true, role: selectFileStorage(parsed.data) };
}

/** True when the file routes to the protected Media R2 tier. */
export function isMediaTier(byteLength: number): boolean {
  return selectFileStorage(byteLength) === 'media';
}

/** True when the file stays on the ordinary Preview/Production path. */
export function isOrdinaryTier(byteLength: number): boolean {
  return selectFileStorage(byteLength) === 'ordinary';
}
