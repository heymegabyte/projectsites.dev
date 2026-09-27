-- 0644_app_instance_domain_purchases.sql
--
-- Pending "buy a domain through us" records for the app-instance domain flow.
--
-- The purchase endpoint (`POST /api/apps/instances/:id/domains/purchase`) creates a Stripe
-- Checkout Session that combines a ONE-TIME domain-registration line item (at CF Registrar
-- at-cost pricing) with the $50/mo recurring paid subscription. Because the charge only
-- settles asynchronously (Stripe `checkout.session.completed` webhook), we persist a PENDING
-- record here keyed on the Stripe Checkout Session id so the webhook can complete the flow:
-- register the domain at Cloudflare Registrar (or queue it for concierge), then create + attach
-- the CF custom hostname to the instance.
--
-- Idempotency: the webhook keys completion on `status` reaching a terminal value
-- (`registered` | `registration_queued` | `failed`). `stripe_session_id` is UNIQUE so a
-- replayed webhook (or double-delivery) resolves to the same row and short-circuits.
--
-- Additive (blast-radius-minimization): no change to `app_instances` or `app_instance_domains`.
-- On completion the webhook writes the live domain into `app_instance_domains` (status
-- `active` when registered, `registration_queued` when CF can't auto-register the TLD).

CREATE TABLE IF NOT EXISTS app_instance_domain_purchases (
  id                 TEXT PRIMARY KEY,
  instance_id        TEXT NOT NULL,
  org_id             TEXT NOT NULL,
  domain             TEXT NOT NULL,
  tld                TEXT NOT NULL,
  -- At-cost registration price captured at checkout time (USD, whole dollars).
  price_usd          INTEGER NOT NULL DEFAULT 0,
  currency           TEXT NOT NULL DEFAULT 'USD',
  stripe_session_id  TEXT NOT NULL,
  -- 'pending' → checkout created, awaiting payment
  -- 'paid'    → webhook received, registration in flight
  -- 'registered'          → CF Registrar registration succeeded + hostname attached
  -- 'registration_queued' → paid, but CF can't auto-register (unsupported TLD / API gap) → concierge
  -- 'failed'  → registration failed after payment (needs manual intervention / refund)
  status             TEXT NOT NULL DEFAULT 'pending',
  -- CF Registrar async workflow poll URL (202 responses) for status follow-up, when present.
  cf_poll_url        TEXT,
  error             TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

-- One pending row per Stripe Checkout Session (idempotency key for the webhook).
CREATE UNIQUE INDEX IF NOT EXISTS idx_aidp_session ON app_instance_domain_purchases(stripe_session_id);
CREATE INDEX IF NOT EXISTS idx_aidp_instance ON app_instance_domain_purchases(instance_id);
CREATE INDEX IF NOT EXISTS idx_aidp_domain ON app_instance_domain_purchases(domain);
