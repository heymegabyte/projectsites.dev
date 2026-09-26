/**
 * Site creation — the reusable core extracted from `POST /api/sites`.
 *
 * @remarks
 * Builds the `sites` row, inserts it, writes the `site.created` audit log, and
 * fires the PostHog `created` event (fire-and-forget). Slug RESOLUTION (the
 * AI/user/derived slug) stays at the call site — this service takes the resolved
 * slug and persists. Extracted so the claimyour.site funnel can provision a site
 * from a lead profile the same way the manual `POST /api/sites` route does
 * (one site-creation definition, no drift).
 *
 * @example
 * ```ts
 * const site = await createSite(env, { orgId, slug, businessName }, { actorId, requestId, executionCtx });
 * ```
 *
 * @packageDocumentation
 */
import type { Env } from '../types/env.js';
import { dbInsert } from './db.js';
import { writeAuditLog } from './audit.js';
import { trackSite } from '../lib/posthog.js';
import { tryEmitEvent } from './emit_event.js';
import { grantSiteOwner } from './authz_bootstrap.js';
import { badRequest } from '@project-sites/shared';

/** The fields a caller provides to provision a site (slug already resolved). */
export interface CreateSiteInput {
  orgId: string;
  slug: string;
  businessName: string;
  businessPhone?: string | null;
  businessEmail?: string | null;
  businessAddress?: string | null;
  googlePlaceId?: string | null;
}

/** Request-scoped context for audit + analytics (optional outside a request). */
export interface CreateSiteCtx {
  actorId?: string | null;
  requestId?: string;
  executionCtx?: ExecutionContext;
}

/** The persisted `sites` row (the shape returned to API callers as `data`). */
export interface SiteRow {
  id: string;
  org_id: string;
  slug: string;
  business_name: string;
  business_phone: string | null;
  business_email: string | null;
  business_address: string | null;
  google_place_id: string | null;
  bolt_chat_id: string | null;
  current_build_version: string | null;
  status: string;
  lighthouse_score: number | null;
  lighthouse_last_run: string | null;
  deleted_at: string | null;
}

/**
 * Persist a new site row + audit + analytics.
 *
 * @param env   - Worker env (uses `env.DB` + PostHog config).
 * @param input - The resolved site fields ({@link CreateSiteInput}).
 * @param ctx   - Optional audit/analytics context.
 * @returns The created {@link SiteRow}.
 * @throws {AppError} `BAD_REQUEST` when the D1 insert fails (typically a slug
 *   collision via the `sites.slug` unique index).
 */
export async function createSite(
  env: Env,
  input: CreateSiteInput,
  ctx: CreateSiteCtx = {},
): Promise<SiteRow> {
  const site: SiteRow = {
    id: crypto.randomUUID(),
    org_id: input.orgId,
    slug: input.slug,
    business_name: input.businessName,
    business_phone: input.businessPhone ?? null,
    business_email: input.businessEmail ?? null,
    business_address: input.businessAddress ?? null,
    google_place_id: input.googlePlaceId ?? null,
    bolt_chat_id: null,
    current_build_version: null,
    status: 'draft',
    lighthouse_score: null,
    lighthouse_last_run: null,
    deleted_at: null,
  };

  const result = await dbInsert(env.DB, 'sites', site as unknown as Record<string, unknown>);
  if (result.error) throw badRequest(`Failed to create site: ${result.error}`);

  await writeAuditLog(env.DB, {
    org_id: input.orgId,
    actor_id: ctx.actorId ?? null,
    action: 'site.created',
    message: `Site '${input.slug}' created for '${input.businessName}'`,
    target_type: 'site',
    target_id: site.id,
    metadata_json: { site_id: site.id, slug: input.slug, business_name: input.businessName },
    request_id: ctx.requestId,
  });

  // PostHog is fire-and-forget — analytics failures NEVER block site creation,
  // and a non-request caller (e.g. a workflow) without an executionCtx skips it.
  if (ctx.executionCtx) {
    try {
      trackSite(env, ctx.executionCtx, 'created', ctx.actorId || input.orgId, {
        site_id: site.id,
        slug: site.slug,
      });
    } catch {
      /* fire-and-forget */
    }
  }

  // Emit site.created onto the durable bus (drained to Tinybird activation
  // analytics + Hatchet orchestration). Idempotent per site id; tryEmitEvent
  // never throws. waitUntil'd under a request so it never blocks the response;
  // awaited inline for a non-request caller (workflow) so the row still lands.
  const emit = tryEmitEvent(
    env,
    {
      type: 'site.created',
      producer: 'worker',
      tenantId: input.orgId,
      traceId: ctx.requestId ?? site.id,
      siteId: site.id,
      ...(ctx.actorId ? { userId: ctx.actorId } : {}),
      data: { slug: site.slug, businessName: input.businessName },
    },
    { scope: [site.id] },
  );
  if (ctx.executionCtx) {
    try {
      ctx.executionCtx.waitUntil(emit);
    } catch {
      void emit;
    }
  } else {
    await emit;
  }

  // GitHub repo provisioning — every site gets a private repo at
  // github.com/projectsites-dev/{site.id} as canonical source-of-truth.
  // Fire-and-forget: repo creation latency (~2s) never blocks site creation.
  // Feature-flag-gated behind `github_repo_sync` (experimental, default-off).
  if (ctx.executionCtx) {
    const ghRepo = (async () => {
      try {
        const { isFlagOn } = await import('../modules/feature_flags/services.js');
        if (
          !(await isFlagOn(env, 'github_repo_sync', {
            orgId: ctx.actorId ?? undefined,
            siteId: site.id,
          }))
        )
          return;
        const { createRepo } = await import('./github_repo.js');
        await createRepo(env, site.id);
      } catch {
        /* fail-soft — GitHub outage never blocks site creation */
      }
    })();
    try {
      ctx.executionCtx.waitUntil(ghRepo);
    } catch {
      void ghRepo;
    }
  }

  // Per-site data-resource provisioning (Data Platform re-arch, Phase 0c — docs/data-platform-scope.md).
  // Every (paid) site gets its OWN D1 + KV + R2, provisioned IN PARALLEL. Flag-gated behind
  // `per_site_data` (experimental, default-off → DARK: no real Cloudflare resources are created until
  // the flag is promoted). Fail-soft: a CF/provisioning hiccup NEVER blocks site creation, and each
  // provisioner is idempotent + records into `site_database_allocations`, so a later retry converges.
  if (ctx.executionCtx) {
    const provision = (async () => {
      try {
        const { isFlagOn } = await import('../modules/feature_flags/services.js');
        if (
          !(await isFlagOn(env, 'per_site_data', {
            orgId: ctx.actorId ?? undefined,
            siteId: site.id,
          }))
        )
          return;
        const [{ provisionSiteD1 }, { provisionSiteKv }, { provisionSiteR2 }] = await Promise.all([
          import('./d1_provisioner.js'),
          import('./kv_provisioner.js'),
          import('./r2_provisioner.js'),
        ]);
        const args = { orgId: ctx.actorId ?? null, siteId: site.id, tenantId: input.orgId };
        await Promise.all([
          provisionSiteD1(env, args),
          provisionSiteKv(env, args),
          provisionSiteR2(env, args),
        ]);
      } catch {
        /* fail-soft — a provisioning / CF outage never blocks site creation (idempotent retry later) */
      }
    })();
    try {
      ctx.executionCtx.waitUntil(provision);
    } catch {
      void provision;
    }
  }

  // Authz relationship bootstrap (§29/ADR-0005): make the creating user the OWNER
  // of this site in the authorization graph, so the (deferred) requireAuthz
  // ('can_publish') guard passes once OpenFGA is live. Skipped for an anonymous /
  // workflow create (no actorId — nobody to own it). grantSiteOwner is itself
  // fail-soft (logs, never throws), but we keep the same waitUntil/await side-
  // effect discipline as the bus emit; it's a no-op under DenyAll until OpenFGA
  // is configured, so wiring it now is regression-free and pre-populates the graph.
  if (ctx.actorId) {
    const grant = grantSiteOwner(env, ctx.actorId, site.id).catch(() => {
      /* fail-soft — authz outage never blocks site creation */
    });
    if (ctx.executionCtx) {
      try {
        ctx.executionCtx.waitUntil(grant);
      } catch {
        void grant;
      }
    } else {
      await grant;
    }
  }

  return site;
}
