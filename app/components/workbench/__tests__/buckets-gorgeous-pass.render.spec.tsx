// @vitest-environment jsdom
/**
 * @file Resources › Buckets — "gorgeous pass" visual-craft contract (elevate-every-component fire).
 *
 * The Buckets screen got a Linear/Stripe/Vercel-tier polish pass: a dimensional gradient primary
 * button, a richer transform-only entrance (translateY + micro-scale), a cyan-tinted hairline divider
 * on the two-pane rail, and the launchpad empty states keep their WIRED actions. These assertions lock
 * the craft STRUCTURALLY so a regression that flattens the depth, drops the reduced-motion guard, or
 * re-introduces a CLS-causing (layout-box) animation fails HERE — not only in the headless screenshot.
 *
 * All assertions are brand- + a11y-safe by construction:
 *   • motion lives under `motion-safe:` with a `motion-reduce:` opt-out (WCAG 2.3.3),
 *   • the entrance animates TRANSFORM + OPACITY only (never width/height/top/left → 0 CLS),
 *   • the elevated primary keeps dark ink on the cyan fill (the existing accent-pill contrast gate
 *     still owns the ratio; here we only assert the gradient + highlight-ring treatment is present).
 */
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BucketsEmpty,
  BucketsTwoPane,
  BucketsSkeleton,
  ObjectsSkeleton,
  ShimmerBar,
  EMPTY_LAUNCHPAD_CLASS,
  OBJECT_ENTRANCE_CLASS,
  TILE_SHELL_RESTING_CLASS,
  TILE_THUMB_SLOT_CLASS,
  objectEntranceStyle,
} from '~/components/workbench/BucketsPanel';

afterEach(cleanup);

/**
 * HARD GUARDRAIL regression (a real bug shipped once): the `/[opacity]` modifier SILENTLY FAILS on the
 * hex-valued `--bolt-elements-item-contentAccent` var → it renders SOLID cyan (invisible cyan-on-cyan).
 * Any accent alpha MUST go through `color-mix(... , transparent)`. These craft constants are the ones
 * most tempted to tint the accent, so assert NONE of them carry a bracket-opacity on contentAccent.
 */
const FORBIDDEN_ACCENT_ALPHA = /contentAccent\/\[/;

/**
 * gorgeous3 HARDENING — the gorgeous1 guard above only caught the `/[0.x]` BRACKET form, so the
 * `/NN` SLASH-NUMBER form slipped through (`bg-contentAccent/15 text-contentAccent` on the owner-key
 * ACTIVE pill shipped INVISIBLE cyan-on-cyan). BOTH forms silently no-op to SOLID cyan on this
 * hex-valued var. This file-level sweep forbids EITHER opacity form on a TEXT/BG accent utility across
 * the whole panel + the gallery — color-mix is the only legal accent-alpha path. (border-* opacity is
 * cosmetically harmless — a slightly brighter hairline, never invisible text — so it stays allowed.)
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_SRC = readFileSync(join(HERE, '../BucketsPanel.tsx'), 'utf8');
const GALLERY_SRC = readFileSync(join(HERE, '../../../routes/[_]preview.tsx'), 'utf8');
const FORBIDDEN_TEXTBG_ACCENT_ALPHA = /(?:text|bg)-bolt-elements-item-contentAccent\/(?:\[|\d)/g;

describe('gorgeous pass — elevated primary action (dimensional, not flat)', () => {
  it('renders the create-first-bucket primary with a gradient fill + inner highlight ring', () => {
    render(<BucketsEmpty onCreate={() => {}} />);
    const btn = screen.getByTestId('buckets-empty-create');
    const cls = btn.className;

    // A top-lit gradient fill (not a flat bg-color) reads as a premium, pressable primary.
    expect(cls).toContain('linear-gradient');
    // An inset highlight ring gives the button its dimensional top edge.
    expect(cls).toContain('ring-inset');
    // Dark ink on the cyan fill (the accent-pill contrast gate owns the exact ratio).
    expect(cls).toContain('text-[#04121a]');
  });

  it('keeps the primary hover lift transform-only (0 CLS) and motion-safe gated', () => {
    render(<BucketsEmpty onCreate={() => {}} />);
    const cls = screen.getByTestId('buckets-empty-create').className;

    // The lift is a transform (translate), never a layout-box property.
    expect(cls).toMatch(/motion-safe:enabled:hover:-translate-y/);
    expect(cls).not.toMatch(/\b(width|height|top|left|margin|padding)\b/);
  });
});

describe('gorgeous pass — richer entrance (still 0-CLS + reduced-motion safe)', () => {
  it('animates transform + opacity only, under motion-safe, with a reduced-motion opt-out', () => {
    // Belt + suspenders over buckets-animation.render.spec — the elevated class must keep the guards.
    expect(OBJECT_ENTRANCE_CLASS).toContain('motion-safe:');
    expect(OBJECT_ENTRANCE_CLASS).toContain('motion-reduce:animate-none');
    expect(OBJECT_ENTRANCE_CLASS).toMatch(/animate-\[psBucketRise/);
    expect(OBJECT_ENTRANCE_CLASS).not.toMatch(/\b(width|height|top|left|margin|padding)\b/);
  });

  it('still staggers per index, bounded under ~400ms so a big bucket never stalls', () => {
    expect(objectEntranceStyle(0).animationDelay).toBe('0ms');
    expect(parseInt(String(objectEntranceStyle(999).animationDelay), 10)).toBeLessThanOrEqual(400);
  });
});

describe('gorgeous pass — two-pane rail depth', () => {
  it('paints a cyan-tinted hairline divider on the rail (not a flat border) and keeps min-w-0', () => {
    render(<BucketsTwoPane left={<div>list</div>} right={<div>browser</div>} />);
    const pane = screen.getByTestId('buckets-two-pane');

    // A gradient divider overlay rides inside the rail (decorative, pointer-events-none). Scope to the
    // linear-gradient layer specifically — the rail now also carries a radial vignette (asserted below),
    // so pick the divider by its gradient kind rather than by "first pointer-events-none child".
    const decorativeLayers = Array.from(pane.querySelectorAll<HTMLElement>('.pointer-events-none[aria-hidden]'));
    const divider = decorativeLayers.find((el) => el.className.includes('linear-gradient'));
    expect(divider).toBeTruthy();
    expect(divider?.className).toContain('linear-gradient');

    // The clip guard the narrow editor panel depends on survives the polish.
    expect(screen.getByTestId('buckets-object-pane').className).toContain('min-w-0');
    expect(pane.className).toContain('overflow-hidden');
  });

  it('layers a restrained radial vignette behind the rail (decorative, pointer-events-none, 0 CLS)', () => {
    render(<BucketsTwoPane left={<div data-testid="l">list</div>} right={<div>browser</div>} />);
    const pane = screen.getByTestId('buckets-two-pane');

    // A radial-gradient vignette overlay exists AND is non-interactive (never steals a click from a row).
    const vignette = Array.from(pane.querySelectorAll<HTMLElement>('[aria-hidden].pointer-events-none')).find((el) =>
      el.querySelector('[class*="radial-gradient"]'),
    );
    expect(vignette).toBeTruthy();

    // The list content still renders ABOVE the decorative layer (left content is present + reachable).
    expect(screen.getByTestId('l')).toBeTruthy();
  });
});

describe('gorgeous pass — signature grid tile (shared SSOT, depth + hover bloom, 0 CLS)', () => {
  it('thumbnail slot carries richer OKLCH depth (layered radial + blend) and a crisp inset ring', () => {
    // A multi-stop radial depth over a vertical blend reads as a lit recess, not a flat panel.
    expect(TILE_THUMB_SLOT_CLASS).toContain('radial-gradient');
    expect(TILE_THUMB_SLOT_CLASS).toContain('color-mix(in_oklch');
    // The machined lip: an inset ring + a top-edge inset highlight.
    expect(TILE_THUMB_SLOT_CLASS).toContain('ring-inset');
    expect(TILE_THUMB_SLOT_CLASS).toMatch(/shadow-\[inset/);
  });

  it('tile shell hover is a transform lift + shadow bloom + accent border-GLOW via color-mix', () => {
    // The lift is transform-only (0 CLS) and motion-safe gated.
    expect(TILE_SHELL_RESTING_CLASS).toMatch(/motion-safe:hover:-translate-y/);
    // The hover glow is a box-shadow ring painted with color-mix (never a layout-box property).
    expect(TILE_SHELL_RESTING_CLASS).toMatch(/hover:shadow-\[/);
    expect(TILE_SHELL_RESTING_CLASS).toContain('color-mix(in_oklch');
    expect(TILE_SHELL_RESTING_CLASS).not.toMatch(/\b(width|height|top|left|margin|padding)\b/);
  });

  it('NEVER tints the hex contentAccent var with a bracket-opacity (the silent-cyan-on-cyan bug)', () => {
    // color-mix is the only legal accent-alpha path for this hex-valued var.
    expect(TILE_THUMB_SLOT_CLASS).not.toMatch(FORBIDDEN_ACCENT_ALPHA);
    expect(TILE_SHELL_RESTING_CLASS).not.toMatch(FORBIDDEN_ACCENT_ALPHA);
    expect(EMPTY_LAUNCHPAD_CLASS).not.toMatch(FORBIDDEN_ACCENT_ALPHA);
    expect(OBJECT_ENTRANCE_CLASS).not.toMatch(FORBIDDEN_ACCENT_ALPHA);
  });
});

describe('gorgeous pass — cinematic empty launchpads (aura + balanced type, reduced-motion safe)', () => {
  it('BucketsEmpty gets a radial stage aura + balanced headline, with the badge float-in reduced-motion gated', () => {
    render(<BucketsEmpty onCreate={() => {}} />);
    const launchpad = screen.getByTestId('buckets-empty');
    const cls = launchpad.className;

    // A decorative radial aura sits behind the launchpad (a `before:` pseudo painted via background).
    expect(cls).toContain('before:');
    expect(cls).toContain('radial-gradient');
    // The headline is wrap-balanced + fluid (clamp), so short copy never widows / overflows the pane.
    expect(cls).toContain('text-balance');
    expect(cls).toContain('clamp(');
    // The icon-badge float-in only runs under motion-safe, with an explicit reduced-motion opt-out.
    expect(cls).toContain('motion-safe:');
    expect(cls).toMatch(/motion-reduce:\[&>div:first-child\]:animate-none/);
  });

  it('the launchpad aura never introduces a CLS-causing layout animation', () => {
    // Decorative depth is background/box-shadow only — no animated width/height/top/left/margin/padding.
    expect(EMPTY_LAUNCHPAD_CLASS).not.toMatch(/animate-\[[^\]]*(width|height|top|left|margin|padding)/);
  });
});

describe('gorgeous3 — no text/bg accent-alpha no-op survives (hardened, catches /[0.x] AND /NN)', () => {
  it('BucketsPanel.tsx tints every accent fill/text via color-mix — never /[0.x] or /NN', () => {
    const hits = PANEL_SRC.match(FORBIDDEN_TEXTBG_ACCENT_ALPHA) ?? [];
    expect(
      hits,
      `these text/bg accent-opacity forms SILENTLY no-op to SOLID cyan (invisible-text risk) — ` +
        `convert to color-mix(…, transparent):\n  ${hits.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the /_preview gallery holds the same discipline', () => {
    const hits = GALLERY_SRC.match(FORBIDDEN_TEXTBG_ACCENT_ALPHA) ?? [];
    expect(hits, `gallery text/bg accent-opacity no-ops:\n  ${hits.join('\n  ')}`).toEqual([]);
  });

  it('the exact owner-key / per-bucket-key ACTIVE pill is a color-mix tint (the bug that shipped once)', () => {
    // The ACTIVE pill MUST paint its fill with color-mix so the solid-accent label stays legible.
    expect(PANEL_SRC).toContain(
      "bg-[color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_15%,transparent)] text-bolt-elements-item-contentAccent",
    );
    // …and the broken form must be gone entirely.
    expect(PANEL_SRC).not.toContain('bg-bolt-elements-item-contentAccent/15 text-bolt-elements-item-contentAccent');
  });
});

describe('gorgeous3 — premium shimmer loading (brand sheen, 0 CLS, reduced-motion safe)', () => {
  it('injects the psBucketShimmer keyframe alongside psBucketRise (one <style>, both)', () => {
    expect(PANEL_SRC).toContain('@keyframes psBucketShimmer');
    expect(PANEL_SRC).toContain('@keyframes psBucketRise');
  });

  it('ShimmerBar sweeps a color-mix sheen via transform; motion-reduce drops it; 0 CLS', () => {
    const { container } = render(<ShimmerBar className="h-3 w-2/3" />);
    const base = container.firstElementChild as HTMLElement;
    // The resting shape is a neutral depth bar that clips the sweep.
    expect(base.className).toContain('overflow-hidden');
    expect(base.className).toContain('bg-bolt-elements-background-depth-3');

    const sweep = base.querySelector('[aria-hidden]') as HTMLElement;
    expect(sweep, 'the shimmer sweep overlay exists').toBeTruthy();
    expect(sweep.className).toMatch(/motion-safe:animate-\[psBucketShimmer/);
    expect(sweep.className).toContain('motion-reduce:hidden');
    // The sheen is color-mix off the token — NEVER a bracket/slash opacity on the hex var.
    expect(sweep.className).toContain('color-mix(in_oklch');
    expect(sweep.className).not.toMatch(/contentAccent\/(?:\[|\d)/);
    // Transform-only sweep ⇒ zero CLS (never animates a layout box).
    expect(sweep.className).not.toMatch(/\b(?:width|height|top|left|margin|padding)\b/);
  });

  it('both skeletons render shimmer bars, not the old flat animate-pulse', () => {
    const { container: a } = render(<BucketsSkeleton />);
    expect(a.querySelector('[data-testid="buckets-skeleton"]')).toBeTruthy();
    expect(a.innerHTML).toContain('psBucketShimmer');
    expect(a.innerHTML).not.toContain('animate-pulse');

    const { container: b } = render(<ObjectsSkeleton />);
    expect(b.querySelector('[data-testid="buckets-objects-skeleton"]')).toBeTruthy();
    expect(b.innerHTML).toContain('psBucketShimmer');
    expect(b.innerHTML).not.toContain('animate-pulse');
  });
});
