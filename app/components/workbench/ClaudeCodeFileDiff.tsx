/**
 * @file ClaudeCodeFileDiff — the reviewable per-file DIFF for a `file_touched` event
 * (WLK-39 §75 flagship, slice S2).
 *
 * @remarks
 * ## Reuses the editor's existing diff renderer — does NOT build a new diff engine
 *
 * The admin must REVIEW what Claude Code changed. Rather than invent a second diff path, this
 * renders through the SAME mechanism the editor's "Toggle inline diff against AI original" button
 * uses in {@link ../workbench/EditorPanel} (`EditorPanel.tsx` `diffPreview`): the `diff` package's
 * {@link diffLines} produces add/remove/context hunks, and each line renders as a monospace row —
 * green-tinted for additions, red-tinted for removals, muted for context, with the SAME `+ `/`- `/
 * two-space gutter. Identical visual language, one diff library, zero drift.
 *
 * ## Three content shapes, one renderer
 *   1. `before` + `after` raw content → `diffLines(before, after)` (the richest, real diff).
 *   2. a pre-rendered unified `diff` string (e.g. `createTwoFilesPatch` output from the stream) →
 *      each `+`/`-`/` ` line is classified by its leading char (hunk `@@`/`+++`/`---` headers are
 *      dropped), so an already-computed diff still renders in the same row language.
 *   3. neither (a bare `{path, change}` event) → a tasteful "no diff content" note; the row itself
 *      still proves WHICH file changed.
 *
 * Purely presentational: it takes a {@link ClaudeCodeFileTouchedEvent} and renders — no stores, no
 * fetches, no bridge. Capped at {@link MAX_DIFF_LINES} rows so a huge file never floods the panel.
 */
import { memo, useMemo } from 'react';
import { diffLines } from 'diff';
import { classNames } from '~/utils/classNames';
import type { ClaudeCodeFileTouchedEvent } from './claude-code-stream';

/** Cap rendered rows so a massive change never floods the panel (matches EditorPanel's 60-line cap). */
const MAX_DIFF_LINES = 400;

/** One rendered diff row — the kind drives the gutter glyph + tint. */
interface DiffRow {
  kind: 'add' | 'remove' | 'context';
  text: string;
}

/** Drop the trailing empty element `split('\n')` leaves on a newline-terminated string. */
function splitLines(value: string): string[] {
  const lines = value.split('\n');

  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines;
}

/**
 * Classify a pre-rendered unified-diff string into rows. Hunk/file headers (`@@`, `+++`, `---`,
 * `diff `, `index `) are dropped — they aren't change content. A leading `+`/`-` marks add/remove;
 * anything else (including a leading space) is context, with its one-space gutter stripped.
 */
function rowsFromUnifiedDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];

  for (const line of splitLines(diff)) {
    if (
      line.startsWith('@@') ||
      line.startsWith('+++') ||
      line.startsWith('---') ||
      line.startsWith('diff ') ||
      line.startsWith('index ')
    ) {
      continue;
    }

    if (line.startsWith('+')) {
      rows.push({ kind: 'add', text: line.slice(1) });
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'remove', text: line.slice(1) });
    } else {
      rows.push({ kind: 'context', text: line.startsWith(' ') ? line.slice(1) : line });
    }
  }

  return rows;
}

/** Classify a before→after pair into rows via the SAME `diffLines` the editor's inline diff uses. */
function rowsFromBeforeAfter(before: string, after: string): DiffRow[] {
  const rows: DiffRow[] = [];

  for (const change of diffLines(before, after)) {
    const kind: DiffRow['kind'] = change.added ? 'add' : change.removed ? 'remove' : 'context';

    for (const text of splitLines(change.value)) {
      rows.push({ kind, text });

      if (rows.length >= MAX_DIFF_LINES) {
        return rows;
      }
    }
  }

  return rows;
}

export interface ClaudeCodeFileDiffProps {
  /** The selected file-touched event to render a diff for. */
  event: ClaudeCodeFileTouchedEvent;
  /** Override the root `data-testid` (defaults to `cc-file-diff`). */
  testId?: string;
}

/**
 * Render a reviewable diff for ONE touched file, reusing the editor's `diffLines` row language.
 * Prefers a real `before`/`after` diff; falls back to a pre-rendered unified `diff`; else a note.
 */
export const ClaudeCodeFileDiff = memo(function ClaudeCodeFileDiff({ event, testId }: ClaudeCodeFileDiffProps) {
  const rows = useMemo<DiffRow[]>(() => {
    if (event.before !== undefined || event.after !== undefined) {
      return rowsFromBeforeAfter(event.before ?? '', event.after ?? '').slice(0, MAX_DIFF_LINES);
    }

    if (event.diff) {
      return rowsFromUnifiedDiff(event.diff).slice(0, MAX_DIFF_LINES);
    }

    return [];
  }, [event.before, event.after, event.diff]);

  return (
    <div data-testid={testId ?? 'cc-file-diff'} className="flex min-h-0 flex-1 flex-col">
      {/* File path header — always shown so the reviewer knows WHICH file this diff is for. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-3 py-2">
        <span className="i-ph:file-duotone text-base text-bolt-elements-item-contentAccent" aria-hidden="true" />
        <code
          data-testid="cc-file-diff-path"
          className="truncate text-[12px] font-medium text-bolt-elements-textPrimary"
        >
          {event.path}
        </code>
        <span
          data-testid="cc-file-diff-change"
          className="ml-auto rounded-md border border-bolt-elements-item-contentAccent/25 bg-bolt-elements-item-contentAccent/[0.08] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-bolt-elements-item-contentAccent"
        >
          {event.change}
        </span>
      </div>

      {/* Diff body — the EXACT green-add / red-remove / muted-context row language from EditorPanel. */}
      {rows.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-auto bg-bolt-elements-background-depth-1 text-xs font-mono">
          {rows.map((row, i) => (
            <div
              key={i}
              data-testid={`cc-diff-line-${i}`}
              data-diff-kind={row.kind}
              className={classNames('whitespace-pre px-3 py-0.5', {
                'bg-green-500/10 text-green-500': row.kind === 'add',
                'bg-red-500/10 text-red-500': row.kind === 'remove',
                'text-bolt-elements-textSecondary': row.kind === 'context',
              })}
            >
              {row.kind === 'add' ? '+ ' : row.kind === 'remove' ? '- ' : '  '}
              {row.text}
            </div>
          ))}
        </div>
      ) : (
        <div
          data-testid="cc-file-diff-nocontent"
          className="flex-1 px-3 py-3 text-[11px] text-bolt-elements-textTertiary"
        >
          No diff content for this file — Claude Code reported the change but didn't attach its
          contents.
        </div>
      )}
    </div>
  );
});
