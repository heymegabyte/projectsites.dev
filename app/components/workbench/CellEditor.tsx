/**
 * @file CellEditor — the shared typed single-cell editor for the Data tab. Extracted from the grid's
 * inline row-detail so BOTH the grid detail AND the record drawer render the exact same editor (no
 * duplication). Purely presentational: the edit state (kind/value/error/busy) + the save/cancel
 * handlers live in the parent (DataPanel); this component just renders the widget. The parent decides
 * WHICH row is edited (grid detail row vs drawer row) via `onSave`/`previewSql`.
 */

import { classNames } from '~/utils/classNames';
import { CELL_INPUT_KIND_OPTIONS, type CellInputKind } from './data-panel-logic';
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

  /** The parameterized UPDATE SQL preview (SQL shape only — the value binds as ?1), or null. */
  previewSql: string | null;

  /** A human error from a failed coerce/build, or ''. */
  editError: string;

  /** True while the UPDATE round-trip is in flight (disables Save/Cancel). */
  editBusy: boolean;
  onSave: () => void;
  onCancel: () => void;
}

/** The typed cell editor: type-select + value input + live SQL preview + error + Save/Cancel. */
export function CellEditor({
  label,
  editKind,
  onKindChange,
  editValue,
  onValueChange,
  previewSql,
  editError,
  editBusy,
  onSave,
  onCancel,
}: CellEditorProps) {
  return (
    <div className="flex w-full flex-col gap-1" data-testid="data-edit-cell">
      <div className="flex items-start gap-1.5">
        <select
          value={editKind}
          onChange={(e) => onKindChange(e.target.value as CellInputKind)}
          data-testid="data-edit-kind"
          aria-label={`Type for ${label}`}
          className="shrink-0 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-1 py-0.5 text-[10px] text-bolt-elements-textPrimary focus:outline-none"
        >
          {CELL_INPUT_KIND_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <TypedValueField
          kind={editKind}
          value={editValue}
          onValueChange={onValueChange}
          disabled={editKind === 'null'}
          ariaLabel={`New value for ${label}`}
          placeholder={editKind === 'null' ? 'NULL' : editKind === 'json' ? '{"key":"value"}' : ''}
          testId="data-edit-value"
        />
      </div>
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
