# Discovery — security supply-chain + H1 correction (loop fire, 2026-09-29)

> Read-only. JOB A: worker security-supply-chain audit. JOB B: correct a prior grep-based finding.
> Headline: posture is STRONG — the one actionable item is SHA-pinning GitHub Actions.

## JOB A — security-supply-chain

**Confirmed strong (no action):**
- **Webhook signature** — Stripe verified (HMAC-SHA256, timing-safe) at `routes/webhooks.ts:141` + `services/webhook.ts:59-105`; all inbound webhooks go through it.
- **Stripe replay** — idempotent on `event.id` via `webhook_events` UNIQUE(provider,event_id); terminal states block reprocess (`webhook.ts:150-186`).
- **Secrets at rest** — `ai_crypto.ts` AES-GCM + per-record IV in D1; plaintext never logged; mandatory for org/site/mcp env vars.

**Next-wave tasks:**
1. **[SUPPLY · READY · <2h] SHA-pin GitHub Actions.** `.github/workflows/ci.yaml` (+ siblings) pin actions to major version (`actions/checkout@v4`), not commit SHA — a malicious minor release ships unnoticed. Action: pin every `uses:` to a full SHA (per `supply-chain-integrity`); wire a `sha-pin-actions --check` gate. Latent risk, but the standard hardening.
2. **[TOKEN · latent] API-token rotation cadence.** `api_tokens.expires_at` column is wired + checked (`middleware/api-keys.ts:50`) but tokens default to never-expire; no rotation cadence enforced in code (policy-level). Action: optional default TTL + a rotation reminder.
3. **[SUPPLY · info] `pnpm audit`** runs on every push (`security.yaml:76`) but `continue-on-error:true` (visibility, not a block). Consider failing on `high`+.

## JOB B — H1 correction (grep false-positive)
- **Verdict:** the prior "5 admin sections have 0 H1" finding was a **FALSE POSITIVE**. `analytics`/`ai-logs`/`analytics-glossary`/`analytics-live`/`api-tokens` have no INLINE `<h1>` but render as sub-routes under the admin shell, which provides ONE page-level H1 (confirmed live: `/admin/analytics` rendered `h1:1` via Browserbase last fire). So they are WCAG-OK (exactly 1 rendered H1). No fix needed. Optional nicety: a scoped `<h1 class="sr-only">` per section for independent-page screen-reader clarity — low value, do NOT add blindly (would risk a 2nd H1).

## Sub-area NOT reached (rotate next fire)
- GDPR data-at-rest for customer PII · Better-Auth IdP/SAML webhook sig-verify · secret rotation cadence (tracked in `secret-provisioning`).
