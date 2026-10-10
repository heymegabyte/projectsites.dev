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
import { BucketsEmpty, BucketsTwoPane, OBJECT_ENTRANCE_CLASS, objectEntranceStyle } from '~/components/workbench/BucketsPanel';

afterEach(cleanup);

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

    // A gradient divider overlay rides inside the rail (decorative, pointer-events-none).
    const divider = pane.querySelector('.pointer-events-none[aria-hidden]');
    expect(divider).toBeTruthy();
    expect(divider?.className).toContain('linear-gradient');

    // The clip guard the narrow editor panel depends on survives the polish.
    expect(screen.getByTestId('buckets-object-pane').className).toContain('min-w-0');
    expect(pane.className).toContain('overflow-hidden');
  });
});
