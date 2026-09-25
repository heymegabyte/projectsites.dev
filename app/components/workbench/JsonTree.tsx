/**
 * JsonTree.tsx
 *
 * Pretty, collapsible JSON viewer for a cell/row value that holds JSON
 * (D1 rows, KV metadata, Worker/DO state). Mimics Chrome DevTools object tree.
 *
 * Click any key button → copies its JSONPath (e.g. `$.user.address.city`)
 * to the clipboard and briefly shows a ✓ confirmation in an aria-live region.
 *
 * Zero dependencies — React 18 only.
 *
 * @module JsonTree
 */

import React, { useState, useCallback } from 'react';

// ────────────────────────────────────────────────────────────────────────────────
// Pure helpers (exported so specs can test them directly)
// ────────────────────────────────────────────────────────────────────────────────

/**
 * Plain-identifier regex.
 * A "plain" identifier starts with `$`, `_`, or a letter, followed by
 * `$`, `_`, letters, or digits. Only plain identifiers use dot notation in
 * JSONPath; everything else uses bracket notation with a quoted string.
 */
const PLAIN_ID = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Build one segment of a JSONPath.
 *
 * @param parentPath - The accumulated path so far (e.g. `"$"` or `"$.user"`).
 * @param keyOrIndex - The object key (string) or array index (number).
 * @param isArray    - `true` when the parent is an Array (use `[i]` syntax).
 * @returns The extended JSONPath string.
 *
 * @example
 * buildPath('$', 'user', false)         // → '$.user'
 * buildPath('$.items', 2, true)         // → '$.items[2]'
 * buildPath('$', 'x-api-key', false)    // → '$["x-api-key"]'
 *
 * @throws Never — pure function, no side effects.
 */
export function buildPath(
  parentPath: string,
  keyOrIndex: string | number,
  isArray: boolean,
): string {
  if (isArray) {
    // Array indices always use bracket notation.
    return `${parentPath}[${keyOrIndex as number}]`;
  }

  const key = keyOrIndex as string;

  if (PLAIN_ID.test(key)) {
    return `${parentPath}.${key}`;
  }

  // Escape backslashes and double-quotes inside the key.
  const escaped = key.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `${parentPath}["${escaped}"]`;
}

/**
 * Recursively collect every JSONPath reachable in `value`.
 * The root itself is always `"$"`.
 *
 * @param value      - Any JSON-compatible value.
 * @param parentPath - Starting path; defaults to `"$"`.
 * @returns Flat array of all JSONPath strings, depth-first.
 *
 * @example
 * jsonPaths({ a: [1, 2] })
 * // → ['$', '$.a', '$.a[0]', '$.a[1]']
 */
export function jsonPaths(value: unknown, parentPath = '$'): string[] {
  const paths: string[] = [parentPath];

  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      const child = buildPath(parentPath, i, true);
      paths.push(...jsonPaths(item, child).slice(1)); // skip child's own '$'
      paths.splice(paths.indexOf(child), 0); // keep child path in correct order
    });

    // Re-collect cleanly to avoid ordering issues with the splicing above.
    const clean: string[] = [parentPath];
    value.forEach((item, i) => {
      const child = buildPath(parentPath, i, true);
      clean.push(child);
      if (isObject(item) || Array.isArray(item)) {
        clean.push(...jsonPaths(item, child).slice(1));
      }
    });

    return clean;
  }

  if (isObject(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const child = buildPath(parentPath, k, false);
      paths.push(child);

      if (isObject(v) || Array.isArray(v)) {
        paths.push(...jsonPaths(v, child).slice(1));
      }
    }
  }

  return paths;
}

/** Narrowing helper — plain object, not null/array. */
function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ────────────────────────────────────────────────────────────────────────────────
// Props
// ────────────────────────────────────────────────────────────────────────────────

/** Props for the JsonTree viewer component. */
export interface JsonTreeProps {
  /** The JSON value to display — any JSON-compatible type. */
  value: unknown;
  /**
   * Optional label shown on the root summary.
   * Defaults to the type indicator (`{...}` / `[...]`).
   */
  rootLabel?: string;
}

// ────────────────────────────────────────────────────────────────────────────────
// Primitive renderer
// ────────────────────────────────────────────────────────────────────────────────

/**
 * Render a leaf value with the correct colour class.
 *
 * | Type    | Colour   | Hex       |
 * |---------|----------|-----------|
 * | null    | muted/italic | CSS var |
 * | number  | amber    | #f5c451   |
 * | boolean | cyan     | #00E5FF   |
 * | string  | green    | #7ee787   |
 * | other   | default  | —         |
 */
function PrimitiveValue({ value }: { value: unknown }): React.ReactElement {
  if (value === null) {
    return (
      <span className="italic text-bolt-elements-textTertiary opacity-70">null</span>
    );
  }

  if (typeof value === 'number') {
    return <span className="text-[#f5c451] font-mono">{String(value)}</span>;
  }

  if (typeof value === 'boolean') {
    return <span className="text-[#00E5FF] font-mono">{String(value)}</span>;
  }

  if (typeof value === 'string') {
    return <span className="text-[#7ee787] font-mono">&quot;{value}&quot;</span>;
  }

  // undefined / symbol / function (shouldn't appear in JSON but be defensive)
  return (
    <span className="text-bolt-elements-textSecondary font-mono italic">
      {String(value)}
    </span>
  );
}

// ────────────────────────────────────────────────────────────────────────────────
// Key button — copies JSONPath on click, shows ✓ briefly
// ────────────────────────────────────────────────────────────────────────────────

interface KeyButtonProps {
  /** Display label shown in the button. */
  label: string;
  /** Full JSONPath that gets written to the clipboard. */
  path: string;
  /** Shared aria-live setter so all buttons share the single live region. */
  onCopied: (msg: string) => void;
}

function KeyButton({ label, path, onCopied }: KeyButtonProps): React.ReactElement {
  const handleClick = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();

      try {
        await navigator.clipboard.writeText(path);
      } catch {
        // Clipboard unavailable (test env / no permissions) — still show flash.
      }

      onCopied('✓');
    },
    [path, onCopied],
  );

  return (
    <button
      type="button"
      data-testid="data-json-key"
      data-path={path}
      onClick={handleClick}
      className={[
        'font-mono text-[11px] text-bolt-elements-textSecondary',
        'hover:text-bolt-elements-item-contentAccent',
        'cursor-pointer bg-transparent border-0 p-0',
        'underline-offset-2 hover:underline',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#00E5FF]',
      ].join(' ')}
      aria-label={`Copy path ${path}`}
      title={path}
    >
      {label}
    </button>
  );
}

// ────────────────────────────────────────────────────────────────────────────────
// Recursive tree node
// ────────────────────────────────────────────────────────────────────────────────

interface TreeNodeProps {
  value: unknown;
  /** JSONPath of THIS node (e.g. `$.user.address`). */
  path: string;
  /** Display key label (e.g. `"address"` or `[2]`). */
  keyLabel: string;
  /** Depth from root (0 = root). */
  depth: number;
  /** Shared callback to update the aria-live region. */
  onCopied: (msg: string) => void;
}

function TreeNode({
  value,
  path,
  keyLabel,
  depth,
  onCopied,
}: TreeNodeProps): React.ReactElement {
  const isArr = Array.isArray(value);
  const isObj = isObject(value);
  const isExpandable = isArr || isObj;

  const childCount = isExpandable
    ? isArr
      ? (value as unknown[]).length
      : Object.keys(value as Record<string, unknown>).length
    : 0;

  const summaryLabel = isArr ? `[${childCount}]` : `{${childCount}}`;

  if (!isExpandable) {
    // Leaf node — inline display: key: value
    return (
      <div className="flex items-center gap-1 pl-2 py-px leading-5">
        <KeyButton label={keyLabel} path={path} onCopied={onCopied} />
        <span className="text-bolt-elements-textTertiary text-[11px] font-mono">:</span>
        <PrimitiveValue value={value} />
      </div>
    );
  }

  // Expandable — use <details>/<summary>
  const entries: Array<{ label: string; childPath: string; childValue: unknown }> = isArr
    ? (value as unknown[]).map((item, i) => ({
        label: `[${i}]`,
        childPath: buildPath(path, i, true),
        childValue: item,
      }))
    : Object.entries(value as Record<string, unknown>).map(([k, v]) => ({
        label: PLAIN_ID.test(k) ? k : `["${k.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`,
        childPath: buildPath(path, k, false),
        childValue: v,
      }));

  return (
    <details
      className="pl-2"
      // Only the root node (depth 0) starts open.
      {...(depth === 0 ? { open: true } : {})}
    >
      <summary className="flex items-center gap-1 cursor-pointer list-none py-px leading-5 select-none">
        {/* Disclosure triangle via CSS — kept accessible via the <details> semantics. */}
        <span className="inline-block w-3 text-[10px] text-bolt-elements-textTertiary select-none">
          ▶
        </span>

        <KeyButton label={keyLabel} path={path} onCopied={onCopied} />
        <span className="text-bolt-elements-textTertiary text-[11px] font-mono">:</span>
        <span className="text-bolt-elements-textTertiary text-[11px] font-mono">
          {summaryLabel}
        </span>
      </summary>

      <div className="border-l border-bolt-elements-borderColor ml-1 pl-2">
        {entries.map(({ label, childPath, childValue }) => (
          <TreeNode
            key={childPath}
            value={childValue}
            path={childPath}
            keyLabel={label}
            depth={depth + 1}
            onCopied={onCopied}
          />
        ))}
      </div>
    </details>
  );
}

// ────────────────────────────────────────────────────────────────────────────────
// Public component
// ────────────────────────────────────────────────────────────────────────────────

/**
 * JsonTree — pretty, collapsible JSON viewer with click-to-copy JSONPath.
 *
 * Objects and arrays render as expandable `<details>` elements (top level open,
 * deeper levels collapsed). Primitives render inline with type-coded colours:
 *
 * - **null** — muted italic
 * - **number** — amber `#f5c451`
 * - **boolean** — cyan `#00E5FF`
 * - **string** — green `#7ee787`
 *
 * Clicking any key button copies its full JSONPath to the clipboard
 * (`navigator.clipboard.writeText`) and briefly shows a `✓` in an
 * `aria-live="polite"` region.
 *
 * @example
 * // In DataPanel's row-detail view:
 * const isJson = (raw: string) => { try { JSON.parse(raw); return true; } catch { return false; } };
 *
 * {isJson(cellValue) && (
 *   <JsonTree value={JSON.parse(cellValue)} />
 * )}
 *
 * @example
 * // With an explicit root label:
 * <JsonTree value={parsedCell} rootLabel="response" />
 */
export const JsonTree: React.FC<JsonTreeProps> = ({ value, rootLabel }) => {
  const [liveMsg, setLiveMsg] = useState('');

  const handleCopied = useCallback((msg: string) => {
    setLiveMsg(msg);

    // Clear the flash after 1.2 s so screen readers only announce once.
    setTimeout(() => setLiveMsg(''), 1200);
  }, []);

  const isArr = Array.isArray(value);
  const isObj = isObject(value);
  const rootKeyLabel = rootLabel ?? (isArr ? '[ ]' : isObj ? '{ }' : 'value');

  return (
    <div
      data-testid="data-json-tree"
      className={[
        'font-mono text-[11px]',
        'text-bolt-elements-textSecondary',
        'bg-bolt-elements-bg-depth-3',
        'rounded-md p-2 overflow-auto',
        'leading-5',
      ].join(' ')}
    >
      {/* aria-live region for ✓ copy confirmation */}
      <span
        aria-live="polite"
        className="sr-only"
        style={{ position: 'absolute', left: '-9999px' }}
      >
        {liveMsg}
      </span>

      <TreeNode
        value={value}
        path="$"
        keyLabel={rootKeyLabel}
        depth={0}
        onCopied={handleCopied}
      />
    </div>
  );
};
