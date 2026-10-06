#!/usr/bin/env node
/**
 * Visual Inspection Loop — Skill 56 Implementation
 *
 * Screenshots every page at 6 breakpoints, sends to GPT-4o vision for analysis,
 * and outputs a structured report of issues found.
 *
 * Usage:
 *   node scripts/visual-inspection.mjs [--base-url http://localhost:4200] [--output report.json]
 *
 * Requires:
 *   - OPENAI_API_KEY env var (primary)
 *   - ANTHROPIC_API_KEY env var (fallback)
 *   - playwright installed
 *
 * PROVIDER POLICY (category-B PRODUCT, PRESERVED — rules/agent-provider-policy.md
 * § Product-runtime boundary + ADR-0057): GPT-4o / Claude VISION QA of a generated CUSTOMER
 * site at 6 breakpoints. Vision has no DeepSeek equivalent, so OpenAI-primary + Anthropic-fallback
 * stay — product delivery, not internal dev orchestration. (Workers-AI vision = possible FUTURE
 * enhancement, not a policy fix.)
 */

import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { writeFileSync } from 'fs';

const BASE_URL = process.argv.includes('--base-url')
  ? process.argv[process.argv.indexOf('--base-url') + 1]
  : 'http://localhost:4200';

const OUTPUT_FILE = process.argv.includes('--output')
  ? process.argv[process.argv.indexOf('--output') + 1]
  : 'visual-inspection-report.json';

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

if (!OPENAI_KEY && !ANTHROPIC_KEY) {
  console.error('ERROR: Set OPENAI_API_KEY or ANTHROPIC_API_KEY');
  process.exit(1);
}

const BREAKPOINTS = [
  { name: 'iPhone SE', width: 375, height: 667 },
  { name: 'iPhone 14', width: 390, height: 844 },
  { name: 'iPad', width: 768, height: 1024 },
  { name: 'iPad Landscape', width: 1024, height: 768 },
  { name: 'Laptop', width: 1280, height: 720 },
  { name: 'Desktop', width: 1920, height: 1080 },
];

const ROUTES = [
  '/',
  '/search',
  '/signin',
  '/create',
  '/blog',
  '/blog/small-business-professional-website-2025',
  '/changelog',
  '/status',
  '/privacy',
  '/terms',
  '/nonexistent-page-for-404',
];

const VISION_PROMPT = `You are a Principal UI/UX Engineer reviewing a production web application screenshot.

Analyze this screenshot and report issues in these categories:
1. LAYOUT: Alignment, spacing, overflow, responsive breaks
2. TYPOGRAPHY: Font size, weight, line-height, readability, hierarchy
3. COLOR: Contrast ratios, brand consistency, dark theme quality
4. CONTENT: Placeholder text, missing content, truncation, spelling
5. INTERACTION: Missing hover states, focus indicators, cursor styles
6. ACCESSIBILITY: Missing alt text, contrast failures, focus management
7. POLISH: Rough edges, inconsistent borders, shadow/glow issues
8. COMPLETENESS: Missing sections, placeholder UI, stub content

For each issue, provide JSON:
- category (one of the 8 above)
- severity (critical / major / minor / cosmetic)
- location (describe where on the page)
- fix (specific CSS/HTML change needed)

If the page looks PRODUCTION READY with no issues, respond ONLY with:
{"status": "verified", "issues": []}

Otherwise respond ONLY with:
{"status": "needs_fixes", "issues": [{"category":"...","severity":"...","location":"...","fix":"..."}]}`;

async function analyzeWithGPT4o(screenshotBase64, routeInfo) {
  if (!OPENAI_KEY) throw new Error('No OpenAI API key');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: VISION_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: `Route: ${routeInfo.route} | Breakpoint: ${routeInfo.breakpoint} (${routeInfo.width}x${routeInfo.height})` },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${screenshotBase64}`, detail: 'high' } },
          ],
        },
      ],
      max_tokens: 2000,
      temperature: 0.2,
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GPT-4o error ${res.status}: ${text}`);
  }

  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

async function analyzeWithAnthropic(screenshotBase64, routeInfo) {
  if (!ANTHROPIC_KEY) throw new Error('No Anthropic API key');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      system: VISION_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: `Route: ${routeInfo.route} | Breakpoint: ${routeInfo.breakpoint} (${routeInfo.width}x${routeInfo.height})` },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshotBase64 } },
          ],
        },
      ],
      max_tokens: 2000,
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('');

  // Try to parse JSON from response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) return JSON.parse(jsonMatch[0]);
  return { status: 'error', issues: [{ category: 'UNKNOWN', severity: 'minor', location: 'N/A', fix: text }] };
}

async function analyzeScreenshot(screenshotBase64, routeInfo) {
  // Primary: GPT-4o
  if (OPENAI_KEY) {
    try {
      return await analyzeWithGPT4o(screenshotBase64, routeInfo);
    } catch (err) {
      console.warn(`  GPT-4o failed: ${err.message}, trying Anthropic fallback...`);
    }
  }

  // Fallback: Anthropic
  if (ANTHROPIC_KEY) {
    return await analyzeWithAnthropic(screenshotBase64, routeInfo);
  }

  throw new Error('No vision provider available');
}

async function main() {
  console.log(`\n🔍 Visual Inspection Loop — Skill 56`);
  console.log(`   Base URL: ${BASE_URL}`);
  console.log(`   Routes: ${ROUTES.length}`);
  console.log(`   Breakpoints: ${BREAKPOINTS.length}`);
  console.log(`   Total screenshots: ${ROUTES.length * BREAKPOINTS.length}\n`);

  const browser = await chromium.launch({ headless: true });
  const report = {
    timestamp: new Date().toISOString(),
    base_url: BASE_URL,
    total_screenshots: 0,
    total_issues: 0,
    verified_count: 0,
    routes: {},
  };

  for (const route of ROUTES) {
    console.log(`📸 Route: ${route}`);
    report.routes[route] = { breakpoints: {}, issues: [], verified: false };

    for (const bp of BREAKPOINTS) {
      const context = await browser.newContext({ viewport: { width: bp.width, height: bp.height } });
      const page = await context.newPage();

      try {
        await page.goto(`${BASE_URL}${route}`, { waitUntil: 'networkidle', timeout: 15000 });
        await page.waitForTimeout(1000); // Wait for animations

        const screenshot = await page.screenshot({ fullPage: true });
        const base64 = screenshot.toString('base64');
        report.total_screenshots++;

        console.log(`   ${bp.name} (${bp.width}x${bp.height})...`);

        const analysis = await analyzeScreenshot(base64, {
          route,
          breakpoint: bp.name,
          width: bp.width,
          height: bp.height,
        });

        report.routes[route].breakpoints[bp.name] = analysis;

        if (analysis.status === 'verified') {
          console.log(`   ✅ Verified`);
          report.verified_count++;
        } else {
          const issues = analysis.issues || [];
          console.log(`   ⚠️  ${issues.length} issues found`);
          report.routes[route].issues.push(...issues.map(i => ({ ...i, breakpoint: bp.name })));
          report.total_issues += issues.length;
        }
      } catch (err) {
        console.log(`   ❌ Error: ${err.message}`);
        report.routes[route].breakpoints[bp.name] = { status: 'error', error: err.message };
      } finally {
        await context.close();
      }
    }

    // Route is verified if ALL breakpoints are verified
    const allVerified = BREAKPOINTS.every(bp =>
      report.routes[route].breakpoints[bp.name]?.status === 'verified'
    );
    report.routes[route].verified = allVerified;
    if (allVerified) console.log(`   ✅ Route fully verified\n`);
    else console.log(`   ⚠️  Route needs fixes\n`);
  }

  await browser.close();

  // Summary
  const verifiedRoutes = Object.values(report.routes).filter(r => r.verified).length;
  console.log(`\n📊 Visual Inspection Complete`);
  console.log(`   Screenshots: ${report.total_screenshots}`);
  console.log(`   Verified routes: ${verifiedRoutes}/${ROUTES.length}`);
  console.log(`   Total issues: ${report.total_issues}`);
  console.log(`   Report: ${OUTPUT_FILE}\n`);

  // Group issues by severity
  const allIssues = Object.entries(report.routes).flatMap(([route, data]) =>
    data.issues.map(i => ({ ...i, route }))
  );
  const bySeverity = { critical: 0, major: 0, minor: 0, cosmetic: 0 };
  allIssues.forEach(i => { bySeverity[i.severity] = (bySeverity[i.severity] || 0) + 1; });

  if (allIssues.length > 0) {
    console.log(`   Critical: ${bySeverity.critical || 0}`);
    console.log(`   Major: ${bySeverity.major || 0}`);
    console.log(`   Minor: ${bySeverity.minor || 0}`);
    console.log(`   Cosmetic: ${bySeverity.cosmetic || 0}\n`);

    console.log(`\n🔧 Issues to fix:`);
    allIssues.filter(i => i.severity === 'critical' || i.severity === 'major').forEach(i => {
      console.log(`   [${i.severity.toUpperCase()}] ${i.route} @ ${i.breakpoint}: ${i.location} — ${i.fix}`);
    });
  }

  writeFileSync(OUTPUT_FILE, JSON.stringify(report, null, 2));

  // Exit code: 0 if all verified, 1 if issues remain
  process.exit(allIssues.filter(i => i.severity === 'critical' || i.severity === 'major').length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(2);
});
