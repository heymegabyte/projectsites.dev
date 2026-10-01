/**
 * @file Regression — the editor's CSP `frame-ancestors` must cover every parent
 * origin the editor itself accepts messages from.
 *
 * Root cause pinned by long-trail case-001 action 40 (fire-60): the bolt.diy
 * editor (`editor.projectsites.dev`, served from repo-root `public/_headers`)
 * ships `frame-ancestors 'self' https://projectsites.dev https://*.projectsites.dev …`
 * while the editor's OWN inbound-message allowlist (`app/lib/embed/embedded-mode.ts`
 * `ALLOWED_ORIGINS`) includes `http://localhost:4200` + `http://localhost:4300`.
 * Result: the LOCAL admin (`ng serve :4200`, the long-trail stack) mounts the
 * editor iframe and Chromium refuses the document — "Refused to frame
 * 'https://editor.projectsites.dev/' … ancestor violates frame-ancestors" — so
 * the editor can NEVER boot in the local composition even though the editor code
 * explicitly supports a localhost parent. Header/code drift, one-sided.
 *
 * This test derives both sides from the REAL files (no duplicated literals):
 * every absolute http(s) origin in the editor's `ALLOWED_ORIGINS` must appear in
 * the `frame-ancestors` directive of `public/_headers`. If either file drifts,
 * this fails with the exact missing origin.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// apps/project-sites/src/__tests__ → repo root is four levels up.
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const HEADERS_PATH = resolve(REPO_ROOT, 'public', '_headers');
const EMBEDDED_MODE_PATH = resolve(REPO_ROOT, 'app', 'lib', 'embed', 'embedded-mode.ts');

/** Extract the frame-ancestors source list from the editor's `_headers` CSP. */
function readFrameAncestors(): string[] {
  const headers = readFileSync(HEADERS_PATH, 'utf-8');
  const csp = headers
    .split('\n')
    .find((l) => l.trim().toLowerCase().startsWith('content-security-policy:'));
  if (!csp) throw new Error(`No Content-Security-Policy line in ${HEADERS_PATH}`);
  const directive = csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.startsWith('frame-ancestors'));
  if (!directive) throw new Error('CSP has no frame-ancestors directive');
  return directive.replace(/^frame-ancestors\s+/, '').split(/\s+/);
}

/** Extract the editor's inbound parent-origin allowlist (absolute origins only). */
function readEditorAllowedOrigins(): string[] {
  const src = readFileSync(EMBEDDED_MODE_PATH, 'utf-8');
  const m = src.match(/ALLOWED_ORIGINS\s*=\s*new Set\(\[([^\]]+)\]\)/);
  if (!m) throw new Error(`ALLOWED_ORIGINS set literal not found in ${EMBEDDED_MODE_PATH}`);
  const origins = [...m[1].matchAll(/'(https?:\/\/[^']+)'/g)].map((x) => x[1]);
  if (origins.length === 0) throw new Error('ALLOWED_ORIGINS parsed to zero origins');
  return origins;
}

describe('editor frame-ancestors ↔ ALLOWED_ORIGINS sync (long-trail case-001 fire-60)', () => {
  it('frame-ancestors covers every parent origin the editor accepts messages from', () => {
    const ancestors = readFrameAncestors();
    const allowed = readEditorAllowedOrigins();

    const missing = allowed.filter((origin) => !ancestors.includes(origin));
    expect(missing).toEqual([]);
  });

  it('keeps the production parents (regression guard for the prod embed)', () => {
    const ancestors = readFrameAncestors();
    expect(ancestors).toEqual(expect.arrayContaining(["'self'", 'https://projectsites.dev']));
    expect(ancestors.some((a) => a === 'https://*.projectsites.dev')).toBe(true);
  });

  it('local long-trail stack parents are embeddable (the fire-59/60 blocker)', () => {
    const ancestors = readFrameAncestors();
    // ng serve (:4200) — the real local admin; e2e static server (:4300) — the CI frontend suite.
    expect(ancestors).toEqual(
      expect.arrayContaining(['http://localhost:4200', 'http://localhost:4300']),
    );
  });
});
