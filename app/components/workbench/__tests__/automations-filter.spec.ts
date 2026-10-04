/**
 * @file Resources › Automations — triage status-filter logic (Resources EPIC, fire-138).
 *
 * Gap closed: the Automations panel shipped as a flat, read-only dump of up to
 * 200 `workflow_jobs` rows with NO way to triage — a busy owner couldn't focus
 * on what FAILED or is still RUNNING. This fire added a status-filter bar backed
 * by two PURE functions, `statusBucket` + `summarizeAutomations`, so the triage
 * logic is falsifiable without mounting the panel (mirrors `MediaPageStats`).
 *
 * These tests pin:
 *   1. `statusBucket` maps every raw `workflow_jobs.status` synonym onto exactly
 *      one of failed / success / running (the fallback is running, never throws).
 *   2. `summarizeAutomations` counts each bucket AND returns the filtered subset,
 *      so the pill counts and the rendered rows share ONE source of truth.
 *   3. The 'all' filter returns every row; an empty bucket yields `[]`.
 */
import { describe, expect, it } from 'vitest';
import { statusBucket, summarizeAutomations, type AutomationFilter } from '../AutomationsPanel';
import type { AutomationEntry } from '~/lib/embed/embedded-mode';

/** Build an AutomationEntry with just the fields the filter logic reads. */
function job(id: string, status: string): AutomationEntry {
  return { id, type: 'site-generation', status, created_at: '2026-10-04T00:00:00Z', finished_at: null };
}

// ─── statusBucket — every synonym maps to one coarse bucket ──────────────────

describe('statusBucket', () => {
  it('maps failure synonyms → failed', () => {
    for (const s of ['failed', 'error', 'errored', 'cancelled', 'canceled', 'FAILED', 'Error']) {
      expect(statusBucket(s)).toBe('failed');
    }
  });

  it('maps success synonyms → success', () => {
    for (const s of ['success', 'succeeded', 'complete', 'completed', 'published', 'SUCCESS']) {
      expect(statusBucket(s)).toBe('success');
    }
  });

  it('maps in-flight synonyms (and anything unknown) → running, never throwing', () => {
    for (const s of ['running', 'queued', 'pending', 'processing', 'generating', 'weird-new-status', '']) {
      expect(statusBucket(s)).toBe('running');
    }
  });
});

// ─── summarizeAutomations — counts + filtered subset share one truth ─────────

describe('summarizeAutomations', () => {
  const list: AutomationEntry[] = [
    job('a', 'success'),
    job('b', 'failed'),
    job('c', 'running'),
    job('d', 'queued'), // → running bucket
    job('e', 'completed'), // → success bucket
  ];

  it("'all' returns every row and the correct per-bucket counts", () => {
    const { counts, visible } = summarizeAutomations(list, 'all');
    expect(counts).toEqual({ all: 5, running: 2, success: 2, failed: 1 });
    expect(visible).toHaveLength(5);
  });

  it("'failed' returns only the failed row", () => {
    const { visible } = summarizeAutomations(list, 'failed');
    expect(visible.map((v) => v.id)).toEqual(['b']);
  });

  it("'running' returns in-flight rows (running + queued)", () => {
    const { visible } = summarizeAutomations(list, 'running');
    expect(visible.map((v) => v.id)).toEqual(['c', 'd']);
  });

  it("'success' returns completed/succeeded rows", () => {
    const { visible } = summarizeAutomations(list, 'success');
    expect(visible.map((v) => v.id)).toEqual(['a', 'e']);
  });

  it('a bucket with no matches yields an empty visible list (never a crash)', () => {
    const onlySuccess: AutomationEntry[] = [job('x', 'success'), job('y', 'published')];
    const failed: AutomationFilter = 'failed';
    const { counts, visible } = summarizeAutomations(onlySuccess, failed);
    expect(counts.failed).toBe(0);
    expect(visible).toEqual([]);
  });

  it('an empty store yields zero counts and an empty list', () => {
    const { counts, visible } = summarizeAutomations([], 'all');
    expect(counts).toEqual({ all: 0, running: 0, success: 0, failed: 0 });
    expect(visible).toEqual([]);
  });
});
