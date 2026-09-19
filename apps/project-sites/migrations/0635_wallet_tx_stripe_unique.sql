-- 0635_wallet_tx_stripe_unique.sql
-- Harden wallet-credit idempotency to be DB-ENFORCED (defense-in-depth on the money path).
--
-- creditWallet() dedupes on stripe_event_id via a SELECT-then-skip, and in prod the
-- webhooks.ts webhook_events UNIQUE(provider,event_id) guard already serializes each Stripe
-- delivery BEFORE the credit runs — so today there is no live double-credit. But the
-- SUPPORTING index (idx_wallet_tx_stripe from 0036_wallet_billing.sql) was NON-unique, so the
-- credit path's exactly-once guarantee rested entirely on the outer layer + an app-level
-- SELECT (a TOCTOU under any future un-deduped caller). Replace it with a UNIQUE partial
-- index: a second credit carrying the same Stripe event id now FAILS at INSERT, and
-- creditWallet reverses its balance add + treats the violation as an idempotent no-op →
-- exactly-once, guaranteed by the database. Mirrors the billing.ts UNIQUE(provider,event_id)
-- webhook race-guard precedent.
--
-- Safe to apply: prod wallet_transactions has 0 rows with a non-null stripe_event_id
-- (verified 2026-09-19 on project-sites-db-production: dup_event_ids=0, total_credited=0),
-- so no existing row can violate the new constraint. Manual credits (stripe_event_id IS NULL)
-- are excluded by the partial predicate, so unlimited null-event manual adjustments still work.
DROP INDEX IF EXISTS idx_wallet_tx_stripe;
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_tx_stripe
  ON wallet_transactions(stripe_event_id)
  WHERE stripe_event_id IS NOT NULL;
