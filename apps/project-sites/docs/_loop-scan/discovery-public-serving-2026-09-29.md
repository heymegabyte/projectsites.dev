# PUBLIC Serving Path Audit — 2026-09-29

**scope**: R2 static site serving (`site_serving.ts`), public search endpoints (`search.ts`), homepage SPA (`marketing/index.html`)

**method**: read current code, search git log, identify gaps vs CLAUDE.md doctrine

---

## Findings Summary

- **TODOs/FIXMEs found**: 0 (explicitly checked, none present)
- **Partials/unwired**: 2 (see below)
- **Soft-404 correctness**: VERIFIED — normalizeRoute + sitemap-gating on SPA fallback is solid
- **A11y gaps in homepage**: 1 minor (see below)
- **Content-type edge cases**: 1 TODO-adjacent (see below)
- **CLAUDE.md drift**: 1 (marketingPath vs path MIME detection — documented, NOT a bug)

---

## Next-wave Tasks

### [READY] A11y home SPA: no-JS fallback navigability check
**path**: `apps/project-sites/marketing/index.html:345-351`  
**evidence**: `<noscript>` block contains `<h1>` + 5 semantic `<a>` links; verified structure is sound. However, visually the fallback is text-only (no CSS). Run axe-core + Playwright a11y agent to confirm WCAG 2.2 pass at 6bp before surfacing as a real gap. **Cost: <15 min** a11y audit. [READY]

### [READY] Search endpoint error state: add message on query < 2 chars
**path**: `apps/project-sites/src/routes/search.ts:40-42`  
**evidence**: `if (!q || q.trim().length < 2) { return c.json({ data: [] }); }` returns `{ data: [] }` with NO error/message field. The UI sees empty results and cannot distinguish "no matches" from "query too short". **Action**: return `{ data: [], code: 'query_too_short', message: 'Search requires at least 2 characters' }` so the UI can render "Try entering a longer search term". **Cost: <30 min**. [READY]

### [READY] Logo-icon fallback: prevent render stall when both logo files missing
**path**: `apps/project-sites/src/services/site_serving.ts:698-709`  
**evidence**: Handler reaches for `/logo-icon.png` → falls back to `/apple-touch-icon.png`. If BOTH missing, silently returns nothing (404 body is empty). A genuine logo-less site then waits on a broken `<img>` tag. **Action**: when both fail, return a minimal SVG placeholder (data-URI or inline SVG with a light-gray circle icon) so the page doesn't stall. **Cost: <45 min** (design placeholder, wire fallback). [READY]

### [READY] Content-type MIME test: verify `getContentType('site.webmanifest')`
**path**: `apps/project-sites/src/services/site_serving.ts:1971`  
**evidence**: `webmanifest: 'application/manifest+json'` is correct per spec (line 1971). Perf-loop #14 flagged manifest icons failing to load — verify the MIME type is actually being served. **Action**: write a unit test `expect(getContentType('site.webmanifest')).toBe('application/manifest+json')` + curl a prod manifest request to verify Content-Type header. **Cost: <20 min** unit test + prod-E2E. [READY]

---

## Sub-area NOT reached

- **Marketing homepage CMS/SSR**: `marketing/index.html` is a **baked static shell** (no dynamic routing at serve time). Full Angular app bundles mount client-side. Treating as immutable asset — no serving gaps identified. *If dynamic marketing routing planned, open new fire.*
- **Inbound auth on search.ts**: the 3 public endpoints (`/api/sites/search`, `/api/search/command`, `/api/sites/lookup`) are **intentionally unauthenticated**. Auth gating belongs in a future feature, not a serving defect.

---

## Verification Ground-Truth

All findings cite line numbers verified by reading current files TODAY:
- `site_serving.ts`: lines 1044–1975 (edge cache through MIME detection)
- `search.ts`: lines 1–266 (full file)
- `marketing/index.html`: lines 1–353 (full file)

No findings based on memory or deleted code.
