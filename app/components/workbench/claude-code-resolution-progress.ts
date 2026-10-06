/**
 * @file claude-code-resolution-progress — the PURE phase schedule + elapsed-clock formatter for the
 * embedded "Claude Code" panel's Resolution staged-progress experience (WLK-39 §75 flagship,
 * STREAM-RESOLVE — kills the dead 24s spinner).
 *
 * @remarks
 * ## Why a separate pure module
 * Resolution mode POSTs `/api/resolve` ONCE through the admin bridge ({@link requestResolve}); that
 * dual-provider research → Claude-synthesis call takes ~24-27s end-to-end (longer on the premium
 * dual-frontier path). While it is in flight the panel used to show a bare nebula + one static line —
 * a dead 24-second stare. This module turns that wait into an INFORMATIVE, cinematic staged story:
 * which stage the engine is in, on a schedule tuned to the real cadence, plus a live `m:ss` elapsed
 * readout. The schedule + the clock are pure (no React, no `Date.now()`, no timers), so they're
 * trivially unit-testable and the component just re-renders them on a tick.
 *
 * ## The schedule (tuned to the ~24s cadence)
 * The real pipeline runs the two independent research legs, then synthesizes. We mirror that:
 * ```
 *   0s ───────────▶ 8s ───────────▶ 16s ───────────▶ (holds)
 *   Research pass 1   Research pass 2   Synthesizing…
 * ```
 * The LAST phase is terminal-on-the-timeline: it HOLDS for any elapsed past its start, so a SLOW
 * return (the call runs longer than the ~24s expected) keeps a calm "Synthesizing…" with the elapsed
 * clock still climbing — it NEVER claims the run completed early (completion is the caller's job: the
 * reducer flips to `done` and the branch unmounts). A FAST return is a non-issue for the schedule —
 * the caller unmounts this view the instant the reply lands, so an early phase is simply replaced by
 * the result, never "stuck".
 *
 * The function is TOTAL + MONOTONIC: non-finite/negative elapsed clamps to the first phase, `+∞`
 * clamps to the last, and the index never decreases as elapsed grows (proven in the spec).
 */

/** One staged-progress beat: a short imperative label + a calm one-line detail + when it begins. */
export interface ResolutionProgressPhaseDef {
  /** The imperative headline shown while this phase is active (e.g. "Researching — independent pass 1…"). */
  label: string;

  /** A calm supporting line beneath the label (what's happening, in the user's terms). */
  detail: string;

  /** Elapsed-ms threshold at/after which this phase becomes active (the first is always `0`). */
  startMs: number;
}

/**
 * The ordered phase schedule, tuned to the ~24s dual-research → synthesis cadence. The two research
 * legs run first (0-8s, 8-16s), then synthesis holds from 16s onward. Exported so the spec asserts
 * the count/boundaries against the SAME source of truth the component renders.
 */
export const RESOLUTION_PROGRESS_PHASES: readonly ResolutionProgressPhaseDef[] = [
  {
    label: 'Researching — independent pass 1…',
    detail: 'The first provider is gathering evidence from scratch.',
    startMs: 0,
  },
  {
    label: 'Researching — independent pass 2…',
    detail: 'A second provider researches the same question in parallel.',
    startMs: 8_000,
  },
  {
    label: 'Synthesizing the strongest plan…',
    detail: 'Weighing both research passes into one best combined answer.',
    startMs: 16_000,
  },
] as const;

/** The resolved active phase for a given elapsed time — what the component renders this tick. */
export interface ResolutionProgressState {
  /** 0-based index of the active phase (clamped into range). */
  index: number;

  /** Total number of phases — for an honest "step N of M" dot rail. */
  phaseCount: number;

  /** The active phase's imperative headline. */
  label: string;

  /** The active phase's calm supporting line. */
  detail: string;

  /** Echo of the caller's reduced-motion preference — threaded through unchanged (never alters the phase). */
  reducedMotion: boolean;
}

/**
 * Resolve which staged-progress phase is active for `elapsedMs`. Pure + total + monotonic: clamps a
 * non-finite/negative elapsed to the first phase and `+∞` to the last, and the index never decreases
 * as elapsed grows. The LAST phase HOLDS for any elapsed past its start (slow-return safe — it never
 * advances past "Synthesizing…" and never claims completion). `reducedMotion` is passed straight
 * through so the component can render static text without re-deriving it; it NEVER changes the phase.
 *
 * @param elapsedMs - milliseconds since the Resolution run started.
 * @param reducedMotion - whether the user prefers reduced motion (echoed, not used to pick the phase).
 */
export function resolutionProgressPhase(elapsedMs: number, reducedMotion: boolean): ResolutionProgressState {
  const phases = RESOLUTION_PROGRESS_PHASES;
  const safeElapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : elapsedMs > 0 ? Infinity : 0;

  // Walk forward to the LAST phase whose threshold we've passed — holds on the final one forever.
  let index = 0;

  for (let i = 0; i < phases.length; i++) {
    if (safeElapsed >= phases[i].startMs) {
      index = i;
    } else {
      break;
    }
  }

  const active = phases[index];

  return {
    index,
    phaseCount: phases.length,
    label: active.label,
    detail: active.detail,
    reducedMotion,
  };
}

/**
 * Format elapsed milliseconds as a compact `m:ss` clock (e.g. "0:07", "0:12", "1:05") for the live
 * readout. Floors sub-second ms and clamps a non-finite/negative value to "0:00" (defensive — the
 * value comes from a `Date.now()` delta the component recomputes on a tick).
 */
export function formatElapsedClock(elapsedMs: number): string {
  const totalSec = Number.isFinite(elapsedMs) && elapsedMs > 0 ? Math.floor(elapsedMs / 1000) : 0;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;

  return `${min}:${sec.toString().padStart(2, '0')}`;
}
