/**
 * Toast legibility contract — fire-54 (WCAG 1.4.3, contrast ≥4.5:1).
 *
 * Locks the styling contract that keeps EVERY toast-like surface legible in the
 * dark-first embedded editor. Two defect layers are covered:
 *
 * 1. **UA ButtonFace white pill** (the DUX-observed "Loaded 49 files" defect,
 *    run dux-2026-09-29T20-01-44-425Z states 07-09): `@unocss/reset/tailwind-compat.css`
 *    keeps `-webkit-appearance: button` but deliberately DROPS the preflight's
 *    `background-color: transparent` (unocss#2127). Any `<button>` without an
 *    explicit `bg-*` utility therefore paints the browser's default white
 *    ButtonFace OVER its dark parent — the SiteImportStatus card's full-width
 *    header button rendered as a white pill under near-white `#f4f4ff` ink.
 *    index.scss must restore the dropped preflight rule.
 *
 * 2. **react-toastify light theme** (same class, the real Toastify layer):
 *    `<ToastContainer>` without a `theme` prop defaults to `theme="light"`, so
 *    every toast carries `.Toastify__toast-theme--light` (`#fff` surface,
 *    `#757575` ink). Our dark override on bare `.Toastify__toast` only won by
 *    stylesheet ORDER (a specificity tie) — one reorder away from white-on-white
 *    for ALL variants (success/error/info/warning). The contract pins three
 *    redundant layers: the container `theme="dark"` prop, brand-token remaps of
 *    the Toastify surface/ink custom properties, and an override selector list
 *    that names the vendor theme classes explicitly.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const indexScss = read('./index.scss');
const toastScss = read('./components/toast.scss');
const variablesScss = read('./variables.scss');
const rootTsx = read('../root.tsx');

/** WCAG relative luminance for a #rrggbb hex color. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** WCAG contrast ratio between two #rrggbb hex colors. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('toast legibility — UA ButtonFace neutralizer (white "Loaded N files" pill)', () => {
  it('index.scss restores the preflight button background the unocss tailwind-compat reset dropped', () => {
    /*
     * The rule must target bare buttons + button-typed inputs and set
     * background-color: transparent, mirroring Tailwind preflight — wrapped in
     * zero-specificity `:where(...)` (fire-59): a raw `[type='button']` is (0,1,0),
     * which TIED the `bg-*` utilities and, loading later, stripped accent fills
     * (invisible filled-pill labels). :where() still beats the UA ButtonFace
     * (author > UA) while every utility + component rule wins. Specificity side
     * is locked by accent-pill-ink-contrast.spec.ts.
     */
    const rule = indexScss.match(/(^|\n):where\(\s*button\s*,[^{)]*\[type=['"]button['"]\][^{)]*\[type=['"]submit['"]\][^{)]*\)\s*\{([^}]*)\}/);
    expect(rule, 'expected a `:where(button, [type=button], [type=reset], [type=submit])` rule in index.scss').toBeTruthy();
    expect(rule![2]).toMatch(/background-color:\s*transparent/);
  });
});

describe('toast legibility — react-toastify dark brand (all variants)', () => {
  it('ToastContainer opts into the dark theme (no light-theme default)', () => {
    expect(rootTsx).toMatch(/<ToastContainer\s+theme="dark"/);
  });

  it('variables.scss remaps BOTH light + dark Toastify surface/ink tokens to bolt tokens', () => {
    expect(variablesScss).toMatch(/--toastify-color-light:\s*var\(--bolt-elements-bg-depth-2\)/);
    expect(variablesScss).toMatch(/--toastify-text-color-light:\s*var\(--bolt-elements-textPrimary\)/);
    expect(variablesScss).toMatch(/--toastify-color-dark:\s*var\(--bolt-elements-bg-depth-2\)/);
    expect(variablesScss).toMatch(/--toastify-text-color-dark:\s*var\(--bolt-elements-textPrimary\)/);
  });

  it('toast.scss override names the vendor theme classes so it cannot lose the cascade tie', () => {
    const block = toastScss.match(/\.Toastify__toast-theme--light[^{]*\{([^}]*)\}/);
    expect(block, 'expected .Toastify__toast-theme--light in the dark override selector list').toBeTruthy();
    expect(block![1]).toMatch(/background-color:\s*var\(--bolt-elements-bg-depth-2\)/);
    expect(block![1]).toMatch(/color:\s*var\(--bolt-elements-textPrimary\)/);
    expect(toastScss).toMatch(/\.Toastify__toast-theme--dark/);
  });

  it('keeps the base .Toastify__toast dark surface + ink (regression lock)', () => {
    const block = toastScss.match(/\.Toastify__toast[^-][^{]*\{([^}]*)\}/);
    expect(block).toBeTruthy();
    expect(toastScss).toMatch(/background-color:\s*var\(--bolt-elements-bg-depth-2\)/);
    expect(toastScss).toMatch(/color:\s*var\(--bolt-elements-textPrimary\)/);
  });
});

describe('toast legibility — resolved brand tokens meet WCAG AA (1.4.3)', () => {
  it('the brand override values behind the toast tokens contrast ≥ 4.5:1', () => {
    /*
     * The always-on brand override block pins the concrete values every theme
     * resolves to: --bolt-elements-bg-depth-2 (surface) + --bolt-elements-
     * textPrimary (ink). Compute the real WCAG ratio so a future palette edit
     * can never silently push toasts below AA.
     */
    const surface = variablesScss.match(/--bolt-elements-bg-depth-2:\s*(#[0-9a-fA-F]{6})/);
    const ink = variablesScss.match(/--bolt-elements-textPrimary:\s*(#[0-9a-fA-F]{6})/);
    expect(surface, 'brand override must pin a hex --bolt-elements-bg-depth-2').toBeTruthy();
    expect(ink, 'brand override must pin a hex --bolt-elements-textPrimary').toBeTruthy();

    const ratio = contrast(surface![1], ink![1]);
    expect(ratio, `toast ink ${ink![1]} on surface ${surface![1]} must be ≥ 4.5:1, got ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });
});
