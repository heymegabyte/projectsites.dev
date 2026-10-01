-- Migration 0527: Affiliate Program (idea #32)
--
-- Public-facing partner version of the internal referral_loop. Partners enroll,
-- get a unique tracking code + /r/:code attribution link, and earn a 50%
-- recurring commission on the MRR of orgs they refer for the first 12 months
-- (the Framer model). Payouts settle via Stripe Connect Express.
--
--   1. affiliates             — one row per enrolled partner (code, owner email,
--                               optional Stripe Connect account id for payouts).
--   2. affiliate_referrals    — attribution trail: a visitor anon-id bound to an
--                               affiliate code, optionally resolving to a signed-up
--                               org once they convert to a paid subscription.
--   3. affiliate_commissions  — one row per accrued recurring-month commission
--                               (50% of that month's MRR), with payout status.

-- ─── 1. Affiliates ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS affiliates (
  id                  TEXT PRIMARY KEY,
  code                TEXT NOT NULL UNIQUE,        -- uppercase alphanumeric tracking code
  owner_email         TEXT NOT NULL,
  owner_user_id       TEXT,                        -- nullable: enrollee may pre-date an account
  stripe_connect_id   TEXT,                        -- Stripe Connect Express acct for payouts
  status              TEXT NOT NULL DEFAULT 'active', -- 'active' | 'suspended'
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  deleted_at          TEXT
);

-- fire-61 reconcile (2026-10-01): prod's `affiliates` table was created by a
-- DIFFERENT (tracked) lineage with shape (id, org_id, affiliate_email, code,
-- commission_pct, lifetime_revenue_cents, status, created_at). The CREATE TABLE
-- above no-ops there via IF NOT EXISTS, so owner_email/owner_user_id never exist
-- and these two indexes can never apply. Prod reality wins - retired.
-- CREATE UNIQUE INDEX IF NOT EXISTS idx_affiliates_owner_email ON affiliates(owner_email) WHERE deleted_at IS NULL;
-- CREATE INDEX IF NOT EXISTS idx_affiliates_owner_user_id ON affiliates(owner_user_id);

-- ─── 2. Attribution referrals ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS affiliate_referrals (
  id                  TEXT PRIMARY KEY,
  affiliate_code      TEXT NOT NULL,               -- denormalized for fast click-time writes
  visitor_anon_id     TEXT NOT NULL,               -- cookie-set anonymous attribution id
  signed_up_org_id    TEXT,                        -- set when the visitor converts to an org
  status              TEXT NOT NULL DEFAULT 'clicked', -- 'clicked' | 'signed_up' | 'converted'
  clicked_at          TEXT NOT NULL,
  converted_at        TEXT,                        -- timestamp of first paid subscription
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  deleted_at          TEXT
);

-- fire-61 reconcile (2026-10-01): prod's `affiliate_referrals` was likewise created
-- by a tracked lineage with shape (id, affiliate_id, referred_customer_id,
-- conversion_cents, commission_cents, status, created_at) - no affiliate_code /
-- visitor_anon_id / signed_up_org_id columns, so these indexes are retired too.
-- CREATE INDEX IF NOT EXISTS idx_affiliate_referrals_code ON affiliate_referrals(affiliate_code);
-- CREATE INDEX IF NOT EXISTS idx_affiliate_referrals_anon ON affiliate_referrals(visitor_anon_id);
-- CREATE INDEX IF NOT EXISTS idx_affiliate_referrals_org ON affiliate_referrals(signed_up_org_id);

-- ─── 3. Recurring commissions ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS affiliate_commissions (
  id                  TEXT PRIMARY KEY,
  affiliate_code      TEXT NOT NULL,
  referral_id         TEXT NOT NULL,               -- FK -> affiliate_referrals.id
  amount_usd          REAL NOT NULL,               -- 50% of the month's MRR, in USD
  pct                 INTEGER NOT NULL DEFAULT 50, -- commission percent (always 50 for v1)
  recurring_month     INTEGER NOT NULL,            -- 1..12; the Nth billed month
  status              TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'paid' | 'void'
  paid_at             TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  deleted_at          TEXT
);

-- One commission per (referral, recurring_month) — idempotent accrual guard.
CREATE UNIQUE INDEX IF NOT EXISTS idx_affiliate_commissions_referral_month
  ON affiliate_commissions(referral_id, recurring_month) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_affiliate_commissions_code ON affiliate_commissions(affiliate_code);
CREATE INDEX IF NOT EXISTS idx_affiliate_commissions_status ON affiliate_commissions(status);
