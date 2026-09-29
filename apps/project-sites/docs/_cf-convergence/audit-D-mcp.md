# Audit D — ProjectSites MCP broker (fire-1, 2026-09-28)

Read-only audit, Workstream D. Cited `file:line` under `apps/project-sites/`.

## Top gaps

1. **OAuth AS mints an org-wide 90-day `psk_` token** (`mcp_oauth_provider/handlers.ts:308`) — not
   audience-bound, not Site-scoped. Full-org blast radius from one leaked token.
2. **`mcp_resource_tokens` (audience-bound, per-site, RFC-8707; `migrations/0037:249`) is a total
   ORPHAN** — zero code refs. The idea-#6 mitigation was schema'd then abandoned.
3. **No consent Site multi-select** (`oauth-consent.component.ts`) — consent is org-wide; shows a
   generic label, never real `client_name`.
4. **Not Streamable-HTTP, unversioned** (`/api/mcp`, JSON-RPC single-shot; `handlers.ts:49`). No SSE/
   session/version.
5. **Per-site CRUD tools (`SITE_MCP_TOOLS`) have no live JSON-RPC transport** (`mcp_site.ts` absent) —
   tokens authenticate nothing.

## First slices (RED-testable, ≤15min)

- `resource_token_audience.test.ts` — OAuth exchange issues an `aud`-bound, site-scoped token (wires
  the orphaned `mcp_resource_tokens`).
- `oauth_consent_site_select.spec.ts` — consent lists only owned sites; grant scoped to the subset.
- `idor_body_siteid.test.ts` — regression pinning every `site_id` tool/route to 404-on-foreign.

## IDOR / tenant-isolation

**No live IDOR.** Ownership enforced everywhere (org-scoped SQL + `assertSiteOwned`/`siteOwned`),
rechecked at `tools/call` not just `tools/list`, 404-not-403. `mcp_connections` IS per-site
(`UNIQUE(site_id,provider)`, `migrations/0013:138`). Only concern is the org-wide OAuth token blast
radius (gap 1).
