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

import { useId } from 'react';
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

  /**
   * Distinct-value suggestions for the TEXT widget → a native `<datalist>` (the input stays open
   * free-text; the user may pick or type). Empty/absent → a plain input. Ignored by non-text kinds.
   */
  suggestions?: string[];

  /**
   * Fired when the TEXT widget gains focus → the parent lazily loads {@link suggestions} (cache-first).
   * Lets the Add-row form fetch a column's distinct values only when its field is actually used.
   */
  onRequestSuggestions?: () => void;

  /**
   * CONSTRAINED enum options for the TEXT widget → a real `<select>` (dropdown) instead of a free-text
   * input, when the column's value domain is a small fixed set (an "enum-ish" column). Distinct from
   * {@link suggestions} (which keeps the input open free-text): `options` MEANS "pick one of these". A
   * final "Other…" entry lets the user drop back to free text for a value not in the set (so a select is
   * never a dead-end). Empty/absent → the free-text/datalist widget. Ignored by non-text kinds.
   */
  options?: string[];
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
  suggestions,
  onRequestSuggestions,
  options,
}: TypedValueFieldProps) {
  const listId = useId();

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

  /*
   * CONSTRAINED enum select — a real dropdown for a small fixed value set (an "enum-ish" TEXT column). Only
   * for the free-text TEXT widget (date/datetime/boolean/json have their own controls). A trailing "Other…"
   * sentinel drops back to free text so the select is never a dead-end. `__other__` is a UI-only marker; the
   * value it produces is the empty string until the user types (then the free-text input shows).
   */
  const enumOptions = inputType === 'text' && !disabled ? (options ?? []) : [];
  const OTHER = '__ps_other__';
  const valueInEnum = enumOptions.includes(value);

  if (enumOptions.length > 0) {
    // Show the select unless the user chose "Other…" (value not in the set AND non-empty → free text).
    const usingOther = value !== '' && !valueInEnum;

    if (!usingOther) {
      return (
        <select
          value={valueInEnum ? value : ''}
          disabled={disabled}
          onChange={(e) => onValueChange(e.target.value === OTHER ? ' ' : e.target.value)}
          data-testid={testId}
          aria-label={ariaLabel}
          className={classNames(BASE_INPUT, 'cursor-pointer', disabled ? 'opacity-40' : '')}
        >
          <option value="">{placeholder || 'Choose…'}</option>
          {enumOptions.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
          <option value={OTHER}>Other…</option>
        </select>
      );
    }

    // usingOther → fall through to the free-text input below (pre-filled with the typed value).
  }

  // A datalist only makes sense for the free-text widget (date/datetime have their own pickers).
  const listValues = inputType === 'text' && !disabled ? (suggestions ?? []) : [];
  const showList = listValues.length > 0;

  return (
    <>
      <input
        type={inputType}
        step={kind === 'datetime' ? 1 : undefined}
        value={value}
        disabled={disabled}
        onChange={(e) => onValueChange(e.target.value)}
        onFocus={onRequestSuggestions}
        data-testid={testId}
        aria-label={ariaLabel}
        placeholder={placeholder}
        spellCheck={false}
        list={showList ? listId : undefined}
        className={classNames(BASE_INPUT, disabled ? 'opacity-40' : '')}
      />
      {showList && (
        <datalist id={listId} data-testid={`${testId}-suggestions`}>
          {listValues.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </>
  );
}
