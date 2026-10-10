/**
 * @file Filled-pill tab ink — regression lock for the invisible-active-label class.
 *
 * Deep UI Explorer finding (fire-53, run dux-2026-09-29T20-01-44-425Z, states 08/09):
 * the Database sub-nav's ACTIVE "Tables" pill rendered as a solid cyan lozenge with an
 * INVISIBLE label — real-browser computed styles showed color === backgroundColor ===
 * rgb(0,229,255), contrast **1:1** (WCAG 1.4.3 needs ≥4.5:1).
 *
 * TRUE root cause (confirmed by probing the LIVE editor after a first wrong fix):
 * `app/styles/index.scss` brand override forces `color: var(--ps-accent) !important`
 * onto every `[aria-selected='true'][role='tab']` — a cyan-glow treatment designed for
 * TEXT tab strips (Code · Preview · Database) that also clobbered FILLED pill tabs
 * (Database/Resources/Source-control segmented controls), painting accent ink onto an
 * accent-filled pill. Because it is `!important`, no utility class on the button can
 * win — the fix is an opt-out: filled pills carry `data-filled-pill` and the override
 * excludes them via `:not([data-filled-pill])`.
 *
 * This spec locks BOTH halves of that contract; the explorer's live computed-style
 * probe covers the rendered result.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKBENCH_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_SCSS = join(WORKBENCH_DIR, '../../styles/index.scss');

/** Every .tsx source under components/workbench (tests + snapshots excluded). */
function workbenchSources(dir: string = WORKBENCH_DIR): string[] {
  const out: string[] = [];

  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === '__snapshots__') {
      continue;
    }

    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      out.push(...workbenchSources(full));
    } else if (/\.tsx$/.test(entry)) {
      out.push(full);
    }
  }

  return out;
}

describe('filled-pill tabs stay legible under the brand override (fire-53)', () => {
  it('every INK-forcing tab override excludes data-filled-pill', () => {
    /*
     * Only rules that FORCE text color onto tabs are dangerous — the ::after
     * underline decorations and transition rules are fine on filled pills.
     */
    const scss = readFileSync(INDEX_SCSS, 'utf8');
    const offenders: string[] = [];

    // Walk top-level-ish blocks: selector chunk up to `{`, body up to matching `}`.
    const blockRe = /([^{}]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    let sawExcludedInkRule = false;

    while ((m = blockRe.exec(scss)) !== null) {
      const selector = m[1];
      const body = m[2];
      const isTabSelector = selector.includes("[role='tab']");
      const forcesInk = /(^|;|\s)color\s*:\s*var\(--ps-accent/.test(body);

      if (!isTabSelector || !forcesInk) {
        continue;
      }

      if (selector.includes(':not([data-filled-pill])')) {
        sawExcludedInkRule = true;
      } else {
        offenders.push(selector.trim().split('\n').join(' ').slice(0, 160));
      }
    }
    expect(sawExcludedInkRule, 'expected the excluded cyan-glow ink rule to exist').toBe(true);
    expect(
      offenders,
      `an ink-forcing [role='tab'] override without :not([data-filled-pill]) paints ` +
        `accent ink onto accent-FILLED pills → invisible label (1:1). Add the exclusion:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every workbench tab strip with a filled accent pill opts out via data-filled-pill', () => {
    const offenders: string[] = [];

    for (const file of workbenchSources()) {
      const src = readFileSync(file, 'utf8');
      const rendersFilledTabPill = src.includes('role="tab"') && src.includes('bg-bolt-elements-item-contentAccent');

      if (rendersFilledTabPill && !src.includes('data-filled-pill')) {
        offenders.push(file.replace(WORKBENCH_DIR, 'workbench'));
      }
    }
    expect(
      offenders,
      `these components render role="tab" with a filled accent pill but never opt out of ` +
        `the cyan-glow override (label will be invisible when active):\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the UA ButtonFace neutralizer carries ZERO specificity (:where) so bg-* utilities win', () => {
    /**
     * Fire-59 regression (live-probed 2026-10-01): the fire-54 neutralizer
     * `button, [type='button'], … { background-color: transparent }` was commented
     * as "element-level specificity (0,0,1)" — but `[type='button']` is an ATTRIBUTE
     * selector = (0,1,0), the SAME specificity as `.bg-bolt-elements-item-contentAccent`.
     * It loads in a LATER stylesheet (index.scss) than the UnoCSS utilities (root css),
     * so it won the cascade tie and stripped the accent FILL from every
     * `type="button"` — dark literal ink on the dark panel → invisible active pill
     * (measured 1.10:1 on the live Database sub-nav while attr + ink were correct).
     * The zero-specificity `:where(...)` wrap restores true preflight semantics:
     * still beats the UA ButtonFace default (author origin > UA origin at ANY
     * specificity), loses to every author rule + utility.
     */
    const scss = readFileSync(INDEX_SCSS, 'utf8');
    const offenders: string[] = [];
    const blockRe = /([^{}]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    let sawZeroSpecificityNeutralizer = false;

    while ((m = blockRe.exec(scss)) !== null) {
      const selector = m[1];
      const body = m[2];
      const clearsBg = /background-color\s*:\s*transparent/.test(body);
      const targetsTypedButtons = /\[type=/.test(selector);

      if (!clearsBg || !targetsTypedButtons) {
        continue;
      }

      if (/:where\(/.test(selector)) {
        sawZeroSpecificityNeutralizer = true;
      } else {
        offenders.push(selector.trim().split('\n').join(' ').slice(0, 160));
      }
    }
    expect(
      sawZeroSpecificityNeutralizer,
      'expected the :where()-wrapped ButtonFace neutralizer to exist in index.scss',
    ).toBe(true);
    expect(
      offenders,
      `a bg-clearing rule with a raw [type=…] selector is (0,1,0) — it TIES every ` +
        `bg-* utility class and, loading later, WINS, stripping accent fills ` +
        `(invisible filled-pill labels). Wrap the selectors in :where(...):\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('filled pills keep literal dark ink (robust against token indirection)', () => {
    /*
     * Companion hardening from the same fire: accent-filled pills use the literal
     * `text-[#061018]` (≈12.5:1 on #00E5FF) rather than a themed token, so ink can
     * never silently follow a token remap. The known-hardened filled-pill tab strips —
     * fire-312 refreshed this list: dropped DatabasePanel (refactored away from inline
     * pills) + added BucketsPanel's Files/Settings workspace tabs. A fuller dynamic sweep
     * (surfacing AutomationsPanel + PanelSegmentedNav, which carry data-filled-pill but not
     * literal ink) is tracked in BACKLOG as BKT-PILL-INK-SWEEP.
     */
    for (const name of ['BucketsPanel.tsx', 'ResourcesPanel.tsx', 'SourceControlPanel.tsx']) {
      const src = readFileSync(join(WORKBENCH_DIR, name), 'utf8');
      expect(src.includes('text-[#061018]'), `${name} lost its literal dark pill ink`).toBe(true);
    }
  });
});
