/**
 * @file CellEditor — the shared typed single-cell editor for the Data tab. Extracted from the grid's
 * inline row-detail so BOTH the grid detail AND the record drawer render the exact same editor (no
 * duplication). Purely presentational: the edit state (kind/value/error/busy) + the save/cancel
 * handlers live in the parent (DataPanel); this component just renders the widget. The parent decides
 * WHICH row is edited (grid detail row vs drawer row) via `onSave`/`previewSql`.
 */

import { classNames } from '~/utils/classNames';
import { nullabilityHint, type CellInputKind } from './data-panel-logic';
import { TypedValueField } from './TypedValueField';

export interface CellEditorProps {
  /** Column label (for aria-labels only). */
  label: string;

  /** The chosen input type. */
  editKind: CellInputKind;
  onKindChange: (kind: CellInputKind) => void;

  /** The raw string value being entered (ignored when kind === 'null'). */
  editValue: string;
  onValueChange: (value: string) => void;

  /**
   * Bounded distinct values of this column → a "pick an existing value" datalist on the text widget
   * (select-like hint; the input stays open free-text). Empty/absent → a plain text input.
   */
  suggestions?: string[];

  /** Fired when the text widget gains focus → the parent lazily loads {@link suggestions} (cache-first). */
  onRequestSuggestions?: () => void;

  /**
   * CONSTRAINED enum options → a real `<select>` dropdown on the TEXT widget (for an "enum-ish" column with a
   * small fixed value set), with a trailing "Other…" escape to free text. Distinct from {@link suggestions}
   * (open free-text): `options` MEANS "pick one of these". Empty/absent → the free-text/datalist widget.
   */
  options?: string[];

  /** The parameterized UPDATE SQL preview (SQL shape only — the value binds as ?1), or null. */
  previewSql: string | null;

  /** A human error from a failed coerce/build, or ''. */
  editError: string;

  /** True while the UPDATE round-trip is in flight (disables Save/Cancel). */
  editBusy: boolean;
  onSave: () => void;
  onCancel: () => void;
}

/** The cell editor: value input + live SQL preview + error + Save/Cancel (type is set per-column, not per-edit). */
export function CellEditor({
  label,
  editKind,
  onKindChange,
  editValue,
  onValueChange,
  suggestions,
  onRequestSuggestions,
  options,
  previewSql,
  editError,
  editBusy,
  onSave,
  onCancel,
}: CellEditorProps) {
  const nullHint = nullabilityHint(editKind, editValue);

  /*
   * The NULL⇄empty-text toggle is only meaningful for the ambiguous text/null pair (number/boolean/date
   * have unambiguous widgets; an empty date/json already throws on save, guiding the user to NULL).
   */
  const showNullToggle = editKind === 'text' || editKind === 'null';

  return (
    <div className="flex w-full flex-col gap-1" data-testid="data-edit-cell">
      <div className="flex items-start gap-1.5">
        {/*
         * VALUE-ONLY: the per-edit data-type <select> was removed (Brian 2026-09-28) — a cell editor
         * shows the VALUE, not the type. The input KIND is inferred from the column's declared type
         * (editorKindForColumn) and the column's type is changed at the COLUMN level (header edit menu
         * / add-column), never mid-edit. The NULL toggle below is a value affordance, not a type.
         */}
        <TypedValueField
          kind={editKind}
          value={editValue}
          onValueChange={onValueChange}
          disabled={editKind === 'null'}
          ariaLabel={`New value for ${label}`}
          placeholder={editKind === 'null' ? 'NULL' : editKind === 'json' ? '{"key":"value"}' : ''}
          suggestions={suggestions}
          onRequestSuggestions={onRequestSuggestions}
          options={options}
          testId="data-edit-value"
        />
        {showNullToggle && (
          <button
            type="button"
            onClick={() => onKindChange(editKind === 'null' ? 'text' : 'null')}
            aria-pressed={editKind === 'null'}
            data-testid="data-edit-null-toggle"
            title={
              editKind === 'null'
                ? 'Currently NULL — click to enter an empty string instead'
                : 'Set this cell to NULL (no value)'
            }
            className={classNames(
              'shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium transition-colors',
              editKind === 'null'
                ? 'border-[#00e5ff]/40 bg-[#00e5ff]/15 text-[#00E5FF]'
                : 'border-bolt-elements-borderColor text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary',
            )}
          >
            ∅ NULL
          </button>
        )}
      </div>
      {nullHint && (
        <p className="text-[10px] text-bolt-elements-textTertiary" data-testid="data-edit-null-hint">
          {nullHint}
        </p>
      )}
      {previewSql && (
        <div
          className="overflow-x-auto rounded bg-bolt-elements-background-depth-2 px-2 py-1 text-[10px] text-bolt-elements-textTertiary"
          data-testid="data-edit-preview"
        >
          {previewSql}
        </div>
      )}
      {editError && (
        <p className="text-[10px] text-red-400" role="alert" data-testid="data-edit-error">
          {editError}
        </p>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onSave}
          disabled={editBusy}
          data-testid="data-edit-save"
          className={classNames(
            'rounded px-2 py-0.5 text-[10px] font-medium',
            editBusy
              ? 'cursor-not-allowed bg-bolt-elements-background-depth-3 text-bolt-elements-textTertiary'
              : 'cursor-pointer bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent hover:opacity-90',
          )}
        >
          {editBusy ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={editBusy}
          data-testid="data-edit-cancel"
          className="cursor-pointer text-[10px] text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
