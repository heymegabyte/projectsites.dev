/**
 * ai-ask-logic.spec.ts
 *
 * Unit tests for the PURE core of the unified "Ask AI" data-grid action (WLK-04):
 * the one box that replaced the split "AI filter" + "AI column" buttons. We test
 * that the model's reply is robustly classified into a dispatchable action plan,
 * that noisy/fenced/garbage replies degrade to the safest action (`filter`)
 * rather than dead-ending, and that `fill` is never chosen without a selection.
 */
import { describe, expect, it } from 'vitest';
import { buildAskSystemPrompt, parseAskPlan, stripJsonFence, type AskPlan } from './ai-ask-logic';

describe('stripJsonFence', () => {
  it('removes ```json fences and trims', () => {
    expect(stripJsonFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripJsonFence('```\n{"b":2}\n```')).toBe('{"b":2}');
    expect(stripJsonFence('  {"c":3}  ')).toBe('{"c":3}');
  });
});

describe('buildAskSystemPrompt', () => {
  it('offers fill when rows are selected', () => {
    const p = buildAskSystemPrompt('orders(id, total)', true);
    expect(p).toContain('SCHEMA:');
    expect(p).toContain('orders(id, total)');
    expect(p).toMatch(/"fill".*SELECTED rows/);
    expect(p).not.toContain('NOT available');
  });

  it('forbids fill when nothing is selected', () => {
    const p = buildAskSystemPrompt('orders(id, total)', false);
    expect(p).toContain('NOT available');
    expect(p).toContain('Never choose "fill"');
  });
});

describe('parseAskPlan — the unified intent router', () => {
  it('routes a filter request', () => {
    const plan = parseAskPlan('{"action":"filter","instruction":"orders over $100"}', 'raw', false);
    expect(plan).toEqual<AskPlan>({ action: 'filter', instruction: 'orders over $100' });
  });

  it('routes a column request', () => {
    const plan = parseAskPlan('{"action":"column","instruction":"add a status column"}', 'add a status column', false);
    expect(plan).toEqual<AskPlan>({ action: 'column', instruction: 'add a status column' });
  });

  it('routes a fill request WITH a target column when rows are selected', () => {
    const plan = parseAskPlan(
      '{"action":"fill","column":"summary","instruction":"one-line summary"}',
      'summarize each',
      true,
    );
    expect(plan).toEqual<AskPlan>({
      action: 'fill',
      column: 'summary',
      instruction: 'one-line summary',
    });
  });

  it('tolerates ```json fences around the plan', () => {
    const plan = parseAskPlan('```json\n{"action":"column","instruction":"x"}\n```', 'x', false);
    expect(plan.action).toBe('column');
  });

  it('DOWNGRADES fill to filter when nothing is selected (never strand the user)', () => {
    const plan = parseAskPlan('{"action":"fill","column":"c","instruction":"fill it"}', 'fill it', false);
    expect(plan.action).toBe('filter');
    expect(plan.instruction).toBe('fill it');
  });

  it('falls back to a filter over the raw text on unparseable JSON', () => {
    const plan = parseAskPlan('I think you want to filter…', 'orders this week', true);
    expect(plan).toEqual<AskPlan>({ action: 'filter', instruction: 'orders this week' });
  });

  it('falls back to filter on an unknown/invalid action', () => {
    const plan = parseAskPlan('{"action":"delete","instruction":"drop stuff"}', 'drop stuff', true);
    expect(plan.action).toBe('filter');
  });

  it('defaults instruction to the user text when the model omits it', () => {
    const plan = parseAskPlan('{"action":"column"}', 'a tax column', false);
    expect(plan.instruction).toBe('a tax column');
  });

  it('omits column for non-fill actions even if the model returns one', () => {
    const plan = parseAskPlan('{"action":"filter","column":"nope","instruction":"x"}', 'x', true);
    expect(plan).toEqual<AskPlan>({ action: 'filter', instruction: 'x' });
  });
});
