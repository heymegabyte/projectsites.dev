/**
 * @file ChartView — a lightweight, dependency-free inline-SVG bar chart for a query/table result.
 *
 * @remarks
 * Rev 5 of the editor Data Platform ("render a query/table result as a CHART"). This is the render
 * half of a feature whose LOGIC already shipped + is unit-tested in `./data-panel-logic`
 * (`detectChartable` picks the label + numeric columns from the ALREADY-loaded rows; `buildChartSeries`
 * turns one measure column into `{label,value}` points). No new endpoint, no new fetch — this component
 * only draws what {@link ../DataGrid} already holds.
 *
 * Deliberately NO chart library: `app/` ships none (recharts/chart.js/visx/echarts), and this is a
 * simple bar chart — a hand-rolled `<svg>` (transform/opacity only, `prefers-reduced-motion` safe) is
 * lighter than pulling a heavy dep. Style matches the Database tab: black `#060610` + cyan `#00E5FF`,
 * `bolt-elements-*` tokens, `i-ph:*` phosphor icons.
 *
 * When the result has no numeric column to plot, {@link DataGrid} renders the honest empty note itself;
 * this component always receives a real {@link ChartSpec} + a chosen measure and just draws the bars.
 */
import React, { memo, useMemo } from 'react';

import { classNames } from '~/utils/classNames';
import { buildChartSeries, type ChartSpec } from './data-panel-logic';

export interface ChartViewProps {
  /** The chartable columns detected from the result (a label column + ≥1 numeric measure column). */
  spec: ChartSpec;

  /** The rows to plot (the already-fetched result set — never re-queried). */
  rows: Record<string, unknown>[];

  /** The numeric column currently plotted on the Y axis. Must be one of `spec.valueCols`. */
  measure: string;

  /** Called when the user picks a different numeric measure column. */
  onMeasureChange: (col: string) => void;

  /** Root `data-testid` (the SVG bars get `${testId}-bar`, the measure picker `${testId}-measure`). */
  testId?: string;
}

/** A compact number label for a bar (`1234` → `1,234`, `1234.5` → `1,234.5`). Pure. */
function formatValue(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * A horizontal bar chart of `measure` grouped by `spec.labelCol`, drawn as inline SVG. Each row is one
 * bar; width is relative to the max magnitude (0 when all values are 0). Rendered rows are capped by the
 * upstream `detectChartable` (summary-sized results only), so no virtualization is needed.
 */
export const ChartView = memo(({ spec, rows, measure, onMeasureChange, testId = 'chart' }: ChartViewProps) => {
  const series = useMemo(() => buildChartSeries(rows, spec.labelCol, measure), [rows, spec.labelCol, measure]);

  const max = useMemo(() => series.reduce((m, p) => Math.max(m, p.value), 0), [series]);

  // Layout constants for the SVG (a fixed row height per bar; the label rail is a fixed left column).
  const ROW_H = 26;
  const GAP = 6;
  const LABEL_W = 128;
  const VALUE_W = 64;
  const BAR_MIN = 2; // a non-zero value always paints at least a sliver, so it's never invisible
  const height = Math.max(ROW_H, series.length * (ROW_H + GAP));

  return (
    <div data-testid={testId} className="[color-scheme:dark]">
      {/* Measure picker — which numeric column is plotted (only shown when there's a choice). */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-[11px] text-bolt-elements-textSecondary">
          <div className="i-ph:chart-bar text-bolt-elements-item-contentAccent text-sm" aria-hidden />
          <span className="uppercase tracking-wider text-[10px] text-bolt-elements-textTertiary">Measure</span>
          <select
            value={measure}
            onChange={(e) => onMeasureChange(e.target.value)}
            aria-label="Chart measure column"
            data-testid={`${testId}-measure`}
            className="rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-1.5 py-1 text-[11px] text-bolt-elements-textPrimary focus:border-bolt-elements-item-contentAccent focus:outline-none"
          >
            {spec.valueCols.map((c) => (
              <option key={c} value={c} className="bg-[#0e0e28] text-bolt-elements-textPrimary">
                {c}
              </option>
            ))}
          </select>
        </label>
        <span className="text-[10px] text-bolt-elements-textTertiary tabular-nums">
          {series.length.toLocaleString()} {series.length === 1 ? 'bar' : 'bars'} · by {spec.labelCol}
        </span>
      </div>

      {/* The bar chart — a single inline SVG, no chart library. */}
      <div className="overflow-auto modern-scrollbar rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
        <svg
          width="100%"
          height={height}
          viewBox={`0 0 100 ${height}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Bar chart of ${measure} by ${spec.labelCol}`}
          className="block"
        >
          {series.map((point, i) => {
            const y = i * (ROW_H + GAP);
            const frac = max > 0 ? point.value / max : 0;

            // The plot area is the SVG width minus the (fixed, viewBox-relative) label + value rails.
            const plotLeft = LABEL_W / 6; // px→viewBox-unit approximation; keeps the label rail readable
            const plotRight = 100 - VALUE_W / 12;
            const plotW = Math.max(0, plotRight - plotLeft);
            const barW = point.value > 0 ? Math.max(BAR_MIN, frac * plotW) : 0;

            return (
              <g key={`${point.label}:${i}`} data-testid={`${testId}-bar`}>
                {/* Category label (left rail) */}
                <text
                  x={plotLeft - 2}
                  y={y + ROW_H / 2}
                  textAnchor="end"
                  dominantBaseline="middle"
                  className="fill-bolt-elements-textSecondary"
                  style={{ fontSize: '9px' }}
                >
                  {point.label}
                </text>

                {/* Track */}
                <rect
                  x={plotLeft}
                  y={y + 4}
                  width={plotW}
                  height={ROW_H - 8}
                  rx="2"
                  className="fill-bolt-elements-background-depth-3"
                  opacity={0.4}
                />

                {/* Bar */}
                <rect
                  x={plotLeft}
                  y={y + 4}
                  width={barW}
                  height={ROW_H - 8}
                  rx="2"
                  className={classNames(
                    'fill-[color:var(--ps-accent,#00e5ff)] motion-safe:transition-[width] motion-safe:duration-300',
                  )}
                >
                  <title>{`${point.label}: ${formatValue(point.value)}`}</title>
                </rect>

                {/* Value label (right of the bar) */}
                <text
                  x={plotRight + 1}
                  y={y + ROW_H / 2}
                  textAnchor="start"
                  dominantBaseline="middle"
                  className="fill-bolt-elements-textTertiary tabular-nums"
                  style={{ fontSize: '9px' }}
                >
                  {formatValue(point.value)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
});

ChartView.displayName = 'ChartView';
