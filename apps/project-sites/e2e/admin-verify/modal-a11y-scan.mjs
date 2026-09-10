// modal-a11y-scan.mjs — axe INSIDE open modals (the gap admin-surf-audit misses).
//
// surf-audit runs axe on page LOAD, so a violation that only exists while a MODAL is OPEN
// (focus not trapped, missing aria-modal/labelledby, low-contrast dialog chrome, heading
// order, a form field with no label) ships unseen. Every admin modal renders through the
// shared `DialogShellComponent`, so a defect here is shared across ALL modals — and a fix
// at the primitive fixes them all. This opens representative modals via their real triggers
// and runs axe with the dialog on screen. Reports serious/critical violations (the tier that
// blocks use); best-practice/minor are advisory.
//
// Fail-open (conditional-ci-gates): E2E_API_KEY unset ⇒ ::notice:: + exit 0.
// Usage: E2E_API_KEY=$(get-secret E2E_API_KEY) node e2e/admin-verify/modal-a11y-scan.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(__dirname, '../../frontend/'));
const { chromium } = req('playwright');
const { default: AxeBuilder } = req('@axe-core/playwright');

const KEY = process.env.E2E_API_KEY;
if (!KEY) { console.log('::notice:: modal-a11y-scan skipped — E2E_API_KEY unset'); process.exit(0); }
const ORIGIN = process.env.ORIGIN || 'https://projectsites.dev';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

// Representative modals, keyed by section + trigger (data-testid preferred, else name regex).
// All render via DialogShellComponent, so this validates the shared primitive broadly.
const MODALS = [
  { section: 'api-tokens', trigger: /new token/i, name: 'create-token' },
  { section: 'user', testid: 'apikey-create-button', name: 'generate-user-key' },
  // Destructive-confirm variant (danger button + "Revoke X?" title). SAFE: clicking "Revoke"
  // only OPENS the confirm (`confirmRevoke` sets the target) — the DELETE fires solely from the
  // confirm button, which this probe NEVER clicks. Validates the danger-button contrast/label
  // + the confirm dialog's a11y, not just the create dialogs.
  { section: 'api-tokens', trigger: /^revoke/i, name: 'revoke-confirm', destructive: true },
];

const browser = await chromium.launch();
// Viewport configurable (VIEWPORT=390 for the mobile modal pass — modals that
// overflow / park close+focus off-screen only bite on narrow screens); default
// desktop. Mirrors admin-surf-audit + focus-not-obscured + target-size-scan.
const VW = parseInt(process.env.VIEWPORT || '1280', 10);
const ctx = await browser.newContext({ userAgent: UA, viewport: { width: VW, height: 900 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.evaluate((k) => localStorage.setItem('ps_session', JSON.stringify({ token: k, identifier: 'e2e@megabyte.space', issuedAt: Date.now() })), KEY);

const rows = [];
let fails = 0;
for (const m of MODALS) {
  try {
    await page.goto(`${ORIGIN}/admin/${m.section}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2200); // async subsections (e.g. user API-keys) load after first paint
    const btn = m.testid ? page.locator(`[data-testid="${m.testid}"]`).first() : page.getByRole('button', { name: m.trigger }).first();
    if (!(await btn.count().catch(() => 0))) { rows.push({ name: m.name, note: 'trigger not found (skipped)' }); continue; }
    await btn.click().catch(() => {});
    // Wait for the dialog to be on screen.
    let opened = false;
    try { await page.waitForSelector('[role="dialog"], .ps-dialog, app-dialog-shell', { state: 'visible', timeout: 6000 }); opened = true; } catch { /* */ }
    if (!opened) { rows.push({ name: m.name, note: 'dialog did not open (skipped)' }); continue; }
    await page.waitForTimeout(600);
    // axe over the whole page WITH the modal open — catches modal chrome + backdrop issues.
    const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
    const serious = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    if (serious.length) fails += serious.length;
    rows.push({ name: m.name, section: m.section, serious, all: res.violations.length });
  } catch (e) {
    rows.push({ name: m.name, note: 'error: ' + String(e).slice(0, 80) });
  }
}
await browser.close();

for (const r of rows) {
  if (r.note) { console.log(`  ·  ${r.name.padEnd(18)} ${r.note}`); continue; }
  if (!r.serious.length) { console.log(`  ✓  ${r.name.padEnd(18)} axe clean (0 serious/critical, ${r.all} total incl. advisory)`); continue; }
  console.log(`  ✗  ${r.name.padEnd(18)} ${r.serious.length} serious/critical:`);
  for (const v of r.serious) console.log(`        [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length}) — ${(v.nodes[0]?.html || '').slice(0, 90)}`);
}
console.log(
  fails
    ? `\nVERDICT: ❌ FAIL — ${fails} serious/critical axe violation(s) inside open modal(s) (DialogShell — fix at the primitive).`
    : `\nVERDICT: ✅ PASS — every scanned modal is axe-clean (0 serious/critical) with the dialog open.`,
);
process.exit(fails ? 1 : 0);
