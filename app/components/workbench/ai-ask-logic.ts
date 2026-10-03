/**
 * "Ask AI" intent routing for the Site Data grid (WLK-04).
 *
 * The editor Data-tab used to expose TWO split AI buttons ("AI filter" + "AI
 * column"). They are unified into ONE "Ask AI" box: the user types a plain
 * request, the model classifies it into one of three concrete actions, and the
 * client dispatches to the existing (resilient) handler. This module is the
 * PURE, unit-tested core of that routing — no React, no network:
 *
 *   • {@link buildAskSystemPrompt} — the grounding system prompt that asks the
 *     model to return a strict `{action, …}` JSON plan over the real schema.
 *   • {@link parseAskPlan} — robustly parse + validate the model's JSON into a
 *     typed {@link AskPlan}, tolerating ```json fences and junk.
 *
 * Keeping this pure means the "which action did the user mean" decision is
 * testable without a live model (see `ai-ask-logic.spec.ts`).
 */

/** The three concrete grid actions a free-text "Ask AI" request can map to. */
export type AskAction = 'filter' | 'column' | 'fill';

/** A validated plan the client dispatches after the model classifies the request. */
export interface AskPlan {
  /** Which grid action to run. */
  action: AskAction;

  /** For `fill`: the target column name (the model picks from the schema). */
  column?: string;

  /**
   * The natural-language instruction to hand to the chosen action's existing
   * handler (e.g. the filter phrasing, the column description, the fill rule).
   * Defaults to the user's original text when the model omits it.
   */
  instruction: string;
}

/** Strip a leading/trailing markdown code fence the model sometimes wraps JSON in. */
export function stripJsonFence(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();
}

/**
 * Build the system prompt that turns a free-text request into a typed action
 * plan. The model is grounded on the real schema + the current selection so it
 * can pick `fill` (and a column) only when rows are selected.
 *
 * @param schemaOutline - Human-readable schema (columns + types) for grounding.
 * @param hasSelection - Whether any rows are currently selected (enables `fill`).
 */
export function buildAskSystemPrompt(schemaOutline: string, hasSelection: boolean): string {
  return [
    'You are a data-grid assistant. Classify the user request into ONE action and return ONLY minified JSON.',
    'Shape: {"action":"filter|column|fill","column":"<name, only for fill>","instruction":"<what to do, in plain words>"}',
    'Actions:',
    '• "filter" — narrow/sort the visible rows (e.g. "orders over $100", "newest first").',
    '• "column" — add a NEW computed/derived column (e.g. "add a status column", "a full_name column").',
    hasSelection
      ? '• "fill" — write values into an existing column for the SELECTED rows (e.g. "summarize each row"). Set "column" to the target.'
      : '• "fill" — NOT available right now (no rows are selected). Never choose "fill".',
    'If the request is ambiguous, prefer "filter". Keep "instruction" faithful to the user; omit "column" unless action is "fill".',
    '',
    'SCHEMA:',
    schemaOutline,
  ].join('\n');
}

/**
 * Parse the model's reply into a validated {@link AskPlan}. Falls back to a
 * `filter` plan over the user's raw text when the action is missing/invalid, so
 * a flaky classification degrades to the safest action rather than dead-ending.
 *
 * @param raw - The model's text reply (may be fenced JSON or noisy).
 * @param userText - The user's original request (instruction fallback).
 * @param hasSelection - When false, a `fill` plan is downgraded to `filter`
 *   (fill is impossible with no selection — never strand the user).
 * @returns A typed plan, always valid and dispatchable.
 */
export function parseAskPlan(raw: string, userText: string, hasSelection: boolean): AskPlan {
  const fallback: AskPlan = { action: 'filter', instruction: userText.trim() };

  let obj: { action?: unknown; column?: unknown; instruction?: unknown };

  try {
    obj = JSON.parse(stripJsonFence(raw)) as typeof obj;
  } catch {
    return fallback;
  }

  const action = obj.action;

  if (action !== 'filter' && action !== 'column' && action !== 'fill') {
    return fallback;
  }

  // `fill` is only legal with a selection; otherwise downgrade (never strand).
  if (action === 'fill' && !hasSelection) {
    return fallback;
  }

  const instruction =
    typeof obj.instruction === 'string' && obj.instruction.trim() ? obj.instruction.trim() : userText.trim();

  const column = typeof obj.column === 'string' && obj.column.trim() ? obj.column.trim() : undefined;

  return action === 'fill' ? { action, column, instruction } : { action, instruction };
}
