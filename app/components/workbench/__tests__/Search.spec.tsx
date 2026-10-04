// @vitest-environment jsdom
/**
 * Search.spec.tsx — characterisation tests for the workbench file-search panel.
 *
 * Search.tsx is coupled to `workbenchStore`, `webcontainer` (Promise<WebContainer>),
 * and `debounce`. We mock them all so the component renders in jsdom without a
 * running WebContainer instance.
 *
 * Covers:
 *   1. groupResultsByFile logic — the pure grouping helper (not exported; inline copy).
 *   2. Smoke mount             — renders without throwing, shows the search input.
 *   3. Empty-input state       — no results text, no "Searching…" when query is blank.
 *   4. No-results state        — searching a query that returns no matches shows
 *      "No results found."
 *   5. Results state           — a non-empty results set shows file path entries.
 *   6. Keyboard type           — typing in the input updates the controlled value.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';

// ─── workbenchStore stub ──────────────────────────────────────────────────────
const { mockSetSelectedFile, mockSetCurrentDocumentScrollPosition } = vi.hoisted(() => ({
  mockSetSelectedFile: vi.fn(),
  mockSetCurrentDocumentScrollPosition: vi.fn(),
}));

vi.mock('~/lib/stores/workbench', () => ({
  workbenchStore: {
    setSelectedFile: mockSetSelectedFile,
    setCurrentDocumentScrollPosition: mockSetCurrentDocumentScrollPosition,
  },
}));

// ─── WORK_DIR constant ────────────────────────────────────────────────────────
vi.mock('~/utils/constants', () => ({
  WORK_DIR: '/home/project',
}));

// ─── debounce — execute the callback immediately so tests aren't timing-sensitive
vi.mock('~/utils/debounce', () => ({
  debounce: (fn: (...args: unknown[]) => unknown) => fn,
}));

// ─── webcontainer — a controlled stub that exposes internal.textSearch ────────
let textSearchImpl: (
  query: string,
  opts: unknown,
  progress: (filePath: string, matches: unknown[]) => void,
) => Promise<void> = async () => {};

vi.mock('~/lib/webcontainer', () => ({
  webcontainer: Promise.resolve({
    workdir: '/home/project',
    internal: {
      textSearch: async (
        query: string,
        opts: unknown,
        cb: (fp: string, m: unknown[]) => void,
      ) => textSearchImpl(query, opts, cb),
    },
    fs: {
      mkdir: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {}),
    },
  }),
}));

// ─── Component import ─────────────────────────────────────────────────────────
import { Search } from '../Search';

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no results.
  textSearchImpl = async () => {};
});

afterEach(() => cleanup());

// ── 1. groupResultsByFile logic (inline copy — pure helper not exported) ──────

interface DisplayMatch {
  path: string;
  lineNumber: number;
  previewText: string;
  matchCharStart: number;
  matchCharEnd: number;
}

function groupResultsByFile(results: DisplayMatch[]): Record<string, DisplayMatch[]> {
  return results.reduce(
    (acc, result) => {
      if (!acc[result.path]) {
        acc[result.path] = [];
      }

      acc[result.path].push(result);

      return acc;
    },
    {} as Record<string, DisplayMatch[]>,
  );
}

describe('groupResultsByFile (pure logic)', () => {
  it('groups results by file path', () => {
    const results: DisplayMatch[] = [
      { path: 'src/a.ts', lineNumber: 1, previewText: 'foo', matchCharStart: 0, matchCharEnd: 3 },
      { path: 'src/b.ts', lineNumber: 2, previewText: 'bar', matchCharStart: 0, matchCharEnd: 3 },
      { path: 'src/a.ts', lineNumber: 5, previewText: 'baz', matchCharStart: 0, matchCharEnd: 3 },
    ];
    const grouped = groupResultsByFile(results);
    expect(Object.keys(grouped)).toHaveLength(2);
    expect(grouped['src/a.ts']).toHaveLength(2);
    expect(grouped['src/b.ts']).toHaveLength(1);
  });

  it('returns an empty object for an empty results array', () => {
    expect(groupResultsByFile([])).toEqual({});
  });

  it('preserves order within each file group', () => {
    const results: DisplayMatch[] = [
      { path: 'x.ts', lineNumber: 10, previewText: 'first', matchCharStart: 0, matchCharEnd: 5 },
      { path: 'x.ts', lineNumber: 20, previewText: 'second', matchCharStart: 0, matchCharEnd: 6 },
    ];
    const grouped = groupResultsByFile(results);
    expect(grouped['x.ts'][0].lineNumber).toBe(10);
    expect(grouped['x.ts'][1].lineNumber).toBe(20);
  });
});

// ── 2. Smoke mount ────────────────────────────────────────────────────────────

describe('Search — smoke mount', () => {
  it('renders without throwing', () => {
    expect(() => render(<Search />)).not.toThrow();
  });

  it('renders the search input with placeholder "Search"', () => {
    render(<Search />);
    expect(screen.getByPlaceholderText('Search')).toBeInTheDocument();
  });
});

// ── 3. Empty-input state ──────────────────────────────────────────────────────

describe('Search — empty input state', () => {
  it('does not show "No results found." with an empty query', () => {
    render(<Search />);
    expect(screen.queryByText(/No results found/i)).not.toBeInTheDocument();
  });

  it('does not show "Searching…" with an empty query', () => {
    render(<Search />);
    expect(screen.queryByText(/Searching/i)).not.toBeInTheDocument();
  });
});

// ── 4. No-results state ───────────────────────────────────────────────────────

describe('Search — no-results state', () => {
  it('shows "No results found." when a search returns no matches', async () => {
    // textSearchImpl stays as default no-op — no progress callbacks fired.
    render(<Search />);

    const input = screen.getByPlaceholderText('Search');
    fireEvent.change(input, { target: { value: 'somethingnotinfiles' } });

    await waitFor(() =>
      expect(screen.getByText(/No results found\./i)).toBeInTheDocument(),
    );
  });
});

// ── 5. Results state ──────────────────────────────────────────────────────────

describe('Search — results state', () => {
  it('displays a file entry when the search returns a match', async () => {
    // Simulate one match in src/app.ts.
    textSearchImpl = async (_query, _opts, progress) => {
      progress('src/app.ts', [
        {
          preview: {
            text: 'const hello = "world";',
            matches: [{ startLineNumber: 1, startColumn: 6, endColumn: 11 }],
          },
          ranges: [{ startLineNumber: 1, startColumn: 6, endColumn: 11 }],
        },
      ]);
    };

    render(<Search />);

    const input = screen.getByPlaceholderText('Search');
    fireEvent.change(input, { target: { value: 'hello' } });

    // The file header renders the basename (file.split('/').pop()), so match "app.ts", not the full path.
    await waitFor(() => expect(screen.getByText(/app\.ts/)).toBeInTheDocument());
  });
});

// ── 6. Keyboard type ─────────────────────────────────────────────────────────

describe('Search — keyboard typing', () => {
  it('updates the input value as the user types', () => {
    render(<Search />);
    const input = screen.getByPlaceholderText('Search') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'component' } });
    expect(input.value).toBe('component');
  });

  it('clears results when the input is cleared back to empty', async () => {
    textSearchImpl = async (_query, _opts, progress) => {
      progress('file.ts', [
        {
          preview: { text: 'match', matches: [{ startLineNumber: 1, startColumn: 0, endColumn: 5 }] },
          ranges: [{ startLineNumber: 1, startColumn: 0, endColumn: 5 }],
        },
      ]);
    };

    render(<Search />);
    const input = screen.getByPlaceholderText('Search');

    fireEvent.change(input, { target: { value: 'match' } });
    await waitFor(() => expect(screen.getByText(/file\.ts/)).toBeInTheDocument());

    fireEvent.change(input, { target: { value: '' } });
    await waitFor(() => expect(screen.queryByText(/file\.ts/)).not.toBeInTheDocument());
  });
});
