# Audit B — Twilio/SMS/compliance/Stripe (fire-1, 2026-09-28)

Read-only audit, Workstream B. Cited `file:line` under `apps/project-sites/`.

## Top gaps

1. **Purchase calls Twilio with NO Stripe quote/charge boundary** — any authed org member spends real
   money on click (`src/routes/voice.ts:193-218`).
2. **Orphan-number risk is real** — Twilio buys BEFORE the single `dbInsert`; no pre-write `pending`
   row, no `Idempotency-Key` on the Twilio POST, no `releaseNumber` compensation on the 500 path
   (`voice.ts:214-261`, `services/twilio.ts:283`). `pending` status exists in schema
   (`migrations/0036b_voice.sql:30`) but code inserts `'active'` directly.
3. **Hardcoded `monthly_cost_cents: 100`** in two code sites + schema default — not sourced from
   `pricing_config`; the $0.25/started-min rate exists nowhere (`voice.ts:233,286`; `app_cost_meter.ts`
   has 0 voice lines).
4. **No Twilio subaccount** (grep = 0 hits) → zero per-tenant isolation/attribution/suspend.
5. **`BILLING_PROVIDER` resolves to `noop`** (`services/billing_provider.ts:214,237`) → all metered
   usage silently dropped; no CallSid-priced immutable ledger; no nightly reconciliation.

## Single most dangerous current bug

The orphan-number + no-payment-gate purchase — unpaid, non-idempotent, uncompensated carrier charge;
money leaves via Twilio with no Stripe capture and a real double-buy/orphan window. Voice routes are
mounted with **no `isFlagOn` gate** (`src/index.ts:998-1001`) → no killswitch.

## First slices (RED-testable, ≤15min)

- (a) Register a `voice_numbers` flag + gate the purchase route (immediate killswitch).
- (b) Failing mock-Twilio test: buy-succeeds-then-D1-fails → fires compensating `releaseNumber`,
  persists no `active` row.
- (c) Number rental price reads `pricing_config`, not the literal `100`.
- (d) `Idempotency-Key` (= pre-written pending-row id) on `purchaseNumber`; double-POST → one buy.

## Already solid (not gaps)

- Stripe webhook sig verification + replay window + quarantine (`services/webhook.ts:59`,
  `routes/webhooks.ts:141`).
- Twilio webhook sig verification → 403 (`twilio.ts:480`, `routes/voice_webhooks.ts:60`).
- DB-ownership re-checks on every voice read/mutate — **no IDOR** (`voice.ts:95,368,523,707`).
- B1 live number search largely built.
