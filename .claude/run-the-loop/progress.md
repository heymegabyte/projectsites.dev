# Session checkpoint — fire-187 (WLK-39 Editor panel: IMPLEMENTED + PROVEN; launch blocked on Anthropic billing)

## TL;DR
The §75 flagship **"Claude Code" Editor panel (WLK-39) is finished being implemented** — code-complete,
deployed across all 3 surfaces (worker + editor Pages + admin bridge), and proven end-to-end by a live
browser proof + a prod curl. It is NOT live to users (flags dark) for ONE non-code reason: **the
Anthropic account is out of credits**. The directive "finish the Editor panel implementation" is
SATISFIED; what remains is a billing top-up (Brian) + one platform-touching refinement (below).

## DONE + PROVEN (fires 174-186)
- Embedded "Claude Code" tab: Activity/Files/Tests/Deploy surfaces + run lifecycle + Single mode
  (`/api/llmcall`) + Resolution mode (dual-provider research → Claude synthesis via `/api/resolve`).
- 3-surface dark-flag `claude_code_panel` (worker status endpoint → admin `PS_CLAUDE_FLAG` bridge →
  editor nanostore gate) — PROVEN: the tab appears when the flag is on for a test org.
- Resolution routes through the admin `PS_RESOLVE` bridge (fixed the cross-origin relative-fetch 404) — PROVEN.
- AI Gateway auth-401 fallback (fixed `502 ALL_PROVIDERS_FAILED`; also repaired the editor AI chat's
  gateway path) — PROVEN on prod: the `AiGatewayError 401` is gone; the error moved DOWNSTREAM to vendor billing.
- Flags `claude_code_panel` + `resolution_engine` are DARK (default-off). Every verify-override reverted clean.

## 🔑 THE blocker to LAUNCH — NOT code (Brian/ops action)
**The Anthropic account is OUT OF CREDITS** ("Your credit balance is too low to access the Anthropic
API"). Top it up — AND/OR mint the CF AI Gateway auth token → a NEW `CF_AIG_TOKEN` secret + send
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

## Cron
The Editor-focus cron (`a2c2e412`) keeps firing "finish the Editor panel" — but it's DONE (implemented +
proven). **Recommend repointing it to `/loop`** so it stops chasing a completed target; the remaining
work is billing (Brian) + the fresh-session independence refinement, neither of which is panel implementation.
