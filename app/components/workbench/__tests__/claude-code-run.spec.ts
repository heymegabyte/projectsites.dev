/**
 * claude-code-run.spec.ts — unit spec for the PURE run-lifecycle state machine (WLK-39 S5).
 *
 * Proves the typed machine's contract WITHOUT React:
 *   1. The happy paths: running → done, running → error, running → cancelled.
 *   2. The guardrails: illegal transitions are no-ops returning the SAME reference, so a late
 *      stream event can't revive a cancelled/finished run.
 *   3. Every accepted transition appends exactly one timeline beat with the injected timestamp.
 *   4. The pure formatters (`summarizePrompt`, `formatRelative`) + the S6 subagents seam stays empty.
 */
import { describe, expect, it } from 'vitest';
import {
  initialRunState,
  runReducer,
  isTerminal,
  summarizePrompt,
  formatRelative,
  type RunState,
} from '../claude-code-run';

const started = (summary = 'Add a hero headline', at = 1_000): RunState =>
  runReducer(initialRunState, { type: 'start', summary, at });

describe('claude-code-run — lifecycle reducer', () => {
  it('starts a run: idle → running, records the prompt summary + a `started` beat', () => {
    const state = started('Add a bold hero headline', 1_000);

    expect(state.status).toBe('running');
    expect(state.promptSummary).toBe('Add a bold hero headline');
    expect(state.errorMessage).toBeNull();
    expect(state.timeline).toHaveLength(1);
    expect(state.timeline[0]).toMatchObject({ phase: 'started', at: 1_000 });
  });

  it('running → done on finish, appending a `finished` beat', () => {
    const done = runReducer(started(), { type: 'finish', at: 2_500 });

    expect(done.status).toBe('done');
    expect(isTerminal(done.status)).toBe(true);
    expect(done.timeline.map((t) => t.phase)).toEqual(['started', 'finished']);
    expect(done.timeline[1].at).toBe(2_500);
  });

  it('running → error on fail, carrying the message + a `failed` beat', () => {
    const failed = runReducer(started(), { type: 'fail', message: 'HTTP 500', at: 3_000 });

    expect(failed.status).toBe('error');
    expect(failed.errorMessage).toBe('HTTP 500');
    expect(failed.timeline.map((t) => t.phase)).toEqual(['started', 'failed']);
    expect(failed.timeline[1].detail).toBe('HTTP 500');
  });

  it('running → stop → cancelled, appending a `cancelled` beat', () => {
    const cancelled = runReducer(started(), { type: 'cancel', at: 4_000 });

    expect(cancelled.status).toBe('cancelled');
    expect(isTerminal(cancelled.status)).toBe(true);
    expect(cancelled.timeline.map((t) => t.phase)).toEqual(['started', 'cancelled']);
  });

  it('records a single `streaming` beat (first byte) and never a second', () => {
    const streaming = runReducer(started(), { type: 'streaming', at: 1_200 });
    expect(streaming.timeline.map((t) => t.phase)).toEqual(['started', 'streaming']);

    // A second streaming action is a no-op — same reference, still one streaming beat.
    const again = runReducer(streaming, { type: 'streaming', at: 1_300 });
    expect(again).toBe(streaming);
  });

  it('is a no-op (same reference) for finish/fail/cancel while NOT running — a late event cannot revive it', () => {
    // From idle.
    expect(runReducer(initialRunState, { type: 'finish', at: 1 })).toBe(initialRunState);
    expect(runReducer(initialRunState, { type: 'cancel', at: 1 })).toBe(initialRunState);

    // After cancel, a late `finish` from a still-draining stream is ignored.
    const cancelled = runReducer(started(), { type: 'cancel', at: 4_000 });
    const afterLateFinish = runReducer(cancelled, { type: 'finish', at: 5_000 });
    expect(afterLateFinish).toBe(cancelled);
    expect(afterLateFinish.status).toBe('cancelled');
  });

  it('reset returns to idle from a terminal state, and is a no-op from idle', () => {
    const done = runReducer(started(), { type: 'finish', at: 2_000 });
    expect(runReducer(done, { type: 'reset' })).toEqual(initialRunState);
    // Idempotent from idle (same reference — no needless re-render).
    expect(runReducer(initialRunState, { type: 'reset' })).toBe(initialRunState);
  });

  it('a fresh start from a terminal state clears the prior timeline + error', () => {
    const failed = runReducer(started(), { type: 'fail', message: 'boom', at: 3_000 });
    const rerun = runReducer(failed, { type: 'start', summary: 'try again', at: 9_000 });

    expect(rerun.status).toBe('running');
    expect(rerun.errorMessage).toBeNull();
    expect(rerun.timeline).toHaveLength(1);
    expect(rerun.timeline[0].phase).toBe('started');
  });

  it('keeps the S6 subagents seam EMPTY (deferred, not scaffolded)', () => {
    expect(initialRunState.subagents).toEqual([]);
    expect(started().subagents).toEqual([]);
    expect(runReducer(started(), { type: 'finish', at: 2 }).subagents).toEqual([]);
  });
});

describe('claude-code-run — pure formatters', () => {
  it('summarizePrompt collapses whitespace, caps length, and falls back on blank', () => {
    expect(summarizePrompt('  Add   a\nhero  ')).toBe('Add a hero');
    expect(summarizePrompt('')).toBe('Running Claude Code');
    expect(summarizePrompt('x'.repeat(200)).endsWith('…')).toBe(true);
    expect(summarizePrompt('x'.repeat(200)).length).toBeLessThanOrEqual(80);
  });

  it('formatRelative renders compact, human durations', () => {
    expect(formatRelative(0)).toBe('now');
    expect(formatRelative(500)).toBe('now');
    expect(formatRelative(3_000)).toBe('3s');
    expect(formatRelative(65_000)).toBe('1m 5s');
    expect(formatRelative(120_000)).toBe('2m');
    expect(formatRelative(3_600_000)).toBe('1h');
    expect(formatRelative(3_660_000)).toBe('1h 1m');
  });
});
