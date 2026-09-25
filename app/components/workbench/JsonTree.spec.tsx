// @vitest-environment jsdom
/**
 * JsonTree.spec.tsx — TDD spec written BEFORE implementation.
 *
 * Covers:
 *  1. buildPath pure helper — object keys, array indices, weird-key escaping
 *  2. jsonPaths pure helper — full flattened JSONPath list
 *  3. Component render — primitive colour classes, expandable nodes, data-testid
 *  4. Click-to-copy — clipboard write + aria-live ✓ flash
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';

// ─── pure helpers (importable before RTL; always testable) ─────────────────────
import { buildPath, jsonPaths, JsonTree } from './JsonTree';

// ────────────────────────────────────────────────────────────────────────────────
// 1. buildPath
// ────────────────────────────────────────────────────────────────────────────────
describe('buildPath', () => {
  it('starts from root with a plain key', () => {
    expect(buildPath('$', 'user', false)).toBe('$.user');
  });

  it('starts from root with an array index', () => {
    expect(buildPath('$', 0, true)).toBe('$[0]');
  });

  it('chains nested plain keys', () => {
    expect(buildPath('$.user', 'address', false)).toBe('$.user.address');
  });

  it('chains nested array index', () => {
    expect(buildPath('$.items', 2, true)).toBe('$.items[2]');
  });

  it('uses bracket notation for keys with spaces', () => {
    expect(buildPath('$', 'my key', false)).toBe('$["my key"]');
  });

  it('uses bracket notation for keys with hyphens', () => {
    expect(buildPath('$', 'x-api-key', false)).toBe('$["x-api-key"]');
  });

  it('uses bracket notation for keys starting with a digit', () => {
    expect(buildPath('$', '2fast', false)).toBe('$["2fast"]');
  });

  it('uses bracket notation for keys with dots', () => {
    expect(buildPath('$', 'a.b', false)).toBe('$["a.b"]');
  });

  it('uses plain dot notation for camelCase keys', () => {
    expect(buildPath('$.obj', 'camelCase', false)).toBe('$.obj.camelCase');
  });

  it('uses plain dot notation for keys with underscores', () => {
    expect(buildPath('$', '_private', false)).toBe('$._private');
  });

  it('uses bracket notation for empty-string key', () => {
    expect(buildPath('$', '', false)).toBe('$[""]');
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// 2. jsonPaths
// ────────────────────────────────────────────────────────────────────────────────
describe('jsonPaths', () => {
  it('returns root $ for a primitive', () => {
    expect(jsonPaths(42)).toEqual(['$']);
  });

  it('returns paths for a flat object', () => {
    const result = jsonPaths({ a: 1, b: 2 });
    expect(result).toContain('$.a');
    expect(result).toContain('$.b');
  });

  it('returns nested paths', () => {
    const result = jsonPaths({ user: { name: 'Alice' } });
    expect(result).toContain('$.user');
    expect(result).toContain('$.user.name');
  });

  it('returns array index paths', () => {
    const result = jsonPaths({ items: [10, 20] });
    expect(result).toContain('$.items');
    expect(result).toContain('$.items[0]');
    expect(result).toContain('$.items[1]');
  });

  it('handles a weird key', () => {
    const result = jsonPaths({ 'bad key': true });
    expect(result).toContain('$["bad key"]');
  });

  it('handles null value at a key', () => {
    const result = jsonPaths({ x: null });
    expect(result).toContain('$.x');
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// 3. Component render
// ────────────────────────────────────────────────────────────────────────────────
describe('JsonTree component', () => {
  afterEach(cleanup);

  it('renders with data-testid="data-json-tree"', () => {
    render(<JsonTree value={{ a: 1 }} />);
    expect(screen.getByTestId('data-json-tree')).toBeTruthy();
  });

  it('renders key buttons with data-testid="data-json-key"', () => {
    render(<JsonTree value={{ name: 'Alice', age: 30 }} />);
    const keyBtns = screen.getAllByTestId('data-json-key');
    expect(keyBtns.length).toBeGreaterThanOrEqual(2);
  });

  it('applies amber class to number primitives', () => {
    render(<JsonTree value={{ count: 99 }} />);
    // The amber-coloured span contains the number text
    const amberSpans = document.querySelectorAll('.text-\\[\\#f5c451\\]');
    expect(amberSpans.length).toBeGreaterThan(0);
    expect(Array.from(amberSpans).some((el) => el.textContent === '99')).toBe(true);
  });

  it('applies cyan class to boolean primitives', () => {
    render(<JsonTree value={{ active: true }} />);
    const cyanSpans = document.querySelectorAll('.text-\\[\\#00E5FF\\]');
    expect(cyanSpans.length).toBeGreaterThan(0);
    expect(Array.from(cyanSpans).some((el) => el.textContent === 'true')).toBe(true);
  });

  it('applies green class to string primitives', () => {
    render(<JsonTree value={{ city: 'Paris' }} />);
    const greenSpans = document.querySelectorAll('.text-\\[\\#7ee787\\]');
    expect(greenSpans.length).toBeGreaterThan(0);
    expect(Array.from(greenSpans).some((el) => el.textContent === '"Paris"')).toBe(true);
  });

  it('renders null as muted italic', () => {
    render(<JsonTree value={{ x: null }} />);
    const nullSpans = document.querySelectorAll('.italic');
    expect(nullSpans.length).toBeGreaterThan(0);
    expect(Array.from(nullSpans).some((el) => el.textContent === 'null')).toBe(true);
  });

  it('renders top-level object as an open <details>', () => {
    render(<JsonTree value={{ a: { b: 1 } }} />);
    // The root details must be open
    const allDetails = document.querySelectorAll('details');
    expect(allDetails.length).toBeGreaterThan(0);
    const root = allDetails[0];
    expect(root.hasAttribute('open')).toBe(true);
  });

  it('renders nested object as a collapsed <details>', () => {
    render(<JsonTree value={{ a: { deep: true } }} />);
    const allDetails = document.querySelectorAll('details');
    // Depth > 0 details should NOT have the open attribute
    const nested = Array.from(allDetails).filter((d) => !d.hasAttribute('open'));
    expect(nested.length).toBeGreaterThan(0);
  });

  it('renders an array with [i] in key buttons', () => {
    render(<JsonTree value={[10, 20]} />);
    const keys = screen.getAllByTestId('data-json-key');
    const texts = keys.map((k) => k.textContent);
    expect(texts.some((t) => t?.includes('[0]') || t?.includes('[1]'))).toBe(true);
  });

  it('uses bracket notation for weird keys in buttons', () => {
    render(<JsonTree value={{ 'my key': 1 }} />);
    const keys = screen.getAllByTestId('data-json-key');
    const texts = keys.map((k) => k.textContent);
    expect(texts.some((t) => t?.includes('"my key"'))).toBe(true);
  });

  it('uses an optional rootLabel in the summary', () => {
    render(<JsonTree value={{ a: 1 }} rootLabel="result" />);
    expect(screen.getByText(/result/)).toBeTruthy();
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// 4. Click-to-copy
// ────────────────────────────────────────────────────────────────────────────────
describe('JsonTree click-to-copy', () => {
  afterEach(cleanup);

  beforeEach(() => {
    // Stub navigator.clipboard.writeText
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it('calls clipboard.writeText with the correct JSONPath on key click', async () => {
    render(<JsonTree value={{ city: 'Paris' }} />);
    const keyBtns = screen.getAllByTestId('data-json-key');
    // Find the button labelled "city"
    const cityBtn = keyBtns.find((b) => b.textContent?.includes('city'));
    expect(cityBtn).toBeTruthy();
    fireEvent.click(cityBtn!);
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('$.city');
    });
  });

  it('shows ✓ confirmation after clicking a key', async () => {
    render(<JsonTree value={{ name: 'Bob' }} />);
    const keyBtns = screen.getAllByTestId('data-json-key');
    const nameBtn = keyBtns.find((b) => b.textContent?.includes('name'));
    expect(nameBtn).toBeTruthy();

    await act(async () => {
      fireEvent.click(nameBtn!);
    });

    // The aria-live region should contain ✓
    await waitFor(() => {
      const liveEl = document.querySelector('[aria-live="polite"]');
      expect(liveEl?.textContent).toContain('✓');
    });
  });

  it('copies nested JSONPath: $.user.address', async () => {
    render(<JsonTree value={{ user: { address: { city: 'NY' } } }} />);
    // Expand nested objects first by clicking the summaries
    const summaries = document.querySelectorAll('summary');
    summaries.forEach((s) => fireEvent.click(s));

    const keyBtns = screen.getAllByTestId('data-json-key');
    // Find the "city" button inside $.user.address
    const cityBtn = keyBtns.find((b) => b.getAttribute('data-path') === '$.user.address.city');
    expect(cityBtn).toBeTruthy();
    fireEvent.click(cityBtn!);
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('$.user.address.city');
    });
  });

  it('copies array index path: $.items[0]', async () => {
    render(<JsonTree value={{ items: ['a', 'b'] }} />);
    const summaries = document.querySelectorAll('summary');
    summaries.forEach((s) => fireEvent.click(s));

    const keyBtns = screen.getAllByTestId('data-json-key');
    const idxBtn = keyBtns.find((b) => b.getAttribute('data-path') === '$.items[0]');
    expect(idxBtn).toBeTruthy();
    fireEvent.click(idxBtn!);
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('$.items[0]');
    });
  });
});
