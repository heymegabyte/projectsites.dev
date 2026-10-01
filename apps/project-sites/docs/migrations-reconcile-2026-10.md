# D1 Migration Reconciliation — fire-61 (2026-10-01)

Prod `project-sites-db-production` (`ea3e839a`) reported **78 migrations unapplied** on a
working schema; blanket `wrangler d1 migrations apply` died (fire-60, on `ai_endpoints`).
This pass schema-diffed every ghost file against prod `sqlite_master`, applied what was
genuinely missing (additive only), rewrote files that contradict prod reality, and tracked
all 78. **End state proven: `migrations list` → "No migrations to apply!" and
`migrations apply` → clean no-op.** Prod: 572 → 629 tables, feature_flags 2 → 43 rows,
d1_migrations 111 → 189 rows.

## Method

1. Dump `sqlite_master` (2,125 objects) once; parse every ghost file statement-by-statement
   (tables/indexes/views/triggers/columns/seed rows) and classify.
2. **Local dress rehearsal**: preload the full prod DDL into a `:memory:` SQLite and replay
   all 68 apply-candidates in lexicographic order via `executescript` — caught 2 broken
   files **before** any remote call.
3. Apply each file whole via `wrangler d1 execute --remote --file` (small discrete batches;
   concurrent-rebuild-safe), stop-on-first-failure.
4. Track all 78 via idempotent `INSERT INTO d1_migrations (name) SELECT ... WHERE NOT EXISTS`.

## Classification + disposition (78 ghosts)

| Class | Count | Files | Action |
|---|---|---|---|
| ALREADY-EFFECTIVE | 8 | 0643_app_instance_domains · 0644_app_instance_domain_purchases · 0645_site_r2_allocations · 0646_durable_preview_model · 0648_add_serving_sha · 0649_ai_api_key_grants · 0650_mcp_oauth_codes · 0651_team_invites_deleted_at | Every object already in prod (created by earlier direct-applies, fire-58/60 precedent). Tracking row inserted; nothing executed. |
| NOT-D1 (DO schemas) | 2 | do-app-runtime-schema · do-tracehub-schema | Durable-Object SQLite reference copies that live in `migrations/` only because the lockstep tests (`app_runtime_schema_lockstep.test.ts`, `trace_hub_schema_lockstep.test.ts`) read them there. They must NEVER run against platform D1 → **sentinel-tracked** (row inserted, content never executed). Proper fix (deferred, needs code edits): move them out of `migrations/` + update the two test paths. |
| NOT/PARTIALLY-EFFECTIVE, applied | 68 | everything else (0020…0647) | Whole-file direct-applied after prod-reality edits (below). All statements additive: 57 new tables, ~150 indexes, 3 views, 2 FTS triggers, ~25 ADD COLUMNs, 41 dark flag seeds, section_marketplace seed rows. Zero DROPs, zero destructive ALTERs. |

## Files edited (19 — all were UNAPPLIED, so editing is safe)

| File | Edit | Why |
|---|---|---|
| 0020_ai_endpoints_ide | **Rewritten to no-op** (`SELECT 1`) | 11 ALTERs on `ai_endpoints` — a REMOVED feature (ADR-0035, Functions-on-WfP); the table is intentionally absent in prod. This file is what killed fire-60's blanket apply. Never recreate ai_endpoints. |
| 0516_drop_phone_otps | **Rewritten to no-op** | Its DROPs never ran; `phone_otps` still exists and doctrine treats it as an inert orphan. Reconciliation constraint = NEVER-DROP. Wanting the drop later = author a NEW migration. |
| 0512_copilot | 2 indexes retired (commented) | Prod `copilot_sessions` was created by a different tracked lineage WITHOUT `site_slug`/`intent`; those indexes can never apply. The valid org/site index WAS applied. |
| 0527_affiliate_program | 5 indexes retired | Prod `affiliates`/`affiliate_referrals` are a different live implementation (affiliate_email/code vs owner_email/owner_user_id). `affiliate_commissions` (+3 indexes) WAS created. |
| 0566_feature_flags_new_modules | 1 index retired | Prod `booking_slots` has no `org_id`. Other 6 indexes applied (incl. on 0563's new payments_rail_events). |
| 0509 0510 0517 0518 0519 0520 0521 0522 0523 0525 0563 0609 | **Flag INSERTs rewritten to prod shape** | They targeted legacy column sets — `(key, description, enabled_globally, rollout_pct)` / `(key, enabled, rollout_percent, stage, …)` — that NEVER existed in prod `feature_flags` `(id, org_id, flag_name, enabled, metadata_json)`. Rewritten as idempotent `INSERT OR IGNORE` carrying the original description/stage/rollout inside `metadata_json`. 15 flags across these files. |
| 0506_section_marketplace | Quote-escape fix | 5 seed rows contained a bare `'true'` inside the FAQ template's inline JS → `near "true": syntax error`. **The file was unapplyable anywhere, ever** — which is why section_marketplace never existed. |
| 0593_ai_content_strategist_flag | Quote-escape fix | Bare apostrophe in `doesn't` inside the description string → same class. |

## Flag-seed safety note

The runtime flag engine (`modules/feature_flags/services.ts`) evaluates `FLAG_REGISTRY`
(code) + `flag_overrides` (D1). The legacy `feature_flags` table is **not read by the
evaluator** — seeding its 41 missing rows (all `enabled=0`) is runtime-inert history
alignment: nothing darkened, nothing lit up.

## Residual oddities (documented, deliberately left)

- **2 ghost tracking rows** — `0009_audit_logs_token_cost.sql` + `0010_widget_events.sql`
  are tracked in `d1_migrations` but have no file on disk (renamed/deleted after apply).
  Harmless: wrangler only compares files→rows, not rows→files.
- **Number collisions** — tracked `0643_data_resource_registry.sql`/`0644_data_query_history.sql`
  coexist with on-disk `0643_app_instance_domains.sql`/`0644_app_instance_domain_purchases.sql`
  (numbers were reused after a rename era). Names, not numbers, are the identity — both sets
  are now tracked.

## Invariants going forward

1. **Never rename or delete an APPLIED migration file.** Tracking is by exact filename; a
   rename makes wrangler re-list it as unapplied (and re-RUN it on the next blanket apply)
   while stranding a ghost row. (Also codified in the global naming rule.)
2. **Reconcile via direct-apply + track, never blanket-apply history onto a drifted DB:**
   schema-diff → apply only the genuinely-missing ADDITIVE statements → insert the
   `d1_migrations` row `WHERE NOT EXISTS`. Fire-58 (0651), fire-60 (0652), fire-61 (this).
3. **Parse-validate every new migration before commit** — `python3 -c "import sqlite3;
   sqlite3.connect(':memory:').executescript(open('migrations/NNNN_x.sql').read())"` (with
   prod-DDL preload for ALTERs; see `/tmp`-era `fire61-rehearse.py` pattern). 0506 and 0593
   sat unapplyable for months because nothing ever parsed them.
4. **Editing an UNAPPLIED migration file is safe and correct** when prod reality has moved
   past it (dead-feature tables, shape divergence) — no-op/guard it, then track it.
5. **DO-schema `.sql` files don't belong in `migrations/`** — until moved (needs the two
   lockstep-test path updates), they stay sentinel-tracked.

## Proof (2026-10-01)

```
$ wrangler d1 migrations list project-sites-db-production --env production --remote
✅ No migrations to apply!
$ wrangler d1 migrations apply project-sites-db-production --env production --remote
✅ No migrations to apply!
```

Post-apply spot-checks: `billing_events` · `section_marketplace` (30 seeds) · `worker_logs`
(+FTS trigger `worker_logs_ai`) · better-auth `account` · `site_tags` ·
`affiliate_commissions` · `idx_users_created_at` · `v_billing_health_7d` all present;
tables 629; feature_flags 43; d1_migrations 189.
