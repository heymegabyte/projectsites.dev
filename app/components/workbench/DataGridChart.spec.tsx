// @vitest-environment jsdom
/**
 * DataGridChart.spec.tsx — Rev 5 of the Editor Data Platform: render a query/table result as a CHART.
 *
 * The shared read-only {@link ../DataGrid} gains a Grid | Chart view toggle. When the already-loaded
 * result has a label column + ≥1 numeric column ({@link ../data-panel-logic}.detectChartable), the
 * Chart view draws a lightweight inline-SVG bar chart (one bar per row, per selected numeric column).
 * When NOTHING is chartable the Chart affordance is a clear inline note, never a dead/broken toggle.
 *
 * This is a PURE presentational component (props: columns + rows) — no embed bridge, no fetch, no
 * network. It reuses the mature, already-unit-tested detection (`detectChartable`) + series
 * (`buildChartSeries`) logic, so this spec asserts the RENDER wiring: the toggle appears, the chart
 * draws N bars for N rows, the column picker switches the plotted measure, and a non-chartable result
 * shows the honest note instead of a broken chart.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import React from 'react';

import { DataGrid } from './DataGrid';

afterEach(cleanup);

/** A summary-sized, clearly chartable result: a label column + two numeric columns. */
const CHARTABLE_COLUMNS = ['country', 'hits', 'misses'];
const CHARTABLE_ROWS = [
  { country: 'US', hits: 12, misses: 3 },
  { country: 'CA', hits: 7, misses: 1 },
  { country: 'GB', hits: 5, misses: 9 },
];

/** A result with NO numeric column to plot — chart is impossible, must show the honest note. */
const UNCHARTABLE_COLUMNS = ['name', 'email'];
const UNCHARTABLE_ROWS = [
  { name: 'Ada', email: 'ada@example.com' },
  { name: 'Alan', email: 'alan@example.com' },
];

describe('DataGrid — Chart view (Rev 5)', () => {
  it('exposes a Grid | Chart view toggle when the result is chartable', () => {
    render(<DataGrid columns={CHARTABLE_COLUMNS} rows={CHARTABLE_ROWS} testId="grid" />);

    // The view toggle group + both options are keyboard-reachable buttons.
    const toggle = screen.getByTestId('grid-viewtoggle');
    expect(toggle).toBeTruthy();
    expect(screen.getByTestId('grid-view-grid')).toBeTruthy();
    expect(screen.getByTestId('grid-view-chart')).toBeTruthy();
    expect((screen.getByTestId('grid-view-chart') as HTMLButtonElement).tagName).toBe('BUTTON');
  });

  it('starts on the Grid view (the table is visible, the chart is not)', () => {
    render(<DataGrid columns={CHARTABLE_COLUMNS} rows={CHARTABLE_ROWS} testId="grid" />);

    expect(screen.getByTestId('grid-table')).toBeTruthy();
    expect(screen.queryByTestId('grid-chart')).toBeNull();
  });

  it('renders an SVG bar chart with one bar per row when switched to Chart', () => {
    render(<DataGrid columns={CHARTABLE_COLUMNS} rows={CHARTABLE_ROWS} testId="grid" />);

    fireEvent.click(screen.getByTestId('grid-view-chart'));

    const chart = screen.getByTestId('grid-chart');
    expect(chart).toBeTruthy();

    // One bar per row (3 rows → 3 bars) for the default (first) numeric measure.
    const bars = within(chart).getAllByTestId('grid-chart-bar');
    expect(bars).toHaveLength(CHARTABLE_ROWS.length);

    // The chart is real inline SVG (no heavy chart lib) — a <svg> element is present.
    expect(chart.querySelector('svg')).toBeTruthy();

    // Switching to Chart hides the data table.
    expect(screen.queryByTestId('grid-table')).toBeNull();
  });

  it('labels each bar with its category (the first non-numeric column)', () => {
    render(<DataGrid columns={CHARTABLE_COLUMNS} rows={CHARTABLE_ROWS} testId="grid" />);
    fireEvent.click(screen.getByTestId('grid-view-chart'));

    const chart = screen.getByTestId('grid-chart');
    // Category labels from the `country` column are all present.
    expect(within(chart).getByText('US')).toBeTruthy();
    expect(within(chart).getByText('CA')).toBeTruthy();
    expect(within(chart).getByText('GB')).toBeTruthy();
  });

  it('offers a measure-column picker with each numeric column and re-plots on change', () => {
    render(<DataGrid columns={CHARTABLE_COLUMNS} rows={CHARTABLE_ROWS} testId="grid" />);
    fireEvent.click(screen.getByTestId('grid-view-chart'));

    const picker = screen.getByTestId('grid-chart-measure') as HTMLSelectElement;
    // Both numeric columns (hits, misses) are options; the non-numeric label column is NOT.
    const optionValues = Array.from(picker.options).map((o) => o.value);
    expect(optionValues).toEqual(['hits', 'misses']);

    // Switch the measure — the chart still renders one bar per row against the new column.
    fireEvent.change(picker, { target: { value: 'misses' } });
    const bars = within(screen.getByTestId('grid-chart')).getAllByTestId('grid-chart-bar');
    expect(bars).toHaveLength(CHARTABLE_ROWS.length);
  });

  it('shows an honest "no chartable columns" note (never a dead chart) when nothing is numeric', () => {
    render(<DataGrid columns={UNCHARTABLE_COLUMNS} rows={UNCHARTABLE_ROWS} testId="grid" />);

    // The Chart toggle is still reachable (the affordance is never hidden)…
    fireEvent.click(screen.getByTestId('grid-view-chart'));

    // …but selecting it yields the honest note, and NO bars / broken chart.
    const note = screen.getByTestId('grid-chart-empty');
    expect(note.textContent ?? '').toMatch(/no chartable columns/i);
    expect(screen.queryByTestId('grid-chart-bar')).toBeNull();
  });
});
