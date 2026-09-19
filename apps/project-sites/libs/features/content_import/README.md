# content_import

Flag-gated wiring that makes the **already-unit-tested** export parsers in
`src/services/content_import.ts` reachable via an API. Those parsers
(WordPress XML / Squarespace JSON / Wix CSV / Webflow JSON / generic CSV / RSS-Atom →
normalized `ContentItem[]`) had **zero consumers** for ~3 months — built-but-unwired.

## What it does

`POST /api/content-import/parse` — body `{ source, raw }` (Zod-validated) → `{ data: { source, count, items } }`.
The export-based ingestion path that complements the live-site crawler: an owner who has an
export (or whose old site is down) can normalize their content for seeding into a generated site.

## Contract

- **Flag**: `content_import` — `enabled=0, rollout=0, stage='experimental'`. Off → `404` (dark, never 403). Unauth → `401`.
- **Input**: `source ∈ {wordpress,squarespace,wix,webflow,csv,rss}`, `raw` (1–200 000 chars — capped under the 256 KB body limit).
- **Errors**: a malformed export → `400 CONTENT_IMPORT_PARSE_ERROR` (typed, never a 500 or partial write).
- **Pure**: no D1 write, no state — the endpoint only parses + returns.

## Follow-ons (tracked)

- **Seed into a build**: pipe parsed `items` into the site-gen pipeline (the export becomes source content). Gated on build-LLM credit to prove live.
- **Large exports**: multi-MB WP exports exceed the 200 KB cap → an R2-upload → parse path.

## Files

- `handlers.ts` — the flag-gated Hono route. `schemas.ts` — Zod boundary. `service.ts` — `FLAG_KEY`.
- Parsing itself: `src/services/content_import.ts` (+ `src/__tests__/content_import.test.ts`).
- Endpoint test: `__tests__/content_import_endpoint.test.ts`.
