# Code-Quality Sweep Ledger

Tracks the hourly CODE-QUALITY SWEEP loop (cron `1534cb49`, every hour at :53). Each fire picks the next unswept batch, evaluates every file against all dimensions (correctness · Zod · TS-strict · a11y · perf · gorgeous polish · dead-code · dup · error-handling · tests · docs), fixes at root cause + a regression test, verifies, deploys, prod-verifies, and appends a closure here. When the whole tree is swept, loop back to the top and re-sweep (code changed).

## Coverage map (sweep order)

- [~] **T. template sections** — `template.../src/components/sections/*` — img a11y/perf class SWEPT tree-wide (Fire 1 alt, Fire 2 decoding); deeper per-dimension sweeps recur
- [~] **template components** — `template.../src/components/*` — high-signal classes SWEPT (Fire 3): no React-19 inline-`<style>` bug, no missing-alt imgs, DevA11yBadge DEV-gated, forms error-handled; TS-strict fix landed (AiChat `as unknown as FormEvent` → native requestSubmit). Deeper per-dimension sweeps recur ← _next batch: template pages_
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

### Fire 2 — 2026-09-15 — template sections: `decoding="async"` tree-wide + regression gate (batch 2 of "template sections")
- **Verify-before-implement:** worker `5c972b286`, template `eda2215`; only protected + build-artifacts dirty. prod 200.
- **Swept:** all ~24 section components for the img a11y/perf class (building on Fire 1). Systematic scan found TS-strict CLEAN (0 any/@ts-ignore/non-null!), but **12 sections rendered `<img>` WITHOUT `decoding="async"`** — only Fire 1's Menu/FeaturedCollection + LogoCloud had it → images decoded synchronously, blocking the main thread (an INP/CWV cost on EVERY generated site).
- **★ ROOT FIX:** added `decoding="async"` to every below-the-fold section img (10 files: BentoGrid, BlogList×2, CaseStudyCard, Demo, FeatureSplit, Quote, Spotlight, TeamGrid, Timeline, VideoEmbed) via a context-aware script (correctly skipped Demo's `<iframe>` + inlined Timeline's single-line tag). **HeroVariants EXEMPT** (LCP hero — async decode can delay the largest paint, per ttfr-north-star).
- **★ REGRESSION GATE:** `section-img-decoding.test.ts` — asserts every real section `<img>` (except HeroVariants, comment-mentions stripped) sets `decoding="async"`, so the class can't drift back. tsc clean · 22 section tests green · template build green (validate-site 19 routes / 217 tokens). Pushed template `36a6d81` (lands next build, NO redeploy).
- **Result:** ✅ every generated site's below-fold images now async-decode (non-blocking) + a durable gate. Next batch: **template components** (Header, Footer, ContactForm, AiChat, Breadcrumbs, CommandPalette, …).

### Fire 3 — 2026-09-15 — template components: high-signal defect-class sweep + AiChat TS-strict root fix (batch "template components")
- **Verify-before-implement:** worker HEAD `a8533ad82`; template repo dirty only in generated feeds (`public/atom.xml`/`feed.*`/`sitemap.xml` — build artifacts, another session's build) — avoided; touched only `src/components/*` source. worker tree clean, prod 200.
- **Swept** all 56 top-level template components across the high-signal classes: React-19 inline-`<style>{` client-drop bug (0 — the sections-era class stays fixed), `<img>` without `alt` (0), TS-strict (`: any`/`@ts-ignore`/`as any`/`as unknown as`), `console.log`, form fetch error-handling.
- **★ ROOT FIX — AiChat.tsx `as unknown as FormEvent`:** the chat textarea's Enter-to-send fabricated a `FormEvent` from a `KeyboardEvent` via `onSubmit(e as unknown as FormEvent)` (a TS-strict double-cast smell). Replaced with `e.currentTarget.form?.requestSubmit()` — fires the form's REAL SubmitEvent (identical behavior, since `onSubmit` only did `preventDefault()`) AND runs native constraint validation the direct call skipped. **★ REGRESSION GATE** `AiChat.submit.test.ts` (2 tests, source-idiom: asserts `requestSubmit()` present + `as unknown as FormEvent` absent). tsc clean · vitest 2/2 · template build green (19 routes / 217 tokens). Pushed template `94c984d` (lands next build, NO redeploy).
- **False positives correctly NOT touched (validator-precision):** Header.tsx:216 `any` is prose in a comment ("Best-effort: any failure"), not a type; DevA11yBadge `console.log` is inside a fully DEV-gated component (early-returns null in prod + DEV-only effect) — legitimate dev-tooling, zero prod impact; ContactForm/QuoteForm/Newsletter already carry robust error-handling (18/20/7 refs).
- **Result:** ✅ template components batch swept on the high-signal classes; 1 real TS-strict root fix + durable gate; the rest clean. Next batch: **template pages** (`src/pages/*`).
