/**
 * @module e2e/create-blur-required
 *
 * LIVE prod regression for the fire-52 golden-path finding: the /create wizard's
 * required-field inline error (WCAG 3.3.1 Error Identification) must fire on the
 * FOCUS-then-BLUR-empty path — a keyboard/AT user who TABS into Business Name or
 * Business Address and TABS straight back out WITHOUT typing must be TOLD the field
 * is required, with `aria-invalid="true"` + a visible inline message.
 *
 * The original fire-51 fix only marked a field "touched" on TYPING (or a query-param
 * prefill), so a bare focus→blur surfaced NOTHING and left the "Create site" button
 * disabled with zero guidance — the exact catch-22 the fix targeted, still live for
 * the most common keyboard pattern. The fire-52 fix marks the field touched on blur
 * (a blur IS a visit) in `closeBusinessDropdown` / `closeAddressDropdown`.
 *
 * Homepage-first per the E2E mandate: goto('/'), then reach /create by a real nav
 * click (the hero "Build a custom website" path), never a second page.goto(). No
 * auth needed — the wizard is public. No paid build is triggered (we never click
 * "Create site"). Run: `npm run test:e2e:prod`.
 */
import { test, expect } from '@playwright/test';

test.describe('/create — required-field error on focus→blur-empty (WCAG 3.3.1, fire-52)', () => {
  test.describe.configure({ retries: 1 });

  test('Business Name: tab in, tab out empty → inline error + aria-invalid', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });

    // Homepage-first, then navigate to the wizard by a real click.
    await page.goto('/', { waitUntil: 'load' });
    await page.getByTestId('hero-search-input').fill('Vito Salon Blur Test');
    // The search resolves to a "Build a custom website" CTA (Places degrades to manual
    // entry in prod); click it to land on /create by a UI action, not a page.goto().
    await page.getByTestId('search-result').click();
    await expect(page).toHaveURL(/\/create/);

    const name = page.locator('#create-name');
    await expect(name).toBeVisible();
    // Clear any query-param / draft prefill so we exercise the empty path.
    await name.click();
    await name.fill('');
    // Focus is on name; TAB away without typing → blur while empty.
    await page.keyboard.press('Tab');

    // The inline error + aria-invalid must appear from the pure focus→blur (no submit).
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    const nameError = page.locator('#create-name-error');
    await expect(nameError).toContainText(/required/i);

    // Typing a valid value back clears the error immediately.
    await name.fill('Vito Salon');
    await expect(name).toHaveAttribute('aria-invalid', 'false');
    await expect(nameError).toHaveText('');

    expect(consoleErrors, `console errors on /create: ${consoleErrors.join(' | ')}`).toEqual([]);
  });

  test('Business Address: tab in, tab out empty → inline error + aria-invalid', async ({
    page,
  }) => {
    await page.goto('/', { waitUntil: 'load' });
    await page.getByTestId('hero-search-input').fill('Vito Salon Addr Test');
    await page.getByTestId('search-result').click();
    await expect(page).toHaveURL(/\/create/);

    const address = page.locator('#create-address');
    await expect(address).toBeVisible();
    // Focus the empty address field and tab straight out — no keystroke.
    await address.click();
    await page.keyboard.press('Tab');

    await expect(address).toHaveAttribute('aria-invalid', 'true');
    const addrError = page.locator('#create-address-error');
    await expect(addrError).toContainText(/required/i);

    // Recovery: typing a real address clears the error.
    await address.fill('74 N Beverwyck Rd, Lake Hiawatha, NJ 07034');
    await expect(address).toHaveAttribute('aria-invalid', 'false');
    await expect(addrError).toHaveText('');
  });
});
