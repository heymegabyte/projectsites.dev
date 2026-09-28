/**
 * Feature manifest — Buckets (per-site R2 bucket manager).
 *
 * The R2 analog of the per-site D1 "Tables" surface: an owner manages their site's OWN Cloudflare R2
 * buckets (create/list/delete + object browse/upload/download/delete + copy-address + promote
 * preview→production) from the editor Resources → Buckets tab. Server-resolved + isolated + IDOR-guarded
 * + FORBIDDEN_BUCKET_NAMES-denylisted, exactly like the per-site D1. Flag DARK by default → every route
 * 404s until enabled, so zero real R2 resources are created.
 */
export const manifest = {
  slug: 'r2_buckets',
  name: 'Buckets (per-site R2)',
  description:
    "Per-site R2 bucket manager in the editor Resources tab. Owners create/list/delete their site's OWN R2 buckets (site-prefixed, isolated), browse/upload/download/delete objects, copy the S3 address bundle, toggle public access, and promote preview→production. Bucket CRUD via the CF R2 REST API; object ops via the R2 S3 API (SigV4) when R2 S3 creds are set, else an actionable needs-creds message. Flag-gated DARK → 404 when off.",
  flagKey: 'r2_buckets',
  owner: 'brian@megabyte.space',
  stage: 'experimental' as const,
  createdAt: '2026-09-27',
};
