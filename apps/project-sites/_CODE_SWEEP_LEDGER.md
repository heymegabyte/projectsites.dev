# Code-Quality Sweep Ledger

Tracks the hourly CODE-QUALITY SWEEP loop (cron `1534cb49`, every hour at :53). Each fire picks the next unswept batch, evaluates every file against all dimensions (correctness · Zod · TS-strict · a11y · perf · gorgeous polish · dead-code · dup · error-handling · tests · docs), fixes at root cause + a regression test, verifies, deploys, prod-verifies, and appends a closure here. When the whole tree is swept, loop back to the top and re-sweep (code changed).

## Coverage map (sweep order)

- [ ] **T. template sections** — `template.projectsites.dev/src/components/sections/*` (~34 components) ← _in progress (batch 1)_
- [ ] template components — `template.../src/components/*` (Header, Footer, ContactForm, AiChat, Breadcrumbs, CommandPalette, …)
- [ ] template pages — `template.../src/pages/*` (Home, About, Services, Contact, Blog, …)
- [ ] template lib — `template.../src/lib/*` + `src/brand.ts` + `src/*.ts`
- [ ] worker routes — `apps/project-sites/src/routes/*`
- [ ] worker services — `apps/project-sites/src/services/*` (~40 files)
- [ ] worker middleware + prompts + workflows — `src/middleware/*` · `src/prompts/*` · `src/workflows/*`
- [ ] worker feature modules — `apps/project-sites/libs/features/*`
- [ ] packages/shared — `packages/shared/src/*`
- [ ] Angular admin frontend — `apps/project-sites/frontend/src/app/**`
- [ ] editor (bolt.diy) — root `app/**`

## Dimensions (evaluate EVERY file)

correctness/bugs · Zod at every boundary · TS strictness (no `any`/`@ts-ignore`/non-null `!`) · a11y WCAG 2.2 AA · perf (CWV/bundle/INP) · gorgeous UI polish (contrast/spacing/motion/skeletons/first-result CTA) · dead code + unused exports (knip) · duplicate logic · error handling (typed, fail-soft prod) · missing unit/E2E tests · JSDoc/docs drift.

---

## Fires

### Fire 1 — 2026-09-15 — template sections: image a11y + decode-perf polish (batch 1 of "template sections")
- **Swept:** the 4 first-class industry sections (`Menu`, `ServiceMenu`, `DonationTiers`, `FeaturedCollection`) + their image usage.
- **Improvement:** product/dish `<img>` in `Menu` + `FeaturedCollection` sit INSIDE (or beside) their own visible name text → `alt={name}` made the name announce TWICE to a screen reader (WCAG 1.1.1 redundancy) and blocked the main thread on synchronous decode. Fixed → decorative `alt=""` (the adjacent name carries the meaning) + `decoding="async"` (non-blocking decode, a small CWV/INP win). Regression test asserts the FeaturedCollection product image is decorative when a name is present.
- **Result:** ✅ `Menu` + `FeaturedCollection` product images → `alt=""` + `decoding="async"`; regression test added (product image decorative when name present). Template tsc clean · IndustrySections 9/9 · build green (validate-site 19 routes / 217 tokens). Pushed template. Next batch: remaining template sections (Stats, BentoGrid, Pricing, FeatureSplit, Timeline, …).
