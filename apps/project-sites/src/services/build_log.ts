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

/** Carriage return (0x0d) built via charCode so no raw control byte lives in this source file. */
const CARRIAGE_RETURN = String.fromCharCode(13);

/**
 * Strip ANSI escape sequences + C0/C1 control characters from a build-log line so raw terminal
 * control bytes (colour codes, cursor moves, spinner carriage-returns) never reach the owner's
 * /waiting terminal as garbage. The build container streams BOTH `claude -p` stdout AND stderr;
 * stderr from npm/vite/tools carries ANSI colour + carriage-return progress spinners. Runs BEFORE
 * the noise filter so a colour-wrapped `API Error: 402` still matches {@link isBuildLogNoise}. A
 * carriage-return progress line collapses to its final frame. Implemented with `charCodeAt` (no
 * regex over raw control bytes) so this source stays 100% ASCII. Pure — unit-tested; mirrored on
 * the frontend (waiting.component `stripControlChars`).
 *
 * @param text - One raw stdout/stderr line from the build container.
 * @returns The line with ANSI sequences + control chars removed and CR-overwrites collapsed.
 * @example
 * const esc = String.fromCharCode(27);
 * stripControlChars(esc + '[32m' + 'built' + esc + '[0m'); // → 'built'
 */
export function stripControlChars(text: string): string {
  // Carriage-return progress overwrites → keep only the final frame (the last CR wins).
  const cr = text.lastIndexOf(CARRIAGE_RETURN);
  const s = cr >= 0 ? text.slice(cr + 1) : text;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 27) {
      // ESC — skip an ANSI CSI/OSC sequence up to its final byte (0x40-0x7e).
      i++;
      if (i < s.length && (s.charCodeAt(i) === 91 || s.charCodeAt(i) === 93)) i++; // '[' or ']'
      while (i < s.length) {
        const c = s.charCodeAt(i);
        if (c >= 0x40 && c <= 0x7e) break; // final byte terminates the sequence
        i++;
      }
      continue; // the for-loop's i++ steps past the final byte
    }
    // Keep tab (9) + newline (10) + printables ≥32, dropping DEL (127) and C1 (128-159).
    if (code === 9 || code === 10 || (code >= 32 && code !== 127 && !(code >= 128 && code <= 159))) {
      out += s[i];
    }
  }
  return out;
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
 * Provider billing / model-catalog failure signals. When a whole ingest batch is
 * dropped as {@link isBuildLogNoise} AND carries one of these, the BUILD LLM itself
 * is degraded (DeepSeek dead balance / wrong model) — the build fast-paths with no
 * Claude narration, so the /waiting terminal sits EMPTY. Each tuple maps a pattern
 * to a stable machine signal for structured logging.
 * @internal
 */
const BUILD_LLM_DEGRADED_SIGNALS: readonly (readonly [RegExp, string])[] = [
  [/\binsufficient balance\b/i, 'insufficient_balance'],
  [/^\s*API Error:\s*402\b/i, 'api_402'],
  [/^\s*API Error:\s*429\b/i, 'api_429_rate_limited'],
  [/\bunrecognized_model\b/i, 'unrecognized_model'],
  [/model catalog/i, 'model_catalog'],
];

/**
 * Detect whether a raw (pre-filter) build-log batch carries a build-LLM degradation
 * signal (billing/quota exhaustion or an unusable model). Pure — used by the ingest to
 * make a dead build-LLM balance OBSERVABLE (a structured warn) instead of silently
 * returning `written:0` when every streamed line is control-plane noise. Returns the
 * FIRST matching signal so the operator log names the concrete cause.
 *
 * @param rawLines - The untrusted `lines` field from the ingest payload.
 * @returns `{ degraded: true, signal }` on the first billing/model failure, else `{ degraded: false }`.
 * @example
 * detectBuildLlmDegraded(['API Error: 402 Insufficient Balance']) // → { degraded: true, signal: 'api_402' }
 * detectBuildLlmDegraded(['writing src/App.tsx'])                 // → { degraded: false }
 */
export function detectBuildLlmDegraded(rawLines: unknown): { degraded: boolean; signal?: string } {
  const arr = Array.isArray(rawLines) ? rawLines : [];
  for (const l of arr) {
    if (typeof l !== 'string') continue;
    for (const [re, signal] of BUILD_LLM_DEGRADED_SIGNALS) {
      if (re.test(l)) return { degraded: true, signal };
    }
  }
  return { degraded: false };
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
    .map((l) => stripControlChars(l).replace(/\s+$/, '').trim())
    .filter(Boolean)
    .filter((l) => !isBuildLogNoise(l))
    .slice(0, MAX_LINES_PER_CALL)
    .map((l) => redactStreamSecrets(l).slice(0, MAX_LINE_CHARS));
}
