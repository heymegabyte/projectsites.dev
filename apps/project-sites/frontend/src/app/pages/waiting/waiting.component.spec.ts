import {
  redactBuildLogSecrets,
  stripControlChars,
  toBuildLogLine,
  buildTerminalLines,
  classifyLogLine,
  isBuildLogNoise,
  resolveBuildOutcome,
  shouldDegradeToLoadError,
  deriveBuildStep,
  formatHeartbeat,
  mapStatusToPhase,
  OWNER_PHASES,
} from './waiting.component';
import type { LogEntry } from '../../services/api.service';

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);
const mkLog = (action: string, message: string, created_at: string): LogEntry =>
  ({ action, created_at, metadata_json: JSON.stringify({ message }) }) as LogEntry;

describe('mapStatusToPhase (REAL backend status → owner-facing cinematic phase — the HONESTY seam)', () => {
  // Ground truth: the backend writes sites.status (read via getSite().data.status) through the
  // documented machine draft → collecting → imaging → generating → published | error | archived,
  // plus the api.ts create/reset write 'building' and the NO_REGRESS set adds 'queued'/'uploading'.
  // A non-technical owner must NEVER see those raw tokens — mapStatusToPhase is the only translator.

  it('exposes exactly four ordered owner phases (research → design → build → polish), each with human copy', () => {
    expect(OWNER_PHASES.length).toBe(4);
    expect(OWNER_PHASES.map((p) => p.index)).toEqual([0, 1, 2, 3]);
    // Not one phase leaks a raw status token or engineering jargon to the owner.
    const banned = /collecting|imaging|generating|uploading|queued|workflow|r2|status|build pipeline/i;
    for (const p of OWNER_PHASES) {
      expect(p.phaseLabel.length).toBeGreaterThan(0);
      expect(p.friendlyCopy.length).toBeGreaterThan(0);
      expect(p.phaseLabel).not.toMatch(banned);
      expect(p.friendlyCopy).not.toMatch(banned);
    }
  });

  it('maps each REAL in-progress status to its friendly phase (never echoes the raw token)', () => {
    const cases: Array<[string, number]> = [
      ['draft', 0],
      ['queued', 0],
      ['building', 0],
      ['collecting', 0], // "Researching your business…"
      ['imaging', 1], // "Designing your brand & logo…"
      ['generating', 2], // "Building your pages…"
      ['uploading', 3], // "Polishing & going live…"
    ];
    for (const [status, index] of cases) {
      const phase = mapStatusToPhase(status);
      expect(phase.index).toBe(index);
      expect(phase.total).toBe(4);
      // HONESTY: the owner-facing copy must not surface the raw developer status string.
      expect(phase.phaseLabel.toLowerCase()).not.toContain(status);
      expect(phase.friendlyCopy.toLowerCase()).not.toContain(status);
    }
  });

  it('maps the four documented phases to their expected human labels', () => {
    expect(mapStatusToPhase('collecting').phaseLabel).toBe('Researching your business');
    expect(mapStatusToPhase('imaging').phaseLabel).toBe('Designing your brand & logo');
    expect(mapStatusToPhase('generating').phaseLabel).toBe('Building your pages');
    expect(mapStatusToPhase('uploading').phaseLabel).toBe('Polishing & going live');
  });

  it('maps published → the final live phase (index 3)', () => {
    const phase = mapStatusToPhase('published');
    expect(phase.index).toBe(3);
    expect(phase.phaseLabel.toLowerCase()).toContain('live');
  });

  it('HOLDS the last real phase for an UNKNOWN / between-statuses value — never invents progress, never regresses to 0', () => {
    // Between known statuses the backend may briefly report something we do not map. We must HOLD
    // the last real phase (index 2 here), NOT snap back to "Researching…" (index 0) — a fabricated
    // regression would be a lying metric. `lastIndex` carries the monotonic floor.
    const held = mapStatusToPhase('some_unexpected_status', 2);
    expect(held.index).toBe(2);
    expect(held.phaseLabel).toBe(OWNER_PHASES[2].phaseLabel);
  });

  it('defaults an unknown status with no prior phase to the first phase (never a blank/doomed screen)', () => {
    const phase = mapStatusToPhase('totally_unknown');
    expect(phase.index).toBe(0);
    expect(phase.phaseLabel.length).toBeGreaterThan(0);
  });

  it('never REGRESSES below the monotonic floor even when a real status maps lower (windowed-regression guard)', () => {
    // If we have already reached "Building your pages" (2) and a stale poll reports 'collecting' (0),
    // the owner must not see the bar jump backward. The floor wins.
    const phase = mapStatusToPhase('collecting', 2);
    expect(phase.index).toBe(2);
  });

  it('error status still resolves to a real phase object (the component surfaces the error path separately, never masks it as progress)', () => {
    // mapStatusToPhase does not fabricate progress for 'error'; it holds the last real phase so the
    // component's dedicated error UI (status()==='error') owns the failure messaging.
    const phase = mapStatusToPhase('error', 1);
    expect(phase.index).toBe(1);
  });
});

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

describe('shouldDegradeToLoadError (AL-827: never a perpetual fake overlay on an unloadable build)', () => {
  it('degrades after 2 consecutive failures with NO prior successful load (401 expired / bad id)', () => {
    expect(shouldDegradeToLoadError(false, 0)).toBe(false); // first tick — give it a chance
    expect(shouldDegradeToLoadError(false, 1)).toBe(false); // one blip — retry
    expect(shouldDegradeToLoadError(false, 2)).toBe(true); // ~6s of never-loaded → graceful card
    expect(shouldDegradeToLoadError(false, 5)).toBe(true);
  });

  it('NEVER degrades once the site has loaded (a mid-build transient blip must not disrupt a live build)', () => {
    expect(shouldDegradeToLoadError(true, 2)).toBe(false);
    expect(shouldDegradeToLoadError(true, 99)).toBe(false);
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

describe('isBuildLogNoise (drops control-plane + transport noise from the terminal)', () => {
  it('drops Claude Code control-plane + provider-transport lines', () => {
    // Ground truth 2026-09-16: these are the exact lines a dead build-LLM balance streamed —
    // 42/43 rows. An owner watching their site build must never see them.
    for (const m of [
      'API Error: 402 Insufficient Balance',
      'API Error: 429 Too Many Requests',
      '[claude-code:unrecognized_model] {"model":"deepseek-chat"}',
      '"deepseek-chat" isn\'t described by this version\'s model catalog',
      'map it with behavesAs on a modelPicker row',
      '{"query_source":"generate_session_title"}',
    ]) {
      expect(isBuildLogNoise(m)).toBe(true);
    }
  });

  it('keeps real narration AND genuine build errors (specific, not generic)', () => {
    for (const m of ['writing src/App.tsx', '✓ created 12 sections', "Error: Cannot find module './Hero'"]) {
      expect(isBuildLogNoise(m)).toBe(false);
    }
  });
});

describe('stripControlChars (ANSI / control-byte scrub, mirror of build_log.ts)', () => {
  it('strips ANSI colour + cursor sequences', () => {
    expect(stripControlChars(ESC + '[32m' + 'created Hero.tsx' + ESC + '[0m')).toBe('created Hero.tsx');
    expect(stripControlChars(ESC + '[2K' + ESC + '[1G' + 'installing deps')).toBe('installing deps');
  });

  it('collapses a carriage-return progress spinner to its final frame', () => {
    expect(stripControlChars('building' + CR + 'building.' + CR + 'built ok')).toBe('built ok');
  });

  it('keeps tabs + unicode, drops DEL', () => {
    const TAB = String.fromCharCode(9);
    expect(stripControlChars('a' + TAB + 'b')).toBe('a' + TAB + 'b');
    expect(stripControlChars('rocket ' + String.fromCharCode(127) + 'go')).toBe('rocket go');
  });

  it('toBuildLogLine renders a colour-wrapped stdout line as clean text', () => {
    const line = toBuildLogLine(mkLog('claude.output', ESC + '[36m' + 'writing src/App.tsx' + ESC + '[0m', '2026-09-19T12:00:00Z'));
    expect(line.text).toBe('writing src/App.tsx');
  });
});

describe('buildTerminalLines (DESC audit rows → chronological terminal, newest LAST)', () => {
  it('reverses newest-first logs so the newest line is at the BOTTOM (auto-scroll follows it)', () => {
    // The /logs API returns created_at DESC — index 0 is the NEWEST row.
    const descLogs: LogEntry[] = [
      mkLog('claude.output', 'third (newest)', '2026-09-19T12:00:03Z'),
      mkLog('claude.output', 'second', '2026-09-19T12:00:02Z'),
      mkLog('claude.output', 'first (oldest)', '2026-09-19T12:00:01Z'),
    ];
    const lines = buildTerminalLines(descLogs);
    expect(lines[0].text).toBe('first (oldest)');
    expect(lines[lines.length - 1].text).toBe('third (newest)'); // newest LAST → visible after auto-scroll
  });

  it('still drops control-plane noise from the terminal', () => {
    const lines = buildTerminalLines([
      mkLog('claude.output', 'API Error: 402 Insufficient Balance', '2026-09-19T12:00:02Z'),
      mkLog('claude.output', 'writing src/App.tsx', '2026-09-19T12:00:01Z'),
    ]);
    expect(lines.map((l) => l.text)).toEqual(['writing src/App.tsx']);
  });
});

describe('deriveBuildStep + monotonic progress (windowed logs must not regress the bar)', () => {
  it('derives the furthest-reached pipeline step from the log window', () => {
    const logs = [
      mkLog('workflow.started', '', '2026-09-19T12:00:01Z'),
      mkLog('workflow.step.structure_plan_complete', '', '2026-09-19T12:00:02Z'),
    ];
    expect(deriveBuildStep(logs, 'generating').step).toBe(4);
  });

  it('falls back to the site-status map when no pipeline action is in the window', () => {
    // The claude.output flood pushed all workflow.* events out of the 200-row window.
    const floodOnly = [mkLog('claude.output', 'writing Hero.tsx', '2026-09-19T12:05:00Z')];
    expect(deriveBuildStep(floodOnly, 'generating').step).toBe(5); // status map, not step 1
    expect(deriveBuildStep(floodOnly, 'building').step).toBe(1); // still building, no map → step 1
  });
});
