/**
 * @module build_log
 *
 * Pure helpers for the LIVE build-log stream (`POST /api/internal/build-log`).
 *
 * The build container streams its Claude Code stdout to the worker in batches;
 * the worker persists each line to `audit_logs` (action `claude.output`, raw text
 * in `metadata_json.message`) so the /waiting page's gorgeous terminal
 * (`waiting.component` → `toBuildLogLine`) can render the AI building the site live.
 *
 * These two functions are the risky, deterministic core of that ingest — secret
 * redaction (a leaked key must never land at rest) and the unbounded-write cap (a
 * runaway container must never flood `audit_logs`). Extracted here so they are
 * unit-testable in isolation, without importing the whole Worker entry (`index.ts`).
 */

/** Hard caps for one ingest call — keep `audit_logs` growth bounded. */
export const MAX_LINES_PER_CALL = 40;
export const MAX_LINE_CHARS = 500;

/**
 * Redact secret-shaped tokens from a build-log line BEFORE it is persisted or
 * rendered. Defense-in-depth mirror of the frontend `redactBuildLogSecrets`
 * (waiting.component.ts) — the STORED row must be clean even though the client also
 * scrubs on render, so a leaked credential never lands at rest.
 *
 * @param text - One raw stdout line from the build container.
 * @returns The line with `KEY=…` / `sk-…` / `AKIA…` / `phc_…` / `re_…` / `Bearer …` tokens masked.
 * @example
 * redactStreamSecrets('export OPENAI_API_KEY=sk-abcdef123456')
 * // → 'export OPENAI_API_KEY=***REDACTED***'
 */
export function redactStreamSecrets(text: string): string {
  return text
    .replace(
      /(AUTH_TOKEN|API_KEY|ACCESS_KEY|SECRET(?:_KEY)?|PASSWORD|TOKEN)(\s*[=:]\s*)\S+/gi,
      '$1$2***REDACTED***',
    )
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, 'sk-***REDACTED***')
    .replace(/\bAKIA[0-9A-Z]{8,}\b/g, 'AKIA***REDACTED***')
    .replace(/\bphc_[A-Za-z0-9]{16,}\b/g, 'phc_***REDACTED***')
    .replace(/\bre_[A-Za-z0-9]{12,}\b/g, 're_***REDACTED***')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{10,}\b/gi, 'Bearer ***REDACTED***');
}

/**
 * Claude Code control-plane + provider-transport lines that must NEVER reach the
 * owner-facing /waiting terminal. These are internal telemetry / model-catalog
 * warnings and raw upstream API errors (e.g. a `402 Insufficient Balance` when the
 * build LLM balance is exhausted) — meaningless AND alarming to a business owner
 * watching their site build. Dropping them keeps the theater trust-building: real
 * narration streams; control-plane noise + scary infra errors do not.
 *
 * SPECIFIC by design — matches only Claude Code's own control-plane tags + upstream
 * transport errors, never a generic `error`, so a GENUINE build error
 * (`Error: Cannot find module …`) still streams (and `classifyLogLine` colors it red).
 */
const BUILD_LOG_NOISE: readonly RegExp[] = [
  /\[claude-code:/i, // internal control-plane tag, e.g. [claude-code:unrecognized_model]
  /\bunrecognized_model\b/i,
  /\bgenerate_session_title\b/i,
  /model catalog/i, // "…isn't described by this version's model catalog…"
  /\bbehavesAs\b/i, // "…map it with behavesAs on a modelPicker row"
  /"query_source"\s*:/i, // the raw JSON control payload
  /^\s*API Error:\s*\d{3}\b/i, // upstream provider transport error (402 / 429 / 5xx)
  /\binsufficient balance\b/i, // billing/quota exhaustion — never show to the owner
];

/**
 * True when a build-log line is Claude Code control-plane / provider-transport NOISE
 * that must be dropped before it reaches `audit_logs` or the /waiting terminal. Pure +
 * exported for unit coverage; mirrored on the frontend (`waiting.component` isBuildLogNoise)
 * so the stored row AND the rendered line stay clean.
 *
 * @param line - One raw stdout line from the build container.
 * @returns `true` to DROP the line, `false` to keep it.
 * @example
 * isBuildLogNoise('API Error: 402 Insufficient Balance') // → true
 * isBuildLogNoise('writing src/components/Hero.tsx')      // → false
 */
export function isBuildLogNoise(line: string): boolean {
  return BUILD_LOG_NOISE.some((re) => re.test(line));
}

/**
 * Normalize a raw `lines` payload into the bounded, redacted set that will be
 * written to `audit_logs`. Drops non-strings + blank lines, trims trailing
 * whitespace, drops Claude Code control-plane + provider-transport {@link isBuildLogNoise},
 * caps the batch at {@link MAX_LINES_PER_CALL} and each line at {@link MAX_LINE_CHARS},
 * and redacts secrets. Pure — same input → same output.
 *
 * @param rawLines - The `lines` field from the ingest payload (untrusted `unknown`).
 * @returns Up to {@link MAX_LINES_PER_CALL} clean, redacted, non-empty, non-noise lines.
 * @example
 * prepareBuildLogLines(['  writing App.tsx  ', '', 42, 'TOKEN=sk-secret', 'API Error: 402 Insufficient Balance'])
 * // → ['writing App.tsx', 'TOKEN=***REDACTED***']
 */
export function prepareBuildLogLines(rawLines: unknown): string[] {
  return (Array.isArray(rawLines) ? rawLines : [])
    .filter((l): l is string => typeof l === 'string')
    .map((l) => l.replace(/\s+$/, '').trim())
    .filter(Boolean)
    .filter((l) => !isBuildLogNoise(l))
    .slice(0, MAX_LINES_PER_CALL)
    .map((l) => redactStreamSecrets(l).slice(0, MAX_LINE_CHARS));
}
