// @vitest-environment jsdom
/**
 * SqlNavigator.spec.tsx — WLK-05 (fire-68): SQL-console readability.
 *
 * Part 1 — PRESET POPULATE-BEFORE-RUN. When the user clicks a SQL preset (a "Starter" or the
 * "New table" template), the preset SQL must VISIBLY land in the editor textarea FIRST and must
 * NOT auto-execute. The user has to SEE the SQL, then press Run. (The old behaviour set the value
 * and fired `requestDbQuery` in the same click, so the SQL never visibly landed before running.)
 *
 * Part 2 — AA CONTRAST. The small informational labels (the "Starters" eyebrow, the SQL field
 * label) must NOT use the AA-failing muted token `text-bolt-elements-textTertiary` — on the
 * editor's dark theme that token resolves to `rgba(244,244,255,.4)` ≈ 3.5:1, below WCAG AA 4.5:1.
 * They must use a contrast-safe brand token (`textSecondary` ≈ 7.8:1 or `item-contentAccent`
 * ≈ 13:1 on `#060610`). We assert the rendered class, not a screenshot.
 *
 * Mocks mirror DatabasePanel.spec — the embed bridge is stubbed; `requestDbQuery` is a spy so we
 * can prove it is (not) called. `SqlEditor` renders a real `<textarea>` (testId passthrough).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import React from 'react';

// ─── Embed bridge mock ───────────────────────────────────────────────────────────
const { postToParentSpy, onParentMessageSpy, requestDbQuerySpy, parentHandlers } = vi.hoisted(() => {
  const parentHandlers = new Set<(msg: unknown) => void>();
  return {
    parentHandlers,
    postToParentSpy: vi.fn(),
    onParentMessageSpy: vi.fn((handler: (msg: unknown) => void) => {
      parentHandlers.add(handler);
      return () => {
        parentHandlers.delete(handler);
      };
    }),
    // A pending promise that never resolves in these cases — we only assert whether it was CALLED.
    requestDbQuerySpy: vi.fn(() => new Promise(() => {})),
  };
});

vi.mock('~/lib/embed/embedded-mode', () => ({
  isEmbedded: true,
  postToParent: postToParentSpy,
  postToastToParent: vi.fn(),
  onParentMessage: onParentMessageSpy,
  requestDbQuery: requestDbQuerySpy,
}));

// ─── Import AFTER mocks ───────────────────────────────────────────────────────────
import { SqlNavigator } from '~/components/workbench/SqlNavigator';

// localStorage stub (history/saved buckets) — deterministic + no SSR throw.
let store: Record<string, string> = {};

beforeEach(() => {
  store = {};
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = String(v);
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      store = {};
    },
  });
  postToParentSpy.mockClear();
  requestDbQuerySpy.mockClear();
  parentHandlers.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SqlNavigator — WLK-05 preset populate-before-run', () => {
  it('a Starter preset VISIBLY fills the SQL editor and does NOT auto-run', () => {
    render(<SqlNavigator />);

    const starters = screen.getAllByTestId('database-sql-starter');
    expect(starters.length).toBeGreaterThan(0);

    const textareaBefore = screen.getByTestId('database-sql-textarea') as HTMLTextAreaElement;
    expect(textareaBefore.value).toBe('');

    act(() => {
      fireEvent.click(starters[0]);
    });

    // The preset SQL must be VISIBLE in the editor value (populate-before-run).
    const textarea = screen.getByTestId('database-sql-textarea') as HTMLTextAreaElement;
    expect(textarea.value.length).toBeGreaterThan(0);
    expect(textarea.value.toUpperCase()).toContain('SELECT');

    // And it must NOT have executed — the user has to SEE it, then press Run.
    expect(requestDbQuerySpy).not.toHaveBeenCalled();
  });

  it('pressing Run AFTER a preset fills the editor executes exactly that SQL once', () => {
    render(<SqlNavigator />);

    const starters = screen.getAllByTestId('database-sql-starter');
    act(() => {
      fireEvent.click(starters[0]);
    });

    const textarea = screen.getByTestId('database-sql-textarea') as HTMLTextAreaElement;
    const populated = textarea.value;
    expect(requestDbQuerySpy).not.toHaveBeenCalled();

    const runBtn = screen.getByTestId('database-sql-run');
    act(() => {
      fireEvent.click(runBtn);
    });

    expect(requestDbQuerySpy).toHaveBeenCalledTimes(1);
    expect(requestDbQuerySpy).toHaveBeenCalledWith({ sql: populated.trim() });
  });

  it('the "New table" template fills the editor and does NOT auto-run', () => {
    render(<SqlNavigator />);

    act(() => {
      fireEvent.click(screen.getByTestId('database-sql-new-table'));
    });

    const textarea = screen.getByTestId('database-sql-textarea') as HTMLTextAreaElement;
    expect(textarea.value.toUpperCase()).toContain('CREATE TABLE');
    expect(requestDbQuerySpy).not.toHaveBeenCalled();
  });
});

describe('SqlNavigator — WLK-05 AA contrast (brand tokens, no opacity-muted token)', () => {
  /**
   * `text-bolt-elements-textTertiary` resolves to `rgba(244,244,255,.4)` (≈3.5:1) on the editor's
   * dark theme — below WCAG AA 4.5:1 for small text. Informational labels must use a contrast-safe
   * token instead. We assert on the rendered class list.
   */
  const AA_FAIL = 'text-bolt-elements-textTertiary';
  const AA_SAFE = /text-bolt-elements-(textSecondary|item-contentAccent)/;

  it('the "Starters" eyebrow label clears AA (not the muted-tertiary token)', () => {
    render(<SqlNavigator />);
    const label = screen.getByText('Starters');
    expect(label.className).not.toContain(AA_FAIL);
    expect(label.className).toMatch(AA_SAFE);
  });

  it('the SQL field label clears AA (not the muted-tertiary token)', () => {
    render(<SqlNavigator />);
    const label = document.querySelector('label[for="database-sql-input"]') as HTMLElement;
    expect(label).toBeTruthy();
    expect(label.className).not.toContain(AA_FAIL);
    expect(label.className).toMatch(AA_SAFE);
  });

  it('the saved + history rail empty-state hints clear AA (not the muted-tertiary token)', () => {
    render(<SqlNavigator />);
    for (const id of ['database-sql-saved-empty', 'database-sql-history-empty']) {
      const hint = screen.getByTestId(id);
      expect(hint.className, id).not.toContain(AA_FAIL);
      expect(hint.className, id).toMatch(AA_SAFE);
    }
  });
});
