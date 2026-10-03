/**
 * @file ErdView — a lightweight, dependency-free inline-SVG ERD / schema-relationships diagram.
 *
 * @remarks
 * Rev 8 of the editor Data Platform ("visualize the site's D1 schema as a relationship map"). This is
 * the RENDER half of a feature whose LOGIC already ships + is unit-tested in `./data-panel-logic`
 * (`inferErdEdges` derives edges by naming convention; `layoutErdNodes` places every table on a
 * deterministic grid). No physics engine, no chart/graph library — `app/` ships none, and this is a
 * simple boxes-and-lines diagram, so a hand-rolled `<svg>` (transform/opacity only,
 * `prefers-reduced-motion` safe) is far lighter than pulling a heavy dep.
 *
 * WHERE RELATIONSHIPS COME FROM. The per-site D1 schema exposes NO foreign-key metadata (the tables
 * endpoint returns only `{name}`; the rows endpoint only `{name,type,notnull,pk}` from PRAGMA
 * table_info — never `PRAGMA foreign_key_list`). So every edge is INFERRED from column naming
 * (`<x>_id` → a table `x` / `xs` / `xes` / `xies`) and is drawn dashed + labeled "inferred" so it's
 * never mistaken for a declared constraint. When the schema exposes real FKs one day, `inferErdEdges`
 * can emit `inferred:false` and this view dims the "inferred" note without a shape change.
 *
 * NO NEW ENDPOINT / FETCH. The parent gathers each table's columns through the EXISTING
 * `PS_SITEDB_ROWS_REQUEST` bridge (the same call the grid's row-browse uses) and hands the assembled
 * schema map in as `tables`. This component only draws what it's given.
 *
 * Style matches the Database tab exactly: black `#060610` + cyan `#00E5FF`, `bolt-elements-*` tokens,
 * `i-ph:*` phosphor icons — mirrors `./ChartView` + `./DatabasePanel`.
 */
import React, { memo, useMemo } from 'react';

import { classNames } from '~/utils/classNames';
import { inferErdEdges, layoutErdNodes, ERD_MAX_TABLES, type ErdSchemaTable, type ErdNode } from './data-panel-logic';

export interface ErdViewProps {
  /** The assembled schema map — every table + its columns (gathered via the existing rows bridge). */
  tables: ErdSchemaTable[];

  /** Number of node columns the grid is laid out in (defaults to 3). */
  gridColumns?: number;

  /** Called when a node's header is activated — lets the parent open that table in the grid. */
  onOpenTable?: (name: string) => void;

  /** Root `data-testid` (nodes get `${testId}-node`, edges `${testId}-edge`). */
  testId?: string;
}

/** The height of one column row inside a node card (kept in sync with the layout geometry). */
const ROW_H = 20;
const HEADER_H = 30;
const PAD_Y = 10;
const MAX_COL_ROWS = 12;

/** The anchor point (right edge, vertical middle) of a node — where an outgoing edge departs. Pure. */
function rightAnchor(node: ErdNode): { x: number; y: number } {
  return { x: node.x + node.w, y: node.y + node.h / 2 };
}

/** The anchor point (left edge, vertical middle) of a node — where an incoming edge lands. Pure. */
function leftAnchor(node: ErdNode): { x: number; y: number } {
  return { x: node.x, y: node.y + node.h / 2 };
}

/**
 * An inline-SVG ERD: one card per table (name header + its columns, PK marked), dashed edges for each
 * inferred relationship. Deterministic grid layout from {@link layoutErdNodes}; edges from
 * {@link inferErdEdges}. The parent renders the honest empty note for a 0/1-table schema — this
 * component always receives ≥2 real tables and just draws them.
 */
export const ErdView = memo(({ tables, gridColumns = 3, onOpenTable, testId = 'erd' }: ErdViewProps) => {
  const nodes = useMemo(() => layoutErdNodes(tables, { columns: gridColumns }), [tables, gridColumns]);
  const edges = useMemo(() => inferErdEdges(tables), [tables]);

  /** Fast lookup: table name → its laid-out node (only capped/shown tables have a node). */
  const nodeByName = useMemo(() => {
    const m = new Map<string, ErdNode>();

    for (const n of nodes) {
      m.set(n.table, n);
    }

    return m;
  }, [nodes]);

  // The viewBox spans the full laid-out extent (+ a right/bottom margin).
  const width = useMemo(() => nodes.reduce((w, n) => Math.max(w, n.x + n.w), 0) + 24, [nodes]);
  const height = useMemo(() => nodes.reduce((h, n) => Math.max(h, n.y + n.h), 0) + 24, [nodes]);

  const inferredCount = edges.length;
  const truncated = tables.length > ERD_MAX_TABLES;

  return (
    <div data-testid={testId} className="[color-scheme:dark]">
      {/* Legend — names the source of the edges so an "inferred" line is never mistaken for a real FK. */}
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-bolt-elements-textSecondary">
        <span className="inline-flex items-center gap-1.5">
          <div className="i-ph:graph text-bolt-elements-item-contentAccent text-sm" aria-hidden />
          <span className="uppercase tracking-wider text-[10px] text-bolt-elements-textTertiary">Schema map</span>
        </span>
        <span className="tabular-nums text-bolt-elements-textTertiary">
          {nodes.length} {nodes.length === 1 ? 'table' : 'tables'}
        </span>
        {inferredCount > 0 && (
          <span className="inline-flex items-center gap-1.5 text-bolt-elements-textTertiary">
            <svg width="22" height="8" viewBox="0 0 22 8" aria-hidden className="shrink-0">
              <line
                x1="0"
                y1="4"
                x2="22"
                y2="4"
                stroke="var(--ps-accent,#00e5ff)"
                strokeWidth="1.5"
                strokeDasharray="4 3"
              />
            </svg>
            <span>
              {inferredCount} inferred {inferredCount === 1 ? 'link' : 'links'} (by <code>*_id</code> naming)
            </span>
          </span>
        )}
        {truncated && <span className="text-bolt-elements-textTertiary">· showing first {ERD_MAX_TABLES}</span>}
      </div>

      {/* The diagram — a single inline SVG, no graph library. */}
      <div className="overflow-auto modern-scrollbar rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`Schema relationship diagram of ${nodes.length} tables and ${inferredCount} inferred relationships`}
          className="block"
        >
          {/* Edges first (drawn UNDER the node cards). */}
          <g>
            {edges.map((edge, i) => {
              const from = nodeByName.get(edge.from);
              const to = nodeByName.get(edge.to);

              if (!from || !to) {
                return null;
              }

              // Self-referential: a small loop off the right edge. Otherwise a straight anchor-to-anchor line.
              if (edge.from === edge.to) {
                const a = rightAnchor(from);

                return (
                  <path
                    key={`${edge.from}.${edge.fromColumn}->${edge.to}:${i}`}
                    data-testid={`${testId}-edge`}
                    d={`M ${a.x} ${a.y} c 26 -14 26 14 0 0`}
                    fill="none"
                    stroke="var(--ps-accent,#00e5ff)"
                    strokeWidth="1.25"
                    strokeDasharray="4 3"
                    opacity={0.75}
                  >
                    <title>{`${edge.from}.${edge.fromColumn} → ${edge.to} (inferred)`}</title>
                  </path>
                );
              }

              const a = rightAnchor(from);
              const b = leftAnchor(to);

              return (
                <line
                  key={`${edge.from}.${edge.fromColumn}->${edge.to}:${i}`}
                  data-testid={`${testId}-edge`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke="var(--ps-accent,#00e5ff)"
                  strokeWidth="1.25"
                  strokeDasharray="4 3"
                  opacity={0.7}
                >
                  <title>{`${edge.from}.${edge.fromColumn} → ${edge.to} (inferred)`}</title>
                </line>
              );
            })}
          </g>

          {/* Node cards. */}
          <g>
            {nodes.map((node) => {
              const shownCols = node.columns.slice(0, MAX_COL_ROWS);
              const hiddenColCount = node.columns.length - shownCols.length;

              return (
                <g key={node.table} data-testid={`${testId}-node`}>
                  {/* Card body */}
                  <rect
                    x={node.x}
                    y={node.y}
                    width={node.w}
                    height={node.h}
                    rx="8"
                    className="fill-bolt-elements-background-depth-2 stroke-bolt-elements-borderColor"
                    strokeWidth="1"
                  />

                  {/* Header — clickable to open the table in the grid. */}
                  <g
                    role={onOpenTable ? 'button' : undefined}
                    tabIndex={onOpenTable ? 0 : undefined}
                    aria-label={onOpenTable ? `Open table ${node.table}` : undefined}
                    onClick={onOpenTable ? () => onOpenTable(node.table) : undefined}
                    onKeyDown={
                      onOpenTable
                        ? (e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              onOpenTable(node.table);
                            }
                          }
                        : undefined
                    }
                    className={onOpenTable ? 'cursor-pointer' : undefined}
                    style={onOpenTable ? undefined : { pointerEvents: 'none' }}
                  >
                    <rect
                      x={node.x}
                      y={node.y}
                      width={node.w}
                      height={HEADER_H}
                      rx="8"
                      className="fill-bolt-elements-background-depth-3"
                    />
                    {/* Square off the header's lower corners over the body. */}
                    <rect
                      x={node.x}
                      y={node.y + HEADER_H - 8}
                      width={node.w}
                      height={8}
                      className="fill-bolt-elements-background-depth-3"
                    />
                    <text
                      x={node.x + 12}
                      y={node.y + HEADER_H / 2}
                      dominantBaseline="middle"
                      className="fill-bolt-elements-item-contentAccent font-mono"
                      style={{ fontSize: '12px', fontWeight: 600 }}
                    >
                      {node.table}
                    </text>
                  </g>

                  {/* Columns */}
                  {shownCols.map((col, ci) => {
                    const cy = node.y + HEADER_H + PAD_Y / 2 + ci * ROW_H + ROW_H / 2;
                    const isPk = col.pk > 0;
                    const isFk = /_id$/i.test(col.name) && col.name.toLowerCase() !== 'id';

                    return (
                      <g key={col.name}>
                        <text
                          x={node.x + 12}
                          y={cy}
                          dominantBaseline="middle"
                          className={classNames(
                            'font-mono',
                            isPk ? 'fill-bolt-elements-textPrimary' : 'fill-bolt-elements-textSecondary',
                          )}
                          style={{ fontSize: '10.5px', fontWeight: isPk ? 600 : 400 }}
                        >
                          {isPk ? '🔑 ' : isFk ? '↗ ' : ''}
                          {col.name}
                        </text>
                        <text
                          x={node.x + node.w - 12}
                          y={cy}
                          textAnchor="end"
                          dominantBaseline="middle"
                          className="fill-bolt-elements-textTertiary font-mono"
                          style={{ fontSize: '9px' }}
                        >
                          {(col.type || '').toUpperCase()}
                        </text>
                      </g>
                    );
                  })}

                  {hiddenColCount > 0 && (
                    <text
                      x={node.x + 12}
                      y={node.y + HEADER_H + PAD_Y / 2 + MAX_COL_ROWS * ROW_H + 2}
                      dominantBaseline="middle"
                      className="fill-bolt-elements-textTertiary italic"
                      style={{ fontSize: '9px' }}
                    >
                      +{hiddenColCount} more
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    </div>
  );
});

ErdView.displayName = 'ErdView';
