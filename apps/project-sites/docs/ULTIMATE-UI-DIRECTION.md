# Ultimate UI Direction — Admin · Database · Resources

> Opinionated design direction for the ProjectSites admin + the editor Database/Resources consoles.
> UI-FIRST mandate (Brian, 2026-09-27): craft the gorgeous UI first, wire the deep backend after.
> Every iteration must be measurably more beautiful AND more effortless than the last. Black + cyan,
> cinematic, embarrassingly-easy. This is the north star every subsequent UI fire aims at.

## Visual system

- **Palette (tokens, never hardcode):** bg `--ps-bg`/`--bolt-elements-bg-depth-1` `#060610`, ink
  `--ps-ink` `#f4f4ff`, accent `--ps-accent`/`--bolt-elements-item-contentAccent` `#00e5ff`, violet
  seam `#7c3aed` (sparingly, radial washes only). Status: emerald=connected, amber=drift/unsupported,
  red=error. Derive shades with `color-mix(in oklch, #00e5ff N%, transparent)`.
- **Type:** Sora/Space Grotesk display, JetBrains Mono for ids/code/counts (`tabular-nums` always).
  Fluid ramp: eyebrow `text-[10px] uppercase tracking-wider`, title `text-sm font-semibold
  tracking-tight`, hero-number `text-lg/xl font-bold`. `text-wrap: balance` on headings.
- **Spacing/shape:** 4px grid; cards `rounded-xl`, hero panels `rounded-2xl`, tokens
  `--ps-radius-xl:22px`. Hairline dividers fade to transparent (`bg-gradient-to-r from-border/60`).
- **Depth:** layered backgrounds (`depth-1` canvas → `depth-2` panel → `depth-3` hover), one radial
  cyan wash per hero (opacity ≤70%), soft accent shadow on hover only.
- **Motion:** transform/opacity ONLY, `duration-150`, hover lift `-translate-y-0.5`, always paired
  `motion-reduce:*`. `@starting-style` for enters. No layout-shifting animation, ever.
- **A11y (non-negotiable):** WCAG 2.2 AA contrast, ≥24px targets, `focus-visible` cyan ring on every
  control, `aria-label` on icon buttons, honest `role="status"` on async regions.

## The Database tab (rich recycled editors — do NOT ship thin)

- **Recycle `DataPanel.tsx`'s proven SQL editor + Table editor** into Database, re-pointed at the
  per-site D1 — never a thinner reimplementation. The rich original is the floor.
- **SQL console:** Monaco-grade editor (syntax highlight, autocomplete from live schema, run/format,
  history), a results grid with cost meta (`rows_read`/`rows_written`), an "Ask your data" NL→intent
  bar (typed intent, falsifiable SQL, executed — never raw SQL to the model on the owner path).
- **Table editor:** virtualized grid (TanStack) with inline cell edit, typed add/edit/delete rows,
  filter/sort/search over the WHOLE table (honest counts), saved views (grid/gallery/kanban/chart/
  calendar), CSV export. Empty table = a one-click "create your first table" launchpad.

## The Resources console + namespace summary

- **Namespace summary (shipped):** a cinematic hero band that ACCOUNTS FOR EVERY resource in the
  site's WfP dispatch namespace — namespace label + headline stats (total/connected/drift) over a
  complete per-kind grid (D1/KV/R2/DO/Workflows/Queues/Vectorize/bindings/connections/observability),
  each tile a count + status dot + honest "Not available" for kinds CF can't expose. Derived from the
  existing inventory — no extra fetch, no client CF ids.
- **Resource cards:** kind icon in an accent chip, concept + binding, status chips (connected /
  available-to-add / unsupported), drift badge, last-sync, cinematic left accent rail (cyan/amber),
  hover lift. Connected → drill into the generic detail/manage surface; available → "coming soon"
  nudge, never a dead click.
- **Console chrome:** env selector (preview/production) + Reconcile (reserves its widest label) +
  Refresh. Honest states everywhere: loading spinner, friendly dark-flag card, error+retry, empty
  launchpad whose one obvious action is Reconcile.

## Signature "gorgeous" widgets (build these next)

1. **Namespace topology map** — an animated node graph (site worker → each bound resource) that
   pulses on drift; click a node to drill in. Turns the flat rollup into a living diagram.
2. **Drift ribbon** — a sticky, dismissible cyan→amber ribbon summarizing "N drifted · reconcile"
   with a one-click heal, visible across Database + Resources.
3. **Live query-cost meter** — after every SQL run, a compact gauge (`rows_read` vs a budget) that
   glows amber on an expensive scan, teaching cost without a manual.
4. **Resource spark-tiles** — each kind tile carries a 7-point sparkline (rows/objects/keys over
   time) so the owner feels the data breathing, not just a static count.
5. **Cmd+K resource palette** — fuzzy-jump to any table/bucket/namespace/binding, with inline
   actions (open, reconcile, provision) — every surface reachable in one keystroke.
