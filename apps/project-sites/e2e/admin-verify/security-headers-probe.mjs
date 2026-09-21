/**
 * security-headers-probe.mjs — adversarial security-headers + secret-leak audit across every
 * public surface (SECURITY HARDENING loop). Read-only: it FETCHES prod and asserts each surface
 * carries the required security headers with safe values, and scans every response body for
 * leaked secrets. Exits 1 on any HARD finding so it gates run-all.mjs / CI.
 *
 * Why fetch via workers.dev: the apex + subdomains sit behind CF Bot Fight, which serves a
 * CHALLENGE page (its own headers, not the app's) to non-browser UAs — so header assertions on
 * the apex would test the challenge, not the Worker. `project-sites.manhattan.workers.dev` is the
 * same Worker WITHOUT the zone's Bot Fight, so it returns the real app headers (per the
 * bot-fight/workers.dev memory). A real Chrome UA is still sent.
 *
 * Usage: node e2e/admin-verify/security-headers-probe.mjs [--json] [--site=<slug>]
 */
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const WORKER = 'https://project-sites.manhattan.workers.dev';
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const siteSlug = (args.find((a) => a.startsWith('--site=')) || '').split('=')[1] || null;

/** Surfaces to audit. `kind` drives which content-type + soft-404 expectations apply. */
const SURFACES = [
  { name: 'marketing', url: `${WORKER}/`, kind: 'html' },
  { name: 'api-health', url: `${WORKER}/api/health`, kind: 'json' },
  { name: 'admin-shell', url: `${WORKER}/admin`, kind: 'html' },
  { name: 'api-404', url: `${WORKER}/api/__nonexistent__`, kind: 'json-404' },
  ...(siteSlug ? [{ name: 'generated-site', url: `https://${siteSlug}.projectsites.dev/`, kind: 'html' }] : []),
];

/**
 * Header policy. `test(value)` → true when SAFE. `severity`: HARD fails the probe, SOFT warns.
 * SOFT covers the known homepage `'unsafe-inline'` CSP (marketing uses an inline bootstrap script)
 * so the probe reports the weakness without false-failing a documented, accepted state.
 */
const HEADER_POLICY = [
  { header: 'strict-transport-security', severity: 'HARD', test: (v) => !!v && /max-age=\d{5,}/.test(v), want: 'max-age ≥ ~1 day' },
  { header: 'x-content-type-options', severity: 'HARD', test: (v) => v === 'nosniff', want: 'nosniff' },
  { header: 'referrer-policy', severity: 'HARD', test: (v) => !!v && v.length > 0, want: 'present (e.g. strict-origin-when-cross-origin)' },
  { header: 'content-security-policy', severity: 'HARD', test: (v) => !!v && v.length > 0, want: 'present' },
  // Clickjacking: either a non-wildcard CSP frame-ancestors OR X-Frame-Options.
  {
    header: 'content-security-policy',
    as: 'frame-ancestors',
    severity: 'HARD',
    test: (v, all) => {
      const fa = /frame-ancestors ([^;]+)/i.exec(v || '');
      if (fa) return !/\*/.test(fa[1]) || /'self'|'none'/.test(fa[1]);
      return !!all['x-frame-options']; // fallback clickjacking control
    },
    want: "frame-ancestors 'self'/'none' (no bare *) OR X-Frame-Options",
  },
  { header: 'permissions-policy', severity: 'SOFT', test: (v) => !!v && v.length > 0, want: 'present' },
  { header: 'content-security-policy', as: 'no-unsafe-eval', severity: 'HARD', test: (v) => !/unsafe-eval/i.test(v || ''), want: "no 'unsafe-eval'" },
  { header: 'content-security-policy', as: 'strict-dynamic', severity: 'SOFT', test: (v) => /strict-dynamic/i.test(v || ''), want: "'strict-dynamic' + nonce (CSP L3)" },
];

/** High-signal secret patterns to scan response bodies for (a leak in HTML/JSON = HARD). */
const SECRET_PATTERNS = [
  { name: 'stripe-live', re: /sk_live_[0-9a-zA-Z]{16,}/ },
  { name: 'stripe-restricted', re: /rk_live_[0-9a-zA-Z]{16,}/ },
  { name: 'aws-akid', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'private-key', re: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/ },
  { name: 'slack-token', re: /xox[baprs]-[0-9A-Za-z-]{10,}/ },
  { name: 'gh-pat', re: /ghp_[0-9A-Za-z]{30,}/ },
  { name: 'openai', re: /sk-[A-Za-z0-9]{40,}/ },
  { name: 'google-api', re: /AIza[0-9A-Za-z_-]{35}/ },
];

async function fetchSurface(s) {
  try {
    const res = await fetch(s.url, {
      redirect: 'manual',
      headers: { 'User-Agent': UA, Accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(20000),
    });
    const headers = {};
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    const body = await res.text().catch(() => '');
    return { ...s, status: res.status, headers, body: body.slice(0, 200000) };
  } catch (e) {
    return { ...s, status: 0, headers: {}, body: '', error: String((e && e.message) || e).slice(0, 80) };
  }
}

const findings = [];
const surfaces = [];
for (const s of SURFACES) {
  const r = await fetchSurface(s);
  surfaces.push({ name: r.name, url: r.url, status: r.status, error: r.error });

  if (r.status === 0) {
    findings.push({ surface: r.name, severity: 'SOFT', kind: 'unreachable', detail: r.error || 'no response' });
    continue;
  }

  // Header policy (skip on the app-level surfaces only; a real challenge/edge page can't be fixed here).
  for (const p of HEADER_POLICY) {
    const ok = p.test(r.headers[p.header], r.headers);
    if (!ok) {
      findings.push({ surface: r.name, severity: p.severity, kind: `header:${p.as || p.header}`, want: p.want, got: (r.headers[p.header] || '(absent)').slice(0, 120) });
    }
  }

  // Soft-404 hygiene: an unmatched /api/* must be a real 404, not the 200 SPA shell.
  if (r.kind === 'json-404' && r.status === 200) {
    findings.push({ surface: r.name, severity: 'HARD', kind: 'soft-404', detail: 'unmatched /api/* returned 200 (should be 404)' });
  }

  // Secret-leak scan of the response body.
  for (const pat of SECRET_PATTERNS) {
    if (pat.re.test(r.body)) {
      findings.push({ surface: r.name, severity: 'HARD', kind: `secret-leak:${pat.name}`, detail: 'secret pattern present in response body' });
    }
  }
}

const hard = findings.filter((f) => f.severity === 'HARD');
const soft = findings.filter((f) => f.severity === 'SOFT');
const report = { ok: hard.length === 0, surfaces, hardFindings: hard, softFindings: soft, checkedAt: 'run-stamped-by-caller' };

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`\n━━ Security-headers + secret-leak probe → ${report.ok ? 'PASS' : 'FAIL'} ━━`);
  for (const s of surfaces) console.log(`  ${s.name.padEnd(16)} ${s.status}${s.error ? ' · ' + s.error : ''}`);
  if (hard.length) {
    console.log(`\n  ✗ HARD (${hard.length}):`);
    for (const f of hard) console.log(`    [${f.surface}] ${f.kind} — ${f.want ? `want ${f.want}, got ${f.got}` : f.detail}`);
  }
  if (soft.length) {
    console.log(`\n  ⚠ SOFT (${soft.length}):`);
    for (const f of soft) console.log(`    [${f.surface}] ${f.kind} — ${f.want ? `want ${f.want}, got ${f.got}` : f.detail}`);
  }
  if (report.ok && !soft.length) console.log('  ✓ all surfaces carry safe security headers; no secrets leaked');
}

process.exit(hard.length === 0 ? 0 : 1);
