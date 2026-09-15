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
 * Normalize a raw `lines` payload into the bounded, redacted set that will be
 * written to `audit_logs`. Drops non-strings + blank lines, trims trailing
 * whitespace, caps the batch at {@link MAX_LINES_PER_CALL} and each line at
 * {@link MAX_LINE_CHARS}, and redacts secrets. Pure — same input → same output.
 *
 * @param rawLines - The `lines` field from the ingest payload (untrusted `unknown`).
 * @returns Up to {@link MAX_LINES_PER_CALL} clean, redacted, non-empty lines.
 * @example
 * prepareBuildLogLines(['  writing App.tsx  ', '', 42, 'TOKEN=sk-secret'])
 * // → ['writing App.tsx', 'TOKEN=***REDACTED***']
 */
export function prepareBuildLogLines(rawLines: unknown): string[] {
  return (Array.isArray(rawLines) ? rawLines : [])
    .filter((l): l is string => typeof l === 'string')
    .map((l) => l.replace(/\s+$/, '').trim())
    .filter(Boolean)
    .slice(0, MAX_LINES_PER_CALL)
    .map((l) => redactStreamSecrets(l).slice(0, MAX_LINE_CHARS));
}
