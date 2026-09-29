# Audit E — CF-native surfaces + Inspector cleanup + Social (fire-1, 2026-09-28)

Read-only audit, Workstream E. Cited `file:line` under `apps/project-sites/`.

## Inspector-removal file inventory (complete — 26 files, ~4,600 LOC)

- **KV Inspector** (flag `kv_inspector`): `frontend/…/sections/kv-inspector.component.ts` + `.spec.ts`;
  `libs/features/kv_inspector/{handlers.ts,schemas.ts,feature.manifest.ts,__tests__/kv_inspector.test.ts}`.
- **R2 Inspector** (`r2_inspector`): same 6-file shape.
- **Vectorize Inspector** (`vectorize_inspector`): 6 files.
- **Queues Inspector** (`queues_inspector`): 6 files.
- **System Services**: `system-services.component.ts` + `.spec.ts`; `src/routes/super_admin.ts:621`;
  e2e `admin-system-services-journey.spec.ts`, `admin-verify/system-services-{error-state.spec.ts,
  interactions.spec.ts,verify-system-services-health.mjs}`.
- **Shared wiring to unlink:** `app.routes.ts:246-291,570-580` · `admin-nav.model.ts:131-176` ·
  `admin-section-labels.ts:39,45-48` · `command-palette-actions.service.ts:168` · `src/index.ts:145-149,
  1034-1038` · 5 flag rows `registry.ts:503-544`.
- **PRESERVE** (site-scoped, distinct flags `per_site_data`/`site_kv`/`site_r2`/`site_queues`/
  `site_vectorize`): `libs/features/{r2_buckets,r2_bucket_manager,d1_manager}`, `site_data_db.ts`,
  editor `BucketsPanel/DatabasePanel/ResourcesPanel`.

## Social page current state

`social.component.ts` = **2,649 lines / 131KB** (god-component; styles 32.86KB > 28KB budget, WARN).
3-pane, tabs `compose|drafts|queue|sent|calendar` (`:131`). Postiz-HTTP-boundary backend
(`src/routes/social.ts`). Target: split into sub-sections + the 10 documented passes.

## Top surface gaps

1. **E1 EmDash CMS** — no catalog entry; Payload CF-native pattern exists (`apps-catalog.data.ts:452`,
   `cloudflare_provisioner.ts` provisions D1+R2+Worker) — clone it.
2. **E5 Automations / E6 Uppy+Tiptap** — zero deps (React Flow, Tiptap, Uppy absent); greenfield.
3. **E2 Email sidebar** — only stale `email`/`inbox` label stubs (`admin-section-labels.ts:27-28`);
   no nav item, no agentic-inbox-on-SES surface.
4. **E3 Dashboard health widget** — `cf_analytics.ts` writes p50/p95-capable data points
   (`doubles[1]=latency_ms`) but dashboard has no uptime/latency tile.
5. **E9 Traks / E11 microfeed / E10 cloudflare-agents / E12-13 OpenSEO** — entirely absent.

## Already substantially done (reclassify to verify+wire)

- E7 D1 export ships (`d1_manager` `POST /api/admin/d1/:id/export`).
- E6 buckets (`r2_bucket_manager` slice-1 + `BucketsPanel.tsx`).
- E8 shortlinks (claimyour.site funnel `routes/claim.ts`; `claimyour.site` = SEPARATE private repo,
  not inspected here — audit that repo separately per mandate).

## First slices (RED-testable, ≤15min)

1. **Inspector unlink** — RED: `admin-nav.model.spec.ts` asserts no inspector items +
   `/admin/kv-inspector` 404. Delete 4 nav entries + 5 label rows + 5 route blocks; preserve
   site-scoped services.
2. **E1 EmDash CMS catalog row** — RED: `apps-catalog.data.spec.ts` expects `findApp('emdash-cms')`.
   Add one `cf-native:` entry beside Payload (`:452`).
3. **E3 health widget** — RED: dashboard spec expects `[data-testid="health-widget"]` with p50/p95.
   Wire a tile to `cf_analytics` latency doubles.
