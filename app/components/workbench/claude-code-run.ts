/**
 * @file claude-code-run — the pure, typed RUN-LIFECYCLE state machine for the embedded
 * "Claude Code" editor panel (WLK-39 §75 flagship, slice S5; directive §25/§28/§29).
 *
 * @remarks
 * ## Why a separate pure module
 * S0-S4 shipped the stream model + the read-surface tabs. S5 makes the panel feel ALIVE: a run
 * has a LIFE — it starts, streams, and ends (finished / failed / stopped). That lifecycle is its
 * own concern, so it lives here as a PURE reducer (state + action in, new state out) with an
 * injectable clock — trivially unit-testable, no React, no `Date.now()` baked in. The panel owns a
 * single `useReducer` over this; the stream parser ({@link ./claude-code-stream}) is unchanged.
 *
 * ## The machine
 * ```
 *                 start(summary)
 *   idle ───────────────────────────▶ running
 *                                        │  finish()            ┌─▶ done
 *                                        ├──────────────────────┤
 *                                        │  fail(message)       ├─▶ error
 *                                        │                      │
 *                                        │  cancel()            └─▶ cancelled
 *                                        └──────────────────────────────────┐
 *   (any) ─ reset() ─▶ idle                                                  │
 * ```
 * Terminal states (`done`/`error`/`cancelled`) are reached ONLY from `running`. A stray
 * `finish`/`fail`/`cancel` while not running is a NO-OP (returns the same state reference) — the
 * machine can never be driven into an inconsistent state, and a late-arriving stream event after a
 * cancel can't resurrect the run. `reset` returns to `idle` from anywhere (a new prompt submit).
 *
 * ## The timeline (directive §28 — file/lifecycle activity)
 * Every ACCEPTED transition appends one {@link RunTransition} `{ phase, at, detail? }`. The Activity
 * tab interleaves these lifecycle beats (started → streaming → finished/failed/cancelled) with the
 * existing event rows, each stamped with a relative time — so the run reads as a living story.
 *
 * ## Subagents (S6) — DEFERRED, not scaffolded
 * Subagent fan-out needs a backend that doesn't exist yet; the directive forbids rendering empty
 * scaffolding. We leave ONE typed seam — {@link RunState.subagents} is `readonly []` today and
 * nothing renders it — so S6 extends the SAME state object instead of competing. No subagent UI,
 * no empty list, no placeholder rows ship in S5.
 */

/** The five lifecycle states. Terminal set = `done | error | cancelled`. */
export type RunStatus = 'idle' | 'running' | 'done' | 'error' | 'cancelled';

/** The lifecycle "beats" recorded on the timeline — a superset of the statuses plus `streaming`. */
export type RunPhase = 'started' | 'streaming' | 'finished' | 'failed' | 'cancelled';

/** One recorded lifecycle transition (for the Activity timeline). */
export interface RunTransition {
  /** Which beat this is. */
  phase: RunPhase;
  /** Epoch ms when it happened (from the injected clock — never a baked-in `Date.now()`). */
  at: number;
  /** Optional human detail (the prompt summary on `started`, the error message on `failed`). */
  detail?: string;
}

/**
 * A single Claude Code run. Immutable — the reducer returns a NEW object on every accepted action.
 *
 * `subagents` is the S6 seam: typed, always `[]` in S5, rendered by NOTHING (deferred, not
 * scaffolded). Keeping the field here means S6 is an extension, never a rewrite.
 */
export interface RunState {
  status: RunStatus;
  /** The active prompt summary shown in the header while running + after it ends. `null` at idle. */
  promptSummary: string | null;
  /** The failure message when `status === 'error'`, else `null`. */
  errorMessage: string | null;
  /** The ordered lifecycle transitions (oldest first) for the Activity timeline. */
  timeline: readonly RunTransition[];
  /**
   * S6 SEAM — subagent fan-out rows. DEFERRED: always empty in S5, rendered by nothing. Typed as
   * `readonly unknown[]` so S6 can widen it to a real `SubagentRun[]` without a breaking change.
   */
  readonly subagents: readonly unknown[];
}

/** The actions the panel dispatches at the fetch/stream boundary. */
export type RunAction =
  | { type: 'start'; summary: string; at: number }
  | { type: 'streaming'; at: number }
  | { type: 'finish'; at: number }
  | { type: 'fail'; message: string; at: number }
  | { type: 'cancel'; at: number }
  | { type: 'reset' };

/** The pristine idle state — a fresh run, nothing happened yet. */
export const initialRunState: RunState = {
  status: 'idle',
  promptSummary: null,
  errorMessage: null,
  timeline: [],
  subagents: [],
};

/** Terminal states — a run here is OVER; only `reset`/`start` can move it. */
const TERMINAL: ReadonlySet<RunStatus> = new Set<RunStatus>(['done', 'error', 'cancelled']);

/** True when a run is finished/failed/stopped (useful for the UI's "stop" affordance gating). */
export function isTerminal(status: RunStatus): boolean {
  return TERMINAL.has(status);
}

/** Append a transition without mutating the previous array. */
function withTransition(state: RunState, t: RunTransition, next: Partial<RunState>): RunState {
  return { ...state, ...next, timeline: [...state.timeline, t] };
}

/**
 * Trim a prompt to a single-line header summary — collapse whitespace, cap length, add an ellipsis.
 * Pure + total (never throws): a non-string or blank input yields a stable fallback label.
 */
export function summarizePrompt(prompt: string, max = 80): string {
  const collapsed = typeof prompt === 'string' ? prompt.replace(/\s+/g, ' ').trim() : '';

  if (collapsed === '') {
    return 'Running Claude Code';
  }

  return collapsed.length > max ? `${collapsed.slice(0, max - 1).trimEnd()}…` : collapsed;
}

/**
 * The PURE run-lifecycle reducer. Every accepted transition appends a timeline beat; every illegal
 * transition is a no-op that returns the SAME reference (so React bails out of a re-render and a
 * late stream event can't revive a cancelled/finished run).
 *
 * @param state - the current run state.
 * @param action - the dispatched action (carries its own `at` timestamp from the caller's clock).
 * @returns the next state (a new object) or `state` unchanged for an illegal transition.
 */
export function runReducer(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case 'start': {
      const summary = summarizePrompt(action.summary);

      // A new run always starts clean from `running` — valid from idle OR a terminal re-run.
      return {
        status: 'running',
        promptSummary: summary,
        errorMessage: null,
        timeline: [{ phase: 'started', at: action.at, detail: summary }],
        subagents: [],
      };
    }

    case 'streaming': {
      // Record the first byte only once, and only while running.
      if (state.status !== 'running' || state.timeline.some((t) => t.phase === 'streaming')) {
        return state;
      }

      return withTransition(state, { phase: 'streaming', at: action.at }, {});
    }

    case 'finish': {
      if (state.status !== 'running') {
        return state;
      }

      return withTransition(state, { phase: 'finished', at: action.at }, { status: 'done' });
    }

    case 'fail': {
      if (state.status !== 'running') {
        return state;
      }

      const message =
        typeof action.message === 'string' && action.message.trim() !== '' ? action.message : 'Run failed';

      return withTransition(
        state,
        { phase: 'failed', at: action.at, detail: message },
        { status: 'error', errorMessage: message },
      );
    }

    case 'cancel': {
      if (state.status !== 'running') {
        return state;
      }

      return withTransition(state, { phase: 'cancelled', at: action.at }, { status: 'cancelled' });
    }

    case 'reset':
      return state.status === 'idle' ? state : initialRunState;

    default:
      return state;
  }
}

/** Per-status label + glyph + tint for the header status pill (black+cyan; AA on `--ps-bg`). */
export const RUN_STATUS_META: Record<
  Exclude<RunStatus, 'idle'>,
  { label: string; icon: string; className: string; spin: boolean }
> = {
  running: {
    label: 'Running',
    icon: 'i-ph:circle-notch-bold',
    className: 'text-bolt-elements-item-contentAccent',
    spin: true,
  },
  done: { label: 'Done', icon: 'i-ph:check-circle-bold', className: 'text-green-500', spin: false },
  error: { label: 'Error', icon: 'i-ph:x-circle-bold', className: 'text-red-500', spin: false },
  cancelled: {
    label: 'Stopped',
    icon: 'i-ph:stop-circle-bold',
    className: 'text-bolt-elements-textTertiary',
    spin: false,
  },
};

/** Per-phase label + glyph for the Activity timeline beats. */
export const RUN_PHASE_META: Record<RunPhase, { label: string; icon: string; className: string }> = {
  started: {
    label: 'Run started',
    icon: 'i-ph:play-circle-duotone',
    className: 'text-bolt-elements-item-contentAccent',
  },
  streaming: { label: 'Streaming', icon: 'i-ph:waveform-duotone', className: 'text-bolt-elements-item-contentAccent' },
  finished: { label: 'Run finished', icon: 'i-ph:check-circle-duotone', className: 'text-green-500' },
  failed: { label: 'Run failed', icon: 'i-ph:warning-circle-duotone', className: 'text-red-500' },
  cancelled: { label: 'Run stopped', icon: 'i-ph:stop-circle-duotone', className: 'text-bolt-elements-textTertiary' },
};

/**
 * Format an elapsed duration (ms) as a compact relative label for the timeline (`now`, `3s`,
 * `2m 5s`, `1h 4m`). Pure + total; clamps negatives to `now`.
 */
export function formatRelative(deltaMs: number): string {
  if (!Number.isFinite(deltaMs) || deltaMs < 1000) {
    return 'now';
  }

  const totalSec = Math.floor(deltaMs / 1000);

  if (totalSec < 60) {
    return `${totalSec}s`;
  }

  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;

  if (min < 60) {
    return sec === 0 ? `${min}m` : `${min}m ${sec}s`;
  }

  const hr = Math.floor(min / 60);
  const remMin = min % 60;

  return remMin === 0 ? `${hr}h` : `${hr}h ${remMin}m`;
}
