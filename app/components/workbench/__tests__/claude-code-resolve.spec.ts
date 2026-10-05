/**
 * claude-code-resolve.spec.ts — unit spec for the PURE `/api/resolve` client parser (WLK-39 S6-b-ii).
 *
 * Proves the normalize/parse contract WITHOUT React — the panel renders whatever this returns, so a
 * malformed/partial payload must degrade to a safe, renderable shape rather than throw:
 *   1. A well-formed success body → typed legs (ok + down) + a success synthesis.
 *   2. A `synthesis.ok:false` body → legs preserved + a synthesis-unavailable marker (NOT thrown).
 *   3. Defensive edges: missing `research`, non-array, malformed legs, missing synthesis → safe shape.
 *   4. `providerLabel` maps known providers + title-cases unknown ids + handles blanks.
 */
import { describe, expect, it } from 'vitest';
import { parseResolveResult, providerLabel } from '../claude-code-resolve';

describe('parseResolveResult', () => {
  it('parses a success body: two OK legs + a combined synthesis', () => {
    const result = parseResolveResult({
      research: [
        { provider: 'openai', ok: true, model: 'gpt-5', content: 'A' },
        { provider: 'anthropic', ok: true, model: 'claude-fable-5', content: 'B' },
      ],
      synthesis: { provider: 'anthropic', model: 'claude-fable-5', content: 'C' },
    });

    expect(result.research).toHaveLength(2);
    expect(result.research[0]).toEqual({ provider: 'openai', ok: true, model: 'gpt-5', content: 'A' });
    expect(result.synthesis).toEqual({ ok: true, provider: 'anthropic', model: 'claude-fable-5', content: 'C' });
  });

  it('parses a DOWN leg (provider unavailable) with its reason', () => {
    const result = parseResolveResult({
      research: [{ provider: 'anthropic', ok: false, reason: 'no API key' }],
      synthesis: { provider: 'openai', model: 'gpt-5', content: 'C' },
    });

    expect(result.research[0]).toEqual({ provider: 'anthropic', ok: false, reason: 'no API key' });
  });

  it('parses a synthesis-failed marker as {ok:false, reason} — never throws', () => {
    const result = parseResolveResult({
      research: [{ provider: 'openai', ok: true, model: 'gpt-5', content: 'A' }],
      synthesis: { ok: false, reason: 'synthesis timed out' },
    });

    expect(result.synthesis).toEqual({ ok: false, reason: 'synthesis timed out' });
    // The leg is still there — research is valuable even when synthesis fails.
    expect(result.research).toHaveLength(1);
  });

  it('treats a leg that is ok:true but missing content as DOWN (defensive)', () => {
    const result = parseResolveResult({
      research: [{ provider: 'openai', ok: true, model: 'gpt-5' }],
      synthesis: { content: 'C' },
    });

    expect(result.research[0].ok).toBe(false);
    expect((result.research[0] as { reason: string }).reason).toBeTruthy();
  });

  it('degrades a missing/non-array research field to an empty leg list', () => {
    expect(parseResolveResult({ synthesis: { content: 'C' } }).research).toEqual([]);
    expect(parseResolveResult({ research: 'nope', synthesis: { content: 'C' } }).research).toEqual([]);
  });

  it('degrades a missing/malformed synthesis to an unavailable marker', () => {
    const noSynth = parseResolveResult({ research: [] });
    expect(noSynth.synthesis.ok).toBe(false);

    const emptyContent = parseResolveResult({ research: [], synthesis: { content: '' } });
    expect(emptyContent.synthesis.ok).toBe(false);
  });

  it('never throws on a wholly malformed payload', () => {
    for (const bad of [null, undefined, 42, 'x', [], { research: [null, 1, 'y'] }]) {
      expect(() => parseResolveResult(bad)).not.toThrow();
    }

    // A null/garbage leg becomes a down leg with a safe default reason (no crash downstream).
    const r = parseResolveResult({ research: [null, 1], synthesis: null });
    expect(r.research).toHaveLength(2);
    expect(r.research.every((l) => l.ok === false)).toBe(true);
    expect(r.synthesis.ok).toBe(false);
  });
});

describe('providerLabel', () => {
  it('maps known providers to readable labels (case-insensitive)', () => {
    expect(providerLabel('openai')).toBe('OpenAI');
    expect(providerLabel('Anthropic')).toBe('Anthropic');
    expect(providerLabel('deepseek')).toBe('DeepSeek');
  });

  it('title-cases an unknown provider id and handles blanks', () => {
    expect(providerLabel('acme_labs')).toBe('Acme Labs');
    expect(providerLabel('some-vendor')).toBe('Some Vendor');
    expect(providerLabel('')).toBe('Provider');
  });
});
