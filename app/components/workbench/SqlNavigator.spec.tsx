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
 * Part 3 — LABEL↔CONTROL ASSOCIATION (fire-70, WLK-05 a11y follow-up). The visible SQL field
 * `<label htmlFor="database-sql-input">` must point at a REAL focusable control — otherwise it is
 * an orphan label and a screen reader announces nothing when the SQL textarea is focused (WCAG
 * 1.3.1 Info & Relationships / 4.1.2 Name·Role·Value, both AA-relevant). The SqlEditor textarea
 * must carry `id="database-sql-input"` so the label resolves to it.
 *
 * Part 4 — COMPUTED-CONTRAST REGRESSION (fire-70). Part 2 asserts the classNAME, which stays green
 * even if someone lowers the alpha on the brand token in `app/styles/index.scss` — the AA guarantee
 * would silently regress (per `verify-against-source-of-truth`). This part reads the ACTUAL token
 * values from `index.scss`, composites each alpha ink over the real panel background `#060610`, and
 * asserts the measured WCAG ratio: `textSecondary` ≥ 4.5:1 (the token the panel now uses) AND the
 * old `textTertiary` is genuinely < 4.5:1 (proving the swap was necessary, not cosmetic).
 *
 * Mocks mirror DatabasePanel.spec — the embed bridge is stubbed; `requestDbQuery` is a spy so we
 * can prove it is (not) called. `SqlEditor` renders a real `<textarea>` (testId passthrough).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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

describe('SqlNavigator — WLK-05 label↔control association (fire-70 a11y nit)', () => {
  it('the SQL field label resolves to the real editor textarea (not an orphan label)', () => {
    render(<SqlNavigator />);

    const label = document.querySelector('label[for="database-sql-input"]') as HTMLLabelElement | null;
    expect(label, 'the visible SQL label must exist').toBeTruthy();

    // The label's `for` must point at a REAL control in the DOM — else it announces nothing.
    const target = document.getElementById('database-sql-input');
    expect(target, 'label[for="database-sql-input"] must resolve to a real element').toBeTruthy();

    // And that control must be the SQL editor textarea the user types into.
    const textarea = screen.getByTestId('database-sql-textarea');
    expect(target).toBe(textarea);
    expect(target?.tagName).toBe('TEXTAREA');
  });
});

describe('SqlNavigator — WLK-05 computed-contrast regression (reads the real brand tokens)', () => {
  /**
   * Parse the actual token values from `app/styles/index.scss` so this test fails if the brand
   * override's alpha is ever lowered below AA — the className assertions above cannot catch that.
   */
  const here = dirname(fileURLToPath(import.meta.url));
  const scss = readFileSync(resolve(here, '../../styles/index.scss'), 'utf8');

  const PANEL_BG: [number, number, number] = [6, 6, 16]; // #060610 — SqlNavigator root (bg-depth-1)

  function parseAlphaInk(token: string): { ink: [number, number, number]; alpha: number } {
    // Matches e.g. `--bolt-elements-textSecondary: rgba(244, 244, 255, 0.65);`
    const re = new RegExp(
      `--bolt-elements-${token}:\\s*rgba\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*([0-9.]+)\\s*\\)`,
    );
    const m = scss.match(re);

    if (!m) {
      throw new Error(`could not parse --bolt-elements-${token} as rgba() in index.scss`);
    }

    return { ink: [Number(m[1]), Number(m[2]), Number(m[3])], alpha: Number(m[4]) };
  }

  function lin(c: number): number {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }

  function luminance([r, g, b]: [number, number, number]): number {
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  function over(ink: [number, number, number], a: number, bg: [number, number, number]): [number, number, number] {
    return [
      Math.round(ink[0] * a + bg[0] * (1 - a)),
      Math.round(ink[1] * a + bg[1] * (1 - a)),
      Math.round(ink[2] * a + bg[2] * (1 - a)),
    ];
  }

  function ratioOnPanel(token: string): number {
    const { ink, alpha } = parseAlphaInk(token);
    const composited = over(ink, alpha, PANEL_BG);
    const l1 = luminance(composited);
    const l2 = luminance(PANEL_BG);
    const hi = Math.max(l1, l2);
    const lo = Math.min(l1, l2);

    return (hi + 0.05) / (lo + 0.05);
  }

  it('textSecondary (the token the panel uses) measures >= 4.5:1 on #060610', () => {
    const r = ratioOnPanel('textSecondary');
    expect(r).toBeGreaterThanOrEqual(4.5);
  });

  it('textTertiary (the retired token) genuinely FAILS AA — proving the swap was necessary', () => {
    const r = ratioOnPanel('textTertiary');
    expect(r).toBeLessThan(4.5);
  });
});
