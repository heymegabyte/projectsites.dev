# VISUAL-COVERAGE — Human Experience Evaluation (fire-59)

- **Run:** 2026-10-01 ~03:40Z against PROD `https://projectsites.dev` · provider **cloudflare-browser-run** (CDP) · identity verified `brian@megabyte.space` (super-admin) via `/api/auth/me` 200.
- **Method:** real-browser surf (test-login seam `/signin?test=1`, nav by clicks), screenshot per surface, per-surface console-error + failed-request capture (`visual/2026-09-30/meta.json`). Every screenshot was human-reviewed (AI vision read), not just captured.
- **Honesty:** CLEAN = rendered with real data + 0 console errors witnessed in THIS run. Analytics was re-probed with a 30s paint window before any verdict (shot 15).

## Coverage table

| # | Surface | Route | Viewport(s) | Screenshot(s) (`.claude/run-the-loop/visual/2026-09-30/`) | Verdict | Note |
|---|---------|-------|-------------|------------|---------|------|
| 1 | Public homepage | `/` | 1280×800 + 390×844 | `01-public-home-1280.png`, `02-public-home-390.png` | **CLEAN** | Strong hero, single dominant CTA, ES locale pill, 0 errors both viewports. |
| 2 | Admin dashboard | `/admin` | 1280 + 390 | `03-admin-dashboard-1280.png`, `04-admin-dashboard-390.png` | **DELIGHT-DEBT** | Real data (checklist 2/4, cockpit 1 live site, Paid plan, "All clear"). Debt: unlabeled icon-soup rail; cockpit row ~50% dead space right of 3 cards; @390 checklist item 4 icon/text misaligned vs item 3. |
| 3 | Sites list | `/admin/sites` | 1280 | `05-admin-sites-1280.png` | **DELIGHT-DEBT** | Renders the 1 real site, 0 errors. Card broadcasts **"Readiness F 50/100"** with no explanation or fix affordance; ~70% of viewport empty below one card. |
| 4 | Editor shell | `/admin/editor` | 1280 | `06-admin-editor-shell-1280.png` | **CLEAN** | Workbench booted (49 files), file tree + code + terminal + status bar all real. Nits: admin rail section labels clip mid-word ("WORKSPA", "CAPABIL"); stray glyph bleeds under workspace avatar. |
| 5 | Editor › Database (Data tab) | `/admin/editor` → Database | 1280 | `07-admin-editor-data-tab-1280.png` | **CLEAN** (1 nit) | Real per-site D1: 4 tables (customers/my_table/orders/products), SQL + KV sub-tabs, Schema map, Danger zone. Nit = defect #8 below: active sub-tab pill renders with NO visible label. |
| 6 | Analytics | `/admin/analytics` | 1280 | `08-admin-analytics-1280.png` (entry), `15-admin-analytics-30s-1280.png` (30s probe) | **CLEAN** (data verified) | Entry capture = skeleton wall + LOADING mid-refresh; 30s probe painted REAL data (42 views/7d, 18 visits, 36% bounce, plain-language HIGHLIGHTS). Debt: first-paint latency (gap #4); transient doubled breadcrumb during route transition in shot 08. |
| 7 | Domains | nav "Domains" → `/admin/settings#domains` | 1280 | `09-admin-domains-1280.png` | **DEFECT** (doctrine) | Content excellent (backup domain ACTIVE + Copy/Open, add-own-domain + CNAME hint, AI domain search). Defect: manual **"Refresh" button** — violates real-time-no-manual-refresh rule. |
| 8 | Settings | `/admin/settings` | 1280 | `10-admin-settings-1280.png` | **CLEAN** | 9 tabs, scoped-to-project framing + user-settings cross-link. Nits: clicking nav "Settings" kept the Domains tab active (didn't reset to General); tab names "MCP", "AI Env Vars" are engineer jargon. |
| 9 | Feature Flags | `/admin/feature-flags` | 1280 | `11-admin-feature-flags-1280.png` | **CLEAN** (delight) | 75 flags · 48 on, SYNCED·JUST NOW live badge, stage pills w/ counts, runbook-grade cards (stage/rollout/risk/owner). Best-in-class operator surface. |
| 10 | Apps | `/admin/apps` | 1280 | `12-admin-apps-1280.png` | **CLEAN** | 9 apps, Live/Soon filters, honest cost cards ("Idle $1 · Typical ~$6"). Nits: emoji tile icons instead of real app logos; floating "← Feature Flags" pill grazes LiteLLM card corner. |
| 11 | Generated customer site | `https://lone-mountain-global.projectsites.dev/` | 1280 + 390 | `13-customer-site-1280.png`, `14-customer-site-390.png` | **DEFECT** (serious, multiple) | H1 = "Lone Mountain Global — **Your your** community local business"; eyebrow "**LOCAL LOCAL** BUSINESS YOU CAN TRUST" (doubled seed tokens, both viewports). Platform cyan/black "L" monogram instead of the business's real logo. **5 console errors / 3 failed requests**: `logo-wordmark.png` 404 ×2, `apple-touch-icon.png` 404 + manifest icon error. Olive H1 gradient line ~illegible on dark green. Dark theme despite polished light-themed source. Generic trust chips. Consistent with the Readiness F the admin shows. |

**Tally: 11 surfaces swept (15 captures) — 6 CLEAN · 2 DELIGHT-DEBT · 2 DEFECT · 1 CLEAN-with-named-defect-nit (editor Database) · 0 STUB · 0 BLOCKED.**

## Top gaps (ranked by user value × visibility)

| Rank | Problem | Surface | Evidence | Proposed fix (one line) |
|------|---------|---------|----------|------------------------|
| 1 | Delivered site hero reads broken: "Your your", "LOCAL LOCAL" doubled seed tokens — every visitor of the paying customer sees it | Customer site | `13-customer-site-1280.png` | Add doubled-token + pack-default-H1 build validator and dedupe token fill in hero templates; re-run copy pass on live site. |
| 2 | Brand leak: platform cyan/black "L" tile ships as the customer's logo; real wordmark 404s | Customer site | `13-customer-site-1280.png` + meta fails | Enforce logo-extraction chain; fail build when header-referenced `logo-wordmark.png` 404s (extend asset-existence validator to rendered header refs). |
| 3 | "Readiness F 50/100" shown with zero explanation or action — scary grade, dead end | Sites list | `05-admin-sites-1280.png` | Make badge click through to the readiness report + one-click "Fix with AI" CTA. |
| 4 | Analytics first paint is a skeleton wall >10s on the most-visited data surface | Analytics | `08` vs `15` | Serve last-known KPIs stale-while-revalidate (KV cache) so numbers paint instantly. |
| 5 | Delivered site ships 5 console errors / 4 asset 404s — fails our own console-error gate post-delivery | Customer site | `meta.json` shot 13 | Post-publish prod-E2E must assert console-error-free homepage before marking delivered; re-heal existing sites. |
| 6 | Icon-only nav rail: ~17 unlabeled icons, OPERATIONS block is 5 near-identical glyphs — IA invisible | All admin | `03`, `05`, `11` | Expand rail with labels at ≥1280 (collapse below lg); distinct icons per section. |
| 7 | Manual "Refresh" button on Domains (and tab-state carryover makes nav "Settings" land on Domains) | Domains/Settings | `09`, `10` | Remove button → visibility-aware poll (AdminStateService pattern); nav "Settings" resets to General tab. |
| 8 | Database sub-nav ACTIVE pill has invisible/empty label (known filled-pill brand-override class) | Editor › Database | `07-admin-editor-data-tab-1280.png` | Apply `data-filled-pill` opt-out / restore label contrast on the active Tables pill. |
| 9 | H1 gradient's olive/khaki stop ~fails contrast on dark green hero | Customer site | `13-customer-site-1280.png` | Constrain generated gradient stops to AA-passing range (gradient-text contrast validator). |
| 10 | Owner-facing jargon: "MCP", "AI Env Vars" tabs; emoji-glyph app icons read low-fi next to premium chrome | Settings, Apps | `10`, `12` | Rename to owner language ("Integrations", "AI Keys"); swap emoji tiles for real product logos. |

Minor (noted, unranked): admin rail section labels clip mid-word on some routes (`06`,`07`,`11`); transient doubled "Analytics" breadcrumb during route transition (`08`); floating back-pill grazes card content (`12`); @390 dashboard checklist item-4 alignment (`04`); hidden marketing-shell text remains in admin DOM (innerText artifact only — not visible, info-level).

## Not yet inspected (known to exist, not reached this run)

- Admin: Billing, Snapshots (+diff), Forms, Hosting, Logs, Deliverability, Social (+analytics), Voice, Leads, SEO, Traces, Webhooks, AI Chat, AI Logs, Audit, Site Features, Docs, Team, Auth/Security, Super Admin, System Services, KV/R2/Vectorize/Queues inspectors, user settings, notifications panel (badge shows 6), Cmd+K palette, Actions menu.
- Editor: Preview tab, Resources tab, SQL console + KV sub-views, Chat build flow.
- Public: `/create` wizard, `/pricing`, `/developers`, `/blog`, `/changelog`, `/trust`, checkout.
- Customer site: sub-pages (About/Services/Contact), contact form submit, 404 page.
- Mobile (390) for: Sites, Analytics, Settings, Feature Flags, Apps, Editor.

## Artifacts

- Screenshots + `meta.json` (per-surface console errors, failed requests, h1, text length): `.claude/run-the-loop/visual/2026-09-30/`
- Sweep scripts (throwaway, not committed): `/tmp/hx-sweep-fire59.mjs`, `/tmp/hx-analytics-probe.mjs` — reuse the deep-ui-explorer auth seam + CF Browser Run ladder.
