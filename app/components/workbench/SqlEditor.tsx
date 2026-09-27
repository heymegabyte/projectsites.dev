/**
 * @module components/workbench/SqlEditor
 *
 * A dependency-free SQL editor with SQLite-aware syntax highlighting AND schema-aware completion
 * for the Data console. Implemented as a highlighted-textarea OVERLAY (not CodeMirror — bolt.diy
 * ships the CodeMirror suite but not `@codemirror/lang-sql`, and a real textarea keeps native caret
 * / selection / undo / IME + the console's history/saved/⌘↵ wiring):
 *
 *   • a `<pre aria-hidden>` in normal flow renders {@link tokenizeSql} colour spans and DRIVES the
 *     height; a transparent-text `<textarea>` is absolutely overlaid — identical inline typography →
 *     glyph-perfect alignment, no scroll-sync;
 *   • when a `schema` is supplied, {@link sqlCompletions} offers real table/column/keyword candidates
 *     for the word being typed, in a keyboard-navigable dropdown (↑↓ move · Tab/↵ accept · Esc close).
 */
import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { tokenizeSql, type SqlTokenKind } from './sql-highlight';
import { applyCompletion, sqlCompletions, type SqlCompletion, type SqlSchema } from './sql-complete';

/** Colour per token kind. Keyword uses the brand cyan; string/number/comment are conventional. */
const KIND_CLASS: Record<SqlTokenKind, string> = {
  keyword: 'text-[#00E5FF] font-semibold',
  string: 'text-[#7ee787]',
  comment: 'text-bolt-elements-textTertiary italic',
  number: 'text-[#f5c451]',
  punct: 'text-bolt-elements-textSecondary',
  text: 'text-bolt-elements-textPrimary',
};

/** Short badge per completion kind. */
const COMPLETION_BADGE: Record<SqlCompletion['kind'], string> = {
  table: 'tbl',
  column: 'col',
  keyword: 'kw',
};

/** Typography applied IDENTICALLY (inline) to the `<pre>` and `<textarea>` — any drift misaligns. */
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
  /** Fired on ⌘↵ / Ctrl↵ (when the completion dropdown is closed) — run the current query. */
  readonly onRun: () => void;
  readonly placeholder?: string;
  readonly minRows?: number;
  readonly testId?: string;
  /** Inspected schema for completion (real table + column identifiers). Omit to disable completion. */
  readonly schema?: SqlSchema;
}

/**
 * SQLite-highlighted, schema-completing SQL editor. Controlled (`value` + `onValueChange`); `onRun`
 * handles ⌘↵. Auto-grows (the `<pre>` drives height), minimum `minRows`.
 */
export const SqlEditor = memo(function SqlEditor({
  value,
  onValueChange,
  onRun,
  placeholder,
  minRows = 4,
  testId,
  schema,
}: SqlEditorProps) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);

  const tokens = useMemo(() => tokenizeSql(value), [value]);
  const minHeight = `${minRows * 1.5 * 12 + 16}px`;

  // Completions for the word left of the caret (only when a schema is supplied + not just dismissed).
  const completions = useMemo<SqlCompletion[]>(() => {
    if (!schema || dismissed) return [];
    return sqlCompletions(value.slice(0, caret), schema);
  }, [schema, dismissed, value, caret]);
  const open = completions.length > 0;

  // Keep activeIdx in range as the candidate list changes.
  useEffect(() => {
    if (activeIdx >= completions.length) setActiveIdx(0);
  }, [completions.length, activeIdx]);

  // After we programmatically change the value (completion accept), restore the caret.
  useEffect(() => {
    if (pendingCaret.current != null && taRef.current) {
      const pos = pendingCaret.current;
      pendingCaret.current = null;
      taRef.current.setSelectionRange(pos, pos);
      setCaret(pos);
    }
  }, [value]);

  const syncCaret = (): void => {
    if (taRef.current) setCaret(taRef.current.selectionStart ?? 0);
  };

  const accept = (c: SqlCompletion): void => {
    const { text, caret: nextCaret } = applyCompletion(value, caret, c.label);
    pendingCaret.current = nextCaret;
    setDismissed(true); // don't immediately re-open on the freshly-inserted word
    onValueChange(text);
    taRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => (i + 1) % completions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => (i - 1 + completions.length) % completions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        // Enter/Tab accept the highlighted completion (⌘↵ still runs — handled below).
        if (!(e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          accept(completions[activeIdx] ?? completions[0]);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }
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
        {value.endsWith('\n') || value === '' ? ' ' : ''}
      </pre>
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => {
          setDismissed(false);
          onValueChange(e.target.value);
          setCaret(e.target.selectionStart ?? 0);
        }}
        onKeyDown={onKeyDown}
        onKeyUp={syncCaret}
        onClick={syncCaret}
        onSelect={syncCaret}
        spellCheck={false}
        placeholder={placeholder}
        data-testid={testId}
        aria-autocomplete={schema ? 'list' : undefined}
        className="absolute inset-0 w-full h-full block bg-transparent placeholder:text-bolt-elements-textTertiary focus:outline-none overflow-hidden"
        style={{ ...TYPO, minHeight, color: 'transparent', caretColor: '#00E5FF', resize: 'none' }}
      />
      {open && (
        <ul
          data-testid="data-sql-completions"
          role="listbox"
          aria-label="SQL completions"
          className="absolute left-2 top-full z-20 mt-1 max-h-56 w-64 overflow-auto rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 py-1 shadow-lg"
        >
          {completions.map((c, idx) => (
            <li
              key={`${c.kind}:${c.label}`}
              role="option"
              aria-selected={idx === activeIdx}
              data-testid="data-sql-completion"
              onMouseDown={(e) => {
                e.preventDefault(); // keep textarea focus
                accept(c);
              }}
              onMouseEnter={() => setActiveIdx(idx)}
              className={
                'flex items-center gap-2 px-2 py-1 text-[12px] cursor-pointer ' +
                (idx === activeIdx
                  ? 'bg-bolt-elements-item-contentAccent/15 text-bolt-elements-textPrimary'
                  : 'text-bolt-elements-textSecondary')
              }
            >
              <span
                className={
                  'shrink-0 rounded px-1 text-[9px] font-mono uppercase ' +
                  (c.kind === 'keyword'
                    ? 'text-[#00E5FF]'
                    : 'text-bolt-elements-textTertiary')
                }
              >
                {COMPLETION_BADGE[c.kind]}
              </span>
              <span className="truncate font-mono">{c.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});
