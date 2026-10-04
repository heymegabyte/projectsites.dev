# site_crawl

The provider-independent **FOUNDATION** (CRAWL-0) of the whole-site-crawl feature. This slice
is pure types + a port + a stub — it ships NO reachable surface. It exists so CRAWL-1..4
(engine wiring, routes, workflow, persistence) build against a stable, vendor-free contract.

## What it does (CRAWL-0)

- **`schemas.ts`** — the Zod domain SSOT: `CrawlRequest`, `CrawlJob`, `CrawlPage`, `CrawlLink`,
  `CrawlCoverage`, `CrawlManifest` + the `CrawlMode` / `CrawlStatus` / `CoverageStatus` /
  `LinkKind` enums. Every TS type is `z.infer`'d — never hand-duplicated. NO Cloudflare shape
  leaks in; this is the vendor-free domain.
- **`provider.ts`** — the `CrawlProvider` port (`start` / `status` / `results` / `cancel`, all
  speaking only domain types) + `CloudflareCrawlProvider`, a STUB whose every method throws
  `CRAWL-1: not yet implemented`. The CF Browser-Run `/crawl` semantics (async job, cursor
  pagination that MUST be exhausted, `source:all`, `crawlPurposes:["search"]`,
  `contentUse:"reference"`, `render:false` fast path) are documented in its JSDoc and are the
  CRAWL-1 implementation's concern — they never appear in the port's signatures.

## Not here (later slices)

Routes, the crawl workflow, R2/D1 persistence, and the real engine wiring are **CRAWL-1..4** —
intentionally out of this foundation. Swapping crawl engines later is a new
`implements CrawlProvider`, nothing more.

## Flag + safe-disabled behavior

- **flagKey**: `site_crawl` — `enabled=0, rollout=0, stage='experimental'` (DARK by default).
- There is no route yet, so there is nothing to 404. When CRAWL-1 adds routes, the server guard
  returns **404** (never 403 — don't leak existence) while the flag is off, and the UI guard
  renders nothing. Promotion through the flag stages (`/admin/feature-flags`) is what turns the
  feature on — no code change, no redeploy.

## Files

- `schemas.ts` — Zod domain. `provider.ts` — port + CF stub. `feature.manifest.ts` — the manifest.
- `__tests__/schemas.spec.ts` — unit coverage (request validity, enums, stub throws CRAWL-1).
