# Discovery — WfP site-hosting (Lane 2) external-gate audit (loop fire, 2026-09-29)

> Read-only audit of the Workers-for-Platforms serving path. Feeds `_RUN_THE_LOOP.md` Lane 2.
> **Headline: the WfP external gate is closer than the queue implied** — `[[dispatch_namespaces]]`
> is ALREADY present in `wrangler.toml` (production, `project-sites-endpoints`,
> id `6ea19ae4-…`). The ONLY external blocker is setting the `CF_API_TOKEN` secret.
>
> (This fire also shipped: Lane 10 psnotify contract-parity — the DO now returns the legacy
> bell's `{data,unread_count}` + `POST /read-all` + a canonical type enum, so promoting the
> `psnotify` flag is a clean flag-flip [still DARK]; and editor Data Rev 8 ERD — see the report.)

## The external gate (single blocker)
- `isWfpConfigured(env)` (`src/services/wfp_dispatch.ts:21-25`) gates on `USER_DISPATCH && WFP_NAMESPACE_NAME && CF_ACCOUNT_ID && CF_API_TOKEN`. Namespace binding present ✅; **`CF_API_TOKEN` secret NOT set** ❌ → `deploySiteToWfp` fail-softs `{ok:false}` + serving falls back to R2 (byte-identical when flag off). The doc's "CF_API_TOKEN 10405 on the Static-Assets upload-session" is NOT a separate gate — it's the token used INSIDE the Worker for the assets-upload PUT.
- **`[external-gate]` — provision the token:** `wrangler secret put --env production CF_API_TOKEN <token>`, then flip `site_wfp_hosting` ON for ONE test site (`4f450690-…`) with an existing R2 build → publish → WebFetch the subdomain → assert 200 + styled + `x-ps-serve: wfp`.

## READY-code tasks (no provisioning needed)
1. **[WFP · READY] Test `CF_API_TOKEN`-unset in `isWfpConfigured()`** — `src/__tests__/wfp_dispatch.test.ts` covers USER_DISPATCH-absent but not the token-missing branch. +1 case.
2. **[WFP · READY] Script-name 64-char cap + collision test** — `siteFunctionsScriptName` normalization can exceed the WfP 64-char limit for long site ids. Add a length+collision test.
3. **[WFP · READY] E2E assert `x-ps-serve: wfp`** — the header is documented but no e2e exercises it. Add a Playwright step to `e2e/wfp-site-hosting.spec.ts`.
4. **[WFP · READY] Structured log on `deploySiteToWfp` failure** — fail-soft returns `{ok:false}` but emits no `log.warn` (observability gap). Add `log.warn({msg,error,siteId,slot})` at the ~3 failure sites.
5. **[WFP · READY] Teardown journey e2e** — deploy → delete → next request 404/R2. Proven in units, not e2e.

## Sub-area NOT reached
- The in-Worker assets-upload-session recipe internals (`uploadSiteFunctionsWorker`) · per-slot deploy concurrency.
