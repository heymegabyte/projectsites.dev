// @vitest-environment jsdom
/**
 * ClaudeCodePanel.spec.tsx — render spec for the embedded Claude Code tab (WLK-39 S1).
 *
 * Proves the wire-complete vertical's UI contract:
 *  1. Renders the spine-composed panel (header + sub-nav + prompt composer) with the launchpad empty.
 *  2. Shows the prompt input + Run button (the ONE obvious primary action).
 *  3. Maps a sample Claude Code stream to Activity events via the real parser — and leaks NO CoT.
 *  4. "Apply a sample edit" writes ONE file through the SHARED workbenchStore (the ONE WebContainer),
 *     never a parallel filesystem.
 *
 * `~/utils/constants` (instantiates LLMManager at module scope) and `~/lib/stores/workbench`
 * (the WebContainer singleton chain) are mocked so the render stays hermetic — the parser itself
 * is NOT mocked (its mapping is part of this contract). Assertions use plain vitest matchers
 * (`toBeTruthy`/`.textContent`/`.querySelectorAll`), matching the repo's render-spec convention
 * (jest-dom matchers are not globally registered here).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';

// Stub the constants module — it builds LLMManager at import time (not needed for render).
vi.mock('~/utils/constants', () => ({
  DEFAULT_MODEL: 'claude-opus-4-6',
  DEFAULT_PROVIDER: { name: 'ProjectSites AI' },
}));

// Stub the workbench store — assert the file-edit rail is the SHARED one (no parallel FS).
const { createFileSpy } = vi.hoisted(() => ({ createFileSpy: vi.fn() }));
vi.mock('~/lib/stores/workbench', () => ({
  workbenchStore: { createFile: createFileSpy },
}));

// Stub the embed bridge — Resolution mode runs `/api/resolve` through the admin PS_RESOLVE bridge
// (WLK-39 S7), NOT a relative `fetch` (which 404s from the editor origin). Mocking at THIS boundary
// is the fix: the panel awaits `requestResolve(prompt)` and branches on the bridge reply.
const { requestResolveSpy } = vi.hoisted(() => ({ requestResolveSpy: vi.fn() }));
vi.mock('~/lib/embed/embedded-mode', () => ({
  requestResolve: requestResolveSpy,
}));

import { ClaudeCodePanel, SAMPLE_ACTIVITY_STREAM } from '../ClaudeCodePanel';
import { parseClaudeCodeStream, FORBIDDEN_EVENT_KINDS } from '../claude-code-stream';

beforeEach(() => {
  createFileSpy.mockReset();
  createFileSpy.mockResolvedValue(true);
  requestResolveSpy.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ClaudeCodePanel', () => {
  it('renders the panel shell, header, sub-nav, and the launchpad empty state', () => {
    render(<ClaudeCodePanel />);

    expect(screen.getByTestId('claude-code-panel')).toBeTruthy();
    // One canonical header title.
    expect(screen.getByRole('heading', { name: 'Claude Code' })).toBeTruthy();
    // Spine sub-nav with the Activity segment.
    expect(screen.getByTestId('cc-subnav')).toBeTruthy();
    expect(screen.getByTestId('panel-segnav-activity')).toBeTruthy();
    // Launchpad empty — never a dead wall.
    expect(screen.getByTestId('cc-empty')).toBeTruthy();
  });

  it('shows the prompt input + Run button; Run is disabled until the prompt is non-empty', () => {
    render(<ClaudeCodePanel />);

    const input = screen.getByTestId('cc-prompt-input') as HTMLTextAreaElement;
    const run = screen.getByTestId('cc-run-button') as HTMLButtonElement;

    expect(input).toBeTruthy();
    expect(run).toBeTruthy();
    expect(run.disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'Add a hero headline' } });
    expect(run.disabled).toBe(false);
  });

  it('maps a sample stream to Activity events via the real parser — and leaks NO chain-of-thought', async () => {
    render(<ClaudeCodePanel />);

    // "Apply a sample edit" seeds the Activity log from the deterministic sample stream.
    fireEvent.click(screen.getByTestId('cc-apply-sample'));

    const list = await screen.findByTestId('cc-activity-list');
    expect(list).toBeTruthy();

    // The sample contains a `thought` line — the parser drops it, so the rendered count is the
    // parsed (CoT-stripped) count, and NO rendered row carries a forbidden kind.
    const expectedEvents = parseClaudeCodeStream(SAMPLE_ACTIVITY_STREAM);
    const rows = list.querySelectorAll('[data-testid^="cc-event-"]');
    expect(rows.length).toBe(expectedEvents.length);
    expect(rows.length).toBeGreaterThan(0);

    for (const row of Array.from(rows)) {
      const kind = row.getAttribute('data-kind');
      expect(FORBIDDEN_EVENT_KINDS as readonly string[]).not.toContain(kind ?? '');
    }

    // The raw sample text includes the private-reasoning string — it must NOT reach the DOM.
    expect(screen.queryByText(/private reasoning MUST be stripped/i)).toBeNull();
    // But the real decision + file-touch DID render.
    expect(screen.getByText('Add a greeting to the homepage')).toBeTruthy();
    expect(screen.getByText('src/App.tsx')).toBeTruthy();
  });

  it('applies ONE file edit through the SHARED workbenchStore (the one WebContainer, no parallel FS)', async () => {
    render(<ClaudeCodePanel />);

    fireEvent.click(screen.getByTestId('cc-apply-sample'));

    await waitFor(() => expect(createFileSpy).toHaveBeenCalledTimes(1));

    const [path, content] = createFileSpy.mock.calls[0];
    expect(path).toBe('CLAUDE_CODE_SAMPLE.md');
    expect(String(content)).toContain('one WebContainer');
  });

  it('shows the Files empty launchpad before any file is touched (never a blank body)', () => {
    render(<ClaudeCodePanel />);

    fireEvent.click(screen.getByTestId('panel-segnav-files'));
    expect(screen.getByTestId('cc-files-empty')).toBeTruthy();
    expect(screen.getByText('No files changed yet')).toBeTruthy();
  });

  // ── S2 — Files tab: list the touched files + open a reviewable diff for a selected file ──

  it('Files tab lists the file_touched events with a change badge', async () => {
    render(<ClaudeCodePanel />);

    // Seed the stream (the sample carries a `file_touched` event with before/after content).
    fireEvent.click(screen.getByTestId('cc-apply-sample'));
    await screen.findByTestId('cc-activity-list');

    fireEvent.click(screen.getByTestId('panel-segnav-files'));

    const list = screen.getByTestId('cc-files-list');
    expect(list).toBeTruthy();

    // Every file_touched event in the parsed sample appears as a row.
    const files = parseClaudeCodeStream(SAMPLE_ACTIVITY_STREAM).filter((e) => e.kind === 'file_touched');
    const rows = list.querySelectorAll('[data-testid^="cc-file-"]');
    expect(rows.length).toBe(files.length);
    expect(rows.length).toBeGreaterThan(0);

    // The first touched file's path + its change badge render.
    expect(screen.getAllByText('src/App.tsx').length).toBeGreaterThan(0);
    expect(screen.getByTestId('cc-file-0').getAttribute('data-change')).toBe('edit');
  });

  it('opens a reviewable per-file DIFF (reusing the editor diff renderer) for the selected file', async () => {
    render(<ClaudeCodePanel />);

    fireEvent.click(screen.getByTestId('cc-apply-sample'));
    await screen.findByTestId('cc-activity-list');

    fireEvent.click(screen.getByTestId('panel-segnav-files'));
    // Select the first file.
    fireEvent.click(screen.getByTestId('cc-file-0'));

    const diff = screen.getByTestId('cc-file-diff');
    expect(diff).toBeTruthy();
    expect(screen.getByTestId('cc-file-diff-path').textContent).toBe('src/App.tsx');

    // The sample's before/after differ, so the reused diffLines renderer emits add + remove rows.
    const addRows = diff.querySelectorAll('[data-diff-kind="add"]');
    const removeRows = diff.querySelectorAll('[data-diff-kind="remove"]');
    expect(addRows.length).toBeGreaterThan(0);
    expect(removeRows.length).toBeGreaterThan(0);
    // The new hero copy is on an added line.
    expect(diff.textContent).toContain('Welcome home');
  });

  // ── S3/S4 — Tests + Deploy tabs render their already-defined events ──

  it('Tests tab renders test_result events with a pass/fail summary', async () => {
    render(<ClaudeCodePanel />);

    fireEvent.click(screen.getByTestId('cc-apply-sample'));
    await screen.findByTestId('cc-activity-list');

    fireEvent.click(screen.getByTestId('panel-segnav-tests'));

    expect(screen.getByTestId('cc-tests-summary')).toBeTruthy();
    expect(screen.getByText('homepage renders')).toBeTruthy();
  });

  it('Deploy tab renders the latest deploy_state', async () => {
    render(<ClaudeCodePanel />);

    fireEvent.click(screen.getByTestId('cc-apply-sample'));
    await screen.findByTestId('cc-activity-list');

    fireEvent.click(screen.getByTestId('panel-segnav-deploy'));

    const latest = screen.getByTestId('cc-deploy-latest');
    expect(latest).toBeTruthy();
    expect(latest.getAttribute('data-state')).toBe('deployed');
  });

  // ── S5 — the RUN LIFECYCLE: current-task header, stop/cancel, timeline ──

  /**
   * A tiny controllable stream fixture: `fetch` resolves with a body whose reader yields the
   * queued chunks, then (optionally) blocks on a never-resolving read so the run stays `running`
   * until the test either pushes a final chunk or aborts it. Drives the lifecycle deterministically
   * without a real network.
   */
  function makeStreamResponse() {
    let pushChunk!: (text: string) => void;
    let closeStream!: () => void;
    const pending: string[] = [];
    let resolveRead: ((r: { value?: Uint8Array; done: boolean }) => void) | null = null;
    let aborted = false;

    const enc = new TextEncoder();
    const deliver = () => {
      if (resolveRead && (pending.length > 0 || aborted)) {
        const fn = resolveRead;
        resolveRead = null;

        if (pending.length > 0) {
          fn({ value: enc.encode(pending.shift()!), done: false });
        } else {
          fn({ value: undefined, done: true });
        }
      }
    };

    pushChunk = (text: string) => {
      pending.push(text);
      deliver();
    };
    closeStream = () => {
      aborted = true;
      deliver();
    };

    const reader = {
      read: () =>
        new Promise<{ value?: Uint8Array; done: boolean }>((resolve) => {
          resolveRead = resolve;
          deliver();
        }),
      cancel: vi.fn(),
    };

    const body = { getReader: () => reader };
    const signalAbort = () => {
      aborted = true;
      deliver();
    };

    return { response: { ok: true, status: 200, body }, pushChunk, closeStream, signalAbort };
  }

  it('run: idle → running shows the current task in the header; → done on stream close (running→done)', async () => {
    const fixture = makeStreamResponse();
    const fetchSpy = vi.fn().mockResolvedValue(fixture.response);
    vi.stubGlobal('fetch', fetchSpy);

    render(<ClaudeCodePanel />);

    const input = screen.getByTestId('cc-prompt-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Add a bold hero headline' } });
    fireEvent.click(screen.getByTestId('cc-run-button'));

    // Current-task affordance appears in the header: the prompt summary + a RUNNING status.
    const status = await screen.findByTestId('cc-run-status');
    expect(status.getAttribute('data-status')).toBe('running');
    expect(screen.getByTestId('cc-current-task-summary').textContent).toContain('Add a bold hero headline');
    // The POST went to the existing streaming path.
    expect(fetchSpy).toHaveBeenCalledWith('/api/llmcall', expect.objectContaining({ method: 'POST' }));

    // Stream one event line then close → the machine finishes.
    fixture.pushChunk('{"kind":"action","label":"Edited src/App.tsx"}\n');
    fixture.closeStream();

    await waitFor(() => expect(screen.getByTestId('cc-run-status').getAttribute('data-status')).toBe('done'));
    // The finishing timeline beat is rendered in the Activity log.
    expect(screen.getByTestId('cc-timeline-finished')).toBeTruthy();
  });

  it('run: running → error when the stream read rejects (running→error)', async () => {
    const reader = { read: () => Promise.reject(new Error('stream exploded')), cancel: vi.fn() };
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, body: { getReader: () => reader } });
    vi.stubGlobal('fetch', fetchSpy);

    render(<ClaudeCodePanel />);

    fireEvent.change(screen.getByTestId('cc-prompt-input'), { target: { value: 'break it' } });
    fireEvent.click(screen.getByTestId('cc-run-button'));

    await waitFor(() => expect(screen.getByTestId('cc-run-status').getAttribute('data-status')).toBe('error'));
    expect(screen.getByTestId('cc-timeline-failed')).toBeTruthy();
    // The error surfaces to the user.
    expect(screen.getByTestId('cc-error').textContent).toContain('stream exploded');
  });

  it('stop: running → stop → cancelled, aborts the stream (AbortController called) and stops rendering', async () => {
    const fixture = makeStreamResponse();
    const abortSpy = vi.fn();
    // Spy on AbortController.abort so we can PROVE the stop control aborts the in-flight fetch.
    const realAbort = AbortController.prototype.abort;
    AbortController.prototype.abort = function patchedAbort(this: AbortController, ...args: unknown[]) {
      abortSpy();
      fixture.signalAbort();
      return (realAbort as (...a: unknown[]) => void).apply(this, args);
    };

    try {
      const fetchSpy = vi.fn().mockResolvedValue(fixture.response);
      vi.stubGlobal('fetch', fetchSpy);

      render(<ClaudeCodePanel />);

      fireEvent.change(screen.getByTestId('cc-prompt-input'), { target: { value: 'long task' } });
      fireEvent.click(screen.getByTestId('cc-run-button'));

      // Running → the Stop control is present.
      const stop = await screen.findByTestId('cc-stop-button');
      fireEvent.click(stop);

      // The machine is cancelled ("Stopped") and the fetch was aborted.
      await waitFor(() => expect(screen.getByTestId('cc-run-status').getAttribute('data-status')).toBe('cancelled'));
      expect(abortSpy).toHaveBeenCalled();
      // The cancelled timeline beat renders; the Stop control is gone (no longer running).
      expect(screen.getByTestId('cc-timeline-cancelled')).toBeTruthy();
      expect(screen.queryByTestId('cc-stop-button')).toBeNull();

      // A late chunk arriving after the abort must NOT add an event row (rendering stopped).
      const before = screen.queryAllByTestId(/^cc-event-/).length;
      fixture.pushChunk('{"kind":"action","label":"should not render"}\n');
      await Promise.resolve();
      expect(screen.queryAllByTestId(/^cc-event-/).length).toBe(before);
      expect(screen.queryByText('should not render')).toBeNull();
    } finally {
      AbortController.prototype.abort = realAbort;
    }
  });

  it('timeline: the Activity tab interleaves lifecycle beats with event rows', async () => {
    const fixture = makeStreamResponse();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fixture.response));

    render(<ClaudeCodePanel />);

    fireEvent.change(screen.getByTestId('cc-prompt-input'), { target: { value: 'do a thing' } });
    fireEvent.click(screen.getByTestId('cc-run-button'));

    // The opening `started` beat renders as soon as the run begins (before any event).
    await screen.findByTestId('cc-timeline-started');

    fixture.pushChunk('{"kind":"decision","label":"Chose the simplest edit"}\n');
    fixture.closeStream();

    await screen.findByTestId('cc-timeline-finished');

    const list = screen.getByTestId('cc-activity-list');
    const kinds = Array.from(list.children).map((el) => el.getAttribute('data-testid'));
    // Order: started beat → the event row → finished beat (the run as a story).
    expect(kinds[0]).toBe('cc-timeline-started');
    expect(kinds.some((k) => k?.startsWith('cc-event-'))).toBe(true);
    expect(kinds[kinds.length - 1]).toBe('cc-timeline-finished');
  });

  it('shows the idle launchpad ("Describe a change to start") and no current-task header when idle', () => {
    render(<ClaudeCodePanel />);

    expect(screen.getByText('Describe a change to start')).toBeTruthy();
    // No run yet → the header current-task affordance is absent (clean header).
    expect(screen.queryByTestId('cc-current-task')).toBeNull();
    expect(screen.queryByTestId('cc-run-status')).toBeNull();
  });

  // ── S6-b-ii / S7 — RESOLUTION mode: the "Single | Resolution" toggle + the PS_RESOLVE bridge ──
  //
  // S7 live-fix: Resolution runs `/api/resolve` THROUGH the admin `PS_RESOLVE` bridge
  // (`requestResolve`), NOT a relative `fetch` (which 404s from the editor origin). These tests mock
  // `requestResolve` at that boundary and assert the panel renders legs+synthesis on a success reply,
  // and the calm "unavailable → Single" state on a `dark` reply (never an error).

  /** The admin bridge reply for a successful resolve: `ok:true` + the worker's top-level body. */
  const RESOLVE_OK = {
    research: [
      { provider: 'openai', ok: true, model: 'gpt-5', content: 'OpenAI research briefing on the subject.' },
      {
        provider: 'anthropic',
        ok: true,
        model: 'claude-fable-5',
        content: 'Anthropic research briefing on the subject.',
      },
    ],
    synthesis: {
      provider: 'anthropic',
      model: 'claude-fable-5',
      content: 'The combined, synthesized answer reconciling both briefings.',
    },
  };

  /** Build the admin's `PS_RESOLVE_RESPONSE` reply shape `requestResolve` resolves with. */
  function resolveReply(body: { research?: unknown; synthesis?: unknown }) {
    return { type: 'PS_RESOLVE_RESPONSE', ok: true, research: body.research, synthesis: body.synthesis };
  }

  it('renders the Single | Resolution mode toggle, Single active by default', () => {
    render(<ClaudeCodePanel />);

    const toggle = screen.getByTestId('cc-mode-toggle');
    expect(toggle).toBeTruthy();
    expect(toggle.getAttribute('role')).toBe('radiogroup');

    const single = screen.getByTestId('cc-mode-single');
    const resolution = screen.getByTestId('cc-mode-resolution');
    expect(single.getAttribute('aria-checked')).toBe('true');
    expect(resolution.getAttribute('aria-checked')).toBe('false');
    // Resolution starts optimistically enabled (availability is probed on first run).
    expect((resolution as HTMLButtonElement).disabled).toBe(false);
  });

  it('Resolution run: calls requestResolve (the admin bridge) and renders BOTH research legs + the synthesis', async () => {
    requestResolveSpy.mockResolvedValue(resolveReply(RESOLVE_OK));

    render(<ClaudeCodePanel />);

    // Switch to Resolution mode, then run.
    fireEvent.click(screen.getByTestId('cc-mode-resolution'));
    expect(screen.getByTestId('cc-mode-resolution').getAttribute('aria-checked')).toBe('true');

    fireEvent.change(screen.getByTestId('cc-prompt-input'), { target: { value: 'research Acme Co' } });
    fireEvent.click(screen.getByTestId('cc-run-button'));

    // The run went THROUGH the admin bridge (NOT a relative fetch) with the trimmed prompt.
    await waitFor(() => expect(requestResolveSpy).toHaveBeenCalled());
    expect(requestResolveSpy).toHaveBeenCalledWith('research Acme Co');

    // Both research legs render, provider-labelled, with their models. (Scope to the legs
    // container — "Anthropic" also appears in the synthesis card, so `screen.getByText` would be
    // ambiguous.)
    const legs = await screen.findByTestId('cc-research-legs');
    expect(legs.querySelectorAll('[data-testid^="cc-research-leg-"]').length).toBe(2);
    expect(legs.textContent).toContain('OpenAI');
    expect(legs.textContent).toContain('Anthropic');
    expect(legs.textContent).toContain('OpenAI research briefing on the subject.');
    expect(legs.textContent).toContain('Anthropic research briefing on the subject.');

    // The emphasized synthesis renders the combined answer; the machine is done.
    const synthesis = screen.getByTestId('cc-synthesis');
    expect(synthesis.getAttribute('data-ok')).toBe('true');
    expect(screen.getByText('The combined, synthesized answer reconciling both briefings.')).toBeTruthy();
    expect(screen.getByTestId('cc-run-status').getAttribute('data-status')).toBe('done');
  });

  it('synthesis-failed marker: renders the legs + a calm "unavailable" note, NOT an error', async () => {
    requestResolveSpy.mockResolvedValue(
      resolveReply({
        research: RESOLVE_OK.research,
        synthesis: { ok: false, reason: 'the synthesis model timed out' },
      }),
    );

    render(<ClaudeCodePanel />);

    fireEvent.click(screen.getByTestId('cc-mode-resolution'));
    fireEvent.change(screen.getByTestId('cc-prompt-input'), { target: { value: 'research with bad synth' } });
    fireEvent.click(screen.getByTestId('cc-run-button'));

    // The legs still render (research is valuable).
    const legs = await screen.findByTestId('cc-research-legs');
    expect(legs.querySelectorAll('[data-testid^="cc-research-leg-"]').length).toBe(2);

    // A calm synthesis-unavailable note shows — the success synthesis card does NOT.
    const note = screen.getByTestId('cc-synthesis-unavailable');
    expect(note).toBeTruthy();
    expect(note.getAttribute('data-ok')).toBe('false');
    expect(screen.getByText(/Synthesis unavailable/i)).toBeTruthy();
    expect(screen.queryByTestId('cc-synthesis')).toBeNull();

    // Crucially NOT an error: the run finished `done`, and there's no error alert.
    expect(screen.getByTestId('cc-run-status').getAttribute('data-status')).toBe('done');
    expect(screen.queryByTestId('cc-error')).toBeNull();
  });

  it('renders a DOWN research leg (one provider unavailable) with its reason, not an error', async () => {
    requestResolveSpy.mockResolvedValue(
      resolveReply({
        research: [
          RESOLVE_OK.research[0],
          { provider: 'anthropic', ok: false, reason: 'anthropic is not configured (no API key)' },
        ],
        synthesis: RESOLVE_OK.synthesis,
      }),
    );

    render(<ClaudeCodePanel />);

    fireEvent.click(screen.getByTestId('cc-mode-resolution'));
    fireEvent.change(screen.getByTestId('cc-prompt-input'), { target: { value: 'one leg down' } });
    fireEvent.click(screen.getByTestId('cc-run-button'));

    const legs = await screen.findByTestId('cc-research-legs');
    expect(legs.querySelectorAll('[data-testid^="cc-research-leg-"]').length).toBe(2);

    // The down leg is marked unavailable and surfaces its (safe) reason — still a `done` run.
    const downLeg = screen.getByTestId('cc-research-leg-1');
    expect(downLeg.getAttribute('data-ok')).toBe('false');
    expect(screen.getByText(/anthropic is not configured/i)).toBeTruthy();
    expect(screen.getByTestId('cc-run-status').getAttribute('data-status')).toBe('done');
  });

  it('dark reply (worker 404 relayed as dark:true) → Resolution unavailable (toggle disabled, snaps to Single, NO error)', async () => {
    // The admin bridge translates the worker's `resolution_engine` DARK-flag / foreign-site 404 into
    // `{ ok:false, dark:true }` — the panel must snap to Single CALMLY, never show an error.
    requestResolveSpy.mockResolvedValue({ type: 'PS_RESOLVE_RESPONSE', ok: false, dark: true });

    render(<ClaudeCodePanel />);

    // Choose Resolution and run — the bridge reply says dark.
    fireEvent.click(screen.getByTestId('cc-mode-resolution'));
    fireEvent.change(screen.getByTestId('cc-prompt-input'), { target: { value: 'try when dark' } });
    fireEvent.click(screen.getByTestId('cc-run-button'));

    await waitFor(() => expect(requestResolveSpy).toHaveBeenCalledWith('try when dark'));

    // The toggle's Resolution segment becomes disabled with an explanatory tooltip…
    await waitFor(() => {
      const resolution = screen.getByTestId('cc-mode-resolution') as HTMLButtonElement;
      expect(resolution.disabled).toBe(true);
    });
    const resolution = screen.getByTestId('cc-mode-resolution') as HTMLButtonElement;
    expect(resolution.getAttribute('aria-disabled')).toBe('true');
    expect((resolution.getAttribute('title') ?? '').toLowerCase()).toContain('unavailable');

    // …the panel snapped back to Single (always works)…
    expect(screen.getByTestId('cc-mode-single').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('cc-mode-toggle').getAttribute('data-mode')).toBe('single');

    // …and there is NO error toast/alert + NO resolution render (a dark feature isn't a failure).
    expect(screen.queryByTestId('cc-error')).toBeNull();
    expect(screen.queryByTestId('cc-resolution')).toBeNull();
    expect(screen.queryByTestId('cc-run-status')).toBeNull();
  });

  it('a genuine transport failure (ok:false, no dark) surfaces as a run error — NOT a silent snap', async () => {
    // Distinct from `dark`: a no-site / network / non-404 failure IS a real run failure. The panel
    // must show the error (not snap to Single), so the user knows the run did not complete.
    requestResolveSpy.mockResolvedValue({ type: 'PS_RESOLVE_RESPONSE', ok: false, error: 'No site selected' });

    render(<ClaudeCodePanel />);

    fireEvent.click(screen.getByTestId('cc-mode-resolution'));
    fireEvent.change(screen.getByTestId('cc-prompt-input'), { target: { value: 'no site' } });
    fireEvent.click(screen.getByTestId('cc-run-button'));

    await waitFor(() => expect(screen.getByTestId('cc-run-status').getAttribute('data-status')).toBe('error'));
    expect(screen.getByTestId('cc-timeline-failed')).toBeTruthy();
    expect(screen.getByTestId('cc-error').textContent).toContain('No site selected');
    // It did NOT snap to Single or mark Resolution unavailable (that's reserved for `dark`).
    expect(screen.getByTestId('cc-mode-toggle').getAttribute('data-mode')).toBe('resolution');
  });

  it('Single mode still streams /api/llmcall and is unaffected by Resolution', async () => {
    const fixture = makeStreamResponse();
    const fetchSpy = vi.fn().mockResolvedValue(fixture.response);
    vi.stubGlobal('fetch', fetchSpy);

    render(<ClaudeCodePanel />);

    // Default is Single — run without touching the toggle.
    fireEvent.change(screen.getByTestId('cc-prompt-input'), { target: { value: 'add a hero' } });
    fireEvent.click(screen.getByTestId('cc-run-button'));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith('/api/llmcall', expect.objectContaining({ method: 'POST' })),
    );

    fixture.pushChunk('{"kind":"action","label":"Edited src/App.tsx"}\n');
    fixture.closeStream();

    await waitFor(() => expect(screen.getByTestId('cc-run-status').getAttribute('data-status')).toBe('done'));
    // Single renders the Activity list (no resolution view).
    expect(screen.getByTestId('cc-activity-list')).toBeTruthy();
    expect(screen.queryByTestId('cc-resolution')).toBeNull();
  });
});

// ── STREAM-RESOLVE — the CINEMATIC in-flight staged progress (kills the dead 24s spinner) ──
//
// While `requestResolve` is awaiting the ~24-27s bridge reply, the panel shows the staged-progress
// view instead of a dead spinner. These tests hold `requestResolve` on a DEFERRED promise (so the run
// stays `running`), then use fake timers to advance elapsed and PROVE the phases advance on schedule,
// the final phase HOLDS on a slow return (never claiming completion), and reduced-motion renders the
// static branch. Fake timers also fake `Date.now()`, so the component's `Date.now() - startedAt`
// elapsed tracks the advanced time exactly. Isolated in its own describe so the timer setup is scoped.

describe('ClaudeCodePanel — Resolution staged progress (STREAM-RESOLVE)', () => {
  /** A hand-resolved promise so we can keep the Resolution run in-flight for as long as the test wants. */
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });

    return { promise, resolve };
  }

  /** Install a matchMedia stub reporting the given reduced-motion preference (jsdom lacks it). */
  function stubReducedMotion(reduce: boolean) {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('prefers-reduced-motion') ? reduce : false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
  }

  beforeEach(() => {
    createFileSpy.mockReset().mockResolvedValue(true);
    requestResolveSpy.mockReset();
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    cleanup();
    vi.unstubAllGlobals();
  });

  /** Enter Resolution mode + submit a prompt; the deferred keeps the run in-flight. */
  function startResolution() {
    fireEvent.click(screen.getByTestId('cc-mode-resolution'));
    fireEvent.change(screen.getByTestId('cc-prompt-input'), { target: { value: 'research Acme Co' } });
    fireEvent.click(screen.getByTestId('cc-run-button'));
  }

  it('shows the cinematic staged-progress view (NOT a bare spinner) while the bridge call is in flight', () => {
    stubReducedMotion(false);
    requestResolveSpy.mockReturnValue(deferred().promise);

    render(<ClaudeCodePanel />);
    startResolution();

    // The staged-progress view is up — the old static "cc-loading" spinner is NOT used for Resolution.
    const progress = screen.getByTestId('cc-resolution-progress');
    expect(progress).toBeTruthy();
    expect(progress.getAttribute('role')).toBe('status');
    expect(screen.queryByTestId('cc-loading')).toBeNull();

    // Phase 1 is active at t=0, with the live elapsed clock + an honest step rail.
    expect(progress.getAttribute('data-phase-index')).toBe('0');
    expect(screen.getByTestId('cc-resolution-phase-label').textContent).toMatch(/pass 1/i);
    expect(screen.getByTestId('cc-resolution-steps').children.length).toBeGreaterThanOrEqual(3);
  });

  it('advances the phase labels on the ~24s schedule as time elapses', () => {
    stubReducedMotion(false);
    requestResolveSpy.mockReturnValue(deferred().promise);

    render(<ClaudeCodePanel />);
    startResolution();

    const progress = screen.getByTestId('cc-resolution-progress');
    const label = () => screen.getByTestId('cc-resolution-phase-label').textContent ?? '';

    // t≈0 → pass 1.
    expect(label()).toMatch(/pass 1/i);

    // Advance past the pass-2 boundary (8s) → pass 2.
    act(() => {
      vi.advanceTimersByTime(9_000);
    });
    expect(progress.getAttribute('data-phase-index')).toBe('1');
    expect(label()).toMatch(/pass 2/i);

    // Advance past the synthesis boundary (16s) → synthesizing.
    act(() => {
      vi.advanceTimersByTime(8_000);
    });
    expect(progress.getAttribute('data-phase-index')).toBe('2');
    expect(label()).toMatch(/synthesi/i);
  });

  it('HOLDS on the final "Synthesizing…" phase for a SLOW return — elapsed keeps ticking, never claims completion', () => {
    stubReducedMotion(false);
    // The promise NEVER resolves within the test window → simulate a call slower than the ~24s cadence.
    requestResolveSpy.mockReturnValue(deferred().promise);

    render(<ClaudeCodePanel />);
    startResolution();

    const progress = screen.getByTestId('cc-resolution-progress');
    const label = () => screen.getByTestId('cc-resolution-phase-label').textContent ?? '';

    // Advance WELL past the ~24s expected cadence (e.g. a slow fallback or premium dual-frontier path).
    act(() => {
      vi.advanceTimersByTime(45_000);
    });

    // Still on the LAST phase — held, not advanced past, and NOT claiming the run finished.
    expect(progress.getAttribute('data-phase-index')).toBe('2');
    expect(label()).toMatch(/synthesi/i);
    expect(label().toLowerCase()).not.toMatch(/done|complete|finished|ready/);
    // The run machine is STILL running (the deferred never resolved) — no false "done".
    expect(screen.getByTestId('cc-run-status').getAttribute('data-status')).toBe('running');
    // The staged view is still mounted (no premature switch to the result view).
    expect(screen.queryByTestId('cc-resolution')).toBeNull();
  });

  it('reduced-motion: renders the static current-phase text + elapsed, NO pulsing step animation', () => {
    stubReducedMotion(true);
    requestResolveSpy.mockReturnValue(deferred().promise);

    render(<ClaudeCodePanel />);
    startResolution();

    const progress = screen.getByTestId('cc-resolution-progress');
    // The resolved preference is reflected for audits + the static branch is chosen.
    expect(progress.getAttribute('data-reduced-motion')).toBe('true');

    // The phase text + step rail still render (information is never animation-gated)…
    expect(screen.getByTestId('cc-resolution-phase-label').textContent).toMatch(/pass 1/i);

    // …but NO step dot carries the pulse animation class (static under reduced-motion).
    const steps = screen.getByTestId('cc-resolution-steps');
    for (const dot of Array.from(steps.children)) {
      expect(dot.className).not.toContain('animate-pulse');
    }

    // Phases STILL advance (the clock/text is information, not decoration) — just without motion.
    act(() => {
      vi.advanceTimersByTime(9_000);
    });
    expect(progress.getAttribute('data-phase-index')).toBe('1');
    expect(screen.getByTestId('cc-resolution-phase-label').textContent).toMatch(/pass 2/i);
  });

  it('a successful reply still swaps the staged view for the resolution result (fast-return safe)', async () => {
    stubReducedMotion(false);
    const d = deferred<ReturnType<typeof resolveReplyOk>>();
    requestResolveSpy.mockReturnValue(d.promise);

    render(<ClaudeCodePanel />);
    startResolution();

    // In-flight → staged progress is up.
    expect(screen.getByTestId('cc-resolution-progress')).toBeTruthy();

    // Resolve the bridge call → the staged view is REPLACED by the legs+synthesis (never stuck).
    await act(async () => {
      d.resolve(resolveReplyOk());
      await Promise.resolve();
    });

    expect(screen.queryByTestId('cc-resolution-progress')).toBeNull();
    expect(screen.getByTestId('cc-resolution')).toBeTruthy();
    expect(screen.getByTestId('cc-run-status').getAttribute('data-status')).toBe('done');
  });
});

/** A standalone success reply (the module-scope RESOLVE_OK lives inside the other describe). */
function resolveReplyOk() {
  return {
    type: 'PS_RESOLVE_RESPONSE' as const,
    ok: true as const,
    research: [{ provider: 'openai', ok: true, model: 'gpt-5', content: 'A briefing.' }],
    synthesis: { provider: 'anthropic', model: 'claude-fable-5', content: 'The synthesized answer.' },
  };
}
