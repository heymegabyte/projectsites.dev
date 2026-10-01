-- Migration 0566: indexes for tables introduced in migrations 0563-0565

CREATE INDEX IF NOT EXISTS idx_payments_rail_events_org
  ON payments_rail_events(org_id);

CREATE INDEX IF NOT EXISTS idx_storefront_products_org_site
  ON storefront_products(org_id, site_id);

-- fire-61 reconcile (2026-10-01): RETIRED - prod's booking_slots has NO org_id
-- column (shape: id, site_id, start_at, end_at, capacity, booked_count,
-- price_cents, status), so this index can never apply there.
-- CREATE INDEX IF NOT EXISTS idx_booking_slots_org_site_start
--   ON booking_slots(org_id, site_id, start_at);

CREATE INDEX IF NOT EXISTS idx_booking_appointments_slot
  ON booking_appointments(slot_id);

CREATE INDEX IF NOT EXISTS idx_credit_wallet_ledger_org_created
  ON credit_wallet_ledger(org_id, created_at);

CREATE INDEX IF NOT EXISTS idx_referral_codes_org
  ON referral_codes(org_id);

CREATE INDEX IF NOT EXISTS idx_referral_attributions_code
  ON referral_attributions(referral_code_id);
