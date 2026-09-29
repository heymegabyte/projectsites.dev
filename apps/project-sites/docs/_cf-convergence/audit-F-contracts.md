# Audit F — Shared contracts, migrations, baseline (fire-1, 2026-09-28)

Read-only baseline + shared-contracts + migrations owner. Cited under
`/Users/Apple/emdash/repositories/projectsites.dev/`.

## Baseline

- Branch `main`. **6 uncommitted files** (concurrent sessions — DO NOT clobber): 5 modified + 1
  untracked `apps/project-sites/frontend/src/app/pages/admin/sections/hosting.component.ts` (must
  `git add` or its Angular chunk 404s).

## Numbering

- **Next migration: 0648** (ceiling `0647_site_r2_buckets_catalog.sql`).
- **Next ADR: 0056** (highest = 0055; convergence series).
- ⚠️ Voice tables exist (`0036b_voice.sql`). `voice_receptionist` flag is **NOT** in the 72-flag
  registry despite `voice-architecture.md` declaring it → A must register it (F1).

## 6 shared-contract collision hotspots (`packages/shared/src/schemas/`)

- `index.ts` — barrel, all 5 streams.
- `webhook.ts` — A LiveKit + B Twilio/Stripe + D mcp.
- `media.ts` — A recordings + E assets.
- `billing.ts` — B number/call cost + E seo cost.
- `api.ts` — shared error-code enum (B+D+E).
- `base.ts` — shared primitives.

## One-owner rule (ENFORCED)

`packages/shared/**` and `migrations/**` are **stream-F-EXCLUSIVE**. A stream requests a contract; F
lands schema + migration + ascending number (from 0648) in one serialized change; streams then import
the `z.infer` type. Migration numbers assigned ONLY by F, never parallel-picked.

## Cross-stream migration plan (one owner, ascending from 0648)

Voice calls/media/critique · number-purchase state machine · per-call Stripe ledger · mcp grants +
`mcp_resource_tokens` wiring · Traks analytics · short-links authoritative store · OpenSEO cost ledger.

## Dependency graph

- Shared default-AI-chat service → A voice + C editor.
- `browser_gateway` CF Browser Run Live View → A + C.
- MCP broker authz → A + C + D + E.
- Migrations/contracts (F) → all persisted state.
- ADR 0056 (LiveKit→CF) gates A4/A5.
