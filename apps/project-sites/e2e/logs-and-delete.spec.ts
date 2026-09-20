/**
 * RETIRED 2026-09-20 (AL-831) — tested the DELETED vanilla homepage Logs modal + Delete-with-
 * subscription + Credits pill, removed with vanilla `public/index.html` on 2026-07-31. Those are now
 * Angular surfaces, covered by: `admin-logs-journey.spec.ts` (logs), `admin-verify/verify-site-delete-
 * envelope.mjs` (delete), billing specs (credits/subscription). Skipped (not deleted, per
 * e2e-accumulation) — the old body was a false-green phantom (dead `#screen-*` selectors, green only
 * vs the stale `sites-staging.megabyte.space` shard). A 1:1 rewrite would duplicate the coverage above.
 */

import { test, expect } from './fixtures.js';

test.describe.skip('Logs Modal UI', () => {
  test('Logs modal exists in the DOM and is initially hidden', async ({ page }) => {
    await page.goto('/');

    const logsModal = page.locator('#site-logs-modal');
    await expect(logsModal).toBeAttached();
    await expect(logsModal).not.toHaveClass(/visible/);
  });

  test('Logs modal has required child elements', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('#logs-modal-site-name')).toBeAttached();
    await expect(page.locator('#logs-container')).toBeAttached();
    await expect(page.locator('#logs-count-label')).toBeAttached();
    await expect(page.locator('.logs-refresh-btn')).toBeAttached();
  });
});

test.describe.skip('Delete Modal with Subscription Option', () => {
  test('Delete modal exists and has subscription checkbox', async ({ page }) => {
    await page.goto('/');

    const deleteModal = page.locator('#delete-modal');
    await expect(deleteModal).toBeAttached();
    await expect(deleteModal).not.toHaveClass(/visible/);

    // Subscription option is hidden by default
    const subOption = page.locator('#delete-modal-sub-option');
    await expect(subOption).toBeAttached();
    await expect(subOption).toBeHidden();

    // Cancel checkbox exists
    await expect(page.locator('#delete-cancel-sub')).toBeAttached();
  });
});

test.describe.skip('Credits Pill', () => {
  test('Credits pill element exists in the admin panel', async ({ page }) => {
    await page.goto('/');

    const creditsPill = page.locator('#admin-credits-pill');
    await expect(creditsPill).toBeAttached();
    // Hidden when not logged in
    await expect(creditsPill).toBeHidden();
  });
});

test.describe.skip('CTA Buttons', () => {
  test('Build Your Free Website button calls startBuildFlow', async ({ page }) => {
    await page.goto('/');

    const ctaBtn = page.locator('.hero-ctas .btn-accent');
    await expect(ctaBtn).toBeVisible();
    await expect(ctaBtn).toHaveText('Build Your Free Website');

    // Should have onclick="startBuildFlow()"
    const onclick = await ctaBtn.getAttribute('onclick');
    expect(onclick).toContain('startBuildFlow()');
  });

  test('Get Started Now button calls startBuildFlow', async ({ page }) => {
    await page.goto('/');

    const footerCta = page.getByRole('button', { name: 'Get Started Now' });
    await expect(footerCta).toBeAttached();

    const onclick = await footerCta.getAttribute('onclick');
    expect(onclick).toContain('startBuildFlow()');
  });

  test('startBuildFlow navigates to signin when not logged in', async ({ page }) => {
    await page.goto('/');

    // Click the Build Your Free Website button
    await page.locator('.hero-ctas .btn-accent').click();

    // Should navigate to the sign-in screen
    await expect(page.locator('#screen-signin')).toHaveClass(/active/);
  });
});

test.describe.skip('Relative Time Formatting', () => {
  test('formatLogTimestamp returns "just now" for recent timestamps', async ({ page }) => {
    await page.goto('/');

    const result = await page.evaluate(() => {
      const fn = (window as unknown as Record<string, (s: string) => string>).formatLogTimestamp;
      if (typeof fn !== 'function') return null;
      return fn(new Date().toISOString());
    });
    expect(result).toBe('just now');
  });

  test('formatLogTimestamp returns seconds ago for 20s old', async ({ page }) => {
    await page.goto('/');

    const result = await page.evaluate(() => {
      const fn = (window as unknown as Record<string, (s: string) => string>).formatLogTimestamp;
      if (typeof fn !== 'function') return null;
      return fn(new Date(Date.now() - 20000).toISOString());
    });
    expect(result).toMatch(/20s ago|just now/);
  });

  test('formatLogTimestamp returns "X min ago" for 5 minutes', async ({ page }) => {
    await page.goto('/');

    const result = await page.evaluate(() => {
      const fn = (window as unknown as Record<string, (s: string) => string>).formatLogTimestamp;
      if (typeof fn !== 'function') return null;
      return fn(new Date(Date.now() - 5 * 60 * 1000).toISOString());
    });
    expect(result).toBe('5 min ago');
  });

  test('formatLogTimestamp returns "X hr ago" for 3 hours', async ({ page }) => {
    await page.goto('/');

    const result = await page.evaluate(() => {
      const fn = (window as unknown as Record<string, (s: string) => string>).formatLogTimestamp;
      if (typeof fn !== 'function') return null;
      return fn(new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString());
    });
    expect(result).toBe('3 hr ago');
  });
});

test.describe.skip('Workflow Step Action Labels', () => {
  test('formatActionLabel has labels for new workflow step actions', async ({ page }) => {
    await page.goto('/');

    const labels = await page.evaluate(() => {
      const fn = (window as unknown as Record<string, (s: string) => string>).formatActionLabel;
      if (typeof fn !== 'function') return null;
      return {
        profileStarted: fn('workflow.step.profile_research_started'),
        parallelStarted: fn('workflow.step.parallel_research_started'),
        htmlStarted: fn('workflow.step.html_generation_started'),
        legalStarted: fn('workflow.step.legal_scoring_started'),
        uploadStarted: fn('workflow.step.upload_started'),
        publishStarted: fn('workflow.step.publishing_started'),
        stepFailed: fn('workflow.step.failed'),
      };
    });

    expect(labels).not.toBeNull();
    if (labels) {
      expect(labels.profileStarted).toBe('Researching Business');
      expect(labels.parallelStarted).toBe('Researching Details');
      expect(labels.htmlStarted).toBe('Generating Website');
      expect(labels.legalStarted).toBe('Creating Legal Pages');
      expect(labels.uploadStarted).toBe('Uploading Files');
      expect(labels.publishStarted).toBe('Publishing Site');
      expect(labels.stepFailed).toBe('Step Failed');
    }
  });

  test('formatLogMeta displays step field from meta', async ({ page }) => {
    await page.goto('/');

    const result = await page.evaluate(() => {
      const fn = (window as unknown as Record<string, (m: Record<string, string>) => string>).formatLogMeta;
      if (typeof fn !== 'function') return null;
      return fn({ step: 'research-profile', business_name: 'Test Biz' });
    });

    expect(result).not.toBeNull();
    if (result) {
      expect(result).toContain('step:');
      expect(result).toContain('research-profile');
    }
  });
});

test.describe.skip('Title Inline Edit Style Sync', () => {
  test('site-card-title-row .inline-edit-wrap has matching font properties', async ({ page }) => {
    await page.goto('/');

    // Verify CSS rule exists for .site-card-title-row .inline-edit-wrap
    const styles = await page.evaluate(() => {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            const cssRule = rule as CSSStyleRule;
            if (cssRule.selectorText === '.site-card-title-row .inline-edit-wrap') {
              return {
                fontSize: cssRule.style.fontSize,
                fontWeight: cssRule.style.fontWeight,
                fontFamily: cssRule.style.fontFamily,
                letterSpacing: cssRule.style.letterSpacing,
                lineHeight: cssRule.style.lineHeight,
              };
            }
          }
        } catch (_e) { /* cross-origin */ }
      }
      return null;
    });

    expect(styles).not.toBeNull();
    if (styles) {
      expect(styles.fontSize).toBe('0.9rem');
      expect(styles.fontWeight).toBe('600');
      expect(styles.letterSpacing).toBe('normal');
      expect(styles.lineHeight).toBe('1.5');
    }
  });
});

test.describe.skip('Footer legal links point to local pages', () => {
  test('footer links use local paths instead of external URLs', async ({ page }) => {
    await page.goto('/');

    const privacyHref = await page.locator('.footer-bottom a:has-text("Privacy Policy")').getAttribute('href');
    const termsHref = await page.locator('.footer-bottom a:has-text("Terms of Service")').getAttribute('href');
    const contentHref = await page.locator('.footer-bottom a:has-text("Content Policy")').getAttribute('href');

    expect(privacyHref).toBe('/privacy');
    expect(termsHref).toBe('/terms');
    expect(contentHref).toBe('/content');
  });

  test('signin footer legal links use local paths', async ({ page }) => {
    await page.goto('/');

    // Navigate to signin screen
    await page.evaluate(() => {
      (window as unknown as Record<string, (s: string) => void>).navigateTo('signin');
    });

    const privacyLink = page.locator('.signin-footer-legal a:has-text("Privacy")');
    await expect(privacyLink).toHaveAttribute('href', '/privacy');

    const termsLink = page.locator('.signin-footer-legal a:has-text("Terms")');
    await expect(termsLink).toHaveAttribute('href', '/terms');
  });
});

test.describe.skip('Google Place ID UI', () => {
  test('Place ID info element has a link and close button', async ({ page }) => {
    await page.goto('/');

    // Place ID link element
    const placeIdLink = page.locator('#details-place-id-text');
    await expect(placeIdLink).toBeAttached();

    // Should be an <a> tag
    const tagName = await placeIdLink.evaluate((el) => el.tagName);
    expect(tagName).toBe('A');

    // Close button (X) should exist inside the place-id-info container
    const closeBtn = page.locator('#details-place-id-info button');
    await expect(closeBtn).toBeAttached();
  });
});

test.describe.skip('escapeAttr function', () => {
  test('page has the escapeAttr function defined', async ({ page }) => {
    await page.goto('/');

    // Verify escapeAttr exists and handles apostrophes
    const result = await page.evaluate(() => {
      return (window as unknown as Record<string, (s: string) => string>).escapeAttr(
        "Vito's Salon",
      );
    });
    expect(result).toContain('&#39;');
    expect(result).not.toContain("'");
  });
});

test.describe.skip('Improve with AI without text', () => {
  test('Improve AI link exists and does not check for minimum text', async ({ page }) => {
    await page.goto('/');

    // The Improve with AI link should exist
    const improveBtn = page.locator('#improve-ai-btn');
    await expect(improveBtn).toBeAttached();

    // Verify the JS function does NOT contain the old validation
    const hasOldCheck = await page.evaluate(() => {
      const fn = (window as unknown as Record<string, () => void>).improveWithAI;
      return fn ? fn.toString().includes('Please write some text first') : true;
    });
    expect(hasOldCheck).toBe(false);
  });
});
