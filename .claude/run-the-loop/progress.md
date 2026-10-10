# Buckets convergence — session checkpoint (2026-10-10)

> Resume point for the next `/run-the-loop` fire scoped to the **Ultimate R2 Bucket Manager**
> (`BUCKETS-MASTER-SPEC.md`). Four verified fires shipped this session; DoD ≈ 82%.

## Shipped this session (all on `origin/main`, prod-verified)
1. **slice3** — `iconForObject`→`bucket-icons.ts` (18 distinct glyphs) + **color-coded** per-type tints + populated `/_preview` gallery (list+grid) + owner-key backend + AA-contrast empty states.
2. **slice4-ui** — owner-key credential strip (show-once/copy/rotate/revoke) + cinematic `psBucketRise` animation (reduced-motion safe) + audit-logging + **site-scoped** credential-validity E2E (200 own / 403 scoped / 401 revoked).
3. **b4** — per-**bucket** owner keys (routes + migration `0662` + `bucketScopeResources([bucket])`) + per-bucket credential-validity E2E (200/403/401). Migration-first deploy ordering.
4. **b12** — rich **sandboxed** object previews (image→inert img · pdf→sandboxed iframe no-scripts · text/code→escaped `<pre>` · media→inert controls · else→download) via `requestBucketDownload`.
5. **b3** — object-row **context menu** (Radix ContextMenu) + **keyboard multi-select** (Cmd+A · Shift-range · Esc) + **animated bulk bar** (role=toolbar, psBucketRise). 21 tests.

## DoD §21 ≈ 85% — REMAINING slices (each one fire)
- **B4-UI** — per-bucket Access Keys workspace in bucket Settings (backend DONE; reuse `OwnerKeySection` scoped to selected bucket, consume `PS_R2_BUCKET_KEY_*`).
- **B6** clone bucket · **B7** zip export · **B8** copy/move/rename objects · **B9** per-object public + signed shares · **B10** env reassign + rollback (`EnvAssignmentGrid` is read-only; needs `assignBucketEnv` mutation) · **B11** server-side search · **B15** Code-view bucket source selector (`EditorPanel.tsx` Source picker, money-path).
- **B14** axe @ 6bp on the Buckets panel.
- ✅ **≥5 visual-refinement rounds** — DONE + numbered in LEDGER (5 logged).
- READY-NOW top: **B15** Code-view selector · **B4-UI** · **B8** copy/move/rename · **B6** clone.

## Infra invariants for the next fire (do-not-rediscover)
- **Deploy:** worker `cd apps/project-sites && wrangler deploy --env production` (Docker up, creds via `get-secret CLOUDFLARE_API_KEY` + `CLOUDFLARE_EMAIL=blzalewski@gmail.com`); editor `npm run build` (root) → `wrangler pages deploy build/client --project-name=bolt-diy --branch=main --commit-dirty=true`.
- **Migration-first:** any slice adding a column the deployed worker queries → apply the migration to prod D1 (`wrangler d1 execute project-sites-db-production --remote --file=…`) BEFORE the worker deploy.
- **Credential/objectops probes:** call the API via `https://project-sites.manhattan.workers.dev` (challenge-free) — the editor origin CF-bot-challenges in-page fetches (`listSites 404`). S3 SigV4 runs in Node.
- **Visual-verify:** `/_preview` gallery is the headless surface (`npm run verify:preview-gallery` + `verify:buckets-populated`). Wait ~10s AND re-run after a fresh Pages deploy (propagation makes the first probe flaky: body 23 / stale-bundle).
- **Hot file:** `app/components/workbench/BucketsPanel.tsx` (~3k lines) — single-owner per fire; icons live in `bucket-icons.ts`; two-pane primitive is `BucketsTwoPane.tsx`.
- **Cron `b1182793`** (every 30m) still active — KEEP until the DoD list above is green + prod-verified + visual rounds logged, then `CronDelete`.
