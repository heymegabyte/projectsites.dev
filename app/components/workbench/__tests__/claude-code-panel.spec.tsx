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
});
