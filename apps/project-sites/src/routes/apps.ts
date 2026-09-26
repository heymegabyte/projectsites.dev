/**
 * @module routes/apps
 *
 * Worker routes powering the `/admin/apps` tab: the curated `APPS_CATALOG` of
 * self-hostable open-source apps + the per-org `app_instances` CRUD lifecycle.
 *
 * @packageDocumentation
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  badRequest,
  conflict,
  forbidden,
  internalError,
  notFound,
  unauthorized,
} from '@project-sites/shared';
import type { Env, Variables } from '../types/env.js';
import { APPS_CATALOG, type CatalogApp } from '../data/apps-catalog.js';
import { estimateInstanceCost, type InstanceCostEstimate } from '../services/app_cost_meter.js';
import { dbExecute, dbInsert, dbQuery, dbQueryOne, dbUpdate } from '../services/db.js';
import { decrypt, encrypt } from '../services/ai_crypto.js';
import { deprovisionInfra, provisionInfra } from '../services/app_provisioner.js';
import { MissingEnvError, resolveAppEnv } from '../services/app_env_resolver.js';
import { MissingNeonKeyError } from '../services/neon_provisioner.js';
import { MissingUpstashKeyError } from '../services/upstash_provisioner.js';
import * as dispatcher from '../services/container_dispatcher.js';
import * as auditService from '../services/audit.js';
import { clearAppHost, defaultAppHostname, setAppHost } from '../services/app_host_resolver.js';
import { isSupportedSlug } from '../durable_objects/app_runtime_subclasses.js';
import {
  CfProvisionError,
  deployRealPayloadWorker,
  deprovisionPayloadStack,
  provisionPayloadStack,
} from '../services/cloudflare_provisioner.js';

export const apps = new Hono<{ Bindings: Env; Variables: Variables }>();

// ─── Schemas ─────────────────────────────────────────────────

const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const createInstanceBody = z.object({
  app_id: z.string().min(1).max(64),
  subdomain: z
    .string()
    .min(2)
    .max(63)
    .regex(
      SUBDOMAIN_RE,
      'subdomain must be lowercase alphanumeric + hyphen, not starting/ending with hyphen',
    ),
  env_overrides: z.record(z.string().max(8_000)).optional(),
  // Optional owning site — CF-native apps (Payload) cap at MAX_CF_NATIVE_PER_SITE per site.
  site_id: z.string().min(1).max(64).optional(),
});

const patchEnvBody = z.object({
  env_overrides: z.record(z.string().max(8_000)),
});

// ─── DB shape ────────────────────────────────────────────────

interface AppInstanceRow {
  id: string;
  org_id: string;
  created_by: string;
  app_slug: string;
  subdomain: string;
  status: string;
  env_encrypted: string | null;
  env_iv: string | null;
  neon_project_id: string | null;
  upstash_database_id: string | null;
  r2_bucket_name: string | null;
  do_instance_id: string | null;
  // CF-native launcher (Payload on D1 + R2 + Worker) — 0633 migration.
  d1_database_id: string | null;
  worker_script_name: string | null;
  site_id: string | null;
  last_started_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────

function requireAuth(c: { get: (k: string) => string | undefined }): {
  userId: string;
  orgId: string;
} {
  const userId = c.get('userId');
  const orgId = c.get('orgId');
  if (!userId) throw unauthorized('Sign in to use the Apps tab.');
  if (!orgId) throw forbidden('No organization is associated with this session.');
  return { userId, orgId };
}

function catalogById(id: string): CatalogApp | undefined {
  return APPS_CATALOG.find((a) => a.id === id);
}

/**
 * CF-native apps launch as a per-instance Cloudflare stack (own D1 + R2 + Worker)
 * instead of a container. They bypass the Neon/Upstash `provisionInfra` +
 * container-dispatch path and use {@link provisionPayloadStack} /
 * {@link deprovisionPayloadStack}. `isSupportedSlug` gates CONTAINER subclasses, so
 * CF-native slugs are tracked separately + are ALSO "supported" for the UI.
 */
const CF_NATIVE_SLUGS = new Set<string>(['payload']);
function isCfNativeApp(id: string): boolean {
  return CF_NATIVE_SLUGS.has(id);
}
/** Combined support signal for the catalog UI: container subclass OR CF-native. */
function isLaunchableApp(id: string): boolean {
  return isSupportedSlug(id) || isCfNativeApp(id);
}
/** Per-site (or per-org when unscoped) cap on CF-native instances. */
const MAX_CF_NATIVE_PER_SITE = 3;

async function loadInstance(env: Env, orgId: string, id: string): Promise<AppInstanceRow | null> {
  return dbQueryOne<AppInstanceRow>(
    env.DB,
    `SELECT * FROM app_instances WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
    [id, orgId],
  );
}

/**
 * The public host an instance actually serves on. CF-native Payload instances live at
 * `{slug}.cms.projectsites.dev` (WfP dispatch, cert-ready *.cms pack); container apps at
 * `{slug}.app.projectsites.dev`. The admin uses THIS for the "Open" link so it never
 * points at a dead/cert-broken host.
 */
function instancePublicHost(row: AppInstanceRow): string {
  return isCfNativeApp(row.app_slug)
    ? `${row.subdomain}.cms.projectsites.dev`
    : `${row.subdomain}.app.projectsites.dev`;
}

function sanitizeInstance(row: AppInstanceRow): Omit<AppInstanceRow, 'env_encrypted' | 'env_iv'> & {
  env: null;
  public_host: string;
  costEstimate: InstanceCostEstimate;
} {
  // env is NEVER included on list/get — the decrypted-env detail route requires
  // admin role. costEstimate is a live metered monthly estimate (running-state
  // compute + provisioned infra), replacing the static catalog `estCostMonthly`.
  const { env_encrypted: _ee, env_iv: _ev, ...rest } = row;
  return {
    ...rest,
    env: null,
    public_host: instancePublicHost(row),
    costEstimate: estimateInstanceCost(row),
  };
}

async function decryptEnv(env: Env, row: AppInstanceRow): Promise<Record<string, string>> {
  if (!row.env_encrypted) return {};
  try {
    const plain = await decrypt(env, row.env_encrypted);
    return JSON.parse(plain) as Record<string, string>;
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'apps',
        message: 'decryptEnv failed',
        instance_id: row.id,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return {};
  }
}

// ─── Catalog routes (public, cacheable) ─────────────────────

/**
 * `GET /api/apps/catalog` — List every catalog app.
 *
 * @remarks
 * No auth — the catalog drives signup conversion. Cached at the edge.
 */
apps.get('/api/apps/catalog', (c) => {
  // `?supported=true` filters to apps whose per-image DO subclass is wired up
  // in wrangler.toml (the live-bootable top-10) — drives the "Live" vs
  // "Coming soon" pill in the catalog UI. No flag returns the full curated set.
  const supportedFilter = c.req.query('supported');
  const items =
    supportedFilter === 'true' ? APPS_CATALOG.filter((a) => isLaunchableApp(a.id)) : APPS_CATALOG;
  const decorated = items.map((a) => ({ ...a, supported: isLaunchableApp(a.id) }));
  return c.json(
    {
      apps: decorated,
      count: decorated.length,
    },
    200,
    { 'Cache-Control': 'public, max-age=300, s-maxage=300' },
  );
});

/**
 * `GET /api/apps/catalog/:id` — Detail page for one catalog app.
 *
 * @throws 404 NOT_FOUND when the id isn't in {@link APPS_CATALOG}.
 */
apps.get('/api/apps/catalog/:id', (c) => {
  const app = catalogById(c.req.param('id'));
  if (!app) throw notFound(`No app with id '${c.req.param('id')}' in catalog`);
  return c.json({ app: { ...app, supported: isLaunchableApp(app.id) } }, 200, {
    'Cache-Control': 'public, max-age=300, s-maxage=300',
  });
});

/**
 * `GET /api/apps/install-counts` — DISTINCT-org install count per catalog app.
 *
 * @remarks
 * The marketplace's #1 discovery signal ("X orgs running this"). No auth (drives
 * discovery); short-cached. Soft-degrades to `{}` on any DB error so the catalog
 * never breaks over a missing count.
 */
apps.get('/api/apps/install-counts', async (c) => {
  const { data, error } = await dbQuery<{ app_slug: string; n: number }>(
    c.env.DB,
    `SELECT app_slug, COUNT(DISTINCT org_id) AS n FROM app_instances
       WHERE deleted_at IS NULL AND app_slug IS NOT NULL
       GROUP BY app_slug`,
    [],
  );
  const counts: Record<string, number> = {};
  if (!error) for (const r of data) counts[r.app_slug] = Number(r.n);
  return c.json({ counts }, 200, { 'Cache-Control': 'public, max-age=60, s-maxage=60' });
});

// ─── Instance list ───────────────────────────────────────────

/**
 * `GET /api/apps/instances` — List the current org's running app instances.
 *
 * @throws 401 UNAUTHORIZED when org context is missing.
 */
apps.get('/api/apps/instances', async (c) => {
  const { orgId } = requireAuth(c);
  const { data, error } = await dbQuery<AppInstanceRow>(
    c.env.DB,
    `SELECT * FROM app_instances
       WHERE org_id = ? AND deleted_at IS NULL
       ORDER BY created_at DESC`,
    [orgId],
  );
  if (error) throw badRequest(error);
  return c.json({ instances: data.map(sanitizeInstance) });
});

// ─── CF-native lifecycle (Payload CMS on D1 + R2 + Worker) ───

type AppsContext = Context<{ Bindings: Env; Variables: Variables }>;

/**
 * Launch a CF-native app as a per-instance Cloudflare stack: create D1 → R2 →
 * Worker (proven in {@link provisionPayloadStack}, with rollback on any failure),
 * persist the three resource handles on `app_instances`, and return the live URL.
 *
 * @remarks Runs INSTEAD of the container path for {@link isCfNativeApp} slugs — no
 * Neon/Upstash, no container DO. The recorded `d1_database_id` / `worker_script_name`
 * / `r2_bucket_name` are what the DELETE flow cascade-deletes.
 * @throws 409 when the subdomain is taken or the per-site cap is reached.
 * @throws 501 when CF provisioning credentials are unset; 502 on a CF API failure.
 */
async function launchCfNativeInstance(
  c: AppsContext,
  app: CatalogApp,
  body: z.infer<typeof createInstanceBody>,
  userId: string,
  orgId: string,
): Promise<Response> {
  // Subdomain uniqueness — global namespace (mirrors the container path).
  const existing = await dbQueryOne<{ id: string }>(
    c.env.DB,
    `SELECT id FROM app_instances WHERE subdomain = ? AND deleted_at IS NULL`,
    [body.subdomain],
  );
  if (existing) throw conflict(`Subdomain '${body.subdomain}' is already taken.`);

  // Per-site cap (falls back to per-org when the launch isn't site-scoped).
  const countRow = body.site_id
    ? await dbQueryOne<{ n: number }>(
        c.env.DB,
        `SELECT COUNT(*) AS n FROM app_instances WHERE app_slug = ? AND site_id = ? AND deleted_at IS NULL`,
        [app.id, body.site_id],
      )
    : await dbQueryOne<{ n: number }>(
        c.env.DB,
        `SELECT COUNT(*) AS n FROM app_instances WHERE app_slug = ? AND org_id = ? AND deleted_at IS NULL`,
        [app.id, orgId],
      );
  if ((countRow?.n ?? 0) >= MAX_CF_NATIVE_PER_SITE) {
    return c.json(
      {
        error: 'instance_limit_reached',
        app_id: app.id,
        limit: MAX_CF_NATIVE_PER_SITE,
        message: `Maximum ${MAX_CF_NATIVE_PER_SITE} ${app.name} instances per ${
          body.site_id ? 'site' : 'org'
        }.`,
      },
      409,
    );
  }

  const instanceId = crypto.randomUUID();
  // 48-hex-char (24-byte) PAYLOAD_SECRET — self-generated per always.md § Secrets.
  const payloadSecret = Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  let stack;
  try {
    stack = await provisionPayloadStack(c.env, {
      instanceId,
      slug: body.subdomain,
      payloadSecret,
      // Deploy into the WfP dispatch namespace → served at {slug}.cms.projectsites.dev
      // (cert-ready). Falls back to standalone workers.dev only when WfP isn't configured.
      dispatchNamespace: c.env.WFP_NAMESPACE_NAME,
    });
  } catch (err) {
    if (err instanceof CfProvisionError) {
      const status = err.code === 'NO_CREDENTIALS' || err.code === 'NO_ACCOUNT' ? 501 : 502;
      return c.json({ error: err.code, message: err.message }, status);
    }
    throw err;
  }

  const encrypted = await encrypt(c.env, JSON.stringify({ PAYLOAD_SECRET: payloadSecret }));
  const now = new Date().toISOString();
  const { error: insertErr } = await dbInsert(c.env.DB, 'app_instances', {
    id: instanceId,
    org_id: orgId,
    created_by: userId,
    app_slug: app.id,
    subdomain: body.subdomain,
    status: 'running',
    env_encrypted: encrypted,
    env_iv: 'inline',
    neon_project_id: null,
    upstash_database_id: null,
    r2_bucket_name: stack.r2BucketName,
    do_instance_id: null,
    d1_database_id: stack.d1DatabaseId,
    worker_script_name: stack.workerName,
    site_id: body.site_id ?? null,
    last_started_at: now,
    last_error: null,
    created_at: now,
    updated_at: now,
  });
  if (insertErr) {
    // Never strand a stack on a failed insert — tear the just-created CF resources down.
    await deprovisionPayloadStack(c.env, {
      workerName: stack.workerName,
      d1DatabaseId: stack.d1DatabaseId,
      r2BucketName: stack.r2BucketName,
    }).catch(() => undefined);
    throw badRequest(insertErr);
  }

  // Upgrade the bootstrap → the REAL Payload OpenNext bundle in the background so the
  // launch returns fast. The bootstrap already 200s; deployRealPayloadWorker overwrites
  // the SAME worker name with the real admin (migrate D1 + assets + script upload). A
  // failure leaves the bootstrap serving (degraded, still 200) + records last_error.
  c.executionCtx.waitUntil(
    deployRealPayloadWorker(c.env, {
      name: stack.workerName,
      d1DatabaseId: stack.d1DatabaseId,
      r2BucketName: stack.r2BucketName,
      payloadSecret,
      namespace: stack.dispatchNamespace ?? undefined,
    })
      .then(async (r) => {
        await dbUpdate(
          c.env.DB,
          'app_instances',
          r.ok
            ? { status: 'running', last_error: null }
            : { status: 'running', last_error: `payload_bundle: ${r.error ?? 'deploy failed'}` },
          'id = ?',
          [instanceId],
        );
      })
      .catch(async (err) => {
        await dbUpdate(
          c.env.DB,
          'app_instances',
          { status: 'running', last_error: `payload_bundle_throw: ${String(err)}` },
          'id = ?',
          [instanceId],
        ).catch(() => undefined);
      }),
  );

  await auditService.writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: userId,
    action: 'apps.instance.created',
    target_type: 'app_instance',
    target_id: instanceId,
    metadata_json: {
      app_slug: app.id,
      subdomain: body.subdomain,
      kind: 'cf-native',
      d1_database_id: stack.d1DatabaseId,
      r2_bucket_name: stack.r2BucketName,
      worker_script_name: stack.workerName,
    },
    request_id: c.get('requestId'),
  });

  return c.json(
    {
      instance_id: instanceId,
      status: 'running',
      subdomain: body.subdomain,
      url: `https://${stack.subdomain}`,
      admin_url: `https://${stack.subdomain}/admin`,
      // The three CF resource handles this instance owns — surfaced so the owner
      // (and verification) can see exactly what will be torn down on delete.
      resources: {
        d1_database_id: stack.d1DatabaseId,
        r2_bucket_name: stack.r2BucketName,
        worker_script_name: stack.workerName,
        dispatch_namespace: stack.dispatchNamespace,
      },
    },
    201,
  );
}

/**
 * Destroy a CF-native instance: cascade-delete its Worker → D1 → R2 and CONFIRM
 * each is gone (via {@link deprovisionPayloadStack}) BEFORE marking the row
 * destroyed. On any straggler the row is left live with `last_error` set + a 502 —
 * the honest "teardown incomplete" signal, never a lying "destroyed".
 */
async function destroyCfNativeInstance(
  c: AppsContext,
  row: AppInstanceRow,
  userId: string,
  orgId: string,
): Promise<Response> {
  const report = await deprovisionPayloadStack(c.env, {
    workerName: row.worker_script_name,
    d1DatabaseId: row.d1_database_id,
    r2BucketName: row.r2_bucket_name,
    dispatchNamespace: c.env.WFP_NAMESPACE_NAME,
  });

  if (!report.clean) {
    await dbExecute(
      c.env.DB,
      `UPDATE app_instances SET last_error = ?, updated_at = ? WHERE id = ?`,
      [`teardown_incomplete: ${JSON.stringify(report)}`, new Date().toISOString(), row.id],
    );
    return c.json({ ok: false, error: 'teardown_incomplete', cleanup: report }, 502);
  }

  const { error: destroyErr } = await dbExecute(
    c.env.DB,
    `UPDATE app_instances SET status = 'destroyed', deleted_at = ?, updated_at = ? WHERE id = ?`,
    [new Date().toISOString(), new Date().toISOString(), row.id],
  );
  if (destroyErr) throw internalError(`Failed to record instance destroy: ${destroyErr}`);

  try {
    await clearAppHost(c.env, defaultAppHostname(row.subdomain));
  } catch (err) {
    console.warn(
      JSON.stringify({ level: 'warn', event: 'apphost_clear_failed', id: row.id, err: String(err) }),
    );
  }

  await auditService.writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: userId,
    action: 'apps.instance.destroyed',
    target_type: 'app_instance',
    target_id: row.id,
    metadata_json: { kind: 'cf-native', worker: report.worker, d1: report.d1, r2: report.r2 },
    request_id: c.get('requestId'),
  });

  return c.json({ ok: true, cleanup: report });
}

// ─── Instance create ─────────────────────────────────────────

/**
 * `POST /api/apps/instances` — Provision aux infra (Neon DB, Upstash KV, …) and
 * create a new container instance.
 *
 * @remarks
 * Calls {@link provisionInfra} to mint required cloud resources, encrypts the
 * resulting credentials, persists them on the `app_instances` row, then schedules
 * the container boot. Audit-logged. Hostname is `{subdomain}.app.projectsites.dev`.
 *
 * @throws 400 BAD_REQUEST when payload validation fails, subdomain is
 *   malformed, or app slug isn't supported.
 * @throws 401 UNAUTHORIZED when org context is missing.
 * @throws 409 CONFLICT when the subdomain is already taken.
 * @throws 502 BAD_GATEWAY when upstream provisioning (Neon, Upstash) fails.
 */
apps.post('/api/apps/instances', async (c) => {
  const { userId, orgId } = requireAuth(c);
  const body = createInstanceBody.parse(await c.req.json().catch(() => ({})));
  const app = catalogById(body.app_id);
  if (!app) throw badRequest(`Unknown app id '${body.app_id}'`);

  // CF-native apps (Payload CMS) launch a per-instance D1 + R2 + Worker stack — no
  // container, no Neon/Upstash. Fully cascade-deletable on DELETE.
  if (isCfNativeApp(app.id)) {
    return launchCfNativeInstance(c, app, body, userId, orgId);
  }

  // Preflight: only apps with a per-image DO subclass + matching `[[containers]]`
  // block in wrangler.toml can boot. Everything else 424s so the UI surfaces a
  // queued catalog entry instead of provisioning Neon/Upstash + leaving a useless
  // "coming soon" container running.
  if (!isSupportedSlug(app.id)) {
    return c.json(
      {
        error: 'app_not_supported',
        app_id: app.id,
        message: 'Coming soon — this catalog app is queued for a future subclass registration.',
      },
      424,
    );
  }

  // Subdomain uniqueness — global namespace.
  const existing = await dbQueryOne<{ id: string }>(
    c.env.DB,
    `SELECT id FROM app_instances WHERE subdomain = ? AND deleted_at IS NULL`,
    [body.subdomain],
  );
  if (existing) throw conflict(`Subdomain '${body.subdomain}' is already taken.`);

  const instanceId = crypto.randomUUID();

  // Provisioner rolls back already-created resources if any step fails, so callers
  // either get fully provisioned or fully clean.
  let infra;
  try {
    infra = await provisionInfra(c.env, app.infra, { instanceId, slug: app.id });
  } catch (err) {
    if (err instanceof MissingNeonKeyError || err instanceof MissingUpstashKeyError) {
      return c.json(
        {
          error: err.code,
          service: err.service,
          deeplink: err.deeplink,
          message: err.message,
        },
        424,
      );
    }
    throw err;
  }

  // Resolve env vars (auto-fill + secrets + user overrides).
  let envMap: Record<string, string>;
  try {
    envMap = resolveAppEnv(app, infra, body.subdomain, body.env_overrides ?? {});
  } catch (err) {
    // Roll back the just-provisioned infra so we don't strand resources.
    await deprovisionInfra(c.env, {
      neonProjectId: infra.postgres?.projectId,
      upstashDatabaseId: infra.redis?.databaseId,
      r2BucketName: infra.s3?.bucketName,
    });
    if (err instanceof MissingEnvError) {
      return c.json(
        { error: err.code, key: err.key, app_id: err.appId, message: err.message },
        400,
      );
    }
    throw err;
  }

  const encrypted = await encrypt(c.env, JSON.stringify(envMap));
  const now = new Date().toISOString();

  const { error: insertErr } = await dbInsert(c.env.DB, 'app_instances', {
    id: instanceId,
    org_id: orgId,
    created_by: userId,
    app_slug: app.id,
    subdomain: body.subdomain,
    status: 'provisioning',
    env_encrypted: encrypted,
    env_iv: 'inline',
    neon_project_id: infra.postgres?.projectId ?? null,
    upstash_database_id: infra.redis?.databaseId ?? null,
    r2_bucket_name: infra.s3?.bucketName ?? null,
    do_instance_id: instanceId,
    last_started_at: null,
    last_error: null,
    created_at: now,
    updated_at: now,
  });
  if (insertErr) {
    await deprovisionInfra(c.env, {
      neonProjectId: infra.postgres?.projectId,
      upstashDatabaseId: infra.redis?.databaseId,
      r2BucketName: infra.s3?.bucketName,
    });
    throw badRequest(insertErr);
  }

  // Scale-to-zero routing (docs/architecture/scale-to-zero-apps-routing.md):
  // register the default hostname in the KV host-map so the Worker resolves it
  // (and future custom CNAMEs) without a per-request D1 query. A KV failure must
  // NOT fail instance creation — the suffix path still serves it.
  try {
    await setAppHost(c.env, defaultAppHostname(body.subdomain), {
      instanceId,
      appSlug: app.id,
      orgId,
      subdomain: body.subdomain,
    });
  } catch (err) {
    console.warn(
      JSON.stringify({ level: 'warn', event: 'apphost_set_failed', instanceId, err: String(err) }),
    );
  }

  // Fire-and-forget the container start so the API call returns fast. The
  // dispatcher writes a final `status` via the build-status callback.
  c.executionCtx.waitUntil(
    (async () => {
      const start = await dispatcher.startContainer(c.env, {
        instanceId,
        image: app.image,
        port: app.port,
        memoryMB: app.memoryMB,
        env: envMap,
        volumeMB: app.volumeMB,
        appSlug: app.id,
      });
      const { error: startWriteErr } = await dbUpdate(
        c.env.DB,
        'app_instances',
        start.ok
          ? { status: 'starting', last_started_at: new Date().toISOString(), last_error: null }
          : { status: 'error', last_error: start.detail ?? 'start_failed' },
        'id = ?',
        [instanceId],
      );
      // Background task — the response already returned, so a throw is useless.
      // Log the dropped status-write so a stale row is observable.
      if (startWriteErr) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'app_instance_start_status_write_failed',
            instanceId,
            err: startWriteErr,
          }),
        );
      }
    })(),
  );

  await auditService.writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: userId,
    action: 'apps.instance.created',
    target_type: 'app_instance',
    target_id: instanceId,
    metadata_json: { app_slug: app.id, subdomain: body.subdomain },
    request_id: c.get('requestId'),
  });

  return c.json(
    { instance_id: instanceId, status: 'provisioning', subdomain: body.subdomain },
    201,
  );
});

// ─── Instance detail (decrypted env, admin only) ────────────

/**
 * `GET /api/apps/instances/:id` — Fetch one instance with decrypted env vars.
 *
 * @throws 401 UNAUTHORIZED when org context is missing.
 * @throws 403 FORBIDDEN when the instance isn't owned by the caller's org.
 * @throws 404 NOT_FOUND when the id doesn't exist.
 */
apps.get('/api/apps/instances/:id', async (c) => {
  const { orgId } = requireAuth(c);
  const role = c.get('userRole');
  if (role && !['owner', 'admin'].includes(role)) {
    throw forbidden('Only owners/admins can read decrypted env vars.');
  }
  const row = await loadInstance(c.env, orgId, c.req.param('id'));
  if (!row) throw notFound('app_instance not found');
  const decryptedEnv = await decryptEnv(c.env, row);
  return c.json({ instance: { ...sanitizeInstance(row), env: decryptedEnv } });
});

// ─── Instance lifecycle ─────────────────────────────────────

/**
 * `POST /api/apps/instances/:id/restart` — Bounce the container without dropping
 * its persistent state.
 *
 * @remarks
 * Capped at 3 restarts per rolling minute (enforced inside the container DO) to
 * prevent crash loops. Audit-logged.
 *
 * @throws 401 UNAUTHORIZED when org context is missing.
 * @throws 403 FORBIDDEN when the instance isn't owned by the caller's org.
 * @throws 404 NOT_FOUND when the id doesn't exist.
 * @throws 429 RATE_LIMITED when the restart budget is exhausted.
 */
apps.post('/api/apps/instances/:id/restart', async (c) => {
  const { userId, orgId } = requireAuth(c);
  const row = await loadInstance(c.env, orgId, c.req.param('id'));
  if (!row) throw notFound('app_instance not found');
  const r = await dispatcher.restartContainer(c.env, row.id, row.app_slug);
  const { error: restartWriteErr } = await dbUpdate(
    c.env.DB,
    'app_instances',
    r.ok
      ? { status: 'starting', last_started_at: new Date().toISOString(), last_error: null }
      : { status: 'error', last_error: r.detail ?? 'restart_failed' },
    'id = ?',
    [row.id],
  );
  if (restartWriteErr) throw internalError(`Failed to persist restart status: ${restartWriteErr}`);
  await auditService.writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: userId,
    action: 'apps.instance.restarted',
    target_type: 'app_instance',
    target_id: row.id,
    request_id: c.get('requestId'),
  });
  return c.json({ ok: r.ok, detail: r.detail ?? null });
});

/**
 * `POST /api/apps/instances/:id/stop` — Graceful container shutdown (does NOT
 * deprovision aux infra; use `DELETE` for that).
 *
 * @throws 401 UNAUTHORIZED when org context is missing.
 * @throws 403 FORBIDDEN when the instance isn't owned by the caller's org.
 * @throws 404 NOT_FOUND when the id doesn't exist.
 */
apps.post('/api/apps/instances/:id/stop', async (c) => {
  const { userId, orgId } = requireAuth(c);
  const row = await loadInstance(c.env, orgId, c.req.param('id'));
  if (!row) throw notFound('app_instance not found');
  const r = await dispatcher.stopContainer(c.env, row.id, row.app_slug);
  const { error: stopWriteErr } = await dbUpdate(
    c.env.DB,
    'app_instances',
    r.ok ? { status: 'stopped' } : { status: 'error', last_error: r.detail ?? 'stop_failed' },
    'id = ?',
    [row.id],
  );
  if (stopWriteErr) throw internalError(`Failed to persist stop status: ${stopWriteErr}`);
  await auditService.writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: userId,
    action: 'apps.instance.stopped',
    target_type: 'app_instance',
    target_id: row.id,
    request_id: c.get('requestId'),
  });
  return c.json({ ok: r.ok, detail: r.detail ?? null });
});

/**
 * `PATCH /api/apps/instances/:id/env` — Update encrypted env vars and schedule a
 * restart for the new values to take effect.
 *
 * @remarks
 * Values are re-encrypted via {@link encrypt} (AES-GCM per-record IV) before
 * persisting. Audit-logged.
 *
 * @throws 400 BAD_REQUEST when payload validation fails.
 * @throws 401 UNAUTHORIZED when org context is missing.
 * @throws 403 FORBIDDEN when the instance isn't owned by the caller's org.
 * @throws 404 NOT_FOUND when the id doesn't exist.
 */
apps.patch('/api/apps/instances/:id/env', async (c) => {
  const { userId, orgId } = requireAuth(c);
  const body = patchEnvBody.parse(await c.req.json().catch(() => ({})));
  const row = await loadInstance(c.env, orgId, c.req.param('id'));
  if (!row) throw notFound('app_instance not found');
  const app = catalogById(row.app_slug);
  if (!app) throw badRequest(`Catalog entry '${row.app_slug}' no longer exists`);

  const current = await decryptEnv(c.env, row);
  const merged = { ...current, ...body.env_overrides };
  const encrypted = await encrypt(c.env, JSON.stringify(merged));
  const { error: envWriteErr } = await dbUpdate(
    c.env.DB,
    'app_instances',
    { env_encrypted: encrypted, env_iv: 'inline' },
    'id = ?',
    [row.id],
  );
  // User-data write — never report success (or restart with stale env) on a
  // dropped save. Throw BEFORE the restart is scheduled.
  if (envWriteErr) throw internalError(`Failed to save env vars: ${envWriteErr}`);

  // Schedule a restart so the new env-var values take effect.
  c.executionCtx.waitUntil(
    dispatcher.restartContainer(c.env, row.id, row.app_slug).then(async (r) => {
      const { error: restartWriteErr } = await dbUpdate(
        c.env.DB,
        'app_instances',
        r.ok
          ? { status: 'starting', last_started_at: new Date().toISOString(), last_error: null }
          : { status: 'error', last_error: r.detail ?? 'restart_failed' },
        'id = ?',
        [row.id],
      );
      // Background task — the response already returned; log a dropped write.
      if (restartWriteErr) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'app_instance_env_restart_status_write_failed',
            instanceId: row.id,
            err: restartWriteErr,
          }),
        );
      }
    }),
  );

  await auditService.writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: userId,
    action: 'apps.instance.env_updated',
    target_type: 'app_instance',
    target_id: row.id,
    metadata_json: { keys: Object.keys(body.env_overrides) },
    request_id: c.get('requestId'),
  });
  return c.json({ ok: true, status: 'starting' });
});

/**
 * `DELETE /api/apps/instances/:id` — Destroy the instance and deprovision its aux
 * infra (Neon DB, Upstash KV, R2 bucket, …).
 *
 * @remarks
 * {@link deprovisionInfra} is best-effort — partial failures are logged but never
 * block the row deletion. Audit-logged.
 *
 * @throws 401 UNAUTHORIZED when org context is missing.
 * @throws 403 FORBIDDEN when the instance isn't owned by the caller's org.
 * @throws 404 NOT_FOUND when the id doesn't exist.
 */
apps.delete('/api/apps/instances/:id', async (c) => {
  const { userId, orgId } = requireAuth(c);
  const row = await loadInstance(c.env, orgId, c.req.param('id'));
  if (!row) throw notFound('app_instance not found');

  // CF-native (Payload): cascade-delete the per-instance D1 + R2 + Worker and CONFIRM
  // each is gone before marking destroyed — the "no dangling CF resources" guarantee.
  if (isCfNativeApp(row.app_slug)) {
    return destroyCfNativeInstance(c, row, userId, orgId);
  }

  // Destroy the container layer first so volume + DO state are freed.
  await dispatcher.destroyContainer(c.env, row.id, row.app_slug);

  const cleanup = await deprovisionInfra(c.env, {
    neonProjectId: row.neon_project_id,
    upstashDatabaseId: row.upstash_database_id,
    r2BucketName: row.r2_bucket_name,
  });

  const { error: destroyErr } = await dbExecute(
    c.env.DB,
    `UPDATE app_instances SET status = 'destroyed', deleted_at = ?, updated_at = ? WHERE id = ?`,
    [new Date().toISOString(), new Date().toISOString(), row.id],
  );
  // Container + aux infra are ALREADY torn down above — the record MUST reflect
  // that. A silent write failure would leave a live-looking row for a destroyed
  // instance (a lying "destroyed"); surface it so the inconsistency is visible.
  if (destroyErr) throw internalError(`Failed to record instance destroy: ${destroyErr}`);

  // Scale-to-zero routing: drop the host-map entry so the hostname stops
  // resolving. Best-effort — a KV failure must not fail the destroy.
  try {
    await clearAppHost(c.env, defaultAppHostname(row.subdomain));
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'apphost_clear_failed',
        id: row.id,
        err: String(err),
      }),
    );
  }

  await auditService.writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: userId,
    action: 'apps.instance.destroyed',
    target_type: 'app_instance',
    target_id: row.id,
    metadata_json: {
      neon_cleaned: cleanup.neon,
      upstash_cleaned: cleanup.upstash,
      r2_cleaned: cleanup.r2,
    },
    request_id: c.get('requestId'),
  });

  return c.json({ ok: true, cleanup });
});

// ─── Logs (SSE proxy) ───────────────────────────────────────

/**
 * `GET /api/apps/instances/:id/logs?tail=N` — Tail the last N log lines from the
 * container's SQLite ring buffer (max 1000).
 *
 * @throws 401 UNAUTHORIZED when org context is missing.
 * @throws 403 FORBIDDEN when the instance isn't owned by the caller's org.
 * @throws 404 NOT_FOUND when the id doesn't exist.
 */
apps.get('/api/apps/instances/:id/logs', async (c) => {
  const { orgId } = requireAuth(c);
  const row = await loadInstance(c.env, orgId, c.req.param('id'));
  if (!row) throw notFound('app_instance not found');
  const tail = Math.max(1, Math.min(1000, Number(c.req.query('tail') ?? '100')));
  const r = await dispatcher.getContainerLogs(c.env, row.id, tail, row.app_slug);
  return c.json({ instance_id: row.id, tail, lines: r.lines ?? [] });
});

// ─── SSE log stream ─────────────────────────────────────────

/**
 * `GET /api/apps/instances/:id/logs/stream` — SSE stream of live container logs.
 *
 * @remarks
 * The dispatcher returns a streamed Response sourced from the DO's own SSE pump.
 * When the APP_RUNTIME binding is missing it emits a single `info` event so the
 * client gets a deterministic message instead of hanging.
 *
 * @throws 401 UNAUTHORIZED when org context is missing.
 * @throws 403 FORBIDDEN when the instance isn't owned by the caller's org.
 * @throws 404 NOT_FOUND when the id doesn't exist.
 */
apps.get('/api/apps/instances/:id/logs/stream', async (c) => {
  const { orgId } = requireAuth(c);
  const row = await loadInstance(c.env, orgId, c.req.param('id'));
  if (!row) throw notFound('app_instance not found');
  const tail = Math.max(1, Math.min(500, Number(c.req.query('tail') ?? '50')));
  return dispatcher.tailContainerLogs(c.env, row.id, tail, row.app_slug);
});

// ─── Health (admin polling) ─────────────────────────────────

/**
 * `GET /api/apps/instances/:id/health` — Probe the container's `/health` endpoint
 * and return its response + latency.
 *
 * @remarks
 * Polled every 5-10s by the admin UI while a container is booting / recovering
 * from a crash.
 *
 * @throws 401 UNAUTHORIZED when org context is missing.
 * @throws 403 FORBIDDEN when the instance isn't owned by the caller's org.
 * @throws 404 NOT_FOUND when the id doesn't exist.
 */
apps.get('/api/apps/instances/:id/health', async (c) => {
  const { orgId } = requireAuth(c);
  const row = await loadInstance(c.env, orgId, c.req.param('id'));
  if (!row) throw notFound('app_instance not found');
  const r = await dispatcher.getContainerStatus(c.env, row.id, row.app_slug);
  return c.json({
    instance_id: row.id,
    app_slug: row.app_slug,
    subdomain: row.subdomain,
    db_status: row.status,
    last_error: row.last_error,
    runtime: r.ok
      ? r.status
      : { state: 'unknown', uptime_seconds: 0, memory_mb_used: 0, last_error: r.detail },
  });
});
