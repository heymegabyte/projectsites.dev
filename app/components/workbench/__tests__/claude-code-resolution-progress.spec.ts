/**
 * claude-code-resolution-progress.spec.ts — unit spec for the PURE Resolution staged-progress helper
 * (WLK-39 §75 flagship, STREAM-RESOLVE — kills the dead 24s spinner).
 *
 * The `/api/resolve` bridge call takes ~24-27s (dual research → synthesis). While it is in flight the
 * panel shows a CINEMATIC staged-progress experience instead of a dead spinner. The phase schedule +
 * the `m:ss` elapsed clock are pure, so they're proven here WITHOUT React or real timers:
 *   1. Phases advance on a schedule tuned to the ~24s cadence (pass 1 → pass 2 → synthesize).
 *   2. A SLOW return (> expected) HOLDS on the final "synthesizing" phase — never claims completion,
 *      never advances past the last phase, elapsed keeps climbing.
 *   3. A FAST return is a non-issue for the schedule (the caller unmounts on completion) — but the
 *      helper is still monotonic + total at t=0 and for tiny elapsed values (no stuck/negative index).
 *   4. `reducedMotion` is threaded through unchanged (the component renders static text when true) and
 *      NEVER changes which phase is active — motion preference must not alter the information shown.
 *   5. `formatElapsedClock` renders `m:ss` with a zero-padded seconds field ("0:07", "0:12", "1:05").
 */
import { describe, expect, it } from 'vitest';
import {
  resolutionProgressPhase,
  formatElapsedClock,
  RESOLUTION_PROGRESS_PHASES,
} from '../claude-code-resolution-progress';

describe('resolutionProgressPhase', () => {
  it('starts on the first phase (independent pass 1) at t=0', () => {
    const phase = resolutionProgressPhase(0, false);
    expect(phase.index).toBe(0);
    expect(phase.label).toMatch(/pass 1/i);
    expect(phase.phaseCount).toBe(RESOLUTION_PROGRESS_PHASES.length);
  });

  it('advances through the three phases on the ~24s schedule', () => {
    // pass 1 (0-8s) → pass 2 (8-16s) → synthesize (16s+).
    expect(resolutionProgressPhase(2_000, false).index).toBe(0);
    expect(resolutionProgressPhase(7_999, false).index).toBe(0);
    expect(resolutionProgressPhase(8_000, false).index).toBe(1);
    expect(resolutionProgressPhase(8_000, false).label).toMatch(/pass 2/i);
    expect(resolutionProgressPhase(15_999, false).index).toBe(1);
    expect(resolutionProgressPhase(16_000, false).index).toBe(2);
    expect(resolutionProgressPhase(16_000, false).label).toMatch(/synthesi/i);
  });

  it('HOLDS on the final synthesize phase for a SLOW return — never advances past it, never "completes"', () => {
    const last = RESOLUTION_PROGRESS_PHASES.length - 1;

    // Well past the ~24s expected cadence (e.g. the premium dual-frontier path or a slow fallback).
    for (const elapsed of [24_000, 40_000, 89_000, 120_000]) {
      const phase = resolutionProgressPhase(elapsed, false);
      expect(phase.index).toBe(last);
      expect(phase.label).toMatch(/synthesi/i);
      // The held phase must NEVER claim the run finished — it's still working.
      expect(phase.label.toLowerCase()).not.toMatch(/done|complete|finished|ready/);
    }
  });

  it('is monotonic and total — the index never decreases and never leaves the valid range', () => {
    let prev = -1;

    for (let elapsed = 0; elapsed <= 120_000; elapsed += 250) {
      const { index } = resolutionProgressPhase(elapsed, false);
      expect(index).toBeGreaterThanOrEqual(prev);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(RESOLUTION_PROGRESS_PHASES.length);
      prev = index;
    }
  });

  it('clamps non-finite / negative elapsed to the first phase (defensive)', () => {
    expect(resolutionProgressPhase(-5_000, false).index).toBe(0);
    expect(resolutionProgressPhase(Number.NaN, false).index).toBe(0);
    expect(resolutionProgressPhase(Number.POSITIVE_INFINITY, false).index).toBe(RESOLUTION_PROGRESS_PHASES.length - 1);
  });

  it('threads reducedMotion through unchanged and it NEVER changes the active phase', () => {
    for (const elapsed of [0, 8_000, 16_000, 40_000]) {
      const motion = resolutionProgressPhase(elapsed, false);
      const reduced = resolutionProgressPhase(elapsed, true);
      expect(reduced.reducedMotion).toBe(true);
      expect(motion.reducedMotion).toBe(false);
      // Same information regardless of motion preference.
      expect(reduced.index).toBe(motion.index);
      expect(reduced.label).toBe(motion.label);
    }
  });
});

describe('formatElapsedClock', () => {
  it('renders m:ss with a zero-padded seconds field', () => {
    expect(formatElapsedClock(0)).toBe('0:00');
    expect(formatElapsedClock(7_000)).toBe('0:07');
    expect(formatElapsedClock(12_400)).toBe('0:12');
    expect(formatElapsedClock(59_000)).toBe('0:59');
    expect(formatElapsedClock(60_000)).toBe('1:00');
    expect(formatElapsedClock(65_000)).toBe('1:05');
  });

  it('floors sub-second milliseconds and clamps non-finite / negative to 0:00', () => {
    expect(formatElapsedClock(999)).toBe('0:00');
    expect(formatElapsedClock(-10)).toBe('0:00');
    expect(formatElapsedClock(Number.NaN)).toBe('0:00');
  });
});
