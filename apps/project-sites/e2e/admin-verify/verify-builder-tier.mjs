/**
 * SiteBuilder tier verification — POST /api/diag/container-minimal inside a REAL
 * browser (CF managed-challenge solved), proving the just-right-sized
 * standard-1 container boots + writes R2 + returns. Fast (no Claude Code);
 * the full real-build proof lives in create-edit-publish-flow.spec.ts
 * (E2E_REAL_BUILD=1, ~40 min).
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
// playwright-core via createRequire from the frontend dir — reliably hoisted after `npm ci`;
// bare `import from 'playwright'` throws MODULE_NOT_FOUND when unhoisted (AL-144). Matches admin-surf-audit.mjs.
const { chromium } = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '../../frontend/'))(
  'playwright-core',
);

const secret = (k) => {
  const r = spawnSync('/Users/Apple/.local/bin/get-secret', [k], { encoding: 'utf8' });
  return (r.stdout ?? '').trim();
};

const BB = secret('BROWSERBASE_API_KEY');
const PROJ = secret('BROWSERBASE_PROJECT_ID');
const CF_TOKEN = secret('CF_API_TOKEN');

if (!BB || !PROJ || !CF_TOKEN) {
  console.log('::notice:: verify-builder-tier skipped — missing Browserbase/CF_API_TOKEN creds');
  process.exit(0);
}

const r = await fetch('https://api.browserbase.com/v1/sessions', {
  method: 'POST',
  headers: { 'X-BB-API-Key': BB, 'Content-Type': 'application/json' },
  body: JSON.stringify({ projectId: PROJ, timeout: 300 }),
});
if (!r.ok) {
  console.log('session create failed', r.status);
  process.exit(3);
}
const { id } = await r.json();
const browser = await chromium.connectOverCDP(
  `wss://connect.browserbase.com?apiKey=${encodeURIComponent(BB)}&sessionId=${encodeURIComponent(id)}`,
);

try {
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto('https://projectsites.dev/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(7000); // CF managed-challenge solve

  const result = await page.evaluate(
    async ({ tok }) => {
      try {
        const res = await fetch('/api/diag/container-minimal', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-test-secret': tok.slice(0, 12),
          },
          body: JSON.stringify({ slug: 'tier-verify-standard1' }),
        });
        const text = await res.text();
        let body = null;
        try {
          body = JSON.parse(text);
        } catch {
          /* non-json */
        }
        return { status: res.status, body, raw: text.slice(0, 200) };
      } catch (e) {
        return { status: 0, error: String(e).slice(0, 150) };
      }
    },
    { tok: CF_TOKEN },
  );

  console.log('\n=== SITE BUILDER TIER VERIFICATION (standard-1) ===\n');
  if (result.status === 200 && result.body) {
    console.log('✅ container round-trip 200');
    console.log(JSON.stringify(result.body, null, 1).slice(0, 700));
    const ok = result.body.ok ?? result.body.success ?? result.body.status;
    console.log(ok ? '✅ BUILDER TIER VERIFIED' : '🔴 unexpected body shape — inspect above');
    process.exitCode = ok ? 0 : 1;
  } else {
    console.log(`🔴 HTTP ${result.status} ${result.error ?? result.raw}`);
    process.exitCode = 1;
  }
} finally {
  await browser.close().catch(() => {});
}
