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
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
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

import { ClaudeCodePanel, SAMPLE_ACTIVITY_STREAM } from '../ClaudeCodePanel';
import { parseClaudeCodeStream, FORBIDDEN_EVENT_KINDS } from '../claude-code-stream';

beforeEach(() => {
  createFileSpy.mockReset();
  createFileSpy.mockResolvedValue(true);
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
});
