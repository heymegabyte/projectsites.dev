// @vitest-environment jsdom
/**
 * AiSeedPanel.spec.tsx — characterization tests for the AI seed panel.
 *
 * States covered:
 *   1. LOADING            — tablesState:'loading' before any bridge reply → select absent.
 *   2. DISABLED           — reply enabled:false → "database isn't turned on yet" note.
 *   3. EMPTY-TABLES       — ok:true but zero tables → "Create a table first" empty state;
 *                           seed-empty-create-table button fires onCreateTable callback.
 *   4. READY (table list) — tables loaded → seed-table select present with options.
 *   5. TABLE SELECTED     — select change triggers PS_SITEDB_ROWS_REQUEST + shows seed-columns.
 *   6. GENERATING         — clicking seed-generate fires /api/llmcall + shows "Generating…".
 *   7. PREVIEW            — /api/llmcall resolves with rows → seed-preview-table visible.
 *   8. INSERT             — clicking seed-insert fires PS_RES_MUTATE_REQUEST with action:'exec'.
 *   9. SUCCESS            — exec reply ok:true → role=status success note; preview gone.
 *  10. GEN ERROR          — /api/llmcall returns error → role=alert shown.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import React from 'react';

// ─── Hoisted bridge spies + fetch stub ────────────────────────────────────────
const { postToParent, handlers, lastRequest, fetchMock } = vi.hoisted(() => {
  const handlers: Array<(msg: unknown) => void> = [];
  const lastRequest: { value: Record<string, unknown> | null } = { value: null };
  const postToParent = vi.fn((message: Record<string, unknown>) => {
    lastRequest.value = message;
  });
  const fetchMock = vi.fn();
  return { postToParent, handlers, lastRequest, fetchMock };
});

vi.mock('~/lib/embed/embedded-mode', () => ({
  isEmbedded: true,
  postToParent,
  postToastToParent: vi.fn(),
  onParentMessage: (fn: (msg: unknown) => void) => {
    handlers.push(fn);
    return () => {
      const i = handlers.indexOf(fn);
      if (i >= 0) handlers.splice(i, 1);
    };
  },
}));

vi.mock('~/utils/classNames', () => ({
  classNames: (...args: unknown[]) => args.filter((a) => typeof a === 'string').join(' '),
}));

vi.mock('~/utils/constants', () => ({
  DEFAULT_MODEL: 'claude-opus-4-6',
  DEFAULT_PROVIDER: 'Anthropic',
}));

// Stub panel primitives.
vi.mock('../panel', () => ({
  PanelShell: ({ children, testId }: { children: React.ReactNode; testId?: string }) =>
    React.createElement('div', { 'data-testid': testId ?? 'panel-shell' }, children),
  PanelHeader: ({ title }: { title: string }) =>
    React.createElement('div', { 'data-testid': 'panel-header' }, title),
  PanelEmpty: ({
    title,
    action,
  }: {
    title: string;
    description?: string;
    icon?: string;
    action?: React.ReactNode;
  }) => React.createElement('div', { 'data-testid': 'panel-empty' }, title, action),
}));

// Patch globalThis.fetch with our controllable mock.
vi.stubGlobal('fetch', fetchMock);

import { AiSeedPanel } from '../AiSeedPanel';

/** Deliver a typed reply to the last pending correlationId. */
function replyToLast(type: string, extra: Record<string, unknown>) {
  const cid = lastRequest.value?.correlationId as string | undefined;
  act(() => {
    for (const h of [...handlers]) {
      h({ type, correlationId: cid, ...extra });
    }
  });
}

/** Resolve the tables request with a list of table names. */
async function resolveTablesOk(tableNames: string[]) {
  await waitFor(() => expect(lastRequest.value?.type).toBe('PS_SITEDB_TABLES_REQUEST'));
  replyToLast('PS_SITEDB_TABLES_RESPONSE', {
    ok: true,
    tables: tableNames.map((n) => ({ name: n })),
  });
}

beforeEach(() => {
  postToParent.mockClear();
  fetchMock.mockClear();
  handlers.length = 0;
  lastRequest.value = null;
});

afterEach(() => cleanup());

// ─── 1. Loading state ────────────────────────────────────────────────────────

describe('AiSeedPanel — loading state', () => {
  it('shows ai-seed-panel shell and posts PS_SITEDB_TABLES_REQUEST on mount', async () => {
    render(<AiSeedPanel />);
    // Panel shell renders right away.
    expect(screen.getByTestId('ai-seed-panel')).toBeInTheDocument();
    // Characterization: the component posts the tables request on mount regardless of state.
    await waitFor(() => expect(lastRequest.value?.type).toBe('PS_SITEDB_TABLES_REQUEST'));
  });

  it('seed-table select is present in the DOM during loading (falls to default branch)', async () => {
    render(<AiSeedPanel />);
    // The component does NOT gate the select behind a loading spinner — it renders the full
    // shell immediately; the select has only the "Pick a table…" placeholder while loading.
    await waitFor(() => expect(lastRequest.value?.type).toBe('PS_SITEDB_TABLES_REQUEST'));
    const select = screen.getByTestId('seed-table') as HTMLSelectElement;
    // Only the placeholder option — no real table options yet.
    expect(select.options).toHaveLength(1);
    expect(select.options[0].value).toBe('');
  });
});

// ─── 2. Disabled state ───────────────────────────────────────────────────────

describe('AiSeedPanel — disabled state', () => {
  it('renders the "database isn\'t turned on yet" empty note', async () => {
    render(<AiSeedPanel />);
    await waitFor(() => expect(lastRequest.value?.type).toBe('PS_SITEDB_TABLES_REQUEST'));
    replyToLast('PS_SITEDB_TABLES_RESPONSE', { ok: false, enabled: false, tables: [] });

    await waitFor(() => {
      expect(screen.getByTestId('ai-seed-panel').textContent).toMatch(/database isn.t turned on yet/i);
    });
    expect(screen.queryByTestId('seed-table')).not.toBeInTheDocument();
  });
});

// ─── 3. Empty-tables state ───────────────────────────────────────────────────

describe('AiSeedPanel — empty tables state', () => {
  it('renders panel-empty with "Create a table first" when there are no tables', async () => {
    render(<AiSeedPanel />);
    await resolveTablesOk([]);

    await waitFor(() => expect(screen.getByTestId('panel-empty')).toBeInTheDocument());
    expect(screen.getByTestId('panel-empty').textContent).toMatch(/create a table first/i);
    expect(screen.queryByTestId('seed-table')).not.toBeInTheDocument();
  });

  it('fires onCreateTable when the "Create Table" button is clicked', async () => {
    const onCreateTable = vi.fn();
    render(<AiSeedPanel onCreateTable={onCreateTable} />);
    await resolveTablesOk([]);

    await waitFor(() => expect(screen.getByTestId('seed-empty-create-table')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('seed-empty-create-table'));
    expect(onCreateTable).toHaveBeenCalledOnce();
  });
});

// ─── 4. Ready state — table list rendered ────────────────────────────────────

describe('AiSeedPanel — ready state (tables present)', () => {
  it('renders the seed-table select with a placeholder + an option per table', async () => {
    render(<AiSeedPanel />);
    await resolveTablesOk(['customers', 'orders']);

    await waitFor(() => expect(screen.getByTestId('seed-table')).toBeInTheDocument());

    const select = screen.getByTestId('seed-table') as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toContain('customers');
    expect(options).toContain('orders');
    expect(options[0]).toBe(''); // placeholder "Pick a table…"
  });
});

// ─── 5. Table selected → columns loaded ──────────────────────────────────────

describe('AiSeedPanel — table selected', () => {
  async function renderReady() {
    render(<AiSeedPanel />);
    await resolveTablesOk(['products']);
    await waitFor(() => expect(screen.getByTestId('seed-table')).toBeInTheDocument());
  }

  it('sends PS_SITEDB_ROWS_REQUEST when a table is chosen', async () => {
    await renderReady();

    fireEvent.change(screen.getByTestId('seed-table'), { target: { value: 'products' } });

    await waitFor(() => expect(lastRequest.value?.type).toBe('PS_SITEDB_ROWS_REQUEST'));
    expect(lastRequest.value?.table).toBe('products');
  });

  it('shows seed-columns chips after columns load', async () => {
    await renderReady();
    fireEvent.change(screen.getByTestId('seed-table'), { target: { value: 'products' } });

    await waitFor(() => expect(lastRequest.value?.type).toBe('PS_SITEDB_ROWS_REQUEST'));

    replyToLast('PS_SITEDB_ROWS_RESPONSE', {
      ok: true,
      table: 'products',
      columns: [
        { name: 'name', type: 'TEXT', notnull: 0, pk: 0 },
        { name: 'price', type: 'REAL', notnull: 0, pk: 0 },
      ],
      rows: [],
    });

    await waitFor(() => expect(screen.getByTestId('seed-columns')).toBeInTheDocument());
    expect(screen.getByTestId('seed-columns').textContent).toMatch(/name/);
    expect(screen.getByTestId('seed-columns').textContent).toMatch(/price/);
  });

  it('renders seed-row-count, seed-hint, and seed-generate once columns are loaded', async () => {
    await renderReady();
    fireEvent.change(screen.getByTestId('seed-table'), { target: { value: 'products' } });
    await waitFor(() => expect(lastRequest.value?.type).toBe('PS_SITEDB_ROWS_REQUEST'));
    replyToLast('PS_SITEDB_ROWS_RESPONSE', {
      ok: true,
      table: 'products',
      columns: [{ name: 'name', type: 'TEXT', notnull: 0, pk: 0 }],
      rows: [],
    });

    await waitFor(() => expect(screen.getByTestId('seed-row-count')).toBeInTheDocument());
    expect(screen.getByTestId('seed-hint')).toBeInTheDocument();
    expect(screen.getByTestId('seed-generate')).toBeInTheDocument();
  });
});

// ─── 6. Generating state ─────────────────────────────────────────────────────

describe('AiSeedPanel — generating state', () => {
  async function renderWithColumns() {
    render(<AiSeedPanel />);
    await resolveTablesOk(['users']);
    await waitFor(() => expect(screen.getByTestId('seed-table')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('seed-table'), { target: { value: 'users' } });
    await waitFor(() => expect(lastRequest.value?.type).toBe('PS_SITEDB_ROWS_REQUEST'));
    replyToLast('PS_SITEDB_ROWS_RESPONSE', {
      ok: true,
      table: 'users',
      columns: [{ name: 'email', type: 'TEXT', notnull: 0, pk: 0 }],
      rows: [],
    });

    await waitFor(() => expect(screen.getByTestId('seed-generate')).toBeInTheDocument());
  }

  it('shows "Generating…" text while fetch is in-flight', async () => {
    await renderWithColumns();

    // Keep fetch pending so we can observe the mid-flight state.
    let resolveFetch!: (v: unknown) => void;
    fetchMock.mockReturnValueOnce(new Promise((r) => { resolveFetch = r; }));

    fireEvent.click(screen.getByTestId('seed-generate'));

    await waitFor(() => expect(screen.getByTestId('seed-generate').textContent).toMatch(/Generating/i));

    // Resolve to avoid unhandled promise warning.
    resolveFetch({ ok: false, status: 500, json: async () => ({ message: 'err' }) });
  });
});

// ─── 7. Preview state ───────────────────────────────────────────────────────

describe('AiSeedPanel — preview state', () => {
  async function renderWithColumnsReady() {
    render(<AiSeedPanel />);
    await resolveTablesOk(['contacts']);
    await waitFor(() => expect(screen.getByTestId('seed-table')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('seed-table'), { target: { value: 'contacts' } });
    await waitFor(() => expect(lastRequest.value?.type).toBe('PS_SITEDB_ROWS_REQUEST'));
    replyToLast('PS_SITEDB_ROWS_RESPONSE', {
      ok: true,
      table: 'contacts',
      columns: [
        { name: 'first_name', type: 'TEXT', notnull: 0, pk: 0 },
        { name: 'email', type: 'TEXT', notnull: 0, pk: 0 },
      ],
      rows: [],
    });

    await waitFor(() => expect(screen.getByTestId('seed-generate')).toBeInTheDocument());
  }

  it('shows seed-preview-table with the generated rows after /api/llmcall resolves', async () => {
    await renderWithColumnsReady();

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        text: '[{"first_name":"Alice","email":"alice@example.com"},{"first_name":"Bob","email":"bob@example.com"}]',
      }),
    });

    fireEvent.click(screen.getByTestId('seed-generate'));

    await waitFor(() => expect(screen.getByTestId('seed-preview-table')).toBeInTheDocument());
  });

  it('renders seed-insert and seed-regenerate buttons once preview is available', async () => {
    await renderWithColumnsReady();

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        text: '[{"first_name":"Carol","email":"carol@example.com"}]',
      }),
    });

    fireEvent.click(screen.getByTestId('seed-generate'));

    await waitFor(() => expect(screen.getByTestId('seed-insert')).toBeInTheDocument());
    expect(screen.getByTestId('seed-regenerate')).toBeInTheDocument();
  });
});

// ─── 8. Insert fires exec request ────────────────────────────────────────────

describe('AiSeedPanel — insert rows', () => {
  async function renderWithPreview() {
    render(<AiSeedPanel />);
    await resolveTablesOk(['tasks']);
    await waitFor(() => expect(screen.getByTestId('seed-table')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('seed-table'), { target: { value: 'tasks' } });
    await waitFor(() => expect(lastRequest.value?.type).toBe('PS_SITEDB_ROWS_REQUEST'));
    replyToLast('PS_SITEDB_ROWS_RESPONSE', {
      ok: true,
      table: 'tasks',
      columns: [{ name: 'title', type: 'TEXT', notnull: 0, pk: 0 }],
      rows: [],
    });
    await waitFor(() => expect(screen.getByTestId('seed-generate')).toBeInTheDocument());

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: '[{"title":"Write docs"},{"title":"Fix bug"}]' }),
    });

    fireEvent.click(screen.getByTestId('seed-generate'));
    await waitFor(() => expect(screen.getByTestId('seed-insert')).toBeInTheDocument());
  }

  it('sends PS_RES_MUTATE_REQUEST with action:"exec" when seed-insert is clicked', async () => {
    await renderWithPreview();

    // The exec request will pend until we reply; capture it.
    fireEvent.click(screen.getByTestId('seed-insert'));

    await waitFor(() => {
      expect(lastRequest.value?.type).toBe('PS_RES_MUTATE_REQUEST');
      expect(lastRequest.value?.action).toBe('exec');
    });
  });
});

// ─── 9. Insert success ───────────────────────────────────────────────────────

describe('AiSeedPanel — insert success', () => {
  it('shows a role=status success note and removes preview after successful insert', async () => {
    render(<AiSeedPanel />);
    await resolveTablesOk(['logs']);
    await waitFor(() => expect(screen.getByTestId('seed-table')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('seed-table'), { target: { value: 'logs' } });
    await waitFor(() => expect(lastRequest.value?.type).toBe('PS_SITEDB_ROWS_REQUEST'));
    replyToLast('PS_SITEDB_ROWS_RESPONSE', {
      ok: true,
      table: 'logs',
      columns: [{ name: 'message', type: 'TEXT', notnull: 0, pk: 0 }],
      rows: [],
    });
    await waitFor(() => expect(screen.getByTestId('seed-generate')).toBeInTheDocument());

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: '[{"message":"Server started"},{"message":"Request processed"}]' }),
    });
    fireEvent.click(screen.getByTestId('seed-generate'));
    await waitFor(() => expect(screen.getByTestId('seed-insert')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('seed-insert'));
    await waitFor(() => {
      expect(lastRequest.value?.type).toBe('PS_RES_MUTATE_REQUEST');
      expect(lastRequest.value?.action).toBe('exec');
    });

    replyToLast('PS_RES_MUTATE_RESPONSE', {
      ok: true,
      result: { ok: true, data: { rowsWritten: 2 } },
    });

    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    expect(screen.getByRole('status').textContent).toMatch(/Added 2 rows/i);
    // Preview table disappears after success.
    expect(screen.queryByTestId('seed-preview-table')).not.toBeInTheDocument();
  });
});

// ─── 10. Generation error ────────────────────────────────────────────────────

describe('AiSeedPanel — generation error', () => {
  it('shows a role=alert when /api/llmcall returns a non-ok response', async () => {
    render(<AiSeedPanel />);
    await resolveTablesOk(['events']);
    await waitFor(() => expect(screen.getByTestId('seed-table')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('seed-table'), { target: { value: 'events' } });
    await waitFor(() => expect(lastRequest.value?.type).toBe('PS_SITEDB_ROWS_REQUEST'));
    replyToLast('PS_SITEDB_ROWS_RESPONSE', {
      ok: true,
      table: 'events',
      columns: [{ name: 'name', type: 'TEXT', notnull: 0, pk: 0 }],
      rows: [],
    });
    await waitFor(() => expect(screen.getByTestId('seed-generate')).toBeInTheDocument());

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({ message: 'The assistant is unavailable (HTTP 503).' }),
    });

    fireEvent.click(screen.getByTestId('seed-generate'));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert').textContent).toMatch(/unavailable/i);
  });
});
