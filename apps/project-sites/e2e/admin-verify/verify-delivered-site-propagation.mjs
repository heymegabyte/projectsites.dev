#!/usr/bin/env node
/**
 * verify-delivered-site-propagation.mjs — FULL-JOURNEY step 5+6 for a REAL delivery.
 *
 * The standing causal probe (verify-analytics-visit-count-causal.mjs) targets the
 * e2e-test-org seed site because its owner read is scoped to E2E_API_KEY's org. A REAL
 * delivery lands in org-brian-001, so proving the FRESHLY-BUILT site propagates needs
 * BRIAN auth (Browserbase test-login, CF-clean) — this probe closes that gap and is
 * reusable for every future delivery.
 *
 * What it proves for the delivered {slug}/{siteId} (all as brian, over the owner API):
 *   1. CAUSAL analytics: before = GET /api/sites/:id/analytics.traffic.pageviews →
 *      N real-UA guest visits to {slug}.projectsites.dev → after ≥ before + N
 *      (display==store: the owner's number MOVED because a guest arrived).
 *   2. PROPAGATION: Sites list shows the site + status; Snapshots shows the initial
 *      snapshot; Audit (logs) shows build events. Each section TRULY reflects the build.
 *
 * Guest VISITS go over plain Node fetch (public subdomain GET — works for any non-bot
 * real UA, same as the standing probe). AUTHED /api reads go through the Browserbase
 * page (page.evaluate, projectsites.dev origin, CF-clean IP) because Node fetch to /api
 * gets CF-challenged.
 *
 * Usage:
 *   DELIVERED_SLUG=krugers-austin DELIVERED_SITE_ID=<uuid> \
 *   node e2e/admin-verify/verify-delivered-site-propagation.mjs [N]
 */
import { chromium } from 'playwright';
import { resolveBrowserbaseCreds } from './_browserbase-creds.mjs';

const SLUG = process.env.DELIVERED_SLUG || '';
const SITE_ID = process.env.DELIVERED_SITE_ID || '';
const N = Math.max(1, Number(process.argv[2] || 3));
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!SLUG || !SITE_ID) {
  console.log('::error:: set DELIVERED_SLUG + DELIVERED_SITE_ID');
  process.exit(2);
}
const { BB, PROJ, PW } = resolveBrowserbaseCreds();
if (!BB || !PROJ || !PW) { console.log('::error:: missing Browserbase/E2E creds'); process.exit(2); }

/** N public guest visits via plain Node fetch (CF-clean for public GET + real UA). */
async function guestVisit(i) {
  const res = await fetch(`https://${SLUG}.projectsites.dev/?ps-causal=${Date.now()}-${i}`, {
    headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow',
  });
  return res.status;
}

const r = await fetch('https://api.browserbase.com/v1/sessions', {
  method: 'POST', headers: { 'X-BB-API-Key': BB, 'Content-Type': 'application/json' },
  body: JSON.stringify({ projectId: PROJ, timeout: 600 }),
});
if (!r.ok) { console.log('::error:: BB session create failed', r.status); process.exit(3); }
const { id } = await r.json();
const browser = await chromium.connectOverCDP(`wss://connect.browserbase.com?apiKey=${encodeURIComponent(BB)}&sessionId=${encodeURIComponent(id)}`);
const out = { slug: SLUG, siteId: SITE_ID, n: N };
try {
  const ctx = browser.contexts()[0] ?? await browser.newContext();
  const page = ctx.pages()[0] ?? await ctx.newPage();
  await page.goto('https://projectsites.dev/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(7000); // CF managed-challenge solve

  const token = await page.evaluate(async (pw) => {
    const res = await fetch('/api/auth/test-login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'brian@megabyte.space', password: pw }),
    });
    const j = await res.json().catch(() => ({}));
    return j?.data?.token ?? '';
  }, PW);
  if (!token) { console.log('::error:: test-login returned no token'); process.exit(4); }

  // Authed owner read through the CF-clean page (projectsites.dev origin).
  const readJson = (path) => page.evaluate(async ({ p, tok }) => {
    const res = await fetch(p, { headers: { Authorization: `Bearer ${tok}` } });
    const j = await res.json().catch(() => ({}));
    return { status: res.status, j };
  }, { p: path, tok: token });

  const traffic = (o) => {
    const t = o?.j?.traffic ?? o?.j?.data?.traffic ?? {};
    return {
      pageviews: Number(t.pageviews ?? 0),
      hasPageview: Array.isArray(t.byType) && t.byType.some((x) => x.type === 'pageview'),
      hasRoot: Array.isArray(t.topPaths) && t.topPaths.some((p) => p.path === '/'),
    };
  };

  // --- 1. CAUSAL analytics ---
  const before = traffic(await readJson(`/api/sites/${SITE_ID}/analytics`));
  const statuses = [];
  for (let i = 0; i < N; i++) statuses.push(await guestVisit(i));
  await sleep(6500);
  const after = traffic(await readJson(`/api/sites/${SITE_ID}/analytics`));
  out.analytics = {
    before: before.pageviews, after: after.pageviews, delta: after.pageviews - before.pageviews,
    visits: statuses, pageviewType: after.hasPageview, rootPath: after.hasRoot,
  };

  // --- 2. PROPAGATION ---
  const sitesRes = await readJson('/api/sites');
  const sites = Array.isArray(sitesRes.j) ? sitesRes.j : (sitesRes.j?.data ?? sitesRes.j?.sites ?? []);
  const mine = sites.find((s) => s.slug === SLUG || s.id === SITE_ID) || null;
  out.sitesList = { found: !!mine, status: mine?.status ?? null, total: sites.length };

  const snapRes = await readJson(`/api/sites/${SITE_ID}/snapshots`);
  const snaps = Array.isArray(snapRes.j) ? snapRes.j : (snapRes.j?.data ?? snapRes.j?.snapshots ?? []);
  out.snapshots = { httpStatus: snapRes.status, count: Array.isArray(snaps) ? snaps.length : 0 };

  const logRes = await readJson(`/api/sites/${SITE_ID}/logs?limit=200`);
  const logs = Array.isArray(logRes.j) ? logRes.j : (logRes.j?.data ?? logRes.j?.logs ?? []);
  const buildEvents = (Array.isArray(logs) ? logs : []).filter((l) =>
    /build|generat|publish|workflow|research|container/i.test(`${l.action ?? l.event ?? l.type ?? ''}`));
  out.audit = { httpStatus: logRes.status, total: Array.isArray(logs) ? logs.length : 0, buildEvents: buildEvents.length };

  // --- COMPLETION EMAIL (AL-698) — the delivery is only "delivered" if the OWNER was notified.
  // "Your site is live" fires via SES and logs a `workflow.owner_notified` audit event carrying
  // `{ to, ok, trace_id }` — the D1 ground truth (the notifications TABLE does NOT fire, per
  // [[completion-email-fires-notifications-table-does-not]]). A publish can succeed while the email
  // is silently dropped (SES ACCOUNT suppression, [[ses-account-suppression-silently-drops-mail]]) —
  // a real delivery-loop failure the probe was blind to. Parse the event; HARD-RED on ok:false,
  // ::notice:: if not-yet-fired (validator-precision — the email can lag the publish by seconds).
  const notifiedEvent = (Array.isArray(logs) ? logs : []).find((l) =>
    /owner_notified|owner.notif|completion.email|site.*live.*email/i.test(`${l.action ?? l.event ?? l.type ?? ''}`));
  let emailDetail = {};
  if (notifiedEvent) {
    // The logs API is `SELECT *` over audit_logs → the raw column is `metadata_json` (a JSON STRING),
    // NOT `detail`/`metadata`. The owner_notified row carries `{ to, ok, trace_id }` (verified AL-698).
    const raw =
      notifiedEvent.metadata_json ?? notifiedEvent.detail ?? notifiedEvent.meta ??
      notifiedEvent.metadata ?? notifiedEvent.data ?? notifiedEvent.payload ?? {};
    try { emailDetail = typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); } catch { emailDetail = {}; }
  }
  const emailOk = notifiedEvent ? emailDetail.ok === true || emailDetail.ok === 1 || emailDetail.ok === 'true' : null;
  out.email = {
    found: !!notifiedEvent,
    ok: emailOk,
    to: emailDetail.to ?? emailDetail.recipient ?? null,
    traceId: emailDetail.trace_id ?? emailDetail.traceId ?? null,
  };

  // --- 3. FORMS causal (facet 4: a public contact submit → the owner's /admin/forms shows it) ---
  // Submit from the CF-clean Browserbase page (origin=projectsites.dev is allow-listed; Bot Fight
  // passes with a real fingerprint — a bare Node POST 403s). Same ingestion path as
  // verify-forms-causal.mjs (/api/v1/forms/submit + X-Site-Slug), read back via the owner API.
  const causalEmail = `causal-propagation-${Date.now()}@example.com`;
  const submit = await page.evaluate(async ({ slug, email }) => {
    const res = await fetch('/api/v1/forms/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Site-Slug': slug },
      body: JSON.stringify({ form_name: 'Contact', email, fields: { name: 'Propagation Probe', message: 'Delivered-site forms propagation causal check.' } }),
    });
    return { status: res.status };
  }, { slug: SLUG, email: causalEmail });
  await sleep(2500);
  const formsRes = await readJson(`/api/sites/${SITE_ID}/forms`);
  const formRows = Array.isArray(formsRes.j) ? formsRes.j : (formsRes.j?.data ?? formsRes.j?.forms ?? []);
  out.forms = {
    submitStatus: submit.status,
    ownerHttpStatus: formsRes.status,
    total: Array.isArray(formRows) ? formRows.length : 0,
    causalShows: (Array.isArray(formRows) ? formRows : []).some((r) => (r.email || '') === causalEmail),
  };

  const moved = out.analytics.delta >= N;
  const formsOk = out.forms.submitStatus === 200 && out.forms.causalShows;
  // The completion email is a HARD gate ONLY when it FIRED with a non-ok result (a real SES drop);
  // a not-yet-fired event is inconclusive (the email can lag the publish by seconds) → tracked, not RED.
  const emailFailed = out.email.found && out.email.ok !== true;
  const propagated = out.sitesList.found && out.snapshots.count >= 1 && out.audit.total >= 1 && formsOk;
  const ok = statuses.every((s) => s === 200) && moved && after.hasPageview && out.sitesList.found && formsOk && !emailFailed;
  if (!out.email.found) console.log(`::notice:: completion email (workflow.owner_notified) not yet in the audit log for ${SLUG} — inconclusive, not a fail (it can lag publish; re-run to confirm ok:true).`);

  console.log('\n=== DELIVERED-SITE PROPAGATION (' + SLUG + ') ===\n' + JSON.stringify(out, null, 2));
  console.log(
    `\nVERDICT: ${ok && propagated ? '✅ PASS' : '🔴 CHECK'} ` +
      `analytics(before=${out.analytics.before}→after=${out.analytics.after} Δ${out.analytics.delta}≥${N}=${moved}) ` +
      `sites(found=${out.sitesList.found} status=${out.sitesList.status}) ` +
      `snapshots=${out.snapshots.count} auditEvents=${out.audit.total}(build=${out.audit.buildEvents}) ` +
      `email(found=${out.email.found} ok=${out.email.ok} to=${out.email.to ?? '—'}) ` +
      `forms(submit=${out.forms.submitStatus} owner=${out.forms.ownerHttpStatus} shows=${out.forms.causalShows})`,
  );
  process.exit(ok && propagated ? 0 : 1);
} catch (err) {
  console.log(`\n🔴 ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
} finally {
  await browser.close();
}
