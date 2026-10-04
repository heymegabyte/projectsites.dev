# Seed the full-UI demo at `projectsites.projectsites.dev` (DEMO-0)

`scripts/seed-demo-site.mjs` provisions an idempotent demo site at slug `projectsites`
so **`projectsites.projectsites.dev`** resolves + serves a published bundle, with NO
unpaid top-bar (a `paid`/`active` subscription suppresses it).

## What it does (all idempotent — re-runnable, no duplicate rows)

1. Upserts demo **org** `org-demo-projectsites` (`orgs` row, stable id).
2. Upserts a **paid/active `subscriptions`** row for that org → `resolveActiveOrgPlan`
   returns `paid` → `resolveSite` serves without the free-tier top bar.
3. Upserts the **`sites`** row: slug `projectsites`, `status='published'`,
   `current_build_version='v1'`, `business_name='ProjectSites Demo'` (stable id
   `site-demo-projectsites`). Preflight refuses if a DIFFERENT site already owns the slug.
4. Uploads the **bundle** to R2 `sites/projectsites/v1/...` (walks the dir, uploads each
   file + `_manifest.json`, via the same CF R2 REST API as `upload-to-r2.mjs`).
5. **KV-invalidates** `host:projectsites.projectsites.dev` so the resolution is live
   immediately (not after the 60s TTL).

## Prereqs

- The bundle dir **`apps/project-sites/demo-site/`** must exist (a sibling agent builds
  it) — or pass `--bundle <dir>`. If it has a `dist/`, that's served; else the dir itself.
  It needs an `index.html` at its served root.
- `get-secret CLOUDFLARE_API_KEY` resolves (global-key auth, email `blzalewski@gmail.com`).

## Commands

```bash
cd apps/project-sites

# 1. Preview — prints every step + SQL/keys, touches NOTHING (safe):
node scripts/seed-demo-site.mjs --dry-run

# 2. Seed prod (LEAD runs this after review — mutates prod D1 + R2 + KV):
node scripts/seed-demo-site.mjs

# Then verify (expect 200):
curl -sS -o /dev/null -w '%{http_code}\n' https://projectsites.projectsites.dev/
```

Options: `--bundle <dir>` · `--slug <s>` (default `projectsites`) · `--version <v>`
(default `v1`) · `--dry-run` · `--help`.

## Notes

- `projectsites` is **NOT** in `RESERVED_SLUGS` (`editor,storybook,www,api,admin,staging,
  mail,smtp`) — the script re-checks at runtime and refuses a reserved slug (exit 2).
- Reuses the exact D1 REST (`backfill-wfp-slot.mjs`) + R2 REST (`upload-to-r2.mjs`)
  mechanisms — no parallel path invented.
