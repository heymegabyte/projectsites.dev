#!/usr/bin/env node
/**
 * backfill-wfp-slots.mjs — deploy the Workers-for-Platforms `preview` + `production`
 * slots for EVERY already-published site so they serve via dispatch instead of R2
 * fail-soft.
 *
 * WHY: `site_wfp_hosting` is now the DEFAULT serving path (flag promoted; arc closed
 * fire-50 — `x-ps-serve: wfp` proven for `search-verify`). But WfP slots are only
 * created at PUBLISH time going forward — every site published BEFORE that has NO
 * slot, so its dispatch lookup misses and it silently R2-fail-softs. This backfills
 * the slots for the existing corpus.
 *
 * HOW (a script can't bind the Worker env, so it drives the PROVEN path over HTTP):
 *   1. List published sites straight from prod D1 via the CF D1 REST API
 *      (`/d1/database/{id}/query`) using the global-key header pair
 *      `X-Auth-Email` + `X-Auth-Key` (get-secret CLOUDFLARE_EMAIL / CLOUDFLARE_API_KEY),
 *      DB `project-sites-db-production` (id ea3e839a-…). No wrangler dependency.
 *   2. For each site POST `/api/diag/wfp-deploy {siteId, slot}` (Bearer E2E_API_KEY) to
 *      the prod worker — that endpoint runs the SAME `deploySiteToWfp(env, siteId,
 *      {orgId, slot})` the publish-lifecycle wiring calls, resolving orgId from the
 *      caller's session and enforcing ownership via `assertSiteOwned`.
 *
 * ⚠️ ORG SCOPE (diag is org-scoped): the diag endpoint resolves the CALLER's org and
 * `deploySiteToWfp`'s own `assertSiteOwned` 404s a foreign site. So this backfills ONLY
 * the sites the E2E key's org OWNS. Cross-org backfill (the full corpus) needs an
 * internal super-admin sweep endpoint — see the FULL-SWEEP note in the return / the
 * stub plan below. This E2E-org-scoped version works NOW and proves the mechanism.
 *
 * IDEMPOTENT: `deploySiteToWfp` is a re-deploy of the current R2 build — re-POSTing a
 * site returns the same `version` (the site's current build) + `assetCount`. Safe to
 * re-run; a second run is a no-op refresh, never a duplicate slot.
 *
 * RESILIENT: fail-soft PER SITE (log + continue on any error — a foreign-site 404, a
 * transient CF 5xx, a build with no R2 files); ~500ms delay between calls to stay under
 * CF 10xxx rate limits; both slots (preview + production) deployed per site.
 *
 * FLAGS:
 *   --dry-run     list the published sites + planned deploys, POST nothing
 *   --limit N     cap the number of SITES processed (proof runs; default = all)
 *   --slot S      only one slot (preview|production); default = both
 *   --delay MS    inter-call delay (default 500)
 *   --json        machine-readable summary to stdout
 *
 * VERIFY:
 *   node scripts/backfill-wfp-slots.mjs --dry-run            # count
 *   node scripts/backfill-wfp-slots.mjs --limit 3            # prove (expect ok, assetCount>=1)
 *
 * Exit: 0 = every attempted deploy ok (or dry-run); 1 = ≥1 site failed all its slots.
 */
import { execFileSync } from 'node:child_process';

// ─── Constants (prod, per apps/project-sites/CLAUDE.md § Cloudflare resource IDs) ───
const ACCOUNT_ID = '84fa0d1b16ff8086dd958c468ce7fd59';
const D1_DATABASE_ID = 'ea3e839a-c641-4861-ae30-dfc63bff8032'; // project-sites-db-production
const WORKER_URL = 'https://project-sites.manhattan.workers.dev';
const CF_API = 'https://api.cloudflare.com/client/v4';
const REAL_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

// ─── CLI ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const flagVal = (f, dflt) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const DRY_RUN = hasFlag('--dry-run');
const WANT_JSON = hasFlag('--json');
const LIMIT = Number.parseInt(flagVal('--limit', ''), 10) || Infinity;
const DELAY_MS = Number.parseInt(flagVal('--delay', '500'), 10);
const SLOT_ARG = flagVal('--slot', '');
const SLOTS =
  SLOT_ARG === 'preview' || SLOT_ARG === 'production' ? [SLOT_ARG] : ['preview', 'production'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Read a secret via the get-secret CLI (never inline a credential). */
function getSecret(key) {
  try {
    return execFileSync('/Users/Apple/.local/bin/get-secret', [key], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // Fall back to env (CI / already-exported).
    return process.env[key] || '';
  }
}

const CF_EMAIL = getSecret('CLOUDFLARE_EMAIL') || 'blzalewski@gmail.com';
const CF_KEY = getSecret('CLOUDFLARE_API_KEY');
const E2E_KEY = getSecret('E2E_API_KEY');

function die(msg) {
  console.error(`FATAL: ${msg}`);
  process.exit(2);
}
if (!CF_KEY) die('CLOUDFLARE_API_KEY unavailable (get-secret CLOUDFLARE_API_KEY)');
if (!DRY_RUN && !E2E_KEY) die('E2E_API_KEY unavailable (get-secret E2E_API_KEY) — required to POST deploys');

// ─── 1. List published sites from prod D1 (CF D1 REST API) ────────────────────
/** @returns {Promise<Array<{id:string, org_id:string, slug:string}>>} */
async function listPublishedSites() {
  const res = await fetch(`${CF_API}/accounts/${ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`, {
    method: 'POST',
    headers: {
      'X-Auth-Email': CF_EMAIL,
      'X-Auth-Key': CF_KEY,
      'Content-Type': 'application/json',
      'User-Agent': REAL_UA,
    },
    body: JSON.stringify({
      sql: "SELECT id, org_id, slug FROM sites WHERE status = 'published' AND deleted_at IS NULL ORDER BY created_at ASC",
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.success === false) {
    const errs = Array.isArray(json?.errors) ? json.errors.map((e) => e.message).join('; ') : res.status;
    die(`D1 query failed (${res.status}): ${errs}`);
  }
  // D1 REST returns result:[{ results:[...] }].
  const rows = json?.result?.[0]?.results ?? [];
  return rows.filter((r) => r && r.id && r.org_id);
}

// ─── 2. Deploy one slot via the authed diag endpoint (proven deploySiteToWfp path) ─
/** @returns {Promise<{ok:boolean, slot:string, assetCount?:number, version?:string, error?:string, status?:number}>} */
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
    // Endpoint envelope: { elapsedMs, result: DeploySiteToWfpResult }.
    const result = json?.result ?? json;
    if (!res.ok) {
      return { ok: false, slot, status: res.status, error: json?.error || `HTTP ${res.status}` };
    }
    if (result?.ok) {
      return { ok: true, slot, assetCount: result.assetCount, version: result.version };
    }
    return { ok: false, slot, error: result?.error || 'deploy returned ok:false', status: result?.status };
  } catch (e) {
    return { ok: false, slot, error: e?.message || String(e) };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const all = await listPublishedSites();
  const sites = all.slice(0, LIMIT === Infinity ? all.length : LIMIT);

  const summary = {
    mode: DRY_RUN ? 'dry-run' : 'live',
    totalPublished: all.length,
    processed: sites.length,
    slots: SLOTS,
    ok: 0, // sites with ≥1 slot deployed ok
    failed: 0, // sites where every slot failed
    skipped: 0, // foreign-org (404) sites — expected under org-scoping
    slotOk: 0,
    slotFailed: 0, // real deploy failures (excludes foreign-org skips)
    slotSkipped: 0, // foreign-org slots (not_owned / 404)
    results: [],
  };

  if (!WANT_JSON) {
    console.log(
      `\n  WfP slot backfill — ${all.length} published site(s) in prod D1` +
        (LIMIT !== Infinity ? ` (processing first ${sites.length})` : '') +
        `\n  mode=${summary.mode}  slots=[${SLOTS.join(', ')}]  delay=${DELAY_MS}ms\n`,
    );
  }

  if (DRY_RUN) {
    for (const s of sites) {
      if (!WANT_JSON) console.log(`  · would deploy ${SLOTS.join('+')} → ${s.slug} (${s.id})`);
      summary.results.push({ siteId: s.id, slug: s.slug, orgId: s.org_id, planned: SLOTS });
    }
    if (!WANT_JSON) {
      console.log(`\n  DRY RUN — ${sites.length} site(s) × ${SLOTS.length} slot(s) = ${sites.length * SLOTS.length} deploy(s) planned. POSTed nothing.\n`);
    } else {
      console.log(JSON.stringify(summary, null, 2));
    }
    process.exit(0);
  }

  // A foreign-owned site fails ownership: the diag endpoint returns HTTP 404, OR
  // `deploySiteToWfp`'s own `assertSiteOwned` returns a typed `{ok:false,
  // error:'not_owned'}` inside a 200. Either is EXPECTED under org-scoping → skipped,
  // never a real failure (so the full sweep doesn't false-alarm exit 1 on foreign sites).
  const isForeign = (r) => r.status === 404 || r.error === 'not_owned';

  for (const s of sites) {
    const slotResults = [];
    let anyOk = false;
    let allForeign = true;
    for (const slot of SLOTS) {
      const r = await deploySlot(s.id, slot);
      slotResults.push(r);
      if (r.ok) {
        anyOk = true;
        allForeign = false;
        summary.slotOk++;
      } else if (isForeign(r)) {
        summary.slotSkipped++;
      } else {
        summary.slotFailed++;
        allForeign = false;
      }
      if (!WANT_JSON) {
        const tag = r.ok ? `✅ ok  assets=${r.assetCount} v=${r.version}` : `❌ ${r.error}`;
        console.log(`  ${s.slug} [${slot}] — ${tag}`);
      }
      await sleep(DELAY_MS);
    }
    summary.results.push({ siteId: s.id, slug: s.slug, orgId: s.org_id, slots: slotResults });
    if (anyOk) summary.ok++;
    else if (allForeign) summary.skipped++;
    else summary.failed++;
  }

  if (WANT_JSON) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(
      `\n  Done — sites ok=${summary.ok} skipped(foreign-org)=${summary.skipped} failed=${summary.failed}` +
        `  |  slots ok=${summary.slotOk} skipped=${summary.slotSkipped} failed=${summary.slotFailed}\n`,
    );
    if (summary.skipped > 0) {
      console.log(
        `  ${summary.skipped} site(s) 404'd (owned by another org) — expected: diag is org-scoped.\n` +
          `  Cross-org backfill needs an internal super-admin sweep endpoint (POST /api/internal/wfp-backfill).\n`,
      );
    }
  }
  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch((e) => die(e?.message || String(e)));
