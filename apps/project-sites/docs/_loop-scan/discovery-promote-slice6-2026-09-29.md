# Discovery — Promote Slice 6 (async CF deploy outcome) audit (loop fire 2026-09-29)

> Read-only audit of `libs/features/durable_preview/{service,handlers}.ts`. Feeds Lane 1.
> Headline: the outcome ALREADY flips from a REAL production `index.html` read-back (not a pure
> proxy) + idempotency is already keyed on `(site_id, draft_revision)`. Slice 6's real gap is
> recording a **serving SHA** (proof-of-serving) + capturing a **real CF deployment id**.
>
> (This fire also shipped: Lane 4 social media-CTA launchpad; Lane 7 the validator FP-audit
> harness — which live-flagged 3/3 real sites as strict-flip false positives, so DO NOT flip
> `validator_strict` until the shell/demo exclusions land. See §Lane 7 tasks below + the report.)

## What's already correct
- `service.ts:385` reads back the promoted `index.html` from the new production prefix; outcome `success` iff it's servable (size>0) AND the pointer flipped, else `commit_ok_deploy_failed` (`:389`). So the outcome is NOT a blind proxy — it's a real read-back.
- Idempotency: key `(site_id, draft_revision)` (`:205`); re-POST returns the existing release (`:318`).

## Slice 6 tasks
1. **[PROMOTE · needs-migration] Add `serving_sha` to `site_releases`.** Migration 0646 has `deployment_id` + `artifact_digest` but no `serving_sha`. Add `serving_sha TEXT` (F-owned migration).
2. **[PROMOTE · READY-code] Compute + persist the serving SHA.** At `service.ts:385` after the index read-back, `crypto.subtle.digest('SHA-256', bytes)` → hex → pass to `appendRelease`. Thread `servingSha` through `AppendReleaseInput` (`:154-180`) + the D1 INSERT + the `Release` schema + `PromoteResponseSchema` + `toRelease()`.
3. **[PROMOTE · READY-code] Document the deployment-id semantics.** `service.ts:377` sets `deploymentId = version` (a `v${ts}` frozen-point token, NOT a CF deployment UUID). Either JSDoc that it's the rollback token, or (bigger) integrate the CF Deployments API (`/accounts/{id}/workers/deployments`) to capture a real id — no existing helper today.
4. **[PROMOTE · READY-code] Test `commit_ok_deploy_failed` + retry.** `promote.test.ts` has the success case only. Add: promote → delete prod index → re-promote same draft → assert `commit_ok_deploy_failed` + `servingSha:null` + idempotent 3rd POST returns the same release.
5. **[PROMOTE · READY-code] JSDoc the outcome state machine** on the POST handler (`success`=live · `commit_ok_deploy_failed`=bytes committed/index unservable/retry-same-input · `failed`=freeze/copy error/retry-safe).
6. **[PROMOTE · needs-UI] Release-history card** in the editor Source Control panel: outcome + serving_sha (on success) + a retry button (on `commit_ok_deploy_failed`). Extends Slice-4's panel.

## Lane 7 (from the FP-audit harness — CRITICAL, blocks the strict flip)
- **[SITEGEN · READY] Exclude non-content shells + demo assets from content validators** before flipping any org to `validator_strict`: `404/500/offline.html` shells trip `meta.title_length`/`meta.description_length`/`jsonld.count_below_threshold`/`seo.noindex_leak`; `applied/*` demo-gallery thumbnails trip `image.png_too_large`; the sitemap↔SPA soft-404 gate trips `sitemap.orphan_route`. Fix these in `build_validators.ts`, re-run `scripts/audit-validator-false-positives.mjs --slugs …` GREEN, THEN flip the E2E org.

## Sub-area NOT reached
- CF Deployments-API integration internals · WfP per-site runtime (Slice 8).
