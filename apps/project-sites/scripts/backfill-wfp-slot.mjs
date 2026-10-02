#!/usr/bin/env node
/**
 * backfill-wfp-slot.mjs <slug> — provision the Workers-for-Platforms `preview` +
 * `production` dispatch slots for ONE already-published site so it serves
 * `x-ps-serve: wfp` instead of silently R2-fail-softing (fire-83 money-path #1).
 *
 * WHY one site falls to r2: `serveSiteViaWfpIfPreferred` (src/services/site_serving.ts)
 * returns null — falling through to the byte-identical R2 path — unless Gate 3 finds a
 * live WfP slot (a `site_resource_registry` row: resourceConcept='wfp_namespace',
 * lifecycleState='active', with a userWorkerScript) for the site+environment. Slots are
 * only created at PUBLISH time going forward, so every site published BEFORE WfP shipped
 * (e.g. lonemountainglobal) has NO slot → dispatch misses → honest `x-ps-serve: r2`.
 *
 * THIS SCRIPT reuses the EXACT proven mechanism the plural `backfill-wfp-slots.mjs` and
 * the publish lifecycle use — it does NOT invent a parallel path:
 *   1. Resolve <slug> → {siteId, orgId} from prod D1 via the CF D1 REST API
 *      (`/d1/database/{id}/query`, global-key header pair X-Auth-Email + X-Auth-Key).
 *   2. POST /api/diag/wfp-deploy {siteId, slot} (Bearer E2E_API_KEY) to the prod worker
 *      for BOTH slots — that endpoint runs the SAME `deploySiteToWfp(env, siteId,
 *      {orgId, slot})` the lifecycle wiring calls, re-deploying the site's CURRENT R2
 *      build to the WfP script `site-<siteId>` (+ `-preview`), resolving orgId from the
 *      caller's session and enforcing ownership via `assertSiteOwned`.
 *
 * IDEMPOTENT: `deploySiteToWfp` is a re-deploy of the current R2 build to a deterministic
 * script name — re-running returns the same `version`+`assetCount`, never a duplicate slot.
 *
 * ⚠️ SAFE BY DEFAULT — DOES NOT PROVISION unless you pass `--run`. Default (plan) mode
 * resolves the slug, probes the current `x-ps-serve`, and PRINTS the exact command +
 * preconditions the lead runs; it POSTs nothing. The loop LEAD runs the provisioning
 * step (per fire-83 brief), not this agent. A headless run without `--run` can never
 * mutate prod.
 *
 * ORG SCOPE: `/api/diag/wfp-deploy` is org-scoped — `assertSiteOwned` 404s a site the
 * E2E key's org does NOT own. lonemountainglobal is E2E-org-owned, so this flips it.
 * For a FOREIGN site, use the cross-org super-admin sweep instead (printed in plan mode):
 *   POST /api/super-admin/wfp/backfill {"orgId":"<org>","dryRun":false} (super-admin auth).
 *
 * Usage:
 *   node scripts/backfill-wfp-slot.mjs <slug>                 # PLAN (print command, POST nothing)
 *   node scripts/backfill-wfp-slot.mjs <slug> --run            # ACTUALLY provision (lead runs this)
 *   node scripts/backfill-wfp-slot.mjs <slug> --slot preview   # one slot only
 *   node scripts/backfill-wfp-slot.mjs <slug> --json           # machine-readable
 *   node scripts/backfill-wfp-slot.mjs --help
 *
 * Self-test (manual): plan mode is read-only and prints an r2 current-serve + the exact
 * --run command, exit 0 without POSTing:
 *   node scripts/backfill-wfp-slot.mjs lonemountainglobal
 *   → current x-ps-serve: r2 … PLAN (no changes) … → run: …--run
 *
 * Exit: 0 = plan printed OR every attempted deploy ok; 1 = a --run deploy failed;
 *       2 = bad usage / missing credential / slug not found.
 */
import { execFileSync } from 'node:child_process';

// ─── Constants (prod, per apps/project-sites/CLAUDE.md § Cloudflare resource IDs) ───
const ACCOUNT_ID = '84fa0d1b16ff8086dd958c468ce7fd59';
const D1_DATABASE_ID = 'ea3e839a-c641-4861-ae30-dfc63bff8032'; // project-sites-db-production
const WORKER_URL = 'https://project-sites.manhattan.workers.dev';
const CF_API = 'https://api.cloudflare.com/client/v4';
const SITES_SUFFIX = '.projectsites.dev';
const REAL_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

// ─── CLI ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
  console.log(
    [
      'backfill-wfp-slot.mjs <slug> — provision the WfP preview+production slots for ONE site.',
      '',
      'Usage: node scripts/backfill-wfp-slot.mjs <slug> [--run] [--slot preview|production] [--json]',
      '  <slug>               published-site slug (e.g. lonemountainglobal)',
      '  --run                ACTUALLY provision (POST /api/diag/wfp-deploy). Default = plan only.',
      '  --slot <preview|production>  only one slot (default = both)',
      '  --json               machine-readable output',
      '  --help               show this help',
      '',
      'Default (no --run) is READ-ONLY: resolves the slug, probes x-ps-serve, prints the',
      'exact provisioning command + preconditions, and POSTs nothing. The loop LEAD runs --run.',
    ].join('\n'),
  );
  process.exit(0);
}
const hasFlag = (f) => argv.includes(f);
const flagVal = (f, dflt) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const RUN = hasFlag('--run');
const WANT_JSON = hasFlag('--json');
const SLOT_ARG = flagVal('--slot', '');
const SLOTS =
  SLOT_ARG === 'preview' || SLOT_ARG === 'production' ? [SLOT_ARG] : ['preview', 'production'];
// First non-flag arg is the slug; strip a full host if one was pasted.
let slug = argv.find((a, i) => !a.startsWith('-') && argv[i - 1] !== '--slot');
if (slug) slug = slug.replace(/^https?:\/\//, '').replace(SITES_SUFFIX, '').replace(/\/.*$/, '');

function die(msg, code = 2) {
  console.error(`FATAL: ${msg}`);
  process.exit(code);
}
if (!slug) die('a <slug> argument is required (e.g. lonemountainglobal)');

/** Read a secret via the get-secret CLI (never inline a credential). */
function getSecret(key) {
  try {
    return execFileSync('/Users/Apple/.local/bin/get-secret', [key], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return process.env[key] || '';
  }
}

const CF_EMAIL = getSecret('CLOUDFLARE_EMAIL') || 'blzalewski@gmail.com';
const CF_KEY = getSecret('CLOUDFLARE_API_KEY');
const E2E_KEY = getSecret('E2E_API_KEY');

if (!CF_KEY) die('CLOUDFLARE_API_KEY unavailable (get-secret CLOUDFLARE_API_KEY)');

// ─── 1. Resolve slug → {siteId, orgId, status} from prod D1 (CF D1 REST API) ──
async function resolveSite() {
  const res = await fetch(`${CF_API}/accounts/${ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`, {
    method: 'POST',
    headers: {
      'X-Auth-Email': CF_EMAIL,
      'X-Auth-Key': CF_KEY,
      'Content-Type': 'application/json',
      'User-Agent': REAL_UA,
    },
    // Bound value — parameterized so the slug is never interpolated into SQL.
    body: JSON.stringify({
      sql: 'SELECT id, org_id, slug, status FROM sites WHERE slug = ? AND deleted_at IS NULL LIMIT 1',
      params: [slug],
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.success === false) {
    const errs = Array.isArray(json?.errors) ? json.errors.map((e) => e.message).join('; ') : res.status;
    die(`D1 query failed (${res.status}): ${errs}`);
  }
  const row = json?.result?.[0]?.results?.[0];
  if (!row || !row.id) die(`no published site found for slug "${slug}" in prod D1`, 2);
  return row;
}

/** Probe the live site's current x-ps-serve marker (read-only). */
async function probeServe() {
  try {
    const res = await fetch(`https://${slug}${SITES_SUFFIX}/`, {
      headers: { 'User-Agent': REAL_UA, Accept: 'text/html' },
      redirect: 'follow',
    });
    return { status: res.status, marker: res.headers.get('x-ps-serve') ?? 'MISSING' };
  } catch (e) {
    return { status: 'ERR', marker: `ERR:${e?.cause?.code || e?.name || 'fetch'}` };
  }
}

// ─── 2. Deploy one slot via the authed diag endpoint (proven deploySiteToWfp path) ─
async function deploySlot(siteId, slot) {
  try {
    const res = await fetch(`${WORKER_URL}/api/diag/wfp-deploy`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${E2E_KEY}`,
        'Content-Type': 'application/json',
        'User-Agent': REAL_UA,
      },
      body: JSON.stringify({ siteId, slot }),
    });
    const json = await res.json().catch(() => ({}));
    const result = json?.result ?? json; // envelope: { elapsedMs, result }
    if (!res.ok) return { ok: false, slot, status: res.status, error: json?.error || `HTTP ${res.status}` };
    if (result?.ok) return { ok: true, slot, assetCount: result.assetCount, version: result.version };
    return { ok: false, slot, error: result?.error || 'deploy returned ok:false', status: result?.status };
  } catch (e) {
    return { ok: false, slot, error: e?.message || String(e) };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const site = await resolveSite();
  const before = await probeServe();

  if (!RUN) {
    // PLAN mode (default): read-only. Resolve + probe + print the exact command the lead runs.
    const cmd = `node scripts/backfill-wfp-slot.mjs ${slug} --run` + (SLOT_ARG ? ` --slot ${SLOT_ARG}` : '');
    if (WANT_JSON) {
      console.log(
        JSON.stringify(
          { mode: 'plan', slug, siteId: site.id, orgId: site.org_id, status: site.status, currentServe: before, slots: SLOTS, run: cmd },
          null,
          2,
        ),
      );
    } else {
      console.log(
        `\n  WfP slot backfill — PLAN (no changes)\n` +
          `  slug=${slug}  siteId=${site.id}  org=${site.org_id}  status=${site.status}\n` +
          `  current x-ps-serve: ${before.marker} (HTTP ${before.status})  slots=[${SLOTS.join(', ')}]\n\n` +
          `  Preconditions for --run:\n` +
          `    · E2E_API_KEY available (get-secret E2E_API_KEY) AND its org OWNS this site.\n` +
          `    · prod worker has WfP provisioned (USER_DISPATCH + WFP_NAMESPACE_NAME + CF creds).\n` +
          `    · the site_wfp_hosting flag must be ON for the site/org for the slot to SERVE.\n\n` +
          `  → run (the loop LEAD runs this, not a headless agent):\n      ${cmd}\n\n` +
          `  Foreign-org site? use the cross-org super-admin sweep instead:\n` +
          `      POST ${WORKER_URL}/api/super-admin/wfp/backfill {"orgId":"${site.org_id}","dryRun":false}\n`,
      );
    }
    process.exit(0);
  }

  // RUN mode: actually provision. Requires the E2E key.
  if (!E2E_KEY) die('E2E_API_KEY unavailable (get-secret E2E_API_KEY) — required to POST deploys');

  const slotResults = [];
  for (const slot of SLOTS) {
    const r = await deploySlot(site.id, slot);
    slotResults.push(r);
    if (!WANT_JSON) {
      const tag = r.ok ? `✅ ok  assets=${r.assetCount} v=${r.version}` : `❌ ${r.error}${r.status ? ` (HTTP ${r.status})` : ''}`;
      console.log(`  ${slug} [${slot}] — ${tag}`);
    }
  }
  const after = await probeServe();
  const anyFailed = slotResults.some((r) => !r.ok);

  if (WANT_JSON) {
    console.log(
      JSON.stringify({ mode: 'run', slug, siteId: site.id, orgId: site.org_id, slots: slotResults, before, after }, null, 2),
    );
  } else {
    console.log(
      `\n  Done — ${slug}: ${slotResults.filter((r) => r.ok).length}/${slotResults.length} slot(s) deployed.\n` +
        `  x-ps-serve: ${before.marker} → ${after.marker}` +
        (after.marker === 'wfp'
          ? '  ✅ now serving via WfP'
          : after.marker === 'r2'
            ? '  ⚠ still r2 — check the site_wfp_hosting flag is ON for this org/site'
            : '') +
        `\n`,
    );
  }
  process.exit(anyFailed ? 1 : 0);
}

main().catch((e) => die(e?.message || String(e)));
