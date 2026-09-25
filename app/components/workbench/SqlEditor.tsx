/**
 * @module components/workbench/SqlEditor
 *
 * A dependency-free SQL editor with SQLite-aware syntax highlighting for the Data console.
 * Implemented as a highlighted-textarea OVERLAY (not CodeMirror — bolt.diy ships the CodeMirror
 * suite but not `@codemirror/lang-sql`, and a real textarea keeps native caret / selection / undo
 * / IME behaviour the console's history/saved-query/⌘↵ wiring already depends on):
 *
 *   • a `<pre aria-hidden>` in normal flow renders {@link tokenizeSql} colour spans and DRIVES the
 *     height (grows with content);
 *   • a transparent-text `<textarea>` is absolutely overlaid (`inset-0`), so it always covers the
 *     pre exactly — identical inline typography on both guarantees glyph-perfect alignment with NO
 *     scroll-sync. The caret shows via `caretColor`; the pre paints the colours behind it.
 *
 * The `<pre>` is aria-hidden (decorative); the `<textarea>` is the real, labelled input.
 */
import { memo, useMemo, type KeyboardEvent } from 'react';

import { tokenizeSql, type SqlTokenKind } from './sql-highlight';

/** Colour per token kind. Keyword uses the brand cyan; string/number/comment are conventional. */
const KIND_CLASS: Record<SqlTokenKind, string> = {
  keyword: 'text-[#00E5FF] font-semibold',
  string: 'text-[#7ee787]',
  comment: 'text-bolt-elements-textTertiary italic',
  number: 'text-[#f5c451]',
  punct: 'text-bolt-elements-textSecondary',
  text: 'text-bolt-elements-textPrimary',
};

/**
 * Typography applied IDENTICALLY (inline, so no CSS-cascade drift) to the `<pre>` and the
 * `<textarea>`. Any divergence in font / size / line-height / padding / wrapping misaligns the
 * highlight from the caret, so these MUST stay in lockstep.
 */
const TYPO: React.CSSProperties = {
  margin: 0,
  padding: '8px 12px',
  border: '1px solid transparent',
  font: '12px / 1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  overflowWrap: 'break-word',
  boxSizing: 'border-box',
};

export interface SqlEditorProps {
  readonly value: string;
  readonly onValueChange: (next: string) => void;
  /** Fired on ⌘↵ / Ctrl↵ — run the current query. */
  readonly onRun: () => void;
  readonly placeholder?: string;
  /** Minimum visible rows (the editor auto-grows beyond this). */
  readonly minRows?: number;
  readonly testId?: string;
}

/**
 * SQLite-highlighted SQL editor. Controlled: `value` + `onValueChange` mirror a `<textarea>`;
 * `onRun` handles ⌘↵. Auto-grows with content (the pre drives height); a minimum of `minRows`.
 */
export const SqlEditor = memo(function SqlEditor({
  value,
  onValueChange,
  onRun,
  placeholder,
  minRows = 4,
  testId,
}: SqlEditorProps) {
  const tokens = useMemo(() => tokenizeSql(value), [value]);
  // 1.5 line-height × 12px + 16px vertical padding, per TYPO.
  const minHeight = `${minRows * 1.5 * 12 + 16}px`;

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      onRun();
    }
  };

  return (
    <div
      className="relative w-full rounded-md bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor focus-within:border-bolt-elements-item-contentAccent/50"
      style={{ minHeight }}
    >
      <pre
        aria-hidden="true"
        data-testid="data-sql-highlight"
        className="pointer-events-none select-none overflow-hidden"
        style={{ ...TYPO, minHeight }}
      >
        {tokens.map((t, idx) => (
          <span key={idx} className={KIND_CLASS[t.kind]}>
            {t.text}
          </span>
        ))}
        {/* Guard: an input ending in a newline needs a trailing glyph so the pre reserves that
            final line's height — otherwise the textarea (which does reserve it) grows taller than
            the pre and the last line's highlight drifts up. A space in the aria-hidden pre only. */}
        {value.endsWith('\n') || value === '' ? ' ' : ''}
      </pre>
      <textarea
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={onKeyDown}
        spellCheck={false}
        placeholder={placeholder}
        data-testid={testId}
        className="absolute inset-0 w-full h-full block bg-transparent placeholder:text-bolt-elements-textTertiary focus:outline-none overflow-hidden"
        style={{ ...TYPO, minHeight, color: 'transparent', caretColor: '#00E5FF', resize: 'none' }}
      />
    </div>
  );
});
