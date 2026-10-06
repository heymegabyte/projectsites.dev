# Session checkpoint — WLK-39 Editor panel: ✅ CLOSED + LIVE (via Cloudflare Workers AI)

## TL;DR — ✅ CLOSED (fire-260, 2026-10-06)
The §75 flagship **"Claude Code" Editor panel (WLK-39) is COMPLETE + LIVE** for org `org-brian-001`
("Brian Z"). It was engineering-complete + proven end-to-end (3 surfaces + a live browser proof), then
blocked ONLY by the OpenAI/Anthropic accounts being credit-exhausted. Per Brian's directive ("continue
without passing the prompt through OpenAI/Anthropic"), fire-260 added a **Workers-AI terminal fallback**
(`isCreditQuotaError` → `env.AI` Llama; commit `840322b24`, deployed `f39805c2`): on vendor credit/quota
exhaustion the call degrades to Cloudflare Workers AI (free, CF-native) instead of 502. **Prod-proven:**
`/api/resolve` → **200** with research + synthesis via `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Flags
PROMOTED (reversible): `claude_code_panel`→org-brian-001 + `resolution_engine`→global (`set_by=wlk39-launch`).
Single mode = full quality; Resolution = honest-degraded (Workers AI; flagged "dual-frontier research
needs external credits"). **External dual-frontier (OpenAI+Anthropic) is deferred to a credit top-up —
`DECISIONS.md` ADR-0056;** when funded, the fallback self-heals back to the external providers.
(History of the journey below is retained as context.)

## DONE + PROVEN (fires 174-186)
- Embedded "Claude Code" tab: Activity/Files/Tests/Deploy surfaces + run lifecycle + Single mode
  (`/api/llmcall`) + Resolution mode (dual-provider research → Claude synthesis via `/api/resolve`).
- 3-surface dark-flag `claude_code_panel` (worker status endpoint → admin `PS_CLAUDE_FLAG` bridge →
  editor nanostore gate) — PROVEN: the tab appears when the flag is on for a test org.
- Resolution routes through the admin `PS_RESOLVE` bridge (fixed the cross-origin relative-fetch 404) — PROVEN.
- AI Gateway auth-401 fallback (fixed `502 ALL_PROVIDERS_FAILED`; also repaired the editor AI chat's
  gateway path) — PROVEN on prod: the `AiGatewayError 401` is gone; the error moved DOWNSTREAM to vendor billing.
- Flags `claude_code_panel` + `resolution_engine` are DARK (default-off). Every verify-override reverted clean.

## 🔑 THE (former) blocker — ✅ RESOLVED fire-260 (Workers-AI fallback; an external top-up is now OPTIONAL quality-upgrade, not a launch blocker)
**BOTH external LLM providers were short on credits/quota** (historical — fires 189..257): Anthropic `"Your credit balance is too low to access the Anthropic API"`; OpenAI also
shows quota/`insufficient` markers. Top up BOTH accounts — AND/OR mint the CF AI Gateway auth token → a NEW `CF_AIG_TOKEN` secret + send
`cf-aig-authorization` (CF dashboard → AI Gateway → settings) so calls flow THROUGH the gateway (cache/
cost controls) instead of the direct-vendor fallback. This also blocks the **editor AI chat's premium/
Claude tier** — so it's a real operational item beyond WLK-39.

## Dual-provider INDEPENDENCE fix — ✅ DONE (fire-188, commit `5feab3cee`, NOT yet deployed)
Added an ADDITIVE `lockProvider?: boolean` opt-out to `callExternalLLM` (`src/services/external_llm.ts`
L162 + the `providers` gate L810-814): default off = EXACTLY the historical `[primary, fallback]`
behavior (proven unchanged for the ~15 other callers by 2 default-behavior tests); when true,
`providers = [usablePrimary]` only. `runDualResearch`'s legs now pass `lockProvider: true`
(`libs/features/resolution_engine/service.ts:180`) so each leg rides ONLY its assigned provider — no
intra-leg cross-vendor fallback → invariant #7 enforced (a leg's failure now names its OWN provider).
jest 72 green, tsc 0, validate:features PASS. Committed but NOT deployed (dark + billing-blocked; its
prod-verify needs working LLM credits → rides the billing-unblock fire below). **WLK-39 is now
ENGINEERING-COMPLETE** (implementation + gateway auth + dual-provider independence).

## Then: deploy + re-verify + promote (billing-gated — only after Anthropic has credits)
(1) **Deploy** `wrangler deploy --env production` — ships the committed independence fix `5feab3cee`
(currently undeployed; prod worker is `77eed6f5`). (2) **Re-verify** `POST /api/resolve` → **200** via the
PROVEN override→curl recipe (also confirm each leg's reason names its OWN provider = independence
working). (3) **Promote** both flags (reversible) → **WLK-39 CLOSES**.

## Proven recipes / key facts
- Worker deploy: `cd apps/project-sites && CLOUDFLARE_EMAIL=blzalewski@gmail.com CLOUDFLARE_API_KEY=$(/Users/Apple/.local/bin/get-secret CLOUDFLARE_API_KEY) npx wrangler deploy --env production` (needs Docker up).
- Admin frontend deploy (does NOT auto-deploy on push — only editor Pages does): `cd apps/project-sites/frontend && npm run deploy:production` (same CF auth env). The alt-text gate comment-false-positive is fixed (`755fee004`).
- `/api/resolve` prod-verify: `POST` with `authorization: Bearer $(get-secret E2E_API_KEY)` + `origin: https://projectsites.dev` + `{"prompt":"..."}` → expect 200 (NO browser needed).
- Flag override table = **`flag_overrides`** (NOT feature_flag_overrides); `value_json` needs `{"enabled":true,"rollout_percent":100}`; `resolution_engine` resolves on EMPTY scope → needs a **GLOBAL** override, `claude_code_panel` an ORG override (`org-brian-001`). Wait ~70s for the 60s flag KV TTL after a D1 override write. ALWAYS revert (`DELETE FROM flag_overrides WHERE set_by='...'`).
- Latest HEAD: `134901116`. Milestone commits: S7-prep `4c55c773d` · admin deploy + alt-text fix `755fee004` · Resolution bridge `e9cbe2da4` · gateway-401 fix `316f3ef7a` + deploy `77eed6f5`.
- Memories: `[[admin-frontend-needs-explicit-r2-deploy-not-auto-on-push]]` · `[[editor-dark-flag-resolves-via-admin-bridge-not-direct-fetch]]` · `[[cf-ai-gateway-authenticated-401-needs-cf-aig-authorization-or-fallback]]`.

## Cron + fresh-session guidance (READ if you're continuing this loop)
The Editor-focus cron (`a2c2e412`) keeps firing "finish the Editor panel" — but **BOTH its clauses are
DONE + verified**: the Resources-screen tabs (fire-193, observed live) AND the WLK-39 panel
(engineering-complete fire-188, incl. the dual-provider independence fix `5feab3cee`). The only open
items are platform-secret provisions — **LLM credits (Anthropic+OpenAI)** + **R2 S3 creds** — which are
Brian's, not code.

**If you are a FRESH session and billing is STILL blocked (poll `/api/resolve` per the recipe above, or
ask Brian): DO NOT idle on WLK-39.** The focus-cron's specific target is complete, so the `[[cronE]]`
pin is RELEASED — **pivot to the broader loop frontier in `BACKLOG.md`** (general P2 work: WLK-38 Apps
catalog, WLK-40 Full IDE, WLK-45 Super-Admin ideas, + whatever else is ready) and advance it with fresh
context. Keep an ~hourly billing poll as a BACKGROUND safety net so WLK-39 auto-closes the instant
credits land. Idling on this completed target was only correct within a SATURATED session (fires
187-200); a fresh session should make real progress elsewhere. (Repointing the cron to `/loop` is still
a fine option for Brian, but this guidance keeps a fresh session productive regardless.)
