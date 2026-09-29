# Discovery — backend platform (loop fire, 2026-09-29)

> Read-only audit of the Worker's public-API / Functions / idempotency / analytics / AI-gateway
> layers. Feeds `_RUN_THE_LOOP.md` §4.6 + Lane 11. Headline: idempotency + AI-Gateway are COMPLETE
> (no action); public_api token infra is beta-ready; Functions dispatch is live but untyped;
> Analytics-Engine ingest is gated OFF (a [READY] flip).

## Complete (no action)
- **Idempotency** — `middleware/idempotency.ts` mounted on ALL `/api/*` mutations (KV 24h, org-scoped); billing/domains-purchase/site-deploy auto-covered. ✅
- **AI Gateway** — `services/ai_gateway.ts` active-by-default (`AI_GATEWAY_ENABLED!=='false'`); all providers route through `gateway.ai.cloudflare.com`, fallback on 5xx. ✅

## Next-wave tasks
1. **[OBS · READY · <30min] Flip `ANALYTICS_INGEST_ENABLED="true"` in prod** — `cf_analytics.recordEvent` is wired (8 event types) but no-ops (`types/env.ts:227` falsy). The CF-native metrics backend the doctrine mandates isn't writing. Flip + deploy + watch error-rate (should stay 0).
2. **[API · READY · <2h] Promote `public_api` → beta** — `middleware/api-keys.ts:51` detects `psk_live_*`/`psk_test_*`; admin key CRUD live; OpenAPI at `GET /api/openapi.json`. Gap: flag still experimental. Stage→beta, rollout 5%, document rate limits.
3. **[FN · READY · <2h] Typed Function request/response contract** — `wfp_dispatch.ts` dispatch plumbing is live + tested but the user-code boundary is untyped. Create `libs/features/wfp-functions/schemas.ts` (`FunctionRequestSchema`/`FunctionResponseSchema`) + wire into the dispatch boundary + tests.
4. **[FN · <2h] Per-function metrics** — wire an `fn_dispatch` event (functionName, latencyMs, errorCode) from `wfp_dispatch.ts` → Analytics Engine + `/api/admin/functions/:name/logs` read-only endpoint.
5. **[FN · <4h] Per-function cost guards** — add `max_invocations_per_day` + `max_monthly_cost` to function config; gate dispatch (429) when exceeded; emit cost-exceeded to audit.
6. **[OBS · <2h] `/api/admin/analytics/summary`** — read-only rollup over Analytics Engine (COUNT by event/route/org, 5-min cache) → a usable dashboard payload (raw AE is SQL-only today).
7. **[AI · READY · <1h audit] Verify no direct-vendor LLM calls** — grep `fetch('https://api.openai.com'` (etc.) OUTSIDE the `ai_gateway` wrapper; confirm none bypass the gateway.
8. **[IDEM · READY · <1h verify] Confirm `/api/contact-form/:slug` dedup** — public unauthenticated submit — verify idempotency-key coverage matches the rate-limit policy.

## Sub-area NOT reached (rotate next fire)
- Security-supply-chain: API-token rotation cadence · webhook signature-verify · Stripe event replay guards · D1 encryption-at-rest verification.
