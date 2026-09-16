/**
 * @module services/app_provisioner
 *
 * @description
 * Orchestrates aux-infra provisioning for a new app instance based on the
 * `infra` array declared in the catalog entry. Handles rollback on partial
 * failure so we never strand a Neon project + an Upstash DB after the third
 * call fails.
 *
 * ## Inputs
 *
 *  - `infra: InfraDep[]` from the catalog entry
 *  - `instanceId`, `slug` — used to name the provisioned resources
 *  - `r2Bucket` — the per-instance bucket name we suggest to the user
 *
 * ## Outputs
 *
 * A `ProvisionedInfra` value-object carrying every provisioned ID + the
 * connection strings the env-var resolver feeds into the container.
 *
 * @packageDocumentation
 */
import type { Env } from '../types/env.js';
import type { InfraDep } from '../data/apps-catalog.js';
import * as neon from './neon_provisioner.js';
import * as upstash from './upstash_provisioner.js';

/**
 * Aggregated handles for every aux service spun up by {@link provisionInfra}.
 *
 * @remarks
 * Each property is populated only when the corresponding `InfraDep` was
 * requested by the catalog entry — caller should null-check before passing
 * connection strings into the container env-var resolver. Pair with
 * {@link deprovisionInfra} for clean teardown on app delete.
 */
export interface ProvisionedInfra {
  /** Postgres connection URI + parsed parts (when `postgres` was requested). */
  postgres?: neon.NeonProvisionResult;
  /** Redis REST + native URLs (when `redis` was requested). */
  redis?: upstash.UpstashProvisionResult;
  /** R2 bucket info (when `s3` was requested). */
  s3?: {
    readonly bucketName: string;
    readonly accountId: string;
    readonly endpointUrl: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
  };
  /** When `sqlite`/`volume` requested → tell the DO to allocate persistent storage. */
  needsVolume: boolean;
  /** When `mailrelay` requested → no per-instance provisioning, point at Resend. */
  mailrelay?: { fromAddress: string };
}

/** Provision every aux service listed in `infra`. Rolls back already-provisioned resources on failure. */
export async function provisionInfra(
  env: Env,
  infra: readonly InfraDep[],
  ctx: { instanceId: string; slug: string },
): Promise<ProvisionedInfra> {
  const result: ProvisionedInfra = { needsVolume: false };
  const rollback: Array<() => Promise<void>> = [];

  try {
    if (infra.includes('postgres')) {
      const name = `app-${ctx.slug}-${ctx.instanceId.slice(0, 8)}`;
      const createdPg = await neon.createProject(env, name);
      result.postgres = createdPg;
      rollback.push(() => neon.deleteProject(env, createdPg.projectId).catch(() => undefined));
    }

    if (infra.includes('redis')) {
      const name = `app-${ctx.slug}-${ctx.instanceId.slice(0, 8)}`;
      const createdRedis = await upstash.createDatabase(env, name);
      result.redis = createdRedis;
      rollback.push(() =>
        upstash.deleteDatabase(env, createdRedis.databaseId).catch(() => undefined),
      );
    }

    if (infra.includes('s3')) {
      // R2 buckets are managed via the Cloudflare API — but in practice we
      // suggest reusing the existing `SITES_BUCKET` keyed under
      // `apps/{instanceId}/...`. A separate dedicated bucket can be wired
      // by setting `APPS_BUCKET` and updating this branch.
      const bucketName = `apps-${ctx.instanceId}-${ctx.slug}`.toLowerCase().slice(0, 63);
      const accountId = (env as unknown as { CF_ACCOUNT_ID?: string }).CF_ACCOUNT_ID ?? '';
      // Per-instance access keys must be minted via the CF "create r2 token"
      // API which requires an account-scoped token. We surface a placeholder
      // shape today; the AppRuntime DO is the right place to perform the
      // actual key mint at first-boot so the secret never touches D1.
      result.s3 = {
        bucketName,
        accountId,
        endpointUrl: accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '',
        accessKeyId: '',
        secretAccessKey: '',
      };
    }

    if (infra.includes('sqlite') || infra.includes('volume')) {
      result.needsVolume = true;
    }

    if (infra.includes('mailrelay')) {
      result.mailrelay = { fromAddress: 'noreply@projectsites.dev' };
    }

    return result;
  } catch (err) {
    // Roll back every resource we successfully provisioned before the failure.
    for (const undo of rollback.reverse()) {
      await undo();
    }
    throw err;
  }
}

/** Tear down every aux resource recorded against an instance. Best-effort, never throws. */
export async function deprovisionInfra(
  env: Env,
  ids: {
    neonProjectId?: string | null;
    upstashDatabaseId?: string | null;
    r2BucketName?: string | null;
  },
): Promise<{ neon: boolean; upstash: boolean; r2: boolean }> {
  const out = { neon: true, upstash: true, r2: true };
  if (ids.neonProjectId) {
    try {
      await neon.deleteProject(env, ids.neonProjectId);
    } catch (err) {
      out.neon = false;
      console.warn(
        JSON.stringify({
          level: 'warn',
          service: 'app_provisioner',
          message: 'Neon deprovision failed',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
  if (ids.upstashDatabaseId) {
    try {
      await upstash.deleteDatabase(env, ids.upstashDatabaseId);
    } catch (err) {
      out.upstash = false;
      console.warn(
        JSON.stringify({
          level: 'warn',
          service: 'app_provisioner',
          message: 'Upstash deprovision failed',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
  // R2 bucket deletion is intentionally skipped here — the AppRuntime DO
  // owns bucket cleanup at first-boot key-rotation. Leaving the bucket
  // costs $0 when empty (Cloudflare R2 free tier).
  return out;
}
