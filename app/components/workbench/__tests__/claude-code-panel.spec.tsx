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

  it('switches to a roadmap tab and shows a coming-soon launchpad (never a blank body)', () => {
    render(<ClaudeCodePanel />);

    fireEvent.click(screen.getByTestId('panel-segnav-files'));
    expect(screen.getByTestId('cc-tab-coming-soon')).toBeTruthy();
  });
});
