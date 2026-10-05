/**
 * Unit spec for the Claude Code stream parser (WLK-39 S0).
 *
 * The load-bearing assertion is the GUARDRAIL: chain-of-thought is structurally
 * unrepresentable — the union has no `thought`/`reasoning` member and the parser DROPS any
 * such line. The rest locks the two wire shapes (JSON + `cc:`), the prose→output_delta
 * fallback, enum coercion, and purity.
 */
import { describe, it, expect } from 'vitest';
import {
  parseClaudeCodeStream,
  FORBIDDEN_EVENT_KINDS,
  type ClaudeCodeEvent,
  type ClaudeCodeEventKind,
} from '../claude-code-stream';

describe('parseClaudeCodeStream', () => {
  it('returns [] for empty / non-string input', () => {
    expect(parseClaudeCodeStream('')).toEqual([]);
    expect(parseClaudeCodeStream(undefined as unknown as string)).toEqual([]);
    expect(parseClaudeCodeStream('   \n  \n')).toEqual([]);
  });

  it('parses a JSON `action` line with label + detail', () => {
    const [event] = parseClaudeCodeStream('{"kind":"action","label":"Read package.json","detail":"cat package.json"}');
    expect(event).toEqual({ kind: 'action', label: 'Read package.json', detail: 'cat package.json' });
  });

  it('parses a JSON `decision` line and keeps rationale (a conclusion, not a thought)', () => {
    const [event] = parseClaudeCodeStream(
      '{"kind":"decision","label":"Reuse /api/llmcall","rationale":"Already routes to the AI Gateway"}',
    );
    expect(event).toEqual({
      kind: 'decision',
      label: 'Reuse /api/llmcall',
      rationale: 'Already routes to the AI Gateway',
    });
  });

  it('parses `evidence`, `file_touched`, `test_result`, and `deploy_state`', () => {
    const events = parseClaudeCodeStream(
      [
        '{"kind":"evidence","label":"stream path is wired","source":"api.llmcall.ts:111"}',
        '{"kind":"file_touched","path":"src/App.tsx","change":"edit"}',
        '{"kind":"test_result","name":"parser","passed":true,"summary":"12 passed"}',
        '{"kind":"deploy_state","state":"deployed","detail":"v123"}',
      ].join('\n'),
    );

    expect(events).toEqual([
      { kind: 'evidence', label: 'stream path is wired', source: 'api.llmcall.ts:111' },
      { kind: 'file_touched', path: 'src/App.tsx', change: 'edit' },
      { kind: 'test_result', name: 'parser', passed: true, summary: '12 passed' },
      { kind: 'deploy_state', state: 'deployed', detail: 'v123' },
    ]);
  });

  it('carries the optional file_touched diff payload (diff / before / after) through to the event', () => {
    const [event] = parseClaudeCodeStream(
      JSON.stringify({
        kind: 'file_touched',
        path: 'src/App.tsx',
        change: 'edit',
        before: 'old\n',
        after: 'new\n',
        diff: '@@ -1 +1 @@\n-old\n+new',
      }),
    );
    expect(event).toEqual({
      kind: 'file_touched',
      path: 'src/App.tsx',
      change: 'edit',
      before: 'old\n',
      after: 'new\n',
      diff: '@@ -1 +1 @@\n-old\n+new',
    });
  });

  it('keeps an empty-string before/after (a created/deleted file) rather than dropping it', () => {
    const [event] = parseClaudeCodeStream(
      JSON.stringify({ kind: 'file_touched', path: 'new.ts', change: 'create', before: '', after: 'hello\n' }),
    );
    expect(event).toEqual({ kind: 'file_touched', path: 'new.ts', change: 'create', before: '', after: 'hello\n' });
  });

  it('coerces an unknown file-change to `edit` and an unknown deploy-state to `idle`', () => {
    const events = parseClaudeCodeStream(
      ['{"kind":"file_touched","path":"a.ts","change":"frobnicate"}', '{"kind":"deploy_state","state":"warp"}'].join(
        '\n',
      ),
    );
    expect(events[0]).toEqual({ kind: 'file_touched', path: 'a.ts', change: 'edit' });
    expect(events[1]).toEqual({ kind: 'deploy_state', state: 'idle', detail: undefined });
  });

  it('treats non-structured prose as an output_delta (raw output still shows)', () => {
    const events = parseClaudeCodeStream('I will now edit the hero copy.\nDone.');
    expect(events).toEqual([
      { kind: 'output_delta', text: 'I will now edit the hero copy.' },
      { kind: 'output_delta', text: 'Done.' },
    ]);
  });

  it('parses the terse `cc:` shape — bare, JSON payload, and plain payload', () => {
    const events = parseClaudeCodeStream(
      [
        'cc:action Ran the unit suite',
        'cc:file_touched {"path":"src/x.ts","change":"create"}',
        'cc:deploy_state building',
      ].join('\n'),
    );
    expect(events).toEqual([
      { kind: 'action', label: 'Ran the unit suite', detail: undefined },
      { kind: 'file_touched', path: 'src/x.ts', change: 'create' },
      { kind: 'deploy_state', state: 'building', detail: undefined },
    ]);
  });

  // ── THE GUARDRAIL ──────────────────────────────────────────────────────────────────────

  it('DROPS a `thought` JSON line — chain-of-thought is never emitted', () => {
    const events = parseClaudeCodeStream('{"kind":"thought","label":"Maybe I should refactor first"}');
    expect(events).toEqual([]);
  });

  it('DROPS every forbidden CoT kind (thought/reasoning/thinking/scratchpad), JSON and cc:', () => {
    for (const kind of FORBIDDEN_EVENT_KINDS) {
      expect(parseClaudeCodeStream(`{"kind":"${kind}","label":"secret deliberation"}`)).toEqual([]);
      expect(parseClaudeCodeStream(`cc:${kind} secret deliberation`)).toEqual([]);
    }
  });

  it('keeps the real events in a mixed stream but strips interleaved CoT lines', () => {
    const events = parseClaudeCodeStream(
      [
        '{"kind":"reasoning","label":"thinking about the approach"}',
        '{"kind":"action","label":"Edit src/App.tsx"}',
        'cc:thinking still deciding',
        '{"kind":"file_touched","path":"src/App.tsx","change":"edit"}',
      ].join('\n'),
    );

    expect(events).toEqual([
      { kind: 'action', label: 'Edit src/App.tsx', detail: undefined },
      { kind: 'file_touched', path: 'src/App.tsx', change: 'edit' },
    ]);

    // Belt-and-braces: no event carries a forbidden kind.
    const kinds = events.map((e: ClaudeCodeEvent) => e.kind as ClaudeCodeEventKind);
    for (const forbidden of FORBIDDEN_EVENT_KINDS) {
      expect(kinds).not.toContain(forbidden);
    }
  });

  it('drops structurally-invalid structured lines (missing required field)', () => {
    const events = parseClaudeCodeStream(
      ['{"kind":"action"}', '{"kind":"file_touched","change":"edit"}', '{"kind":"evidence"}'].join('\n'),
    );
    expect(events).toEqual([]);
  });

  it('is pure — the same input yields an equal result every call', () => {
    const input = '{"kind":"action","label":"Read a.ts"}\nplain output';
    expect(parseClaudeCodeStream(input)).toEqual(parseClaudeCodeStream(input));
  });
});
