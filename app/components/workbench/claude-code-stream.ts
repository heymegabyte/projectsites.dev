/**
 * @file claude-code-stream — the typed event model + pure parser for the embedded
 * "Claude Code" editor panel (WLK-39 §75 flagship, slices S0+S1).
 *
 * @remarks
 * ## The guardrail (the whole point of this file's shape)
 *
 * The panel renders a Claude Code RUN as a stream of concrete, inspectable events —
 * the actions it took, the decisions it made, the evidence it gathered, the files it
 * touched, the tests it ran, the deploy state, and raw output. It must NEVER render
 * chain-of-thought / private reasoning.
 *
 * That constraint is enforced STRUCTURALLY, not by a lint rule or a reviewer's memory:
 * {@link ClaudeCodeEvent} is a discriminated union whose `kind` has NO `thought` /
 * `reasoning` member. There is no type to hold CoT, so the renderer cannot be handed CoT,
 * and {@link parseClaudeCodeStream} DROPS any `thought`/`reasoning` line it sees rather than
 * mapping it to a variant (there is nothing to map it to). CoT is unrepresentable by design.
 *
 * ## Wire format
 *
 * The upstream stream (`POST /api/llmcall` with `streamOutput:true`, which routes to
 * ProjectSites AI via the AI Gateway) is plain UTF-8 text. Claude Code emits structured
 * lines; everything else is prose output. The parser accepts two line shapes:
 *
 *   1. A fenced JSON event — a line that is a JSON object with a `kind` field, e.g.
 *      `{"kind":"action","label":"Read package.json"}`. This is the primary, explicit shape.
 *   2. A `cc:`-prefixed directive — `cc:<kind> <payload>` (payload optional / JSON / plain),
 *      a terse shape for streamed tokens, e.g. `cc:file_touched {"path":"src/App.tsx","change":"edit"}`.
 *
 * Any line that is neither (plain prose, blank, a markdown chunk) is coalesced into an
 * `output_delta` event so the raw assistant text still shows in the Activity log. The parser
 * is PURE (string in, events out) + synchronous so it is trivially unit-testable and can be
 * called incrementally on each decoded chunk.
 */

/** The ONLY event kinds the panel can represent. DELIBERATELY NO `thought`/`reasoning`. */
export type ClaudeCodeEventKind =
  | 'action'
  | 'decision'
  | 'evidence'
  | 'file_touched'
  | 'test_result'
  | 'deploy_state'
  | 'output_delta';

/**
 * Kinds that are FORBIDDEN by construction — if the wire ever carries one of these we DROP
 * it. Exported so the spec can assert the guardrail directly (and so a future reader sees the
 * exact denylist the parser enforces). This is the chain-of-thought firewall.
 */
export const FORBIDDEN_EVENT_KINDS = ['thought', 'reasoning', 'thinking', 'scratchpad'] as const;
export type ForbiddenEventKind = (typeof FORBIDDEN_EVENT_KINDS)[number];

/** A discrete action Claude Code took (ran a command, read a file, searched). */
export interface ClaudeCodeActionEvent {
  kind: 'action';
  /** Imperative one-liner, e.g. "Read package.json" or "Searched for `parseStream`". */
  label: string;
  /** Optional detail (the exact command, the glob) shown muted under the label. */
  detail?: string;
}

/** A decision Claude Code made — the OUTCOME + its WHY, never the private deliberation. */
export interface ClaudeCodeDecisionEvent {
  kind: 'decision';
  /** The decision taken, e.g. "Use the existing `/api/llmcall` stream path". */
  label: string;
  /** The stated, user-facing rationale (a conclusion, not a thought trace). Optional. */
  rationale?: string;
}

/** A piece of evidence Claude Code gathered (a grep hit, a doc excerpt, a fact). */
export interface ClaudeCodeEvidenceEvent {
  kind: 'evidence';
  label: string;
  /** Where the evidence came from, e.g. `app/routes/api.llmcall.ts:111`. Optional. */
  source?: string;
}

/** A file Claude Code created/edited/deleted (metadata only — the diff is a later slice). */
export interface ClaudeCodeFileTouchedEvent {
  kind: 'file_touched';
  path: string;
  change: 'create' | 'edit' | 'delete';
}

/** A test result. `passed` drives the chip color; `name`/`summary` describe it. */
export interface ClaudeCodeTestResultEvent {
  kind: 'test_result';
  name: string;
  passed: boolean;
  summary?: string;
}

/** A deploy-pipeline state transition (building → deployed | failed, etc.). */
export interface ClaudeCodeDeployStateEvent {
  kind: 'deploy_state';
  state: 'idle' | 'building' | 'deploying' | 'deployed' | 'failed';
  detail?: string;
}

/** A chunk of raw assistant output text (prose that isn't a structured event). */
export interface ClaudeCodeOutputDeltaEvent {
  kind: 'output_delta';
  text: string;
}

/** The discriminated union the panel renders. No CoT member exists — that's the guardrail. */
export type ClaudeCodeEvent =
  | ClaudeCodeActionEvent
  | ClaudeCodeDecisionEvent
  | ClaudeCodeEvidenceEvent
  | ClaudeCodeFileTouchedEvent
  | ClaudeCodeTestResultEvent
  | ClaudeCodeDeployStateEvent
  | ClaudeCodeOutputDeltaEvent;

/** Narrowing helper — true for every kind the union actually carries. */
function isRenderableKind(kind: unknown): kind is ClaudeCodeEventKind {
  return (
    kind === 'action' ||
    kind === 'decision' ||
    kind === 'evidence' ||
    kind === 'file_touched' ||
    kind === 'test_result' ||
    kind === 'deploy_state' ||
    kind === 'output_delta'
  );
}

/** Coerce an arbitrary string into the file-change enum; default to `edit`. */
function coerceChange(value: unknown): ClaudeCodeFileTouchedEvent['change'] {
  return value === 'create' || value === 'delete' ? value : 'edit';
}

/** Coerce an arbitrary string into the deploy-state enum; default to `idle`. */
function coerceDeployState(value: unknown): ClaudeCodeDeployStateEvent['state'] {
  return value === 'building' || value === 'deploying' || value === 'deployed' || value === 'failed' ? value : 'idle';
}

/** Return a trimmed string for a value when it is a non-empty string, else undefined. */
function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed === '' ? undefined : trimmed;
}

/**
 * Build a validated {@link ClaudeCodeEvent} from a parsed `{ kind, ... }` object, or `null`
 * when the record is a forbidden kind, an unknown kind, or structurally invalid. This is the
 * single gate every structured line passes through — the CoT firewall lives HERE.
 */
function toEvent(record: Record<string, unknown>): ClaudeCodeEvent | null {
  const { kind } = record;

  // ── The guardrail: a forbidden (CoT) kind is DROPPED, never mapped. ──
  if (typeof kind === 'string' && (FORBIDDEN_EVENT_KINDS as readonly string[]).includes(kind)) {
    return null;
  }

  if (!isRenderableKind(kind)) {
    return null;
  }

  switch (kind) {
    case 'action': {
      const label = optionalString(record.label);
      return label ? { kind, label, detail: optionalString(record.detail) } : null;
    }
    case 'decision': {
      const label = optionalString(record.label);
      return label ? { kind, label, rationale: optionalString(record.rationale) } : null;
    }
    case 'evidence': {
      const label = optionalString(record.label);
      return label ? { kind, label, source: optionalString(record.source) } : null;
    }
    case 'file_touched': {
      const path = optionalString(record.path);
      return path ? { kind, path, change: coerceChange(record.change) } : null;
    }
    case 'test_result': {
      const name = optionalString(record.name);
      return name ? { kind, name, passed: record.passed === true, summary: optionalString(record.summary) } : null;
    }
    case 'deploy_state': {
      return { kind, state: coerceDeployState(record.state), detail: optionalString(record.detail) };
    }
    case 'output_delta': {
      const text = typeof record.text === 'string' ? record.text : '';
      return text === '' ? null : { kind, text };
    }
    default:
      return null;
  }
}

/** Parse a single line into an event (JSON shape OR `cc:` shape), or `null` to drop it. */
function parseLine(line: string): ClaudeCodeEvent | null {
  const trimmed = line.trim();

  if (trimmed === '') {
    return null;
  }

  // Shape 1 — a bare JSON object with a `kind`.
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;

      if (parsed && typeof parsed === 'object' && 'kind' in parsed) {
        return toEvent(parsed as Record<string, unknown>);
      }
    } catch {
      // Not valid JSON after all — fall through and treat it as prose output.
    }
  }

  // Shape 2 — `cc:<kind> <payload?>`.
  if (trimmed.startsWith('cc:')) {
    const body = trimmed.slice(3);
    const spaceIdx = body.indexOf(' ');
    const kind = (spaceIdx === -1 ? body : body.slice(0, spaceIdx)).trim();
    const payloadRaw = spaceIdx === -1 ? '' : body.slice(spaceIdx + 1).trim();

    // Forbidden kinds are dropped before we even attempt to build a record.
    if ((FORBIDDEN_EVENT_KINDS as readonly string[]).includes(kind)) {
      return null;
    }

    let record: Record<string, unknown> = { kind };

    if (payloadRaw.startsWith('{') && payloadRaw.endsWith('}')) {
      try {
        const parsed = JSON.parse(payloadRaw) as unknown;

        if (parsed && typeof parsed === 'object') {
          record = { ...(parsed as Record<string, unknown>), kind };
        }
      } catch {
        // Non-JSON payload — treat the whole payload as the primary string field below.
      }
    } else if (payloadRaw !== '') {
      // Map a plain payload onto the kind's primary field so `cc:action Ran tests` works.
      const primary =
        kind === 'file_touched'
          ? 'path'
          : kind === 'test_result'
            ? 'name'
            : kind === 'deploy_state'
              ? 'state'
              : kind === 'output_delta'
                ? 'text'
                : 'label';
      record[primary] = payloadRaw;
    }

    return toEvent(record);
  }

  // Shape 3 — anything else is raw assistant prose → an output_delta.
  return { kind: 'output_delta', text: trimmed };
}

/**
 * Parse a Claude Code stream (or stream chunk) into the renderable event list.
 *
 * PURE + synchronous: splits on newlines, maps each line through {@link parseLine}, and drops
 * nulls (blank lines + every forbidden CoT line). Safe to call per decoded chunk — the caller
 * accumulates the returned events. No chain-of-thought can survive this function.
 *
 * @param text - raw UTF-8 text from the stream (a full response or a single chunk).
 * @returns the ordered {@link ClaudeCodeEvent}s, CoT excluded by construction.
 */
export function parseClaudeCodeStream(text: string): ClaudeCodeEvent[] {
  if (typeof text !== 'string' || text === '') {
    return [];
  }

  const events: ClaudeCodeEvent[] = [];

  for (const line of text.split('\n')) {
    const event = parseLine(line);

    if (event) {
      events.push(event);
    }
  }

  return events;
}
