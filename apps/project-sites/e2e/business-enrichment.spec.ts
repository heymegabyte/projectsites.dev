/**
 * E2E tests for business data enrichment flow.
 *
 * Tests the full flow from homepage search through business selection
 * to data enrichment via Cloudflare AI Workflow.
 *
 * Covers:
 * - Search for "Vito's Mens Salon" on homepage
 * - Business search API returns results
 * - Selection of a business from search dropdown
 * - Navigation to details screen with pre-populated data
 * - Business context textarea and improve-with-AI
 * - AI validation endpoint structure
 * - Workflow step labels and ordering
 * - Build terminal step rendering
 *
 * RETIRED 2026-09-20 (AL-831) — this whole flow was the DELETED vanilla homepage search→select→
 * details→AI-validate paradigm, removed with vanilla `public/index.html` on 2026-07-31. It is now the
 * Angular hero search + `/create` wizard, covered by: `search-and-places.spec.ts` (AL-804 — hero
 * search→results→funnel), `home/create-wizard.spec.ts`, `golden-path.spec.ts`. Skipped (not deleted,
 * per e2e-accumulation) — the old body was a false-green phantom (dead `#screen-*`/`#search-*`
 * selectors, green only vs the stale `sites-staging.megabyte.space` shard). A 1:1 rewrite would
 * duplicate the modern search + create-wizard coverage above.
 */

import { test, expect } from './fixtures.js';

test.describe.skip('Business Search Flow', () => {
  test('search input exists and accepts text', async ({ page }) => {
    await page.goto('/');

    const searchInput = page.locator('#search-input');
    await expect(searchInput).toBeVisible();
    await expect(searchInput).toHaveAttribute('placeholder', expect.stringContaining('business name'));
  });

  test('search dropdown container exists', async ({ page }) => {
    await page.goto('/');

    const dropdown = page.locator('#search-dropdown');
    await expect(dropdown).toBeAttached();
  });

  test('typing in search input triggers debounced search', async ({ page }) => {
    await page.goto('/');

    // The search triggers on input with debounce
    const hasSearchLogic = await page.evaluate(() => {
      const scripts = document.querySelectorAll('script');
      for (let i = 0; i < scripts.length; i++) {
        const text = scripts[i].textContent || '';
        if (text.includes('search-input') && text.includes('debounce') || text.includes('setTimeout')) {
          return true;
        }
      }
      return false;
    });
    expect(hasSearchLogic).toBe(true);
  });
});

test.describe.skip('Business Selection and Details', () => {
  test('details screen has business name input', async ({ page }) => {
    await page.goto('/');

    const nameInput = page.locator('#business-name-input');
    await expect(nameInput).toBeAttached();
  });

  test('details screen has business address input', async ({ page }) => {
    await page.goto('/');

    const addrInput = page.locator('#business-address-input');
    await expect(addrInput).toBeAttached();
  });

  test('details screen has context textarea', async ({ page }) => {
    await page.goto('/');

    const textarea = page.locator('#details-textarea');
    await expect(textarea).toBeAttached();
    const placeholder = await textarea.getAttribute('placeholder');
    expect(placeholder).toContain('phone number');
    expect(placeholder).toContain('services offered');
  });

  test('improve with AI button exists', async ({ page }) => {
    await page.goto('/');

    const improveBtn = page.locator('#improve-ai-btn');
    await expect(improveBtn).toBeAttached();
  });

  test('build button exists with correct initial text', async ({ page }) => {
    await page.goto('/');

    const buildBtn = page.locator('#build-btn');
    await expect(buildBtn).toBeAttached();
    await expect(buildBtn).toHaveText('Build My Website');
  });
});

test.describe.skip('AI Validation Before Build', () => {
  test('submitBuild function calls validate-business endpoint', async ({ page }) => {
    await page.goto('/');

    const hasValidation = await page.evaluate(() => {
      const scripts = document.querySelectorAll('script');
      for (let i = 0; i < scripts.length; i++) {
        const text = scripts[i].textContent || '';
        if (text.includes('submitBuild') && text.includes('validate-business')) {
          return true;
        }
      }
      return false;
    });
    expect(hasValidation).toBe(true);
  });

  test('AI validation shows tooltip while validating', async ({ page }) => {
    await page.goto('/');

    const hasTooltip = await page.evaluate(() => {
      const scripts = document.querySelectorAll('script');
      for (let i = 0; i < scripts.length; i++) {
        const text = scripts[i].textContent || '';
        if (text.includes('showAiValidationTooltip') && text.includes('Validating with AI')) {
          return true;
        }
      }
      return false;
    });
    expect(hasTooltip).toBe(true);
  });
});

test.describe.skip('Workflow Step Labels', () => {
  test('WORKFLOW_STEP_LABELS covers all enrichment steps', async ({ page }) => {
    await page.goto('/');

    const labels = await page.evaluate(() => {
      const w = window as unknown as Record<string, Record<string, string>>;
      return w.WORKFLOW_STEP_LABELS || null;
    });

    expect(labels).not.toBeNull();
    expect(labels!['research-profile']).toContain('business profile');
    expect(labels!['research-social']).toContain('social');
    expect(labels!['research-brand']).toContain('brand');
    expect(labels!['research-selling-points']).toContain('selling points');
    expect(labels!['research-images']).toContain('image');
    expect(labels!['generate-website']).toContain('website');
    expect(labels!['upload-to-r2']).toContain('CDN');
  });

  test('WORKFLOW_STEP_ORDER has all steps in correct sequence', async ({ page }) => {
    await page.goto('/');

    const order = await page.evaluate(() => {
      const w = window as unknown as Record<string, string[]>;
      return w.WORKFLOW_STEP_ORDER || null;
    });

    expect(order).not.toBeNull();
    expect(order!.length).toBe(11);
    expect(order![0]).toBe('research-profile');
    // Parallel research steps
    expect(order!.indexOf('research-social')).toBeGreaterThan(0);
    expect(order!.indexOf('research-brand')).toBeGreaterThan(0);
    expect(order!.indexOf('research-selling-points')).toBeGreaterThan(0);
    expect(order!.indexOf('research-images')).toBeGreaterThan(0);
    // Generation after research
    expect(order!.indexOf('generate-website')).toBeGreaterThan(
      order!.indexOf('research-images'),
    );
    // Upload at end
    expect(order!.indexOf('upload-to-r2')).toBeGreaterThan(
      order!.indexOf('generate-website'),
    );
  });
});

test.describe.skip('Data Enrichment Pipeline', () => {
  test('createSiteFromSearch function is defined', async ({ page }) => {
    await page.goto('/');

    const fn = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return typeof w.createSiteFromSearch;
    });
    expect(fn).toBe('function');
  });

  test('enrichment calls parallel research steps', async ({ page }) => {
    await page.goto('/');

    // Verify the workflow architecture supports parallel steps
    const hasParallelSteps = await page.evaluate(() => {
      const w = window as unknown as Record<string, string[]>;
      const order = w.WORKFLOW_STEP_ORDER || [];
      // Steps 1-4 (research-social through research-images) run in parallel
      const parallelSteps = [
        'research-social',
        'research-brand',
        'research-selling-points',
        'research-images',
      ];
      return parallelSteps.every(step => order.includes(step));
    });
    expect(hasParallelSteps).toBe(true);
  });

  test('build terminal has addTerminalLine function', async ({ page }) => {
    await page.goto('/');

    const fn = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return typeof w.addTerminalLine;
    });
    expect(fn).toBe('function');
  });

  test('pollWorkflowStatus function is defined', async ({ page }) => {
    await page.goto('/');

    const fn = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return typeof w.pollWorkflowStatus;
    });
    expect(fn).toBe('function');
  });
});

test.describe.skip('Search Deduplication', () => {
  test('search dropdown deduplicates pre-built sites from Google Places results', async ({ page }) => {
    await page.goto('/');

    // Check that the renderDetailsBizDropdown function filters duplicates
    const hasDedup = await page.evaluate(() => {
      const scripts = document.querySelectorAll('script');
      for (let i = 0; i < scripts.length; i++) {
        const text = scripts[i].textContent || '';
        if (text.includes('preBuiltPlaceIds') && text.includes('preBuiltNames')) {
          return true;
        }
      }
      return false;
    });
    expect(hasDedup).toBe(true);
  });
});

test.describe.skip('Smooth DOM Updates', () => {
  test('addTerminalLine uses requestAnimationFrame', async ({ page }) => {
    await page.goto('/');

    const usesRAF = await page.evaluate(() => {
      const scripts = document.querySelectorAll('script');
      for (let i = 0; i < scripts.length; i++) {
        const text = scripts[i].textContent || '';
        if (text.includes('addTerminalLine') && text.includes('requestAnimationFrame')) {
          return true;
        }
      }
      return false;
    });
    expect(usesRAF).toBe(true);
  });

  test('site status polling uses requestAnimationFrame for rendering', async ({ page }) => {
    await page.goto('/');

    const usesRAF = await page.evaluate(() => {
      const scripts = document.querySelectorAll('script');
      for (let i = 0; i < scripts.length; i++) {
        const text = scripts[i].textContent || '';
        if (text.includes('startSiteStatusPolling') && text.includes('requestAnimationFrame')) {
          return true;
        }
      }
      return false;
    });
    expect(usesRAF).toBe(true);
  });
});
