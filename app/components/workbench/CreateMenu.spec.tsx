// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

/*
 * Isolate the heavy workbench/WebContainer singleton chain — we test the control,
 * not the store. Full menu-open + createFile dispatch is covered by E2E; the intent
 * classification + scaffold logic is covered by create-intents.test.ts.
 * `vi.mock` factories are hoisted above the module body, so the spies they close
 * over must be hoisted too — a plain `const` here throws
 * "Cannot access 'createFile' before initialization".
 */
const { createFile, viewSet } = vi.hoisted(() => ({
  createFile: vi.fn(async () => true),
  viewSet: vi.fn(),
}));
vi.mock('~/lib/stores/workbench', () => ({
  workbenchStore: { createFile, currentView: { set: viewSet } },
}));
vi.mock('~/utils/constants', () => ({ WORK_DIR: '/home/project' }));

import { CreateMenu } from './CreateMenu';

describe('CreateMenu', () => {
  beforeEach(() => {
    cleanup();
    createFile.mockClear();
    viewSet.mockClear();
  });

  it('renders an accessible, keyboard-operable Create trigger', () => {
    render(<CreateMenu />);

    const btn = screen.getByTestId('workbench-create-menu-trigger');
    expect(btn).toBeTruthy();

    // A real <button> → focusable + Enter/Space-activatable for keyboard users.
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.textContent).toContain('Create');

    // aria-label describes every action for screen readers.
    expect((btn.getAttribute('aria-label') ?? '').toLowerCase()).toContain('endpoint');
  });

  it('does not eagerly render the menu items (dropdown is closed until opened)', () => {
    render(<CreateMenu />);

    // Radix keeps the menu content out of the DOM until the trigger opens it.
    expect(screen.queryByText('Add Function')).toBeNull();
    expect(createFile).not.toHaveBeenCalled();
  });
});
