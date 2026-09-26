/**
 * @file TypedValueField — the shared, per-KIND value input for the Data tab's cell editors. ONE widget
 * so the grid/drawer `<CellEditor>` and the Add-row form render the exact same control for each
 * `CellInputKind` (they would otherwise drift — the same reason the type `<select>` reads from the
 * single `CELL_INPUT_KIND_OPTIONS`). Purely presentational: the value string + change handler live in
 * the parent; this only chooses the widget. Every kind edits a STRING that the parent later coerces +
 * BINDS as a `?` param (never concatenated) — the widget is a UI affordance, not a storage guarantee.
 *
 *   text / number / (null, disabled) → a single-line `<input>`
 *   date / datetime                  → a native date / datetime-local picker
 *   boolean                          → a checkbox with an explicit true/false label
 *   json                             → a multi-line `<textarea>` with a live "not valid JSON yet" hint
 */

import { classNames } from '~/utils/classNames';
import { isValidJsonText, type CellInputKind } from './data-panel-logic';

export interface TypedValueFieldProps {
  /** The chosen input kind (drives which widget renders). */
  kind: CellInputKind;

  /** The raw string value being entered. For `boolean` it is `'true'`/`'false'`. */
  value: string;
  onValueChange: (value: string) => void;

  /** Disable the control (e.g. `null`/`default` kinds that take no user value). */
  disabled?: boolean;

  /** Accessible label for the control (there is no visible `<label>` in the compact rows). */
  ariaLabel: string;

  /** Placeholder for the text/number/json widgets (ignored by checkbox/date). */
  placeholder?: string;

  /** `data-testid` for the primary control (e.g. `data-edit-value` / `data-add-value`). */
  testId: string;

  /** Textarea height for the `json` kind (rows). Default 5 (compact forms pass fewer). */
  jsonRows?: number;
}

const BASE_INPUT =
  'min-w-0 flex-1 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-2 py-0.5 text-[11px] text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:outline-none';

/** The per-kind value widget. See the file header for the kind → widget mapping. */
export function TypedValueField({
  kind,
  value,
  onValueChange,
  disabled = false,
  ariaLabel,
  placeholder,
  testId,
  jsonRows = 5,
}: TypedValueFieldProps) {
  if (kind === 'boolean') {
    const checked = value === 'true';

    return (
      <label className="flex flex-1 items-center gap-2 text-[11px] text-bolt-elements-textPrimary">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onValueChange(e.target.checked ? 'true' : 'false')}
          data-testid={testId}
          aria-label={ariaLabel}
          className="h-3.5 w-3.5 accent-[#00e5ff]"
        />
        <span className={checked ? 'font-medium text-[#00E5FF]' : 'text-bolt-elements-textTertiary'}>
          {checked ? 'true' : 'false'}
        </span>
      </label>
    );
  }

  if (kind === 'json') {
    // Live validity: only flag NON-EMPTY invalid JSON (an empty field is "not filled", not "wrong").
    const showInvalid = !disabled && value.trim() !== '' && !isValidJsonText(value);

    return (
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <textarea
          value={value}
          disabled={disabled}
          onChange={(e) => onValueChange(e.target.value)}
          rows={jsonRows}
          spellCheck={false}
          data-testid={testId}
          aria-label={ariaLabel}
          aria-invalid={showInvalid || undefined}
          placeholder={placeholder}
          className={classNames(
            BASE_INPUT,
            'resize-y font-mono leading-snug',
            showInvalid ? 'border-red-400/60' : '',
            disabled ? 'opacity-40' : '',
          )}
        />
        {showInvalid && (
          <span className="text-[10px] text-red-400" role="alert" data-testid={`${testId}-json-invalid`}>
            not valid JSON yet
          </span>
        )}
      </div>
    );
  }

  const inputType = kind === 'date' ? 'date' : kind === 'datetime' ? 'datetime-local' : 'text';

  return (
    <input
      type={inputType}
      step={kind === 'datetime' ? 1 : undefined}
      value={value}
      disabled={disabled}
      onChange={(e) => onValueChange(e.target.value)}
      data-testid={testId}
      aria-label={ariaLabel}
      placeholder={placeholder}
      spellCheck={false}
      className={classNames(BASE_INPUT, disabled ? 'opacity-40' : '')}
    />
  );
}
