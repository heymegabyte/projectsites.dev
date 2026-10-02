/**
 * Feature / Feature-Flag "Spec Sheet" model + the pure builders behind it.
 *
 * Split from the component so the markdown assembly + coverage maths are unit-
 * testable without TestBed. `buildDossierMarkdown` produces a complete GFM
 * document — enough to fully document AND integrate the capability — and
 * `coverageSignal` derives a transparent documentation+test score (NOT a claim
 * of literal line coverage; it's a completeness signal from the artifacts that
 * exist).
 */

import { type EntitlementState } from '../../pages/admin/sections/feature-flags/flag-logic';

export interface DossierModel {
  /** 'Feature Flag' (Layer 1) or 'Feature' (Layer 2). */
  kind: 'Feature Flag' | 'Feature';
  key: string;
  name: string;
  /** One-paragraph human summary (description or explanation). */
  summary: string;
  /** Longer mechanism prose, if distinct from the summary. */
  explanation?: string;
  /** "What it does" checkpoints. */
  checklist?: readonly string[];
  /** Copy-pasteable verification steps. */
  smokeTest?: readonly string[];
  /** Playwright spec paths covering this capability. */
  e2eTests?: readonly string[];
  /** One captioned screenshot per distinct UI change the capability enables. */
  screenshots?: readonly { url: string; caption: string; alt?: string }[];
  /** External docs / research links. */
  references?: readonly string[];
  stage?: string;
  rolloutPercent?: number;
  owner?: string;
  enabled?: boolean;
  /** Feature-only (Layer 2). */
  requiredPlan?: string;
  category?: string;
  /**
   * Owner-facing entitlement state for this feature. When it's a LOCK state
   * (`upgrade-required` / `addon-required`) the spec sheet surfaces WHY it's
   * locked + a one-click upgrade CTA — never a documented-but-unreachable
   * capability. Omitted / `available` = no lock treatment.
   */
  entitled?: EntitlementState;
  /** Live URL to offer an on-demand AI vision critique (per-site features). */
  previewUrl?: string;
  /**
   * Plain-English "what enabling this does" reassurance, surfaced as a Preview
   * section on the spec sheet (so the preview info lives here, not only on the
   * feature card). Empty/omitted → no Preview section rendered.
   */
  previewNote?: string;
  /** Selected site id — enables the "Ask your site" concierge tester. */
  siteId?: string;
}

const STAGES = ['experimental', 'beta', 'stable', 'deprecated'] as const;

/** Transparent documentation + test completeness score (0-100) + its parts. */
export function coverageSignal(m: DossierModel): {
  score: number;
  label: string;
  parts: ReadonlyArray<{ label: string; got: boolean; pts: number }>;
} {
  const stageBase: Record<string, number> = { beta: 55, deprecated: 70, experimental: 25, killswitch: 10, stable: 90 };
  const base = stageBase[m.stage ?? 'experimental'] ?? 25;
  const e2e = m.e2eTests?.length ?? 0;
  const parts = [
    { got: true, label: 'Lifecycle stage', pts: Math.round(base * 0.4) },
    { got: (m.checklist?.length ?? 0) > 0, label: 'Checklist documented', pts: 10 },
    { got: (m.smokeTest?.length ?? 0) > 0, label: 'Smoke test steps', pts: 10 },
    { got: e2e >= 1, label: 'E2E spec linked', pts: 15 },
    { got: e2e >= 2, label: 'E2E specs ≥ 2', pts: 5 },
    { got: (m.explanation?.length ?? 0) > 0, label: 'Mechanism explained', pts: 5 },
    { got: (m.references?.length ?? 0) > 0, label: 'Sources cited', pts: 5 },
  ];
  const earned = parts.reduce((s, p) => s + (p.got ? p.pts : 0), 0);
  const score = Math.max(0, Math.min(100, earned));
  const label = score >= 85 ? 'Well covered' : score >= 60 ? 'Adequately covered' : score >= 35 ? 'Partially covered' : 'Lightly covered';
  return { label, parts, score };
}

/** Estimated read time in minutes from a word count (≈220 wpm, min 1). */
export function readMinutes(words: number): number {
  return Math.max(1, Math.round(words / 220));
}

function bullet(items: readonly string[] | undefined, prefix = '- '): string {
  return (items ?? []).map((i) => `${prefix}${i}`).join('\n');
}

/**
 * Plain-English smoke-test steps — NO HTTP verbs, no curl, no /api paths. The
 * spec sheet is read by non-engineers, so testing directions must be in English.
 * Drops any step that's a raw request line; if nothing human remains, returns a
 * generic English recipe keyed to the feature name + kind.
 */
export function englishSmoke(steps: readonly string[] | undefined, name: string, kind: DossierModel['kind']): string[] {
  const isReqLine = (s: string) => /\b(GET|POST|PUT|DELETE|PATCH)\b/.test(s) || /\bcurl\b/i.test(s) || /\/api\//.test(s);
  // Keep human steps; for kept "UI: …" style steps, strip a leading "UI:" label.
  const human = (steps ?? [])
    .filter((s) => !isReqLine(s))
    .map((s) => s.replace(/^\s*UI:\s*/i, '').trim())
    .filter(Boolean);
  if (human.length) return human;
  return kind === 'Feature Flag'
    ? [
        `Open the admin and enable ${name}.`,
        `Visit a page where ${name} appears and confirm each capability in the checklist above works.`,
        `Disable ${name} again and confirm the surface is gone (no errors).`,
      ]
    : [
        `Open this site's Features and turn ${name} on.`,
        `Open the published site and confirm each capability in the checklist above is live.`,
        `Turn ${name} off and confirm it's removed from the live site.`,
      ];
}

/**
 * Assemble the full GFM dossier. Pure + deterministic so a snapshot test can
 * assert section presence. The output is intentionally integration-complete:
 * the "Integration guide" section carries the exact server + UI guard snippets,
 * flag key, promotion path and module locations.
 */
export function buildDossierMarkdown(m: DossierModel): string {
  const isFlag = m.kind === 'Feature Flag';
  const cov = coverageSignal(m);
  const out: string[] = [];

  out.push(`> **${m.kind}** · \`${m.key}\`${m.enabled !== undefined ? ` · ${m.enabled ? 'ON' : 'OFF'}` : ''}`);
  out.push('');
  out.push('## Overview');
  out.push(m.summary || '_No summary documented yet._');

  if (m.explanation && m.explanation.trim() && m.explanation.trim() !== m.summary.trim()) {
    out.push('');
    out.push('## How it works');
    out.push(m.explanation);
  }

  if (m.previewNote && m.previewNote.trim()) {
    out.push('');
    out.push('## Preview');
    out.push(m.previewNote.trim());
  }

  out.push('');
  out.push('## At a glance');
  out.push('| Property | Value |');
  out.push('| --- | --- |');
  out.push(`| Key | \`${m.key}\` |`);
  if (m.stage) out.push(`| Lifecycle stage | ${m.stage} |`);
  if (m.rolloutPercent !== undefined) out.push(`| Rollout | ${m.rolloutPercent}% |`);
  if (m.enabled !== undefined) out.push(`| Status | ${m.enabled ? 'On' : 'Off'} |`);
  if (m.requiredPlan) out.push(`| Required plan | ${m.requiredPlan}${m.category ? ` · ${m.category}` : ''} |`);
  if (m.owner) out.push(`| Owner | ${m.owner} |`);
  out.push(`| Coverage signal | ${cov.score}/100 — ${cov.label} |`);

  if (m.checklist?.length) {
    out.push('');
    out.push('## What it does');
    out.push(m.checklist.map((c) => `- [x] ${c}`).join('\n'));
  }

  if (m.screenshots?.length) {
    out.push('');
    out.push('## Screenshots');
    out.push(
      `${m.screenshots.length} view${m.screenshots.length === 1 ? '' : 's'} of the UI this ${isFlag ? 'flag' : 'feature'} turns on:`,
    );
    for (const s of m.screenshots) {
      out.push('');
      out.push(`![${(s.alt ?? s.caption).replace(/[[\]]/g, '')}](${s.url})`);
      out.push(`*${s.caption}*`);
    }
  }

  out.push('');
  out.push('## Lifecycle & rollout');
  out.push(
    isFlag
      ? `Promotion path: **experimental → beta (5–25%) → stable (100%)**. This flag is at **${m.stage ?? 'experimental'}**${m.rolloutPercent !== undefined ? ` with a ${m.rolloutPercent}% rollout` : ''}. Disable safely at any time — the server returns 404 (never 403) and the UI renders nothing when off.`
      : `Owner-facing capability${m.requiredPlan ? ` included on the **${m.requiredPlan}** plan and above` : ''}. Toggling is entitlement-checked server-side and tenant-isolated; the live site updates instantly and the change is undoable.`,
  );

  out.push('');
  out.push('## Smoke test (2-minute verification)');
  out.push('Plain-English steps anyone can follow — no commands needed:');
  out.push('');
  out.push(englishSmoke(m.smokeTest, m.name, m.kind).map((s, i) => `${i + 1}. ${s}`).join('\n'));

  out.push('');
  out.push('## Automated coverage');
  if (m.e2eTests?.length) {
    out.push('Playwright specs exercising this against the prod URL:');
    out.push('');
    out.push(bullet(m.e2eTests.map((p) => `\`${p}\``)));
  } else {
    out.push('_No E2E specs linked yet._ Per the feature-flags rule, a promoted flag must carry at least one Playwright spec before reaching `beta`.');
  }
  out.push('');
  out.push(`Coverage signal: **${cov.score}/100 — ${cov.label}.** Breakdown:`);
  out.push('');
  out.push(cov.parts.map((p) => `- [${p.got ? 'x' : ' '}] ${p.label} (+${p.pts})`).join('\n'));

  out.push('');
  out.push('## Integration guide');
  if (isFlag) {
    out.push('Wire this capability end-to-end:');
    out.push('');
    out.push(`1. **Reserve the key** in \`src/modules/feature_flags/registry.ts\` at \`enabled=false, rollout_percent=0, stage='experimental'\`.`);
    out.push('2. **Guard the server route** — return 404 (never 403) when off:');
    out.push('');
    out.push('```ts');
    out.push(`if (!(await isFlagOn(env, '${m.key}', { orgId, siteId, userId, anonId }))) {`);
    out.push('  return c.notFound();');
    out.push('}');
    out.push('```');
    out.push('3. **Guard the UI** component:');
    out.push('');
    out.push('```ts');
    out.push(`if (!useFeatureFlag('${m.key}')) return null;`);
    out.push('```');
    out.push(`4. **Document it** in \`src/modules/feature_flags/docs.ts\` (checklist + explanation + smoke_test + e2e_tests).`);
    out.push(`5. **Add E2E** specs under \`e2e/_fortress/${m.key}/\` (happy-path + adversarial).`);
    out.push('6. **Promote** in `/admin/feature-flags`: experimental → beta → stable.');
  } else {
    out.push('Wire this owner-facing feature:');
    out.push('');
    out.push(`1. **Catalog entry** in \`src/routes/features.ts\` \`SITE_FEATURE_CATALOG\` (+ the frontend mirror) with \`requiredPlan\` + \`category\`.`);
    out.push(`2. **Capability checklist** in the frontend \`FEATURE_CAPABILITIES['${m.key}']\`.`);
    out.push('3. **Server feature module** at `libs/features/' + m.key + '/` (manifest + schemas + handlers + service + tests).');
    out.push(`4. **Entitlement** — the toggle is gated by plan rank server-side; \`POST /api/site-features/${m.key}\` flips state per tenant.`);
    out.push(`5. **Add E2E** under \`apps/project-sites/e2e/${m.key}/\`.`);
  }

  if (m.references?.length) {
    out.push('');
    out.push('## Sources & references');
    out.push(bullet(m.references.map((r) => `[${r}](${r})`)));
  }

  return out.join('\n');
}

/** Word count of the rendered dossier (for read-time + a metric chip). */
export function wordCount(md: string): number {
  return md.split(/\s+/).filter(Boolean).length;
}

/** Section headings (## …) → TOC entries with slug anchors. */
export function tableOfContents(md: string): ReadonlyArray<{ title: string; slug: string }> {
  return md
    .split('\n')
    .filter((l) => l.startsWith('## '))
    .map((l) => {
      const title = l.replace(/^##\s+/, '').trim();
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      return { slug, title };
    });
}

export { STAGES };
