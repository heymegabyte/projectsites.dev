/**
 * Conversion money-path accessibility gate — axe-core WCAG 2.2 AA + a visible
 * keyboard focus ring on the three surfaces that convert every prospect:
 *
 *     homepage `/`  →  sign-in `/signin`  →  create `/create`
 *
 * WHY THIS SPEC EXISTS (the gap it closes):
 *   • `accessibility.spec.ts` already axe-checks `/` and `/signin` at 6 breakpoints,
 *     but NOT `/create` — and the AUTHED `/create` is where the real funnel form
 *     lives (7 inputs + a textarea + the "Create site" CTA). Unauthed, `/create`
 *     renders an empty gated shell (0 controls), so an unauth axe pass there is
 *     hollow. This spec signs in via the sanctioned test-login seam and audits the
 *     REAL create form — the one durable axe tripwire for the authed funnel step.
 *   • axe CANNOT evaluate focus indicators (WCAG 2.4.7 / 2.4.11) — it has no way to
 *     compute what a control looks like under `:focus-visible`. A filled-pill CTA
 *     whose brand glow swallowed its focus ring (the admin "New site" primary CTA,
 *     fixed in admin.component.scss `.nav-item-create:focus-visible`) passed every
 *     axe gate while shipping with NO visible keyboard focus. The focus-ring
 *     assertions below are the regression guard axe structurally cannot be.
 *
 * Pattern: shared `checkA11y` helper (e2e/helpers/a11y.ts, CRITICAL+SERIOUS here —
 * stricter than the advisory default, because this is the money path), real
 * Chromium, the proven `/signin?test=1` → `POST /api/auth/test-login` seam (same
 * as every sibling money-path prod spec), homepage-first, no sleeps.
 *
 * Gated on `E2E_TEST_PASSWORD` for the authed `/create` leg only — the public
 * `/` + `/signin` legs always run.
 */
import { test, expect, type Page } from '@playwright/test';
import { checkA11y } from './helpers/a11y.js';

const PROD_URL = process.env.PROD_URL ?? 'https://projectsites.dev';

/** The seam's one hardcoded identity (`src/services/auth.ts` TEST_LOGIN_EMAIL). */
const TEST_LOGIN_EMAIL = 'brian@megabyte.space';

/** Money-path key breakpoints: smallest phone, tablet, laptop. */
const BREAKPOINTS: ReadonlyArray<{ name: string; width: number; height: number }> = [
  { name: 'mobile-sm', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

/**
 * Settle the DOM before axe: await every running entrance animation (View
 * Transition / opacity fade) so a mid-fade reduced opacity never reads as a
 * phantom color-contrast fail, capped so a looping animation can't hang.
 */
async function settle(page: Page): Promise<void> {
  await page
    .evaluate(
      () =>
        new Promise<void>((res) => {
          const running = document.getAnimations().filter((a) => a.playState === 'running');
          if (!running.length) return res();
          void Promise.race([
            Promise.allSettled(running.map((a) => a.finished)),
            new Promise((r) => setTimeout(r, 1500)),
          ]).then(() => res());
        }),
    )
    .catch(() => {});
  await page.waitForTimeout(150);
}

/** Run axe (CRITICAL + SERIOUS — money path is stricter than advisory) at every breakpoint. */
async function auditAllBreakpoints(page: Page, label: string): Promise<void> {
  for (const bp of BREAKPOINTS) {
    await page.setViewportSize({ width: bp.width, height: bp.height });
    await settle(page);
    await checkA11y(page, `${label} @ ${bp.name} (${bp.width}×${bp.height})`, {
      includedImpacts: ['critical', 'serious'],
    });
  }
}

/** CSS-escape an id for a `#id` selector (handles Tailwind-ish ids defensively). */
function cssId(id: string): string {
  return id.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
}

/**
 * Walk the keyboard focus order (real `Tab` presses — the WCAG 2.4.7 modality)
 * and assert EVERY focusable control encountered paints a visible focus ring.
 * Establishes keyboard modality first via an initial `Tab`. Returns the list of
 * controls that FAILED (empty = all good) for a precise failure message.
 */
async function assertEveryTabbedControlHasRing(
  page: Page,
  maxTabs: number,
): Promise<string[]> {
  // Reset to a neutral origin so Tab starts from the top of the document.
  await page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    a?.blur?.();
  });
  const failures: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < maxTabs; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      const ow = parseFloat(cs.outlineWidth) || 0;
      const hasOutline = ow > 0 && cs.outlineStyle !== 'none';
      const hasShadowRing = cs.boxShadow !== 'none' && /rgb|oklch|oklab/.test(cs.boxShadow);
      const key =
        el.id ||
        `${el.tagName.toLowerCase()}:${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24)}`;
      return { key, ring: hasOutline || hasShadowRing };
    });
    if (!info) continue;
    if (seen.has(info.key)) continue;
    seen.add(info.key);
    if (!info.ring) failures.push(info.key);
  }
  return failures;
}

/**
 * Tab until the element matching `selector` is `document.activeElement`, then
 * assert it paints a focus ring that is DISTINCT from its resting decoration.
 *
 * Critical subtlety (the [pill!] trap): a filled pill (`.nav-item-create`) carries
 * a decorative `box-shadow` glow AT REST. A naive "box-shadow present?" check reads
 * that resting glow as a ring and passes even when the control has NO focus
 * indicator. So we snapshot the element's resting outline+box-shadow FIRST (while
 * it is NOT focused), then Tab onto it, and require a real `outline` OR a
 * box-shadow that CHANGED from rest. Returns false if never reached.
 */
async function tabToAndAssertRing(
  page: Page,
  selector: string,
  maxTabs = 40,
): Promise<boolean> {
  const loc = page.locator(selector).first();
  // Snapshot resting style (ensure it is not the active element first).
  const rest = await loc.evaluate((el) => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    const cs = getComputedStyle(el as HTMLElement);
    return { outlineWidth: cs.outlineWidth, outlineStyle: cs.outlineStyle, boxShadow: cs.boxShadow };
  });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  for (let i = 0; i < maxTabs; i++) {
    await page.keyboard.press('Tab');
    const res = await loc
      .evaluate(
        (el, restStyle) => {
          if (el !== document.activeElement) return null;
          const cs = getComputedStyle(el as HTMLElement);
          const ow = parseFloat(cs.outlineWidth) || 0;
          const hasOutline = ow > 0 && cs.outlineStyle !== 'none';
          // A focus ring via box-shadow must DIFFER from the resting box-shadow —
          // otherwise it's just the control's resting decoration, not an indicator.
          const shadowChanged = cs.boxShadow !== 'none' && cs.boxShadow !== restStyle.boxShadow;
          return hasOutline || shadowChanged;
        },
        rest,
      )
      .catch(() => null);
    if (res !== null) return res;
  }
  return false;
}

test.describe('Money-path a11y — homepage → signin → create (axe + focus ring)', () => {
  test('/ (homepage) is axe-clean + the hero CTA shows a focus ring', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto(`${PROD_URL}/`, { waitUntil: 'domcontentloaded' });
    await page
      .locator('[data-testid="hero-headline"]')
      .first()
      .waitFor({ state: 'visible', timeout: 35_000 });

    await auditAllBreakpoints(page, '/');

    // Every control the user tabs through on the landing surface must paint a
    // visible keyboard focus ring (WCAG 2.4.7). Real `Tab` traversal — the modality
    // that engages `:focus-visible` on links/buttons.
    await page.setViewportSize({ width: 1280, height: 900 });
    const miss = await assertEveryTabbedControlHasRing(page, 10);
    expect(miss, `homepage controls missing a focus ring: ${miss.join(', ')}`).toEqual([]);
  });

  test('/signin is axe-clean + the email field shows a focus ring', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto(`${PROD_URL}/signin`, { waitUntil: 'domcontentloaded' });
    await page
      .locator('[data-testid="sign-in-page"]')
      .first()
      .waitFor({ state: 'visible', timeout: 35_000 });

    await auditAllBreakpoints(page, '/signin');

    // Every control a user tabs through on sign-in must paint a visible ring — the
    // email/password fields, Show-password toggle, Sign-in + magic-link + OAuth
    // buttons. Real keyboard traversal.
    await page.setViewportSize({ width: 1280, height: 900 });
    const miss = await assertEveryTabbedControlHasRing(page, 12);
    expect(miss, `/signin controls missing a focus ring: ${miss.join(', ')}`).toEqual([]);
  });

  test.describe('authed /create (real funnel form)', () => {
    test.skip(
      !process.env.E2E_TEST_PASSWORD,
      'needs E2E_TEST_PASSWORD for the real /signin?test=1 → /api/auth/test-login seam',
    );

    test('/create is axe-clean + the "New site" CTA shows a focus ring', async ({ page }) => {
      test.setTimeout(120_000);

      // Homepage-first, then the one sanctioned goto — the test-login seam (the
      // E2E equivalent of a magic-link click, per every sibling money-path spec).
      await page.goto(`${PROD_URL}/`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('hero-headline')).toBeVisible({ timeout: 35_000 });

      await page.goto(`${PROD_URL}/signin?test=1`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('test-signin-panel')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId('test-signin-email')).toHaveValue(TEST_LOGIN_EMAIL);
      await page.getByTestId('test-signin-password').fill(process.env.E2E_TEST_PASSWORD!);
      await page.getByTestId('test-signin-submit').click();
      await expect(page).toHaveURL(/\/admin/, { timeout: 30_000 });

      // The authenticated create funnel — the real form (not the unauth gated shell).
      await page.goto(`${PROD_URL}/create`, { waitUntil: 'domcontentloaded' });
      await page.locator('#create-name').waitFor({ state: 'visible', timeout: 35_000 });

      await auditAllBreakpoints(page, '/create (authed)');
      await page.setViewportSize({ width: 1280, height: 900 });

      // Regression guard for the admin primary-CTA focus-ring fix: the filled
      // cyan→violet "New site" pill (admin.component.scss `.nav-item-create`)
      // whose resting glow used to swallow the focus indicator — it shipped with NO
      // visible keyboard focus (axe can't detect that). It now draws a dark→white
      // double box-shadow ring under `:focus-visible`. Reached by real Tab traversal.
      const cta = page.locator('a.nav-item-create');
      if (await cta.count()) {
        expect(
          await tabToAndAssertRing(page, 'a.nav-item-create'),
          'the "New site" primary CTA must have a visible focus ring',
        ).toBe(true);
      }

      // And the funnel's own primary field keeps a ring too.
      expect(
        await tabToAndAssertRing(page, `#${cssId('create-name')}`),
        '/create business-name field must have a visible focus ring',
      ).toBe(true);
    });
  });
});
