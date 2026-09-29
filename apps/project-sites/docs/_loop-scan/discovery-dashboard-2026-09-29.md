# Discovery — Admin Dashboard / Getting-Started Hub (`/admin`)

**Headline:** The post-login home is mature and mostly clean — routed H1 correct, no manual-refresh
controls, honest empty states, `--ps-*` tokens throughout, full aria. Findings are minor: stale
doc-drift in a JSDoc, a no-op ternary, a redundant self-hiding CWV branch, one tone-map dead branch,
and zero E2E coverage of the cockpit/attention/KPI/CWV surfaces (unit-only). File is 2199 LOC → SPLIT.

**Surface:** `frontend/src/app/pages/admin/sections/dashboard.component.ts` — **2199 LOC** (routed at
`app.routes.ts:104`, path `''`). Child widgets: `dashboard/calendar-widget.component.ts` (~1000 LOC),
`dashboard/widgets.ts` (~40K). Unit spec: `dashboard.component.spec.ts` (14 tests). No E2E.

## Next-wave tasks

- [SPLIT] `dashboard.component.ts @ :1..2199` — one 2199-LOC file holds template (138-571) + ~460 lines
  of inline `styles:` (573-1550) + a 643-line class (1556-2199): KPI/attention/CWV/status derivation
  ALL in one component. Evidence: `export class AdminDashboardComponent {` at :1556 with `siteStatusSummary`
  (:1619), `kpiTiles` (:1675), `attentionItems` (:1768), `cwvPills` (:2159) all colocated. Action: extract the
  operator-cockpit strip (KPI tiles + Needs-attention queue, template :153-240 + logic :1619-1795) into a
  `dashboard-cockpit.component.ts`, and the CWV/status block into a `dashboard-site-status.component.ts`;
  dashboard shell keeps search + section-guide. ~2-3h (not [READY]).

- [DEAD] stale JSDoc `dashboard.component.ts @ :1613-1616` — `siteStatusSummary` doc claims *"this
  single-site admin has no `/admin/sites` LIST route (that path soft-404s), so the tile drills straight into
  the site itself"*. Ground truth: `app.routes.ts:181` now defines `path: 'sites'` →
  `AdminSitesComponent` (a real sites GRID, comment at :179 says it "Replaces the former
  redirect-to-dashboard"). The soft-404 claim is false. Action [READY]: correct the JSDoc — a `/admin/sites`
  LIST route now exists; the tile linking to `/admin/sites/:id` detail is still correct, just re-explain why
  (drill-in, not "no list route"). <15min.

- [DEAD] no-op ternary `dashboard.component.ts @ :1688` — `sub: live === 1 ? 'published + serving' :
  'published + serving'` — both branches are the identical string. Evidence: verbatim at :1688 inside the
  `'live'` KPI tile. Action [READY]: collapse to `sub: 'published + serving'` (drop the dead `live === 1`
  branch, or make the singular actually differ, e.g. `'site published + serving'`). <5min.

- [DEAD] unreachable tone branch `dashboard.component.ts @ :1742` — Custom-domains tile
  `tone: domains.failed > 0 ? 'attention' : domains.active > 0 ? 'good' : 'neutral'` — the `'neutral'`
  leg (active===0 && failed===0) is unreachable because the whole tile is gated by `if (domains.total > 0)`
  at :1729 and a domain with total>0 but 0 active & 0 failed would need all-pending; possible but then the
  `sub` says "N pending setup" while tone is neutral — evidence at :1729-1744. Action: verify the pending-only
  case renders sensibly (tone could be `'building'`); low-pri, confirm-in-browser. <30min.

- [A11Y] status-tiles are the ONLY drill-in but announce generic label `dashboard.component.ts @ :340-354`
  — the `.status-tile` `aria-label` is `b.count + ' ' + b.label + ' — ' + b.interp + '. Open site.'`
  (:347) which is good, BUT the `<app-rolling-counter>` inside (:350) animates a number with no
  `aria-hidden`/`aria-label` guard — a screen reader may read the intermediate count-up. Evidence: attention
  rows correctly wrap the counter, but status tiles at :350 expose the raw `<app-rolling-counter>`. Action
  [READY]: confirm `RollingCounterComponent` sets `aria-hidden` internally; if not, the tile's real count is
  already in the `aria-label` so mark the visual counter `aria-hidden="true"`. <20min.

- [DEAD] redundant self-hide branch `dashboard.component.ts @ :360-404` — the CWV `<section>` is gated by
  `@if (hasSites() && latestMetrics())` (:360) then INSIDE splits on `@if (hasCwvData())` (:365) vs an
  `@else` "not run yet" note (:391-402). `hasCwvData()` (:1583) already requires `latestMetrics()` truthy,
  so the two guards partly overlap — fine, but the section renders even when the ONLY snapshot has zero
  metrics, showing a full "Core Web Vitals" heading + empty note. Evidence: :362 heading always renders once
  `latestMetrics()` is set. Action: acceptable (honest empty per the :1576 JSDoc); no change unless the empty
  heading reads as broken in a real-browser pass. Confirm-only.

- [FLOW] no E2E for cockpit / attention / KPI / CWV surfaces — every interactive surface carries a
  `data-testid` (`dash-attn-<id>`, `dash-attn-action-<id>`, `dash-attn-clear`, `dash-cc-skeleton`,
  `cwv-empty`, `cwv-empty-cta`, `dash-search`, `dash-pin-*`, `dash-sec-*`) but NO spec asserts them. Evidence:
  `grep dash-|kpi|attn|cwv-empty e2e/*.spec.ts` returns only analytics-dashboard hits; the `.kpi` locator at
  `analytics-cf-traffic.spec.ts:122` is a DIFFERENT component. Only `dashboard.component.spec.ts` (14 unit
  tests) covers logic. Action: add `e2e/dashboard-hub.spec.ts` — homepage→sign-in→`/admin`, assert search
  filters (`dash-search` → type "editor" → 1 result), pin toggle persists (`dash-pin-code`), and the
  attention queue OR `dash-attn-clear` renders. ~1.5h [READY].

- [A11Y] `.status-source` caption contrast is fixed but `.sec-desc` uses opacity-muted token
  `dashboard.component.ts @ :829` — `.sec-desc { color: color-mix(in oklch, var(--ps-ink) 62%, transparent) }`
  — a 0.8rem body at 62% ink over `rgba(8,8,32,0.45)` card bg (:771). The `.status-source` was already bumped
  to 66% for AA (comment :1043-1045), so the same class of muted caption exists at :829 unbumped. Evidence:
  :826-830. Action: verify `.sec-desc` clears 4.5:1 in a real-Chrome axe pass at the card bg; bump to ~70% if
  it fails. <20min.

## Sub-area NOT reached

- `dashboard/calendar-widget.component.ts` (~1000 LOC) — a distinct calendar widget, not wired into the
  dashboard template read here (no `<app-calendar-widget>` in the 138-571 template); likely orphaned or used
  elsewhere — worth an [ORPHAN] check next wave.
- `dashboard/widgets.ts` (40K) + `mini-markdown` — not audited.
- `OnboardingChecklistComponent`, `ReferralCardComponent`, `QuotaChipComponent` (rendered at :142-145) — their
  own files not audited (self-hide behavior claimed in comments, unverified).
- `analytics-dashboard.component.ts` / `logs-dashboard.component.ts` / `grafana-dashboard.component.ts` — sibling
  dashboards, separate surfaces, not this hub.
