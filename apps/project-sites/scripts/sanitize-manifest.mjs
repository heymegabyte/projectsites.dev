/**
 * @module scripts/sanitize-manifest
 *
 * Clean a token-filled key-value manifest (`llms.txt` / `llms-full.txt`) so an ABSENT
 * business field never ships a blank or dangling line to AI crawlers (a GEO / AI-search
 * quality defect on every generated site whose research lacks a tagline/email/phone/hours).
 *
 * WHY: `fillTemplateTokens` (container-server.mjs) fills an unknown/empty token with `''`
 * (so an owning UI section self-hides). On the flat `Label: {A} | {B}` manifest lines that
 * leaves, e.g., `Tagline:` blank or `Contact:   |` (a dangling separator) — read verbatim
 * by an LLM crawler. Discovered live on a fresh build by
 * `e2e/site-quality/verify-llms-txt-quality.mjs` (AL-791).
 *
 * WHAT: run AFTER the token fill over the manifest text and, per `Label: value` line:
 *   - DROP the line when the value came out entirely empty (`Tagline:` / `Hours:`),
 *   - COLLAPSE `A | B` to only the non-empty side(s) when one side is blank
 *     (`Contact: a@b.com |` → `Contact: a@b.com`; `Contact:   |` → dropped),
 *   - leave every already-clean line BYTE-FOR-BYTE untouched (only defective lines change).
 * Also drops a bare markdown blockquote (`>` alone = empty `> {BUSINESS_DESCRIPTION}`).
 *
 * Pure + fail-soft: any error returns the input unchanged — never breaks a build.
 * Kept as a sibling `scripts/*.mjs` (like `vertical-rules.mjs`) so it's unit-testable and
 * imported by container-server.mjs via a relative path (both COPY'd into the build image).
 *
 * @param {string} text - The token-filled manifest contents.
 * @returns {string} The sanitized manifest (defective metadata lines cleaned/removed).
 * @example
 * sanitizeManifestText('Tagline: \nContact:   |\nSite: https://x.com')
 * // → 'Site: https://x.com'   (blank Tagline + dangling Contact dropped)
 */
export function sanitizeManifestText(text) {
  if (typeof text !== 'string' || text === '') return text;
  try {
    const out = [];
    for (const line of text.split('\n')) {
      // A `Label: value` metadata line — label = letters/spaces before the FIRST colon.
      const m = /^([A-Za-z][A-Za-z ]*?):[ \t]*(.*)$/.exec(line);
      if (m) {
        const parts = m[2].split('|').map((p) => p.trim());
        const nonEmpty = parts.filter(Boolean);
        if (nonEmpty.length === 0) continue; // whole field empty → omit the line entirely
        if (nonEmpty.length !== parts.length) {
          out.push(`${m[1]}: ${nonEmpty.join(' | ')}`); // a blank side existed → collapse
          continue;
        }
        out.push(line); // already clean → leave exactly as authored
        continue;
      }
      if (/^>[ \t]*$/.test(line)) continue; // a bare blockquote (empty `> {DESCRIPTION}`)
      out.push(line);
    }
    // Dropped lines can leave a run of blank lines — collapse 3+ down to a single gap.
    return out.join('\n').replace(/\n{3,}/g, '\n\n');
  } catch {
    return text;
  }
}
