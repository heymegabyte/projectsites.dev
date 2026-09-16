import {
  redactBuildLogSecrets,
  toBuildLogLine,
  classifyLogLine,
  resolveBuildOutcome,
  formatHeartbeat,
} from './waiting.component';
import type { LogEntry } from '../../services/api.service';

describe('formatHeartbeat (terminal keeps breathing during long build gaps)', () => {
  const START = Date.parse('2026-09-15T12:00:00Z');
  it('is empty before the build starts (buildStartedAt=0)', () => {
    expect(formatHeartbeat('building', 0, 0, START)).toBe('');
  });
  it('is empty once terminal (published / error)', () => {
    expect(formatHeartbeat('published', START, START, START + 5000)).toBe('');
    expect(formatHeartbeat('error', START, START, START + 5000)).toBe('');
  });
  it('shows elapsed while active + recent activity (≤10s idle)', () => {
    const out = formatHeartbeat('generating', START, START + 131000, START + 134000);
    expect(out).toBe('building — 2m 14s elapsed');
  });
  it('escalates to "still working" after >10s of silence', () => {
    const out = formatHeartbeat('generating', START, START + 15000, START + 40000);
    expect(out).toContain('still building — 40s elapsed');
    expect(out).toContain('working (25s since last update)');
  });
  it('never emits negative durations under clock skew', () => {
    expect(formatHeartbeat('building', START, START, START - 5000)).toBe('building — 0s elapsed');
  });
});

describe('resolveBuildOutcome (build-progress terminal state)', () => {
  it('published WITH a build → live', () => {
    expect(resolveBuildOutcome('published', true)).toBe('live');
  });

  it('published WITHOUT a build → failed (503 stub, never announced live)', () => {
    // The lying-published guard: a published row with a null current_build_version
    // serves a 503 — the visitor must not be told "Your site is live!".
    expect(resolveBuildOutcome('published', false)).toBe('failed');
  });

  it('error → failed (regardless of build)', () => {
    expect(resolveBuildOutcome('error', false)).toBe('failed');
    expect(resolveBuildOutcome('error', true)).toBe('failed');
  });

  it('in-progress statuses → pending (keep polling)', () => {
    for (const s of ['building', 'generating', 'draft', 'queued', 'collecting']) {
      expect(resolveBuildOutcome(s, false)).toBe('pending');
    }
  });
});

describe('redactBuildLogSecrets', () => {
  it('redacts an ANTHROPIC_AUTH_TOKEN=sk-... leak', () => {
    const out = redactBuildLogSecrets('ANTHROPIC_AUTH_TOKEN=sk-ant-should-be-redacted');
    expect(out).not.toContain('sk-ant-should-be-redacted');
    expect(out).toContain('REDACTED');
  });

  it('redacts a bare sk- key, an AWS AKIA key, and a Bearer token', () => {
    expect(redactBuildLogSecrets('key sk-abcdef123456 done')).not.toContain('sk-abcdef123456');
    expect(redactBuildLogSecrets('AKIAIOSFODNN7EXAMPLE')).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(redactBuildLogSecrets('Authorization: Bearer abcDEF123456xyz')).not.toContain(
      'abcDEF123456xyz',
    );
  });

  it('redacts a PostHog phc_ and a Resend re_ key', () => {
    expect(redactBuildLogSecrets('phc_0123456789abcdefghij')).not.toContain(
      'phc_0123456789abcdefghij',
    );
    expect(redactBuildLogSecrets('re_abcdef123456')).not.toContain('re_abcdef123456');
  });

  it('leaves ordinary build output untouched', () => {
    const clean = 'validator-fixer: 0 blockers remaining';
    expect(redactBuildLogSecrets(clean)).toBe(clean);
  });
});

describe('toBuildLogLine', () => {
  function entry(over: Partial<LogEntry>): LogEntry {
    return { id: 'x', action: 'container.stdout', created_at: '2026-08-15T03:00:00Z', ...over };
  }

  it('prefers the raw metadata_json.message as the line text', () => {
    const line = toBuildLogLine(
      entry({ metadata_json: JSON.stringify({ message: 'building → dist' }) }),
    );
    expect(line.text).toBe('building → dist');
  });

  it('falls back to a human label for a known pipeline action when no message', () => {
    const line = toBuildLogLine(
      entry({ action: 'workflow.step.upload_started', metadata_json: undefined }),
    );
    expect(line.text.length).toBeGreaterThan(0);
    expect(line.kind).toBe('phase');
  });

  it('classifies an error action as kind=error', () => {
    expect(toBuildLogLine(entry({ action: 'workflow.step.generation_failed' })).kind).toBe('error');
  });

  it('redacts secrets inside the rendered line', () => {
    const line = toBuildLogLine(
      entry({ metadata_json: JSON.stringify({ message: 'sk-ant-leak-abcdef123456' }) }),
    );
    expect(line.text).not.toContain('sk-ant-leak-abcdef123456');
  });

  it('survives non-JSON metadata without throwing', () => {
    expect(() => toBuildLogLine(entry({ metadata_json: 'not-json{' }))).not.toThrow();
  });

  it('colors a streamed claude.output success line green (kind=success)', () => {
    const line = toBuildLogLine(
      entry({ action: 'claude.output', metadata_json: JSON.stringify({ message: '✓ created src/App.tsx' }) }),
    );
    expect(line.kind).toBe('success');
  });
});

describe('classifyLogLine (STREAMING BUILD THEATER coloring)', () => {
  it('flags an error-shaped action OR message as error', () => {
    expect(classifyLogLine('workflow.step.generation_failed', 'x')).toBe('error');
    expect(classifyLogLine('claude.output', 'Error: cannot resolve module')).toBe('error');
  });
  it('keeps workflow.* pipeline actions as phase', () => {
    expect(classifyLogLine('workflow.step.upload_started', 'anything')).toBe('phase');
  });
  it('colors finished-unit stdout (past-tense / ✓) as success', () => {
    for (const m of ['✓ wrote index.html', 'created 12 files', 'npm install: installed 340 packages', 'Done.']) {
      expect(classifyLogLine('claude.output', m)).toBe('success');
    }
  });
  it('colors in-progress stdout (present-participle) as phase', () => {
    for (const m of ['Running validator-fixer', 'building dist', 'generating hero image']) {
      expect(classifyLogLine('claude.output', m)).toBe('phase');
    }
  });
  it('defaults ordinary stdout to info (dim)', () => {
    expect(classifyLogLine('claude.output', 'the quick brown fox')).toBe('info');
  });
  it('does not confuse creating (phase) with created (success)', () => {
    expect(classifyLogLine('claude.output', 'creating components')).toBe('phase');
    expect(classifyLogLine('claude.output', 'created components')).toBe('success');
  });
});
