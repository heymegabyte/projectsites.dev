# editor-live — live-verify the Editor Resources tabs

A reusable headless-Playwright gate that drives the **real booted editor** (not a render-test) and
asserts each Resources sub-tab renders its live state. Run it:

```bash
cd apps/project-sites
npm run verify:editor-live            # or: node e2e/editor-live/editor-nav.mjs
# env: E2E_TEST_PASSWORD (auto-resolved via get-secret) · PROD_URL (default https://projectsites.dev)
```

## What it proves

- **Path A (admin embed)** — auths (`authSeedBrian`) → `/admin/editor` → the persistent bolt iframe →
  the editor boots live ("Loaded 49 files") → reaches the Resources tab → **force-clicks** each sub-tab
  (a normal click hangs on the cross-origin WebContainer-iframe actionability check; force + a
  `dispatchEvent` fallback get through) → asserts a known testid rendered + counts console errors +
  screenshots to `e2e/screenshots/editor-live/`.
- **Path B (direct)** — `bolt-diy-8jf.pages.dev` shell smoke only (no admin parent ⇒ no PS_RES bridge).

## Current result (fire-146, 2026-10-04)

| Sub-tab | Live state | Verdict |
|---|---|---|
| **media** | `resources-media-grid` — real data (2 assets) | ✅ PASS |
| **files** | `resources-files-list` — real data | ✅ PASS |
| **buckets** | `buckets-list-item` — real data | ✅ PASS |
| **automations** | `not-rendered` | ⏳ flag-dark (`site_automations` experimental-off) — renders once the flag is promoted; NOT a bug |

3/4 tabs are **proven working live**; the 4th is correctly gated by its experimental flag. This closed
the render-test-only integrity gap for the Resources screen. Extend `verifyResourcesSubTabs()` for new
tabs. Headless-only per the browser-automation-routing HARD RULE (never a visible Chrome).
