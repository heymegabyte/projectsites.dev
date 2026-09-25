# 0036 — Per-site D1 + KV isolation (the Editor "Data" model)

**Status:** Accepted (2026-09-25) · **Supersedes** the shared-D1 Data model + the planned Vectorize/Queues/Workflows/R2 Data-resource adapters.

## Context

- projectsites.dev is a **Cloudflare passthrough vendor** (North Star): customer sites are Workers-for-Platforms tenants. See memory `projectsites-cf-passthrough-vendor-model`.
- **TODAY:** ONE shared platform D1 (`env.DB`) holds every tenant's rows, scoped by `site_id`/`org_id` in our code. No per-site D1/KV. WfP dormant (`wfp_dispatch.ts`). The Editor "Data" SQL console runs against the shared D1 (super-admin only — a write hits every tenant).
- **Decision (Brian):** the ONLY things we bind to a tenant Worker are **D1 and KV**, and **each site gets its OWN D1 + KV, fully isolated ("hidden from each other").** Any other stateful resource that can be scoped to a single site should be — but only D1 + KV are in scope now.

## Security driver (non-negotiable)

- D1/KV bindings are **all-or-nothing — no row-level security.** A binding grants full read/write to the whole database/namespace. Untrusted tenant code + a shared binding = total cross-tenant breach.
- **Per-site provisioning + isolated binding is a PREREQUISITE for any tenant code (WfP Functions).** Order: provision per-site D1+KV → bind ONLY those → THEN enable code. See memory § SECURITY GATE.

## Decision

1. **Per-site D1** — one native D1 database per site, bound ONLY to that site's Worker. Isolation is the WfP binding boundary (a Worker can only access its attached bindings; it can't even name another site's DB). Scales: 50k DBs/account default → millions by request; each tenant Worker binds exactly one.
2. **Per-site KV** — ⚠️ native KV **namespaces cap at 1,000/account**, so a dedicated namespace per site does NOT scale to millions. **Resolution: back each site's KV with its OWN isolated per-site D1** — a `_kv` table (`key TEXT PRIMARY KEY, value BLOB, metadata JSON, expiration INTEGER`). KV becomes a facet of the site's single isolated store → inherits D1's isolation + scale, needs no extra binding, and the Data editor renders a "KV" view over it. (A native KV namespace per site is acceptable ONLY while total sites ≤ ~1,000; abstract KV behind a port so it can migrate to KV-in-D1 without touching tenant code.)
3. **Editor "Data" = the per-site D1 + KV manager** — the Data tab targets the SITE's own D1 (SQL console + table browse/edit) and its KV (list/get/put/delete). The shared-platform-D1 console stays super-admin-only and OFF the owner surface.
4. **Removed from "Data": Vectorize · Queues · Workflows · R2.** They are not tenant Data resources. **R2 → the whole bucket mounts into the bolt.diy file tree** (files, not a Data browser). Vectorize/Queues/Workflows, if ever offered, arrive as mediated Features / WfP-Functions bindings — never the Data tab.

## Consequences

- Isolation is **physical** (binding boundary), not query-discipline → structurally eliminates the tenant-code IDOR class.
- One isolated store per site (D1, with KV as a table in it) is the simplest design that satisfies isolation **and** scale **and** "only bind D1/KV."
- Provisioning becomes a hard dependency to build; cost/usage metering per tenant is mandatory (usage bills to our account).

## Current → Target

- **Current (honest):** shared D1, row-scoped, super-admin SQL console.
- **Target:** per-site D1 (+ KV-in-D1), isolated bindings, owner-facing Data editor over the site's own store.

## Implementation plan (staged — any context can pick this up)

1. **Provisioning service** `provisionSiteResources(siteId)` — create the site's D1 via CF D1 REST (`POST /accounts/{acct}/d1/database`), run the base migration (incl. `_kv`), persist the D1 id + name on the site row. Idempotent; flag-gated (`per_site_data`, default-off); dormant until ready. (KV-in-D1 → no namespace to create.)
2. **Isolated binding wiring** — in the WfP upload (`wfp_dispatch.ts` metadata array), attach ONLY that site's D1. Never the shared platform D1.
3. **Data editor retarget** — the Editor Data panel + owner Data API point at the site's own D1 (SQL/tables) + KV (over `_kv`). Add a KV view (list/get/put/delete/TTL) beside Tables + SQL.
4. **Backfill migration** — move existing sites' shared-D1 rows (`site_data`/`form_submissions`/`visitor_events`, scoped by `site_id`) into each site's new per-site D1. One-way; run with D1 Time Travel as the safety net.
5. **Gate** — no tenant code execution (WfP Functions) until 1–3 are live + verified isolated (a tenant Worker provably cannot read another site's DB).

## Non-goals

- No Vectorize/Queues/Workflows/R2 as tenant Data resources.
- No customer code on shared bindings, ever.
- No per-site native KV namespace at scale (the 1,000-cap makes it a dead end past early stage).
