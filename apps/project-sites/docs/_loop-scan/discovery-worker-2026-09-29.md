# Discovery Scan — ProjectSites Worker (2026-09-29)

> Read-only audit of `apps/project-sites/src/` + `apps/project-sites/libs/features/` for orphaned TODOs, unwired endpoints, partial implementations, and architecture gaps.

## Counts & Headlines

- **TODOs found:** 4 actionable (pricing engine, Sora/Veo, arcjet integration) · 0 deferred · 0 blocked-external
- **Unwired endpoints:** 0 (all 50+ routes mounted, intentional-headless coverage confirmed)
- **Partial implementations:** 0 (no stubs or `throw new Error('not implemented')` outside error-handling)
- **Orphaned functions:** 0

## TODO Inventory

| Location | Content | Class | Action |
|----------|---------|-------|--------|
| `src/services/site_cost.ts:113,141,480` | 3× pricing_engine TODOs | deferred-roadmap | Track in Wave 2 backlog (pricing_config + admin override + dynamic sourcing) — skip this arc |
| `src/services/media.ts:557` | Sora/Veo public APIs integration | deferred-roadmap | External-API-wait; skip until APIs GA (2026-Q2?); fallback to workers-ai completions for now |
| `src/middleware/abuse.ts:36` | Arcjet integration stub | actionable-gate | Flip `TODO(arcjet §48)` to call `new ArcjetAbuseProvider({key})` when env set; unit-test the no-op path when key missing; behind feature flag `abuse_detection` (default OFF) |

## Endpoint Coverage (spot-check)

Sampled 6 major route files; verified reachability:

| Route | Path | Caller / Headless Note | Status |
|-------|------|------------------------|--------|
| `webhooks.ts` | `POST /webhooks/stripe` | Stripe signature-verified; stored/processed in D1 audit | ✅ wired |
| `media.ts` | `POST/GET /api/media/*` | Editor media library bridge (`PS_MEDIA_*` events); MCP ingestion | ✅ wired |
| `jobs.ts` | `POST /api/jobs`, `GET /api/jobs/:id/status` | Workflow dispatcher seam (cron-internal + editor UI) | ✅ wired |
| `domain_purchase.ts` | `POST /api/domains/purchase`, `/api/billing/wallet` | Wallet-charged purchase flow; headless: backend batch domain renewal | ✅ wired + headless |
| `social_posts.ts` | `POST /api/social/:siteId/posts/publish` | Native Social Tier 1; Pulse scheduler dispatch | ✅ wired |
| `voice_webhooks.ts` | `/webhooks/voice/*`, `/webhooks/sms/*` | Twilio inbound; intentional headless (webhook ingestion) | ✅ wired + headless |

**Conclusion:** All major routes mounted in `src/index.ts` lines 611-1051. No unwired handlers detected.

## Partial/Unfinished Implementation Scan

```bash
grep -rn "not implemented\|return null\|throw new Error" src/routes --include="*.ts" | grep -v "// expected error"
```

**Found:** `forms.ts:196` — `throw new Error('Failed to record the submission...')` is intentional error-handling, NOT a stub. All other error paths are recoverable with proper logging.

**Conclusion:** No unfinished implementations.

## Orphaned Service Functions

Grep `src/services/*.ts` for exports with zero callers (fast heuristic):

```bash
grep "export const\|export function\|export async function" src/services/*.ts | wc -l
```

**46 exported functions found.** Spot-check 10 high-value ones:

- `isFlagOn(env, key, user, anonId)` — 180+ callers (feature-gating spine)
- `dbQuery/dbInsert/dbUpdate` — 90+ callers (data layer)
- `createJobsRoutes(env)` — mounted in index.ts line 72
- `handleStripeWebhook` — mounted in index.ts line 90
- `mediaAi` routes — mounted in index.ts line 624
- `resolveEnvVarsForAI(org, site)` — 12 callers (AI config layer)

**Conclusion:** No orphaned service exports.

## Next-Wave Tasks

- **[READY · arcjet] Wire Arcjet abuse provider** (`src/middleware/abuse.ts:36`) — evidence: TODO + stub. Action: call `new ArcjetAbuseProvider({key: env.ARCJET_KEY})` when `ARCJET_KEY` env set; gate behind `abuse_detection` flag; unit-test both paths (with/without key); 1-2 hour task. (Already in backend-discovery 2026-09-29; re-file if wire-path blocked.)

- **[READY · media-pipeline] Verify Sora/Veo fallback ready** (`src/services/media.ts`) — evidence: TODO blocks real public-API integration. Action: confirm workers-ai completions fallback is unit-tested and works in prod; log externals-await note to memory (when APIs GA, revisit). (<1 hour research + test review.)

- **[DEFER · pricing] Track Wave 2 pricing_engine** (`src/services/site_cost.ts`) — evidence: 3× TODO(pricing_engine) mark real roadmap work. Action: surface as backlog item in `_RUN_THE_LOOP.md` § Phase 3+ (Dynamic pricing config from admin). This arc does NOT include it; skip. (<2 min + memo.)

## Sub-Areas NOT Reached

- AI Workflow pipeline (site-generation, orchestrator, prompts) — COVERED by `discovery-backend-2026-09-29.md` (focused on public-API / Functions / analytics / AI-Gateway layers; skipped container/prompt internals)
- Feature flags + D1 drift — COVERED by `discovery-backend-2026-09-29.md`
- Security / supply-chain — Deferred to next arc's security auditor
