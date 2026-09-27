# site_data_api

Per-site **D1 data tables** — a generic key→JSON row store (`site_data`) that
generated websites poll to stay in sync, plus the authenticated admin CRUD
behind it. One public host-resolved read endpoint and four org-scoped admin
endpoints (list tables, read/upsert/delete rows). Table names are whitelisted
(`ALLOWED_PUBLIC_TABLES`) to prevent data leaks. **Core, un-gated** routes (no
feature flag) — the FIRST route-organization module extracted VERBATIM from the
`search.ts` monolith (route-decomposition installment 21), not a dark-launched
feature.

## Routes (`handlers.ts` → `siteDataApi`, mounted at `app.route('/', siteDataApi)`)

| Method | Path                                   | Auth   |
| ------ | -------------------------------------- | ------ |
| GET    | `/api/public-data/:table`              | public |
| GET    | `/api/sites/:siteId/data/:table`       | orgId  |
| PUT    | `/api/sites/:siteId/data/:table/:rowId`| orgId  |
| DELETE | `/api/sites/:siteId/data/:table/:rowId`| orgId  |
| GET    | `/api/sites/:siteId/data`              | orgId  |
| GET    | `/api/sites/:siteId/data-overview`     | orgId  |
| GET    | `/api/sites/:siteId/data-overview/:table` | orgId |

### Data overview (real site-scoped platform tables)

`site_data` above is empty for nearly every site; a site OWNER's real data lives
in shared platform tables scoped by `site_id`. `data-overview` returns a curated,
read-only view of THOSE (`visitor_events`, `form_submissions`, `site_snapshots`,
`mcp_connections`, `site_data`) with live row counts, and `data-overview/:table`
browses recent rows. Powers the editor **Data** tab + admin data overview. Each
table carries an EXPLICIT safe-column allowlist (`SITE_DATA_OVERVIEW_TABLES`) —
`form_submissions` PII (payload/ip/user_agent) and `mcp_connections` encrypted
tokens are NEVER selected; `email` is masked (`maskEmailValue`). Same `ownsSiteData`
IDOR guard; fail-soft per table (a missing table → 0 / empty, never 500).

## Per-site OWN-D1 "Tables" surface (`site_db_handlers.ts` → `siteDbApi`)

The Data Platform re-arch (`docs/data-platform-scope.md`). Distinct from everything above: those
routes read PLATFORM tables from the **shared** master D1 scoped by `site_id`. These read a
customer's **OWN dedicated Cloudflare D1** (blank at first) — never the shared DB, never another
site's DB. Flag-gated `per_site_data` (DARK); **404 when off**.

| Method | Path                                  | Auth  |
| ------ | ------------------------------------- | ----- |
| GET    | `/api/sites/:siteId/db/tables`        | orgId |
| GET    | `/api/sites/:siteId/db/tables/:table` | orgId |

- **Isolation is structural + server-resolved.** The target database id comes from
  `site_database_allocations` for the OWNED site (`resolveSiteDataDb` in
  `src/services/site_data_db.ts`) — never client-supplied. The two shared platform D1 ids are on a
  hard denylist (`FORBIDDEN_DB_IDS`); resolving one fails closed. A Worker can't statically bind
  thousands of per-site D1s, so execution goes through the CF **REST D1 `/query`** API bound to one id.
- **Lazy provisioning** — the site's blank D1 is created on first access (reuses `provisionSiteD1`,
  idempotent). Empty DB → empty table set (SQLite/D1 internals hidden) → the "New table / Ask AI"
  empty state.
- **`:table` is validated** (`isSafeIdent`, quoted via `quoteIdent`) — D1 REST can't bind an
  identifier — and confirmed to exist before browsing; rows/limit/offset are BOUND params.
- Same `ownsSiteData` IDOR guard; gate order is flag(404-dark) → auth(401) → ownership(404) →
  resolve. CRUD / create-table / typed inline editing / undo / Time-Travel snapshots are later slices.

## Boundaries

- `/api/public-data/:table` is public by design (generated sites poll it with no
  session); it resolves the site from the request `host` and only ever reads
  whitelisted tables, returning a cache-friendly `{ data: [] }` on any error.
- The four `/api/sites/:siteId/data/*` admin routes are org-scoped via
  `c.get('orgId')` (401 when absent) AND guarded by `ownsSiteData(db, siteId,
  orgId)` — a foreign/missing `:siteId` returns 404, never 403, so cross-org
  `site_data` never leaks (the IDOR guard; `orgId` alone would only satisfy the
  401 check).
- No `schemas.ts`: the PUT clamps its body inline (object-guard + `data_json`
  serialization) exactly as the original did. Routes return explicit JSON with
  inline status codes and bubble unexpected throws to the app-level error
  handler (no local `onError`), matching `search.ts`.
- **Must mount before `api`** (and before `search`) so `/api/sites/:siteId/data`
  wins over `api`'s `/api/sites/:id` param routes — the precedence `search.ts`
  held.
