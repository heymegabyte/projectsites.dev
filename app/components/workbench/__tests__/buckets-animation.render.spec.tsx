// @vitest-environment jsdom
/**
 * @file Resources › Buckets — animation-pass guard (B5 slice 4, "gorgeous + ANIMATED").
 *
 * The object browser gains a restrained, brand-coherent entrance: staggered opacity+translateY on
 * object rows/tiles (transform-only → no CLS), a scale on select, and a smooth list⇄grid transition.
 * It MUST honor `prefers-reduced-motion: reduce` — motion only under `motion-safe:`, with a
 * `motion-reduce:` opt-out. This asserts the animation CONTRACT structurally (the exported
 * animation-class helpers), so a regression that (a) drops the reduced-motion guard — a vestibular
 * WCAG-2.3.3 failure — or (b) animates a layout prop that causes CLS fails HERE, not just in the
 * headless screenshot of `/_preview`.
 */
import { describe, expect, it } from 'vitest';
import { OBJECT_ENTRANCE_CLASS, objectEntranceStyle } from '~/components/workbench/BucketsPanel';

describe('object-browser entrance animation — motion-safe + reduced-motion guard', () => {
  it('only animates under motion-safe (so reduced-motion users get NO motion)', () => {
    // Every animation utility is motion-safe gated — nothing animates unconditionally.
    expect(OBJECT_ENTRANCE_CLASS).toContain('motion-safe:');

    // And there is an explicit reduced-motion opt-out (belt + suspenders for the transform reset).
    expect(OBJECT_ENTRANCE_CLASS).toContain('motion-reduce:');
  });

  it('animates TRANSFORM + OPACITY only (no width/height/top/left → no CLS)', () => {
    // The entrance rides on opacity + translateY via a keyframe; it never animates a layout box prop.
    expect(OBJECT_ENTRANCE_CLASS).toMatch(/animate-\[/);

    const banned = /\b(width|height|top|left|margin|padding)\b/;
    expect(OBJECT_ENTRANCE_CLASS).not.toMatch(banned);
  });

  it('staggers per-index via a bounded animation-delay (restrained, not a long cascade)', () => {
    const first = objectEntranceStyle(0);
    const tenth = objectEntranceStyle(9);
    const huge = objectEntranceStyle(999);

    // Index 0 starts immediately; later rows are progressively (but subtly) delayed.
    expect(first.animationDelay).toBe('0ms');
    expect(parseInt(String(tenth.animationDelay), 10)).toBeGreaterThan(0);

    // The cascade is CAPPED so a 1,000-object bucket doesn't wait seconds for the last tile.
    const cap = parseInt(String(huge.animationDelay), 10);
    expect(cap).toBeLessThanOrEqual(400);
  });
});
