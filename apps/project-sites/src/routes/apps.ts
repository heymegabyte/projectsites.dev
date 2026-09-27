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
  payloadInstanceHost,
  provisionPayloadStack,
} from '../services/cloudflare_provisioner.js';
import { dispatchToUserWorker } from '../services/wfp_dispatch.js';
import {
  checkCnameTarget,
  createCustomHostname,
  checkDomainAvailability,
  deleteCustomHostname,
} from '../services/domains.js';

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

const slugCheckQuery = z.object({
  app_id: z.string().min(1).max(64),
  // Accept any non-empty string up to 253 chars so the handler can evaluate
  // `valid` and return it as false rather than a 400 for over-long values.
  subdomain: z.string().min(1).max(253),
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
function instancePublicHost(
  row: Pick<AppInstanceRow, 'app_slug' | 'subdomain'>,
  cfNativeHost: string,
): string {
  return isCfNativeApp(row.app_slug)
    ? `${row.subdomain}.${cfNativeHost}`
    : `${row.subdomain}.app.projectsites.dev`;
}

/**
 * The bootstrap placeholder ({@link PAYLOAD_BOOTSTRAP_WORKER}) 200s every path with this
 * phrase while the real Payload bundle is still uploading. Its ABSENCE (on a 200 or a
 * redirect-to-login) is the signal the swapped-in admin is genuinely live.
 */
const PAYLOAD_BOOTSTRAP_MARKER = 'finishing setup';

/**
 * Probe whether a CF-native instance's REAL app is serving at its URL — not the bootstrap
 * placeholder, and not {@link serveAppInstance}'s 202 booting shell. Reaches the user Worker
 * DIRECTLY through the dispatch namespace ({@link dispatchToUserWorker}) so the platform's
 * status gate (which 202s while `provisioning`) is bypassed. Returns false on ANY error so a
 * flaky probe can never falsely report "running".
 */
async function probeInstanceReady(
  env: Env,
  row: Pick<AppInstanceRow, 'app_slug' | 'subdomain' | 'worker_script_name'>,
): Promise<boolean> {
  const scriptName = row.worker_script_name;
  if (!scriptName) return false;
  const host = instancePublicHost(row, payloadInstanceHost(env));
  try {
    const req = new Request(`https://${host}/admin`, {
      headers: { 'user-agent': 'projectsites-readiness-probe' },
      redirect: 'manual',
    });
    // Standalone workers.dev fallback (local dev) isn't in the namespace → fetch directly.
    const res = host.endsWith('.workers.dev')
      ? await fetch(req)
      : await dispatchToUserWorker(env, scriptName, req);
    // Payload's /admin 200s (create-first-user / login) or 3xx-redirects to login once the
    // real bundle is live; the bootstrap ALWAYS 200s its marker page and never redirects.
    if (res.status >= 300 && res.status < 400) return true;
    if (res.status !== 200) return false;
    const body = await res.text();
    return !body.includes(PAYLOAD_BOOTSTRAP_MARKER);
  } catch {
    return false;
  }
}

/**
 * Self-heal a CF-native instance's status on read: if it's still `provisioning` but its real
 * app now answers, flip it to `running` (stamping `last_started_at`). This is the lazy
 * fallback for when the launch-time readiness poll timed out inside `waitUntil`. Returns the
 * row with its (possibly updated) status so the caller surfaces the fresh value immediately.
 */
async function flipToRunningIfReady(env: Env, row: AppInstanceRow): Promise<AppInstanceRow> {
  // Reconcile any not-yet-confirmed CF-native state — `provisioning` (fresh launch) OR
  // `starting` (a legacy/lifecycle write that never resolves for a stateless WfP worker).
  if (!isCfNativeApp(row.app_slug) || !row.worker_script_name) return row;
  if (row.status !== 'provisioning' && row.status !== 'starting') return row;
  if (!(await probeInstanceReady(env, row))) return row;
  const now = new Date().toISOString();
  await dbUpdate(
    env.DB,
    'app_instances',
    { status: 'running', last_error: null, last_started_at: now },
    'id = ?',
    [row.id],
  ).catch(() => undefined);
  return { ...row, status: 'running', last_started_at: now };
}

function sanitizeInstance(
  row: AppInstanceRow,
  cfNativeHost: string,
): Omit<AppInstanceRow, 'env_encrypted' | 'env_iv'> & {
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
    public_host: instancePublicHost(row, cfNativeHost),
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
  const cfHost = payloadInstanceHost(c.env);
  // Self-heal any instance still `provisioning` whose real app is now live (bounded — only
  // provisioning CF-native rows are probed; the rest early-return untouched).
  const rows = await Promise.all(data.map((r) => flipToRunningIfReady(c.env, r)));
  return c.json({ instances: rows.map((r) => sanitizeInstance(r, cfHost)) });
});

// ─── Subdomain availability check ─────────────────────────────

/**
 * `GET /api/apps/slug-check` — Pre-flight check for the Deploy panel: is a
 * requested subdomain valid, available, and what's a good alternative if not?
 *
 * @remarks
 * Runs the identical format rules and uniqueness query used by the POST
 * `/api/apps/instances` handler so the client gets an accurate answer before
 * committing to the launch flow. A suggestion is always returned — if the
 * requested slug is taken the caller can pre-fill the input with it.
 *
 * Suggestion algorithm:
 * 1. Derive a ≤10-char base from the caller's owning site slug or `app_id`.
 * 2. Sanitize to `[a-z0-9-]` and truncate.
 * 3. If the base is free, return it; otherwise append `-2`, `-3`, … up to
 *    a loop cap of 25 attempts.
 *
 * @throws 400 BAD_REQUEST when `app_id` or `subdomain` query params are missing.
 * @throws 401 UNAUTHORIZED when org context is missing.
 */
apps.get('/api/apps/slug-check', async (c) => {
  const { orgId } = requireAuth(c);

  const parsed = slugCheckQuery.safeParse({
    app_id: c.req.query('app_id'),
    subdomain: c.req.query('subdomain'),
  });
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid query params');
  const { app_id, subdomain } = parsed.data;

  // ── valid: mirrors the format rules in createInstanceBody exactly ──────────
  const valid = subdomain.length >= 2 && subdomain.length <= 63 && SUBDOMAIN_RE.test(subdomain);

  // ── available: uniqueness query mirrors POST /api/apps/instances ───────────
  let available = false;
  if (valid) {
    const existing = await dbQueryOne<{ id: string }>(
      c.env.DB,
      `SELECT id FROM app_instances WHERE subdomain = ? AND deleted_at IS NULL`,
      [subdomain],
    );
    available = !existing;
  }

  // ── suggestion: derive a short, url-safe, AVAILABLE slug ──────────────────
  // Prefer a base derived from the site the caller is deploying into; fall
  // back to sanitizing app_id so the suggestion is still contextual.
  const siteRow = await dbQueryOne<{ slug: string; business_name: string }>(
    c.env.DB,
    `SELECT slug, business_name FROM sites
       WHERE org_id = ? AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
    [orgId],
  );

  const rawBase = siteRow?.slug ?? siteRow?.business_name ?? app_id;
  // Sanitize: lowercase, collapse any non-[a-z0-9] run to a single hyphen,
  // strip leading/trailing hyphens, then truncate to 10 chars.
  const sanitized =
    rawBase
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 10)
      .replace(/^-+|-+$/g, '') || 'app';

  let suggestion = sanitized;
  const MAX_ATTEMPTS = 25;
  for (let i = 2; i <= MAX_ATTEMPTS; i++) {
    const candidate = i === 2 ? sanitized : `${sanitized}-${i}`;
    const taken = await dbQueryOne<{ id: string }>(
      c.env.DB,
      `SELECT id FROM app_instances WHERE subdomain = ? AND deleted_at IS NULL`,
      [candidate],
    );
    if (!taken) {
      suggestion = candidate;
      break;
    }
  }

  return c.json({ available, valid, suggestion });
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
  // PAYLOAD_SECRET: honor an owner-supplied value (they can override the auto default on the
  // deploy panel), else self-generate a 48-hex-char (24-byte) secret per always.md § Secrets.
  const ownerPayloadSecret = body.env_overrides?.PAYLOAD_SECRET?.trim();
  const payloadSecret =
    ownerPayloadSecret && ownerPayloadSecret.length > 0
      ? ownerPayloadSecret
      : Array.from(crypto.getRandomValues(new Uint8Array(24)))
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

  // Persist owner-supplied env vars alongside the instance's own PAYLOAD_SECRET (which is
  // written LAST so a caller can never override it). These are injected into the Worker below.
  const launchEnv: Record<string, string> = {
    ...(body.env_overrides ?? {}),
    PAYLOAD_SECRET: payloadSecret,
  };
  const encrypted = await encrypt(c.env, JSON.stringify(launchEnv));
  const now = new Date().toISOString();
  const { error: insertErr } = await dbInsert(c.env.DB, 'app_instances', {
    id: instanceId,
    org_id: orgId,
    created_by: userId,
    app_slug: app.id,
    subdomain: body.subdomain,
    // Seed as `provisioning` — the bootstrap 200s immediately but the REAL Payload admin
    // isn't live until the waitUntil readiness poll (below) confirms it. Never claim
    // `running` before the URL actually serves the real bundle.
    status: 'provisioning',
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
      extraEnv: body.env_overrides ?? undefined,
    })
      .then(async (r) => {
        if (!r.ok) {
          await dbUpdate(
            c.env.DB,
            'app_instances',
            { status: 'error', last_error: `payload_bundle: ${r.error ?? 'deploy failed'}` },
            'id = ?',
            [instanceId],
          );
          return;
        }
        // Bundle uploaded — but the edge needs a beat to serve the swapped-in admin. Poll
        // the REAL URL and flip to `running` ONLY when the actual Payload admin answers (not
        // the bootstrap). If the poll window elapses first, leave it `provisioning` — the
        // lazy flipToRunningIfReady on the next read finishes the job. Never lie `running`.
        const probeRow = {
          app_slug: app.id,
          subdomain: body.subdomain,
          worker_script_name: stack.workerName,
        };
        let ready = false;
        for (let i = 0; i < 14; i++) {
          if (await probeInstanceReady(c.env, probeRow)) {
            ready = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        await dbUpdate(
          c.env.DB,
          'app_instances',
          ready
            ? { status: 'running', last_error: null, last_started_at: new Date().toISOString() }
            : { status: 'provisioning', last_error: null },
          'id = ?',
          [instanceId],
        );
      })
      .catch(async (err) => {
        await dbUpdate(
          c.env.DB,
          'app_instances',
          { status: 'error', last_error: `payload_bundle_throw: ${String(err)}` },
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
      status: 'provisioning',
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
  const loaded = await loadInstance(c.env, orgId, c.req.param('id'));
  if (!loaded) throw notFound('app_instance not found');
  // Self-heal `provisioning → running` the moment the real app answers (see flipToRunningIfReady).
  const row = await flipToRunningIfReady(c.env, loaded);
  const decryptedEnv = await decryptEnv(c.env, row);
  return c.json({
    instance: { ...sanitizeInstance(row, payloadInstanceHost(c.env)), env: decryptedEnv },
  });
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
  // CF-native (Payload on WfP) has no container — a "restart"/"start" just re-checks whether
  // the real admin answers and sets an HONEST status. Never dispatch to the container layer
  // or persist a `starting` that will never resolve (the ted-drewes stuck-instance class).
  if (isCfNativeApp(row.app_slug)) {
    const ready = await probeInstanceReady(c.env, row);
    const { error: writeErr } = await dbUpdate(
      c.env.DB,
      'app_instances',
      {
        status: ready ? 'running' : 'provisioning',
        last_started_at: new Date().toISOString(),
        last_error: null,
      },
      'id = ?',
      [row.id],
    );
    if (writeErr) throw internalError(`Failed to persist restart status: ${writeErr}`);
    await auditService.writeAuditLog(c.env.DB, {
      org_id: orgId,
      actor_id: userId,
      action: 'apps.instance.restarted',
      target_type: 'app_instance',
      target_id: row.id,
      request_id: c.get('requestId'),
    });
    return c.json({ ok: true, status: ready ? 'running' : 'provisioning' });
  }
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
  // CF-native (Payload) "stop" = mark stopped so serveAppInstance serves the stopped shell.
  // The Worker + D1 + R2 stay intact so a later Start brings it right back; true teardown is
  // DELETE. No container dispatcher (there is no container).
  if (isCfNativeApp(row.app_slug)) {
    const { error: writeErr } = await dbUpdate(
      c.env.DB,
      'app_instances',
      { status: 'stopped' },
      'id = ?',
      [row.id],
    );
    if (writeErr) throw internalError(`Failed to persist stop status: ${writeErr}`);
    await auditService.writeAuditLog(c.env.DB, {
      org_id: orgId,
      actor_id: userId,
      action: 'apps.instance.stopped',
      target_type: 'app_instance',
      target_id: row.id,
      request_id: c.get('requestId'),
    });
    return c.json({ ok: true, status: 'stopped' });
  }
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

  // CF-native (Payload): env vars are Worker bindings baked in at deploy — REDEPLOY the
  // worker with the merged env so they actually take effect (no container to restart). The
  // instance keeps serving the old version until CF atomically swaps, so status stays as-is
  // through the redeploy; we re-probe after and only downgrade on failure. PAYLOAD_SECRET is
  // the instance's own; everything else becomes a secret_text binding on the user Worker.
  if (isCfNativeApp(row.app_slug)) {
    const { PAYLOAD_SECRET: instanceSecret = '', ...ownerEnv } = merged;
    const ns =
      (c.env as unknown as { PAYLOAD_BRANDED_HOST?: string }).PAYLOAD_BRANDED_HOST === 'true'
        ? c.env.WFP_NAMESPACE_NAME
        : undefined;
    const probeRow = {
      app_slug: row.app_slug,
      subdomain: row.subdomain,
      worker_script_name: row.worker_script_name,
    };
    c.executionCtx.waitUntil(
      deployRealPayloadWorker(c.env, {
        name: row.worker_script_name ?? '',
        d1DatabaseId: row.d1_database_id ?? '',
        r2BucketName: row.r2_bucket_name ?? '',
        payloadSecret: instanceSecret,
        namespace: ns,
        extraEnv: ownerEnv,
      })
        .then(async (r) => {
          if (!r.ok) {
            await dbUpdate(
              c.env.DB,
              'app_instances',
              { status: 'error', last_error: `env_redeploy: ${r.error ?? 'failed'}` },
              'id = ?',
              [row.id],
            );
            return;
          }
          let ready = false;
          for (let i = 0; i < 14; i++) {
            if (await probeInstanceReady(c.env, probeRow)) {
              ready = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
          await dbUpdate(
            c.env.DB,
            'app_instances',
            ready
              ? { status: 'running', last_error: null, last_started_at: new Date().toISOString() }
              : { status: 'provisioning', last_error: null },
            'id = ?',
            [row.id],
          );
        })
        .catch(async (err) => {
          await dbUpdate(
            c.env.DB,
            'app_instances',
            { status: 'error', last_error: `env_redeploy_throw: ${String(err)}` },
            'id = ?',
            [row.id],
          ).catch(() => undefined);
        }),
    );
    await auditService.writeAuditLog(c.env.DB, {
      org_id: orgId,
      actor_id: userId,
      action: 'apps.instance.env_updated',
      target_type: 'app_instance',
      target_id: row.id,
      metadata_json: { keys: Object.keys(body.env_overrides), kind: 'cf-native' },
      request_id: c.get('requestId'),
    });
    return c.json({ ok: true, status: row.status });
  }

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

/** DoH A-record lookup (Google `dns.google` — reliable clean JSON from Workers; retried once
 *  on an empty/failed response since a transient empty would false-negative the A-match). */
async function dohARecords(name: string): Promise<string[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(name)}&type=A`);
      if (r.ok) {
        const j = (await r.json()) as { Answer?: Array<{ type: number; data: string }> };
        const ips = (j.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data);
        if (ips.length > 0) return ips;
      }
    } catch {
      /* retry */
    }
  }
  return [];
}

/**
 * Is `domain` pointed at projectsites.dev? TRUE when EITHER it has a literal CNAME to
 * projectsites.dev (registrars that expose CNAMEs — GoDaddy/Namecheap) OR its A records match
 * projectsites.dev's (registrars that FLATTEN the CNAME at apex/authoritative — Cloudflare).
 * The A-match arm is essential: a Cloudflare-hosted domain resolves to CF anycast IPs with NO
 * literal CNAME record, so a CNAME-only check wrongly reports "not pointed". (Found live via
 * test-me.megabyte.space, 2026-09-27.)
 */
async function verifyPointed(domain: string): Promise<{ ok: boolean; target: string | null }> {
  const cname = await checkCnameTarget(domain);
  if (cname && /(^|\.)projectsites\.dev$/.test(cname.toLowerCase())) {
    return { ok: true, target: cname };
  }
  const [domA, platA] = await Promise.all([dohARecords(domain), dohARecords('projectsites.dev')]);
  const plat = new Set(platA);
  const flattened = domA.length > 0 && domA.some((ip) => plat.has(ip));
  return { ok: flattened, target: cname ?? (flattened ? 'projectsites.dev (flattened)' : null) };
}

/**
 * `GET /api/apps/instances/:id/cname-check?domain=` — Read-only: is `domain` pointed at
 * projectsites.dev yet (literal CNAME OR flattened A-match)? Powers the live green/red status.
 */
apps.get('/api/apps/instances/:id/cname-check', async (c) => {
  const { orgId } = requireAuth(c);
  const row = await loadInstance(c.env, orgId, c.req.param('id'));
  if (!row) throw notFound('app_instance not found');
  const domain = (c.req.query('domain') ?? '').trim().toLowerCase();
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain))
    throw badRequest('Provide a valid domain.');
  const { ok, target } = await verifyPointed(domain);
  return c.json({ domain, target, ok, expected: 'projectsites.dev' });
});

/**
 * `POST /api/apps/instances/:id/slug` — Rename the instance's `*.cms`/`*.app` subdomain.
 * Validates format + GLOBAL uniqueness, updates the row + KV host map, returns the new public
 * host. Same-zone re-point (serveAppInstance resolves by the subdomain column) — no external DNS.
 */
apps.post('/api/apps/instances/:id/slug', async (c) => {
  const { userId, orgId } = requireAuth(c);
  const row = await loadInstance(c.env, orgId, c.req.param('id'));
  if (!row) throw notFound('app_instance not found');
  const body = z
    .object({ subdomain: z.string().min(2).max(63) })
    .parse(await c.req.json().catch(() => ({})));
  const next = body.subdomain.trim().toLowerCase();
  const cfHost = payloadInstanceHost(c.env);
  if (!SUBDOMAIN_RE.test(next)) {
    throw badRequest('Use lowercase letters, digits, and dashes (no leading/trailing dash).');
  }
  if (next === row.subdomain) {
    return c.json({ ok: true, subdomain: next, host: instancePublicHost(row, cfHost) });
  }
  const clash = await dbQueryOne<{ id: string }>(
    c.env.DB,
    `SELECT id FROM app_instances WHERE subdomain = ? AND deleted_at IS NULL`,
    [next],
  );
  if (clash) throw badRequest('That subdomain is already taken.');
  const { error: upErr } = await dbUpdate(
    c.env.DB,
    'app_instances',
    { subdomain: next },
    'id = ?',
    [row.id],
  );
  if (upErr) throw internalError(`Failed to rename subdomain: ${upErr}`);
  // Re-point the KV host map, and leave a 301 on the OLD host so existing links don't break
  // (SEO-safe rename; serveAppInstance honors `redirectTo`). serveAppInstance resolves the NEW
  // host by the subdomain column.
  const newDefaultHost = instancePublicHost({ ...row, subdomain: next }, cfHost);
  await setAppHost(c.env, defaultAppHostname(row.subdomain), {
    instanceId: row.id,
    appSlug: row.app_slug,
    orgId,
    subdomain: row.subdomain,
    redirectTo: newDefaultHost,
  }).catch(() => undefined);
  // Also leave a redirect on the cms/app host form (in case that's what was linked).
  await setAppHost(c.env, instancePublicHost(row, cfHost), {
    instanceId: row.id,
    appSlug: row.app_slug,
    orgId,
    subdomain: row.subdomain,
    redirectTo: newDefaultHost,
  }).catch(() => undefined);
  await setAppHost(c.env, defaultAppHostname(next), {
    instanceId: row.id,
    appSlug: row.app_slug,
    orgId,
    subdomain: next,
  }).catch(() => undefined);
  await auditService.writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: userId,
    action: 'apps.instance.renamed',
    target_type: 'app_instance',
    target_id: row.id,
    metadata_json: { from: row.subdomain, to: next },
    request_id: c.get('requestId'),
  });
  return c.json({
    ok: true,
    subdomain: next,
    host: instancePublicHost({ ...row, subdomain: next }, cfHost),
  });
});

/**
 * `POST /api/apps/instances/:id/domains` — Attach a custom domain (CNAME'd to projectsites.dev)
 * to this instance: verify the CNAME first, then provision a CF custom hostname (HTTP-DV TLS) and
 * route it to this instance via the KV host map. Additive + reversible (deleteCustomHostname).
 *
 * @throws 400 when the domain is malformed OR its CNAME isn't pointed at projectsites.dev yet.
 */
apps.post('/api/apps/instances/:id/domains', async (c) => {
  const { userId, orgId } = requireAuth(c);
  const row = await loadInstance(c.env, orgId, c.req.param('id'));
  if (!row) throw notFound('app_instance not found');
  const body = z
    .object({ domain: z.string().min(4).max(253) })
    .parse(await c.req.json().catch(() => ({})));
  const domain = body.domain.trim().toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) || domain.endsWith('.projectsites.dev')) {
    throw badRequest('Enter a custom domain you own (not a *.projectsites.dev subdomain).');
  }
  // NOTE: no hard DNS pre-gate. Cloudflare's custom-hostname validation IS the authority — it
  // issues the cert only once the CNAME resolves (HTTP-DV), so we create the hostname now and
  // let the live domain-status ladder surface the real cert progress. A best-effort DoH check
  // (`verifyPointed`) drives the UI hint but must never false-negative-block the attach (found
  // live 2026-09-27: recursive DoH is negative-cached / flattening hides the literal CNAME).
  let cf: Awaited<ReturnType<typeof createCustomHostname>>;
  try {
    cf = await createCustomHostname(c.env, domain);
  } catch (err) {
    // Map CF's "no quota" (SSL for SaaS not provisioned on the zone) to a clean, actionable
    // message instead of leaking the raw CF JSON to the owner.
    const msg = err instanceof Error ? err.message : String(err);
    if (/quota|1404|SSL for SaaS/i.test(msg)) {
      throw badRequest(
        'Custom domains need SSL for SaaS enabled on this account. The DNS is verified — an admin must turn on Cloudflare for SaaS (custom hostnames) to issue the certificate.',
      );
    }
    throw err;
  }
  await setAppHost(c.env, domain, {
    instanceId: row.id,
    appSlug: row.app_slug,
    orgId,
    subdomain: row.subdomain,
  }).catch(() => undefined);
  // Persist to the domains table (multi-domain + primary). First domain becomes primary.
  const existing = await dbQuery<{ n: number }>(
    c.env.DB,
    `SELECT COUNT(*) AS n FROM app_instance_domains WHERE instance_id = ?`,
    [row.id],
  );
  const isFirst = (existing.data?.[0]?.n ?? 0) === 0;
  const nowIso = new Date().toISOString();
  await dbExecute(
    c.env.DB,
    `INSERT INTO app_instance_domains
       (id, instance_id, org_id, domain, cf_hostname_id, is_primary, status, ssl_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(domain) DO UPDATE SET
       cf_hostname_id = excluded.cf_hostname_id, status = excluded.status,
       ssl_status = excluded.ssl_status, updated_at = excluded.updated_at`,
    [
      crypto.randomUUID(),
      row.id,
      orgId,
      domain,
      cf.cf_id,
      isFirst ? 1 : 0,
      cf.status,
      cf.ssl_status,
      nowIso,
      nowIso,
    ],
  );
  await auditService.writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: userId,
    action: 'apps.instance.domain_attached',
    target_type: 'app_instance',
    target_id: row.id,
    metadata_json: { domain, cf_id: cf.cf_id, ssl_status: cf.ssl_status },
    request_id: c.get('requestId'),
  });
  return c.json({ ok: true, domain, ssl_status: cf.ssl_status, status: cf.status });
});

/**
 * `GET /api/apps/instances/:id/domains` — List the instance's attached custom domains
 * (multi-domain + primary flag). The platform host is always available separately.
 */
apps.get('/api/apps/instances/:id/domains', async (c) => {
  const { orgId } = requireAuth(c);
  const row = await loadInstance(c.env, orgId, c.req.param('id'));
  if (!row) throw notFound('app_instance not found');
  const { data } = await dbQuery<{
    domain: string;
    is_primary: number;
    status: string;
    ssl_status: string;
  }>(
    c.env.DB,
    `SELECT domain, is_primary, status, ssl_status FROM app_instance_domains
       WHERE instance_id = ? ORDER BY is_primary DESC, created_at ASC`,
    [row.id],
  );
  return c.json({
    domains: (data ?? []).map((d) => ({
      domain: d.domain,
      primary: d.is_primary === 1,
      status: d.status,
      ssl_status: d.ssl_status,
    })),
  });
});

/**
 * `POST /api/apps/instances/:id/domains/primary` — Mark one attached domain PRIMARY (the URL
 * the admin surfaces). Clears the flag on the instance's other domains (single primary).
 */
apps.post('/api/apps/instances/:id/domains/primary', async (c) => {
  const { userId, orgId } = requireAuth(c);
  const row = await loadInstance(c.env, orgId, c.req.param('id'));
  if (!row) throw notFound('app_instance not found');
  const body = z
    .object({ domain: z.string().min(4).max(253) })
    .parse(await c.req.json().catch(() => ({})));
  const domain = body.domain.trim().toLowerCase();
  const owned = await dbQueryOne<{ id: string }>(
    c.env.DB,
    `SELECT id FROM app_instance_domains WHERE instance_id = ? AND domain = ?`,
    [row.id, domain],
  );
  if (!owned) throw notFound('That domain is not attached to this instance.');
  await dbExecute(
    c.env.DB,
    `UPDATE app_instance_domains SET is_primary = 0 WHERE instance_id = ?`,
    [row.id],
  );
  await dbExecute(
    c.env.DB,
    `UPDATE app_instance_domains SET is_primary = 1, updated_at = ? WHERE instance_id = ? AND domain = ?`,
    [new Date().toISOString(), row.id, domain],
  );
  await auditService.writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: userId,
    action: 'apps.instance.domain_primary_set',
    target_type: 'app_instance',
    target_id: row.id,
    metadata_json: { domain },
    request_id: c.get('requestId'),
  });
  return c.json({ ok: true, domain });
});

/**
 * `DELETE /api/apps/instances/:id/domains?domain=` — Detach a custom domain: delete the CF
 * custom hostname, clear the KV host map, and remove the row. Reversible re-attach.
 */
apps.delete('/api/apps/instances/:id/domains', async (c) => {
  const { userId, orgId } = requireAuth(c);
  const row = await loadInstance(c.env, orgId, c.req.param('id'));
  if (!row) throw notFound('app_instance not found');
  const domain = (c.req.query('domain') ?? '').trim().toLowerCase();
  const owned = await dbQueryOne<{ cf_hostname_id: string | null; is_primary: number }>(
    c.env.DB,
    `SELECT cf_hostname_id, is_primary FROM app_instance_domains WHERE instance_id = ? AND domain = ?`,
    [row.id, domain],
  );
  if (!owned) throw notFound('That domain is not attached to this instance.');
  if (owned.cf_hostname_id)
    await deleteCustomHostname(c.env, owned.cf_hostname_id).catch(() => undefined);
  await clearAppHost(c.env, domain).catch(() => undefined);
  await dbExecute(
    c.env.DB,
    `DELETE FROM app_instance_domains WHERE instance_id = ? AND domain = ?`,
    [row.id, domain],
  );
  // If the primary was removed, promote the next-oldest domain so one stays primary.
  if (owned.is_primary === 1) {
    const nextDomain = await dbQueryOne<{ domain: string }>(
      c.env.DB,
      `SELECT domain FROM app_instance_domains WHERE instance_id = ? ORDER BY created_at ASC LIMIT 1`,
      [row.id],
    );
    if (nextDomain) {
      await dbExecute(
        c.env.DB,
        `UPDATE app_instance_domains SET is_primary = 1 WHERE instance_id = ? AND domain = ?`,
        [row.id, nextDomain.domain],
      );
    }
  }
  await auditService.writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: userId,
    action: 'apps.instance.domain_detached',
    target_type: 'app_instance',
    target_id: row.id,
    metadata_json: { domain },
    request_id: c.get('requestId'),
  });
  return c.json({ ok: true, domain });
});

/**
 * `GET /api/apps/instances/:id/domain-availability?domain=` — Is `domain` free to REGISTER?
 * (RDAP; powers the "don't have a domain? register one at GoDaddy" flow.) Read-only.
 */
apps.get('/api/apps/instances/:id/domain-availability', async (c) => {
  const { orgId } = requireAuth(c);
  const row = await loadInstance(c.env, orgId, c.req.param('id'));
  if (!row) throw notFound('app_instance not found');
  const domain = (c.req.query('domain') ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9-]+\.[a-z]{2,}$/.test(domain)) {
    throw badRequest('Enter a domain to register, e.g. example.com');
  }
  const res = await checkDomainAvailability(c.env, [domain]);
  if (!Array.isArray(res))
    return c.json({ domain, available: false, price_usd: 0, error: res.error });
  const a = res[0];
  return c.json({ domain, available: a?.available ?? false, price_usd: a?.price_usd ?? 0 });
});

/**
 * `GET /api/apps/instances/:id/domain-status?domain=` — Live connection state for a custom
 * domain: is the CNAME pointed AND is the TLS cert active? Drives the live "Connected ✓" ladder.
 * Reads CF custom_hostnames by NAME (no stored cf_id needed). Read-only, safe to poll.
 *
 * phase: `awaiting_dns` → `pointed` (CNAME ok, not attached) → `certifying` → `connected`.
 */
apps.get('/api/apps/instances/:id/domain-status', async (c) => {
  const { orgId } = requireAuth(c);
  const row = await loadInstance(c.env, orgId, c.req.param('id'));
  if (!row) throw notFound('app_instance not found');
  const domain = (c.req.query('domain') ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw badRequest('Provide a valid domain.');
  const pointed = await verifyPointed(domain);
  const target = pointed.target;
  const dnsOk = pointed.ok;
  let chStatus = 'none';
  let sslStatus = 'none';
  try {
    const r = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${c.env.CF_ZONE_ID}/custom_hostnames?hostname=${encodeURIComponent(domain)}`,
      { headers: { Authorization: `Bearer ${c.env.CF_API_TOKEN}` } },
    );
    if (r.ok) {
      const j = (await r.json()) as {
        result?: Array<{ status?: string; ssl?: { status?: string } }>;
      };
      const rec = j.result?.[0];
      if (rec) {
        chStatus = rec.status ?? 'pending';
        sslStatus = rec.ssl?.status ?? 'pending';
      }
    }
  } catch {
    /* soft — the client polls again */
  }
  // SSL active is AUTHORITATIVE — Cloudflare issues the cert only AFTER the CNAME validates, so
  // it implies DNS is pointed. Gating on the (flaky) DoH `dnsOk` too would flip "connected" back
  // to false on a transient empty DoH read (seen live 2026-09-27). Trust CF's cert state.
  const connected = sslStatus === 'active';
  const phase = connected
    ? 'connected'
    : !dnsOk
      ? 'awaiting_dns'
      : chStatus === 'none'
        ? 'pointed'
        : 'certifying';
  return c.json({ domain, target, dnsOk, chStatus, sslStatus, connected, phase });
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
