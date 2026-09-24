# ProjectSites.dev — Generated Customer-Site Quality Bar

> **Generic budgets are global** (`~/.agentskills`: `quality-metrics`, `ttfr-north-star`,
> `image-quality`); this file keeps the **`{slug}.projectsites.dev`-specific** gates +
> CI wiring. Don't duplicate the universal CWV/a11y numbers here — reference them.
> Hard quality gates for every AI-generated customer site we serve from `{slug}.projectsites.dev`.
> Generated sites are served to the public — performance, accessibility, SEO, and safe sanitization
> are non-negotiable. Enforced in CI via Lighthouse CI + the link/JSON-LD validators.

## Budgets (build-fail when exceeded)

| Budget | Threshold | Notes |
|--------|-----------|-------|
| JS per route | ≤ 200 KB gz total; no single chunk > 250 KB gz | Code-split; lazy-load below-fold |
| CSS per route | ≤ 50 KB gz | Lightning CSS transform/minify |
| Fonts | ≤ 100 KB woff2, preloaded + unicode-range subset | `<link rel="preload">` critical only |
| Above-fold weight | < 1 MB | — |
| Total page weight | < 2 MB | — |
| OG image | 1200×630, ≤ 100 KB, branded card | Generated via Satori (not a raw photo) |

## Core Web Vitals (per route)

- **LCP ≤ 2.0s** (cinematic target; 2.5s hard ceiling)
- **CLS ≤ 0.05**
- **INP ≤ 100ms** (200ms hard ceiling)
- Hero/LCP image `fetchpriority="high"`; all other images `loading="lazy" decoding="async"`.

## Image optimization policy

- **AVIF primary** (20–30% smaller than WebP, ~94% support) + **WebP fallback** + JPEG legacy.
- SVG for logos/icons; `SVGO` optimized.
- Responsive `srcset` at 320/640/960/1280/1920w.
- **Prefer Cloudflare Images / R2 pipelines** over a runtime image lib; `Sharp` only where the build runtime supports it.
- Every referenced asset has a committed source variant (a blanket `*.jpeg` gitignore is banned — it silently un-tracks real sources).

## Accessibility budget (WCAG 2.2 AA)

- **axe-core 0 violations** at 6 breakpoints (375/390/768/1024/1280/1920) — necessary, not sufficient.
- **Lighthouse Accessibility ≥ 95.**
- Contrast ≥ 4.5:1; target size ≥ 24px (2.5.8); focus never obscured (2.4.11).
- Manual review each pass for the 6 AA criteria axe can't detect (2.4.11, 2.5.7, 2.5.8, 3.2.6, 3.3.7, 3.3.8).
- ADA Title II / EU EAA ready — generated sites ship AA-conformant.

## Lighthouse CI thresholds

Current `.lighthouserc.json` runs `warn` at Perf 0.8 / A11y 0.9 / Best-practices 0.8 / SEO 0.8. Generated-site gate raises these to **error** at:

| Category | Generated-site gate |
|----------|---------------------|
| Performance | ≥ 0.90 (error) |
| Accessibility | ≥ 0.95 (error) |
| Best practices | ≥ 0.95 (error) |
| SEO | ≥ 0.95 (error) |

**Upcoming:** separate `lighthouserc.generated.json` that asserts `error` against a deployed `{slug}.projectsites.dev` sample, independent from admin/marketing suite (2026-Q4).

## SEO + structured data

- Per-route title 50–60 chars, meta description 120–156 chars, canonical (custom hostname when set).
- Exactly one H1 in the prerendered shell (not script-injected).
- `sitemap.xml` with `<lastmod>` per URL; `robots.txt`; `humans.txt`; `security.txt`; `llms.txt`.
- **`schema-dts`** for all Schema.org JSON-LD — type-safe, accurate types only. WebPage is the floor; add Organization/BreadcrumbList/FAQPage/LocalBusiness/Service ONLY when they describe real entities. **Never pad; FAQPage only when real Q&A exists.**
- JSON-LD claims must match visible content.

## Sanitization (DOMPurify requirements)

- **Every** user/customer/AI-generated HTML string passes through `DOMPurify` before render or storage.
- Scheme-validate links (reject `javascript:`/`data:`); `rel="noopener noreferrer"` on external.
- Strip event handlers + inline scripts; allowlist tags/attrs for content blocks.
- Never expose raw Redis/Postgres credentials or internal data to a customer site.

## Search selection (Pagefind vs Orama)

| Use case | Choice |
|----------|--------|
| Static/mostly-static generated site, build-time index, zero backend | **Pagefind** |
| Dynamic content, edge/hybrid search, in-Worker query, ranking control | **Orama** |
| Vector/semantic search | **Cloudflare Vectorize** (Qdrant only as a documented fallback) |

## OG image generation (Satori)

- Generate a **branded** 1200×630 OG card per route via Satori at the edge (R2-cached), not a raw screenshot.
- `apple-touch-icon` 180×180 mandatory; maskable + monochrome PWA icons.
- Cache generated OG images in R2 keyed by route + content hash; regenerate on content change.

## CI gates

- [ ] Lighthouse CI passes the generated-site thresholds above
- [ ] axe-core 0 violations × 6 breakpoints
- [ ] Link validator: every referenced asset resolves in build output
- [ ] JSON-LD validator: structural + claims-match-content
- [ ] No JS bundle exceeds the per-route budget

## See

- `rules/quality-metrics` · `apps/project-sites/docs/architecture/cloudflare-first.md`
- `docs/OBSERVABILITY.md` — AI-observability that feeds these sites
