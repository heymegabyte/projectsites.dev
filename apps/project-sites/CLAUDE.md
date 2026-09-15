# Project Sites Worker — AI Context Guide

> Cloudflare Worker powering the SaaS website delivery engine at `projectsites.dev`.
> Built with Hono framework, Cloudflare D1/KV/R2/Workflows/AI.
>
> **Template repo:** https://github.com/HeyMegabyte/template.projectsites.dev

## ⟳ Loop Charter (READ on EVERY `/loop` fire)

Every scheduled `/loop` cron MUST obey **`apps/project-sites/_LOOP_CHARTER.md`** — the SSOT
for all loops. Three mandates, every fire: (1) prove the touched surface through a **complete
real-user journey** covering all its sub-actions; (2) **progressively enhance** — advance
several of {polished feature · enhancement · debugging · hardened error-handling · structured
log/trace/event enhancing} in one fire; (3) **faster pace** — ship MORE each fire via 4-6
parallel agents, escalating velocity while every gate stays green. This is the floor beneath
each loop's specialty. (Brian directive 2026-09-15.)

## Infrastructure doctrine (READ FIRST — Cloudflare-first, finalized 2026-06-19)

**Authoritative:** [`docs/architecture/cloudflare-first.md`](docs/architecture/cloudflare-first.md) (mirror: `~/.agentskills/rules/projectsites-cloudflare-first.md`).

- **Allowed default infra: Cloudflare + Neon + Upstash + Fly.io.** NO Cloud Run / AWS / GCP / Azure / Vercel / Supabase / Render / Railway by default (explicit override only).
- **Neon** = Postgres escape hatch (only when D1 can't). **Upstash** = Redis escape hatch (NOT the default cache — KV/R2 first). **Fly.io** = stateful-VM escape hatch (only when no CF primitive can).
- **Hot path** (public site): CF DNS / custom hostname → Worker dispatch → KV manifest → R2 asset → Analytics Engine sample → async Queue. Must NOT touch Neon/Upstash/Fly/Sentry/PostHog/Browserbase/Skyvern/external-AI unless truly dynamic.
- **Browser automation**: `browser.projectsites.dev` (product abstraction, CF Browser Run + Playwright + Stagehand) → Browserbase fallback (managed session/replay/proxy only) → Skyvern is **internal-only** (`skyvern.megabyte.space`, behind CF Access), **never the default product layer**. Worker primitive: `src/services/browser_gateway.ts`.
- **AI Gateway is mandatory** for every model call. **Analytics Engine** (not PostHog) is the default high-volume metrics backend.

## Mandatory Site-Generation Invariants (BUILD-BREAKING)

These invariants are enforced programmatically in `src/services/build_validators.ts` and run between R2 upload and `published` status. Each maps to a gate in `~/.agentskills/15-site-generation/quality-gates.md`. A violation flips the site to `error` once we move from `report` → `strict` mode.

| Invariant | Rule | Code |
|---|---|---|
| Required files | `site.webmanifest`, `robots.txt`, `humans.txt`, `sitemap.xml`, `browserconfig.xml`, `.well-known/security.txt`, `favicon.ico`, `favicon-16x16.png`, `favicon-32x32.png`, `apple-touch-icon.png` all exist | `manifest.required_file_missing` |
| Asset existence | Every internal `src=` / `href=` / `url(...)` in HTML resolves to a file in R2; external hosts must be in allowlist | `asset.missing`, `asset.external_host_not_allowed` |
| Image format | No PNG > 200KB except favicons (re-encode WebP/JPEG) | `image.png_too_large` |
| OG image | `og-image.*` exists, ≤100KB, branded card (1200×630) | `og.missing`, `og.too_large` |
| apple-touch-icon | 180×180 at root | `icon.apple_touch_missing` |
| Meta lengths | `<title>` 50-60 chars, `<meta description>` 120-156 chars | `meta.title_length`, `meta.description_length` |
| JSON-LD | 4+ blocks per HTML page (WebSite + Organization + WebPage + BreadcrumbList minimum) | `jsonld.count_below_threshold` |
| H1 in shell | Exactly 1 `<h1>` in HTML shell (prerender) — outside script/style | `html.h1_count` |
| color-scheme | `<meta name="color-scheme">` present | `meta.color_scheme_missing` |
| Sitemap lastmod | Every `<url>` in `sitemap.xml` has `<lastmod>` | `sitemap.missing_lastmod` |
| Banned slop | No "limitless", "revolutionize", "cutting-edge", "leverage", "world-class", etc. | `copy.banned_word` |
| JS chunk size | No JS chunk > 750KB raw (~250KB gzip) — code-split by route | `js.chunk_too_large` |
| Lightbox | JS bundle contains `data-zoomable` AND `data-gallery` strings | `lightbox.zoomable_missing`, `lightbox.gallery_missing` |

**Mode flag (in workflow `validate-build` step):** currently `report` (logs to D1 audit, never throws). Flip to `strict` once template ships clean across all benchmarks (megabyte-labs, njsk, nyfb, vito's, soup kitchen).

**Run from a unit test:**
```ts
import { validateBuild } from './src/services/build_validators';
const report = validateBuild(files);
if (!report.ok) console.error(report.errors);
```

## Website Generation Philosophy (CRITICAL — read this first)

**Our goal: Generate enterprise-grade, industry-leading websites that BEAT any existing website.** We don't copy sites — we take any website and use AI to make it dramatically better. Every generated site must be more beautiful, more accessible, better structured, faster loading, and better optimized for SEO/conversions than the source. We specialize in information-dense sites: take sprawling, poorly-organized original websites and condense them into gorgeous, well-organized, modern designs that pack MORE useful information into FEWER, better-designed pages.

**Quality bar: The generated website must be so good that the business owner would prefer it over their original.** Think: "What if Stripe's design team rebuilt this local business's website?"

**A perfect website CANNOT be created with a single prompt.** It requires 20-30 iterative, specialized prompts — just like a Principal Software Engineer needs 20+ detailed prompts to deploy a normal website. The system must spread the load across many prompts to circumvent single-prompt limitations.

### Benchmark Sites (use for testing & quality validation)

| Site | URL | Type | What We Improve |
|------|-----|------|----------------|
| **whitehouse.gov** | https://www.whitehouse.gov | Government / Information | Condense sprawling navigation into a clean, gorgeous homepage. Keep ALL important content but present it more beautifully. More information above the fold. Better visual hierarchy. |
| **njsk.org** | https://www.njsk.org | Non-Profit / Soup Kitchen | Bundle 20+ scattered pages into 3-4 well-organized pages + a blog. Make it gorgeous with warm, dignified colors. Add donation CTA, impact counters, volunteer signup. Keep all original content. |

**How to use benchmarks:**
1. Deep-crawl the original site (all pages, all content)
2. Generate our version using the full pipeline
3. Compare: our version must have ALL the original content, but better organized
4. Visual comparison: our version must look more professional, more modern
5. Lighthouse comparison: our version must score higher on all metrics
6. SEO comparison: our version must have better meta tags, schema, keywords

**For information-heavy sites (like whitehouse.gov):**
- The homepage should pack MORE useful information than the original
- Page count = source sitemap count (1:N mapping, max 1000 pages). Do NOT collapse 200 source pages into 4 — recreate every URL the source serves. Navigation reorganization happens in the IA hierarchy (mega-menu, faceted nav, search), not by deleting pages
- Content should be reorganized by user intent, not org structure
- Blog/news section should be auto-generated from scraped articles, with one route per post

**For community/non-profit sites (like njsk.org):**
- Bundle scattered pages into cohesive sections
- Generate a blog from existing news/updates content
- Add prominent donation/volunteer CTAs
- Use warm, inviting, professional colors (not generic)

**See:** `memory/project_prompt_philosophy.md` for the full 30-prompt pipeline specification.

### The Pipeline (6 phases, 25-30 prompts, parallel where possible)

| Phase | Prompts | Parallel? | Duration |
|-------|---------|-----------|----------|
| 1. Research & Planning | 7 prompts (profile, brand, social, USPs, images, deep-crawl, structure) | 5 parallel + 2 sequential | ~3 min |
| 2. Asset Generation | 5 prompts (logo, favicon, hero images, section images, multimedia discovery) | All parallel | ~5 min |
| 3. Website Generation | 5 prompts (base HTML, animations, SEO meta, content, images) | Sequential | ~10 min |
| 4. Inspection & Fixes | 3 prompts (visual inspect via screenshot, fix issues, accessibility audit) | Sequential | ~5 min |
| 5. Quality & Safety | 5 prompts (quality gate, SEO audit, performance audit, safety check, final polish) | Sequential | ~3 min |
| 6. Domain-Specific | 1-3 prompts (donation CTA, menu, booking, child safety, medical compliance) | Conditional | ~2 min |

**Key principles:**
- NO API FALLBACK. Container-only builds. If it fails, it fails visibly with an error email.
- Each prompt has ONE focused job. Never combine multiple responsibilities.
- Parallelize aggressively — research + asset generation runs concurrently.
- Every prompt must measurably improve the website. If it doesn't, the prompt is wrong.
- Visual inspection is MANDATORY — screenshot the rendered page, analyze with GPT-4o vision.
- Domain-specific features are decided by AI based on research data, not hardcoded categories.
- Safety check is ALWAYS the last step regardless of business type.
- Optimize every feature for bottom-line impact (conversions, SEO, retention).

## Container Architecture: Single-Prompt Orchestrator + Parallel Subagents

**The container is a STATELESS Claude Code executor that runs a single orchestrator prompt.** That orchestrator delegates to specialist subagents in parallel via the Task tool. It does not access D1 or R2 directly.

### Inheritance from megabytespace/claude-skills
The container's `~/.claude/CLAUDE.md` `@-imports` the upstream `~/.agentskills/CLAUDE.md`, `AGENTS.md`, and `_router.md` — ProjectSites inherits the **entire Emdash Skills meta surface** (15 skill categories, 18 universal agents, 32 platform variants, conventions, profiles). Project-specific orchestrator instructions layer on top via the same file. Updates land within 10 minutes via `container-server.mjs` git-pull + `syncAgents()`.

### Subagent Surface
| Source | Agents | Role |
|--------|--------|------|
| `~/.agentskills/agents/` (synced to `~/.claude/agents/`) | visual-qa, seo-auditor, accessibility-auditor, performance-profiler, completeness-checker, content-writer, security-reviewer, test-writer (+10 more) | Universal audit/build specialists |
| `apps/project-sites/.claude/agents/` (COPY'd in Dockerfile) | **domain-builder**, **validator-fixer** | Project-specific (no upstream equivalent) |

`domain-builder` creates donation/menu/booking/medical/child-safety/local-business sections as new files in `src/components/sections/`. `validator-fixer` runs `scripts/run-validators.mjs` and surgically fixes the 13 violation codes from `build_validators.ts`.

### Workflow Steps (current — single-call container)
```
Step 1-3: Research (parallel)
  → Profile, Brand, Social, Images, Scrape, Structure plan
  → Workers AI (Llama 3.3 70B + 3.1 8B, FP8) + external APIs

Step 4: container-build (single call, ~25-40 min)
  → Container runs ONE Claude Code orchestrator prompt
  → Orchestrator loads ~/.agentskills/_router.md + skill 15 in full
  → Customizes template directly (template -> dist)
  → npm run build, fix errors
  → PARALLEL FAN-OUT (single Task message, multiple subagents):
      - domain-builder    (writes section components)
      - visual-qa         (audit: screenshots + GPT-4o)
      - seo-auditor       (audit: title/meta/JSON-LD/OG)
      - accessibility-auditor (audit: axe-core 6 bp)
      - performance-profiler  (audit: Lighthouse + bundles)
  → Routes findings:
      - copy/voice  → content-writer
      - HTML/asset/meta/JSON-LD/sitemap/lightbox/js-chunk → validator-fixer
      - a11y/perf remediation → validator-fixer (uses reports as input)
  → Loop until run-validators.mjs reports blockers === 0
  → completeness-checker as final gate (loop back if NOT_DONE)
  → node /home/cuser/upload-to-r2.mjs

Step 5: visual-inspection-final (non-blocking)
  → Screenshot published site, GPT-4o score, log to D1
```

### Why Orchestrator Pattern Beats Sequential Stages
- **Subagents have isolated context windows** — fan-out is free, no context pressure.
- **File partitioning prevents merge conflicts** — domain-builder owns sections, validator-fixer owns shell + public/ + config.
- **Audit and build run concurrently** — visual-qa screenshots while domain-builder writes, both finish ~5 min instead of 15 min sequential.
- **Single container call** — no R2 upload between stages, no workflow step boundaries to lose state across.

### Build Agent LLM Provider (DeepSeek-primary, Anthropic fallback)

When `DEEPSEEK_API_KEY` is set in the Worker env AND `BUILD_LLM_PROVIDER` is NOT `'anthropic'`, the `/build` POST carries `_deepseekKey`, `_anthropicBaseUrl: 'https://api.deepseek.com/anthropic'`, and `_anthropicModel: 'deepseek-chat'`. `container-server.mjs` then exports `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` (set to the DeepSeek key), and `ANTHROPIC_MODEL` into the shell that runs Claude Code — Claude Code reads these env vars and routes all API calls through DeepSeek's Anthropic-compatible endpoint. `ANTHROPIC_API_KEY` remains set as a passive fallback in case the DeepSeek endpoint errors. To force Anthropic regardless of key availability, set `BUILD_LLM_PROVIDER=anthropic` in the Worker secrets. For higher-order reasoning use `deepseek-reasoner` as the model value.

### Container entrypoint (`scripts/container-server.mjs`)
1. Boot: `git pull` on `~/.agentskills` + `~/template`, then `syncAgents()` copies `*.md` from `~/.agentskills/agents/` to `~/.claude/agents/` (project agents already on disk are preserved).
2. Every 10 min: `maybeRefreshSkills()` re-pulls + re-syncs.
3. HTTP server on 8080. `POST /build` accepts `{ prompts, existingFiles, contextFiles }`, runs `claude -p` as `cuser`, HMAC-signs callback to `/api/internal/build-status`.
4. Returns all non-underscore files from the build directory after completion.

**API Credit Discipline (NON-NEGOTIABLE):**
- **NEVER** waste API credits on speculative or debugging builds
- If there's an error, reduce to the **simplest reproducible state** first (e.g., 2+2 math test)
- Fix issues as **separate, temporary tests** — not by running full production builds
- Only trigger full builds when the pipeline is proven working end-to-end
- For infrastructure debugging, use mock responses or static data — never real API calls
- Each Claude Code prompt costs ~$0.50-2.00. Each full build costs ~$5-15. Treat credits as scarce.

**Key constraints:**
- Entrypoint must be under 10KB (CF Containers limit)
- Each workflow step must complete within 25 minutes
- Container uses `node:22-slim` image (CF Containers don't support custom large images)
- Claude Code needs `--dangerously-skip-permissions -p` flag for stdin→stdout mode
- Shell scripts need `String.fromCharCode(10)` for newlines (not `\\n` in template literals)

## Template System (CRITICAL — saves build time)

**Templates are pre-built project skeletons stored in R2.** Instead of generating from scratch every time, Claude Code starts from a template and customizes it.

**Template repo:** https://github.com/HeyMegabyte/template.projectsites.dev

**How templates work:**
1. Templates are Vite + React + Tailwind + shadcn/ui project skeletons
2. Each template has a `package.json` with all dependencies pre-configured
3. The template includes shadcn/ui components, layout patterns, responsive grids
4. Templates are categorized by industry: restaurant, non-profit, retail, professional, etc.
5. Claude Code receives the template as `existingFiles` and customizes it with business-specific content
6. This reduces build time from 15 min to ~5 min (Claude Code edits vs. creates from scratch)

**Template stack:**
- **Vite** — build tool
- **React 18+** — UI framework  
- **Tailwind CSS 3+** — utility-first CSS
- **shadcn/ui** — accessible component library (Radix UI primitives)
- **Inter / Satoshi** — typography (Google Fonts)

**Templates evolve:** Each successful build improves the template for that category. If Claude Code adds a pattern that improves quality, it gets folded back into the template.

**Current templates stored at:** `R2: templates/{category}/` with files like `package.json`, `vite.config.ts`, `tailwind.config.ts`, `src/App.tsx`, etc.

## Prompt System Philosophy (CRITICAL)

**Claude Code is INCAPABLE of designing a perfect website with a single prompt.** The prompts MUST be broken into as many focused prompts as necessary — forming a web of Principal Software Engineer-level prompts that always take what's available and improve it. Each prompt should improve the site tremendously if there's nothing there, or polish incrementally if quality is already high.

**The prompt system should:**
- Use however many prompts are necessary (12 is the floor, not the ceiling)
- Include small, surgical prompts for specific improvements (e.g., "fix color contrast in section 3")
- Leverage GPT-4o visual inspection heavily — screenshot after each major change, analyze, fix
- Use Playwright E2E TDD to validate DOM correctness programmatically
- Parallelize whenever possible (run independent prompts concurrently)
- Target under 1 hour total build time
- Evolve — the prompt chain should get better over time as new patterns emerge

**Color Contrast & Palette Quality:**
- Every color combination in the design MUST be checked for WCAG AA contrast (4.5:1 for text, 3:1 for large text)
- UI default colors, component colors, and backgrounds must use industry-appropriate, legendary, gorgeous, professional palettes
- NEVER use colors that look washed out, muddy, or generic
- The AI should generate 3-5 palette options per business type and select the most professional one
- Brand colors from the original website are extracted via AI vision, then enhanced to be more vibrant if needed while keeping the hue family
- If brand colors have poor contrast combinations, the AI must adjust them (lighter/darker variants) while maintaining brand recognition

**Logo Luminance Drives Theme (BUILD-BREAKING):**
- During brand research, compute the dominant-color luminance of the brand logo (sRGB → relative luminance per WCAG)
- **Dark logo (luminance < 0.4):** build a LIGHT theme (cream/white/off-white background, dark text, accent colors pulled from logo)
- **Light logo (luminance > 0.6):** build a DARK theme (the existing dark-first preference applies here)
- **Mid-luminance logo (0.4-0.6):** default to dark theme but verify logo contrast against header/hero/footer backgrounds — if any combination falls below 4.5:1, flip to light theme
- Logo legibility outranks the dark-theme aesthetic preference. The site's primary background MUST contrast the logo by ≥4.5:1
- Set `_brand.json.theme = "light" | "dark"` BEFORE template selection. The orchestrator must read this and pick a light or dark template variant accordingly
- **Examples:** njsk.org (dark burgundy wordmark) → light theme. Stripe (light-on-dark wordmark) → dark theme. Linear (dark monochrome) → light theme

**Source-Site Theme Preservation (BUILD-BREAKING):**
- GPT-4o-score the source homepage screenshot on aesthetic polish (0-10) during brand research
- If score ≥7 (polished site), preserve the source theme polarity: light → light, dark → dark. Do NOT flip a polished light site to dark just because dark is the platform default
- Set `_brand.json.preserve_source_design = true` when source ≥7/10 — orchestrator clones source layout patterns before adding our improvements
- **Example:** lonemountainglobal.com is a light-themed bespoke WordPress site → MUST stay light. Flipping to dark destroys brand recognition

**Logo Extraction Priority Chain (BUILD-BREAKING):**
- Source HTML must be parsed BEFORE the LLM brand step. Extract logo via deterministic crawler with this priority chain:
  1. Header `<img>` with class/alt containing "logo" → 2. `site.webmanifest` icons[] → 3. WordPress `cropped-*-icon-*.png` and `*-icon-512x512*.png` patterns → 4. `<link rel="apple-touch-icon">` 180×180 → 5. `<link rel="icon">` 32×32 → 6. `og:image` (last resort) → 7. Logo.dev / Brandfetch API → 8. Ideogram A/B/C generation as ABSOLUTE last resort
- Persist BOTH `_brand.json.logo.original_url` (full horizontal/wordmark) AND `_brand.json.logo.original_icon_url` (square icon-only, no text)
- Container orchestrator MUST verify `original_icon_url` HEAD-200s before declaring brand-research complete

**real-favicongenerator Pipeline (MANDATORY every build):**
- Run RFG (`https://realfavicongenerator.net/api/favicon`) against the icon-only logo to produce the FULL 11-file favicon set: `favicon.ico`, `favicon-{16,32,48}.png`, `apple-touch-icon.png` (180×180), `android-chrome-{192,512}.png`, `mstile-150x150.png`, `safari-pinned-tab.svg`, `site.webmanifest` (icons[] populated), `browserconfig.xml`
- If RFG unavailable, fall back to `sharp-cli` + `realfavicon` npm package inside the container
- Build fails if any of the 11 files missing from `public/` after the step

**Media Augmentation 1.4–2.0× (BUILD-BREAKING):**
- Extract ALL original media from source: homepage hero, sliders, galleries, team headshots, og:image, every `<img>` src, every CSS `background-image:` URL. Persist under `_assets.json.original[]`
- Augment via Pexels + Unsplash + Pixabay + Google CSE + DALL-E 3 (heavy use) + Ideogram + YouTube + Sora. Persist under `_assets.json.augmented[]`
- Target count: `augmented.length >= original.length * 1.4` and `<= original.length * 2.0`
- Per-page minimum: 6+ images on homepage, 4+ images on every sub-page
- Group preservation: source `[data-gallery="services"]` MUST round-trip to new site `[data-gallery="services"]` with same images + new ones
- `validator-fixer` fails build if any page has <4 images or if `augmented.length < original.length * 0.4`

**Original Document Preservation:**
- Parse all `<a>` href endings in `.(pdf|docx|pptx|xlsx|doc|ppt|xls|zip)` during scrape
- Download each, host under `public/docs/{filename}`, persist `_assets.json.documents[]` with `{original_url, filename, linked_from_page, anchor_text}`
- Surface on the same page topic in the rebuilt site (CV/resume on About, brochure on Services, etc.)

**Hero Asset From Logo (Brand Convergence):**
- GPT-4o-compare brand logo against source homepage hero image. If cosine similarity of dominant shapes > 0.7, set `_brand.json.hero_extracted_from_logo = true` and persist asset URL
- Container orchestrator MUST use that extracted asset as the hero background AND apply the logo's font family to H1 + nav
- **Example:** lonemountainglobal.com `mountain-background-splash.png` is the mountain shape from the logo blown up — pairing logo + hero + Poppins (logo font) creates instant brand convergence

**Homepage-Clone-When-Source-Excellent:**
- When source aesthetic score ≥7/10, the rebuild MIRRORS source homepage layout (hero structure, section order, color scheme, typography pairings) before adding our polish/animations/content density
- Sub-pages then inherit the homepage's design language for consistency
- "Clone" means structure + color + type — not literal pixel-copy. Improvements layer on top: scroll animations, denser content, better SEO, AI-augmented imagery

**Typography Extraction From Source (NEVER substitute):**
- During brand research, parse source CSS for `font-family` declarations (homepage stylesheets, Google Fonts URL params, `<link rel="stylesheet" href="*fonts.googleapis.com*">`)
- Persist `_brand.json.fonts.{logo, heading, body}` with `source: "extracted"` flag and the exact font names
- Use those EXACT fonts in the rebuild — do not substitute with "modern equivalents" (Inter, Space Grotesk) when source has chosen with intent
- **Example:** lonemountainglobal.com uses Poppins (logo + headings) + Hind (body). Generic "Inter + Space Grotesk" substitution destroys brand identity

## SEO Strategy (MANDATORY — world-class, not boilerplate)

Every generated website must implement aggressive, intelligent SEO that targets low-hanging fruit:

### Keyword Strategy
- **Primary keyword**: `{business type} in {city}` (e.g., "soup kitchen in Newark NJ", "grocery store Hell's Kitchen NYC")
- **Secondary keywords**: Each page targets 2-3 long-tail phrases derived from services + location
- **Keyword placement**: Primary in H1, title tag, meta description, first paragraph, and at least 2 H2s. Secondary in H3s, image alt text, internal link anchor text.
- **Keyword density**: 1-2% natural density. Never stuff. Always readable.

### Technical + Content SEO
- The mechanical set — title 50-60 / meta-desc 120-156 chars, canonical, OG + Twitter cards,
  `LocalBusiness`/`FAQPage`/`BreadcrumbList` JSON-LD, `robots.txt`, `sitemap.xml` + lastmod, semantic
  HTML (exactly 1 H1, logical H2→H3) — is **enforced by `build_validators.ts`** (invariants table above).
- Dictated content specifics: primary keyword in H1/title/desc/first-paragraph/≥2 H2s at 1-2% density;
  every page internal-links ≥2 others with keyword-rich anchors; descriptive alt text + filenames
  (never `img-1.jpg`); homepage 1000+ words / about 500+ (real content, never filler).

### Local SEO (for location-based businesses)
- Google Maps embed with exact address
- `LocalBusiness` schema includes `geo` coordinates, `areaServed`, `serviceArea`
- NAP consistency (Name, Address, Phone) appears in header, footer, contact section, and schema
- Location mentioned naturally in content: "serving {neighborhood} since {year}"

### SEO Audit Prompts (run in the build pipeline)
Two dedicated SEO prompts run during the build:
1. **Keyword research + placement**: Analyze the business type + location, identify 5-8 target keywords, ensure they're placed in all required positions
2. **Technical SEO audit**: Verify all meta tags, schema, sitemap, canonical, heading hierarchy, alt text, internal links. Fix any gaps.

### Visual Quality Standards (CRITICAL — Breathtakingly Gorgeous)

**Every page must be a COMPELLING MULTIMEDIA EXPERIENCE. Everything should be BREATHTAKINGLY GORGEOUS and VIVIDLY + MASTERFULLY ANIMATED.**

**Tech stack:** shadcn/ui + Tailwind CSS + React (Vite). Every generated site uses this stack.

**Visual requirements:**
- 8+ @keyframes animations, glassmorphism, gradient text, scroll reveals
- 10+ unique images per site minimum
- Actual brand colors extracted via AI vision from original website
- Creative typography using premium fonts (Inter, Satoshi, DM Sans, Cabinet Grotesk)
- **Dark theme preferred** — darker + colorful is trending. Use dark backgrounds with vibrant accent colors
- Sites must look award-winning — Stripe / Linear / Vercel level polish

**Multi-page architecture (page count = source sitemap, 1:N up to 1000 max — BUILD-BREAKING):**
- Page count is NEVER capped at 5–8. Recreate every URL the source serves: 12 → 12, 80 → 80, 750 → 750. Cap at 1000 only as a sanity ceiling for runaway crawls
- Source sitemap discovery (priority chain): (1) `/sitemap.xml` + `/sitemap_index.xml` + nested `<sitemap><loc>` indexes, (2) `/wp-sitemap.xml` (WP) / `/sitemap-index.xml` (Squarespace), (3) `robots.txt` Sitemap: lines, (4) Wayback Machine CDX API for full historical URL set, (5) breadth-first crawl from homepage with depth ≤ 6 + same-host rule + dedupe by canonical
- Persist EVERY discovered URL to `_scraped_content.json.routes[]` with `{url, title, h1, body_word_count, internal_links, depth, og_image, hero_image}`. Container builds one Vite+React route per entry
- Floor for thin source sites: even a 1-page source = ≥4 page rebuild (Home + About + Services + Contact). Never go thinner than the 4-page floor
- Homepage = compelling marketing summary of the entire business mission. Sub-pages keep source URL slugs (`/about`, `/programs/scholarships`, `/blog/2024-03-annual-report`) — never lose deep-link continuity
- Blog: every post in source = one route in rebuild. `/blog` index + `/blog/{slug}` permalinks. `BlogPosting` JSON-LD per post
- Proper navigation: mega-menu / faceted nav / on-site search when route count > 12. Tree-organize by URL hierarchy, not by flat sitemap dump

**Brand Recreation Philosophy (CRITICAL — suped-up clone):**
- The goal is a SUPED-UP CLONE — same brand, same content, dramatically more beautiful
- **Logo:** IF THE BUSINESS HAS A LOGO, IT MUST BE USED. Priority: scrape from site header/footer → Logo.dev → Brandfetch → scan merchandise photos → extract from favicon → AI-generate as LAST resort
- **Logo font:** Extract the font from the logo image using AI vision and reuse it in the design
- **Logo graphics:** The graphic elements and colors in the logo should influence the ENTIRE site design
- **App icon:** Find real app icon → extract from logo → upscale favicon with AI → generate
- **Brand colors:** Extract from LOGO first, then website design, then merchandise/signage in photos
- **Content:** Use ALL original website content. Crawl and scrape EVERY page. If pages are too small, combine with 301 redirects
- **Images:** Use ALL original images. IF ANY PICTURE IS TOO SMALL, UPSIZE IT WITH AI
- **Page recreation:** Recreate every URL from the original sitemap. Make each page more beautiful, compelling, multimedia-packed
- **Every pass makes it better:** Structure prompts so each Claude Code pass escalates beauty, adding: gorgeous, accessible, concise, integrated, informative, intuitive, stunning, creative qualities

**Criticism integration (MANDATORY):**
- Any criticism for a *.projectsites.dev site must be adhered to, patched in prompts, and re-deployed
- The prompt system evolves with every user feedback cycle — never ignore a criticism

**Deep content integration:**
- Scrape ALL pages from the source site, not just the homepage
- Combine with web search results
- Augment with research, facts, references to affiliated organizations
- Back up content with real facts, proven research, affiliated org references
- If the source has a blog, recreate it with external CMS capability

**Multimedia everywhere:**
- Every page should have rich media (images, videos, animations)
- Double the parallelized research and multimedia discovery
- Optimize for visual impact — dark overlays on text are OK if they look stunning
- Add interactive, gamification elements where appropriate

**Google Maps embed:**
- Must have proper CSP headers allowing Google Maps iframe sources
- Register the domain with Google Maps Platform for API key restrictions
- Address links should use Google Maps directions URL format: `https://www.google.com/maps/dir/?api=1&destination={encoded_address}`
- Include `LocalBusiness` schema with geo coordinates matching the embedded map

## Design System & Style Guide (MANDATORY)

**Stripe / Linear / Vercel-level polish**, non-negotiable: Material spacing; Apple-level type
hierarchy (Inter/Satoshi — 48px hero / 24px section / 16px body); shadcn/ui + Tailwind + Radix;
brand colors extracted via AI vision at WCAG AA contrast. Immediate above-the-fold clarity (what the
business does in 3s) + a single primary CTA; subtle gradients/shadows/motion, never garish.
Lighthouse 90+ across all categories; minimal JS, lazy images, `font-display:swap`. Production-ready
output — no placeholders, no filler, no lorem ipsum.

## Asset Curation Philosophy (MANDATORY)

**Collect 10x more assets than needed, then curate down via AI visual inspection.**

### The Pipeline
1. **Collect ~100 candidate assets** from ALL APIs: Unsplash, Pexels, Pixabay, Foursquare, Yelp, Google CSE, DALL-E, scraped images, YouTube videos
2. **AI visual inspection on EVERY asset** — GPT-4o vision checks quality, professionalism, relevance, safety, resolution
3. **Score and rank** — each asset gets a quality score (0-100) and a relevance score
4. **Select top 10-15** for the final website — the absolute best from the 100 candidates
5. **Include rich media generously** — scale by route count: 6+ images per route home, 4+ per sub-route, plus 1–2 videos per content cluster. A 4-route site = 15–20 images; a 50-route site = 200+ images; a 500-route site = 2000+. Never cap at 4-page-site numbers when source is larger

### What Gets Inspected
- **Every image**: resolution, composition, relevance to business, professionalism, no watermarks
- **Every video**: quality, relevance, appropriate content, no ads
- **Logos**: clarity at multiple sizes, brand accuracy, text readability
- **App icons**: works at 512px AND 32px, distinctive, brand colors

### Logo & App Icon Selection
- Use ALL available sources: Logo.dev, Brandfetch, website scrape, Google image search
- For logo: prefer horizontal/text-based version with business name readable
- For app icon: prefer square/monogram version, works at small sizes
- Use the best trendy fonts (Inter, Satoshi, DM Sans, Cabinet Grotesk, General Sans) customized to brand personality
- If no suitable logo exists: generate via DALL-E/Ideogram using brand colors + display font

**Branded error pages:** All HTTP errors (400-503) return gorgeous animated HTML pages with Fira Code debug info (for browsers). API clients get JSON.

**Snapshot system:** Each build auto-creates a snapshot (first = "initial", edits = AI-named). Access frozen versions at `{slug}-{snapshot}.projectsites.dev`.

**Many API integrations deployed** — see memory file for full list. Key: Unsplash, Foursquare, Yelp, YouTube, Pexels, Pixabay, DALL-E, Stability AI, Cloudinary, Mapbox, Brandfetch, Logo.dev, plus quality gates (PageSpeed, GTmetrix).

**Quality rules:** See memory file `website_quality_rules.md` for the criticism registry — every user feedback item about generated websites, organized by category.

**Every prompt's suggestions should be considered** and possibly included in the multi-stage build process. When a user provides feedback about a generated site, the feedback should be generalized into rules that apply to all future builds.

## Logo & App Icon Generation (MANDATORY)

Every site MUST have a logo and app icon. If none is uploaded or discovered:

1. **Logo.dev** (`LOGODEV_TOKEN`) — try first for established businesses with domains
2. **Brandfetch** (`BRANDFETCH_API_KEY`) — full brand kit including logos
3. **DALL-E 3** (`OPENAI_API_KEY`) — generate a clean, modern text-based logo
4. **Ideogram** (`IDEOGRAM_API_KEY`) — alternative AI logo generation (good for stylized text)
5. **Stability AI** (`STABILITY_API_KEY`) — Stable Diffusion for logo variations

Logo style — TWO SEPARATE assets, never one text-baked square:
1. **Square icon MARK** — a TEXT-FREE simple geometric symbol OR a 1-2 letter monogram in the brand color. NEVER the full business name. This is what all favicons + the app-icon + the header's square mark use.
2. **Stylized wordmark** — the business name in a bold display font + brand colors, rendered as its OWN piece. The site Header shows the square icon + the wordmark SIDE BY SIDE (the wordmark is crisp styled text, not baked into the icon).

App icon: 512x512 PNG — the TEXT-FREE square icon MARK ONLY (the symbol / 1-2 letter monogram in the brand's primary color on a clean background). NEVER the full business name. All favicons (16/32/180/192/512) derive from this same text-free square. The business name lives only in the header wordmark, beside the icon — never inside the square.

## Multimedia API Usage (MANDATORY in every build)

ALL available multimedia APIs must be queried during the build:

| API | Key | Use In Build |
|-----|-----|-------------|
| Unsplash | `UNSPLASH_ACCESS_KEY` | Hero images, section backgrounds, service card images |
| Pexels | `PEXELS_API_KEY` | Stock photos + videos for hero/section backgrounds |
| Pixabay | `PIXABAY_API_KEY` | Illustrations, vectors, supplementary photos |
| YouTube | `YOUTUBE_API_KEY` | Business-specific videos for hero or featured section |
| Foursquare | `FOURSQUARE_API_KEY` | Venue-specific photos |
| Yelp | `YELP_API_KEY` | Business photos from Yelp listing |
| DALL-E 3 | `OPENAI_API_KEY` | Generated section images, logos, hero art |
| Ideogram | `IDEOGRAM_API_KEY` | Logo generation, stylized text art |
| Stability AI | `STABILITY_API_KEY` | Supplementary images, backgrounds, patterns |
| Replicate | `REPLICATE_API_TOKEN` | Image upscaling, background removal |
| Remove.bg | `REMOVEBG_API_KEY` | Clean up logos, product photos |
| Cloudinary | `CLOUDINARY_*` | Image optimization CDN (auto WebP, responsive sizing) |

The generated website should have **minimum 10 unique images** from these sources. No site should ever launch with placeholder or missing imagery.

## Quick Start

```bash
cd apps/project-sites
npm install --legacy-peer-deps   # NOT pnpm (electron-builder breaks it)
npm test                         # Jest unit tests (run from apps/project-sites; repo-root = babel trap)
npm run typecheck                # tsc --noEmit
npm run lint                     # eslint
npx wrangler dev                 # local dev server (port 8787)
```

## Product Vision

**"We don't sell websites. We deliver them."**

A small-business owner searches for their business, signs in, and receives a professionally
built AI-generated website in under 15 minutes — hosted, SSL'd, and live.

### Golden Path
```
Search → Select business → Sign In → Provide details + upload → AI builds → Live site
```

## Source Layout

```
src/
├── index.ts                    # Hono app: middleware stack, route mounts, queue/scheduled handlers
├── types/env.ts                # Env bindings (D1, KV, R2, AI, Queue, Workflow) + Variables
├── middleware/
│   ├── auth.ts                 # Bearer token → session → userId/orgId (does NOT reject unauthed)
│   ├── error_handler.ts        # AppError → JSON, ZodError → 400, unknown → 500 + Sentry
│   ├── payload_limit.ts        # 256KB max request body
│   ├── request_id.ts           # X-Request-ID header generation/propagation
│   └── security_headers.ts     # CSP, HSTS, X-Frame-Options, Permissions-Policy
├── routes/
│   ├── health.ts               # GET /health (checks KV + R2 latency)
│   ├── search.ts               # Business search, site lookup, create-from-search
│   ├── api.ts                  # Auth, sites CRUD, billing, hostnames, audit logs
│   └── webhooks.ts             # POST /webhooks/stripe (signature verification + idempotency)
├── services/
│   ├── ai_crypto.ts            # AES-GCM helpers (per-record IV) for secrets at rest
│   ├── ai_env_vars.ts          # Per-org/site/MCP encrypted env vars; resolveEnvVarsForAI()
│   ├── ai_workflows.ts         # Multi-phase AI pipeline + prompt registration
│   ├── analytics.ts            # PostHog server-side event capture + captureLLMCall ($ai_*)
│   ├── audit.ts                # Append-only audit log writes
│   ├── auth.ts                 # Custom auth: magic link, Google OAuth, D1 sessions (fallback rail)
│   ├── billing.ts              # Stripe checkout, subscriptions, entitlements
│   ├── build_limits.ts         # Build rate limiting + concurrency
│   ├── confidence.ts           # Confidence scoring for research data
│   ├── contact.ts              # Contact form handling
│   ├── db.ts                   # D1 query helpers (dbQuery, dbInsert, dbUpdate, dbExecute)
│   ├── domains.ts              # CF for SaaS custom hostname provisioning
│   ├── external_llm.ts         # External LLM provider routing (OpenAI, Anthropic, etc.)
│   ├── google_places.ts        # Google Places API integration
│   ├── image_generation.ts     # AI image generation (DALL-E, Stability, etc.)
│   ├── media.ts                # Unified media library (uploads + stock + DALL·E + Sora + TTS + send-to-bolt)
│   ├── notifications.ts        # Email notifications (SES -> Resend -> SendGrid, ADR-0019)
│   ├── openai_research.ts      # OpenAI-powered research pipeline
│   ├── rag.ts                  # Vectorize + AutoRAG (embed, indexChunk, semanticSearch, autoRagQuery)
│   ├── site_serving.ts         # R2 static file serving + top bar injection for unpaid
│   ├── task_inbox.ts           # Task tray: postAskUser, resolveTask, applyExpiredDefaults
│   └── webhook.ts              # Stripe signature verification, idempotency
├── prompts/
│   ├── index.ts                # Registry initialization (registerAllPrompts)
│   ├── types.ts                # PromptSpec interface, PromptKey type
│   ├── parser.ts               # YAML frontmatter + # System/# User section parser
│   ├── renderer.ts             # Template rendering with injection prevention
│   ├── schemas.ts              # Zod I/O schemas per prompt (validatePromptInput/Output)
│   ├── registry.ts             # Version resolution, A/B variants, KV hot-patching
│   └── observability.ts        # LLM call logging, cost estimation, SHA-256 hashing
├── workflows/
│   └── site-generation.ts      # Cloudflare Workflow: 6-step durable AI pipeline
└── lib/
    ├── posthog.ts              # PostHog capture helper (fire-and-forget)
    └── sentry.ts               # Sentry client factory (Toucan)
```

## API Surface

### Public Endpoints (no auth required)
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Health check (KV + R2 probe) |
| GET | `/api/search/businesses?q=...` | Google Places proxy (max 10) |
| GET | `/api/search/address?q=...` | Address search proxy |
| GET | `/api/sites/search?q=...` | Pre-built site search (LIKE) |
| GET | `/api/sites/lookup?place_id=...&slug=...` | Check if site exists |
| GET | `/api/auth/google` | Start Google OAuth flow |
| GET | `/api/auth/google/callback` | Google OAuth callback |
| GET | `/api/auth/:provider/login` | Better Auth (default) / Better Auth IdP login → 302 to authorize (404 dark when `BETTER_AUTH_*`/`BETTER_AUTH_*` unset) |
| GET | `/api/auth/:provider/callback` | IdP callback → verify CSRF state → exchange code → D1 session → 302 home |
| GET | `/api/auth/magic-link/verify?token=...` | Email click verification |
| POST | `/webhooks/stripe` | Stripe webhook (signature verified) |

### Authenticated Endpoints (Bearer token required)
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/sites/create-from-search` | Create site + start AI workflow |
| POST | `/api/auth/magic-link` | Request magic link email |
| POST | `/api/auth/magic-link/verify` | Verify magic link (programmatic) |
| GET | `/api/auth/me` | Get current user session |
| POST | `/api/sites` | Create site (manual) |
| GET | `/api/slug/check` | Check slug availability |
| GET | `/api/sites` | List user's sites |
| GET | `/api/sites/:id` | Get single site |
| GET | `/api/sites/:id/workflow` | Get workflow status |
| GET | `/api/sites/:id/logs` | Get site audit logs |
| GET | `/api/sites/:id/readiness` | Production-readiness grade for one site (#9; reads latest `workflow.build_validation` audit) |
| GET | `/api/readiness?ids=a,b,c` | Batch readiness grades for ≤100 sites in one request (#9 follow-on; org-scoped, `{id: data\|null}`) |
| POST | `/api/sites/:id/reset` | Reset site (rebuild) |
| POST | `/api/sites/:id/deploy` | Deploy zip to site |
| POST | `/api/sites/:id/publish-bolt` | Publish from bolt editor |
| DELETE | `/api/sites/:id` | Delete site |
| POST | `/api/billing/checkout` | Create Stripe checkout session |
| POST | `/api/billing/embedded-checkout` | Create embedded checkout |
| GET | `/api/billing/subscription` | Get subscription status |
| GET | `/api/billing/entitlements` | Get plan entitlements |
| POST | `/api/billing/portal` | Create Stripe billing portal |
| GET | `/api/sites/:siteId/hostnames` | List hostnames |
| POST | `/api/sites/:siteId/hostnames` | Provision hostname |
| PUT | `/api/sites/:siteId/hostnames/:hostnameId/primary` | Set primary hostname |
| POST | `/api/sites/:siteId/hostnames/reset-primary` | Reset to default hostname |
| DELETE | `/api/sites/:siteId/hostnames/:hostnameId` | Delete hostname |
| POST | `/api/sites/:siteId/hostnames/:hostnameId/unsubscribe` | Unsubscribe hostname |
| POST | `/api/sites/improve-prompt` | AI prompt improvement |
| POST | `/api/sites/generate-prompt` | AI prompt generation |
| POST | `/api/ai/categorize` | AI business categorization |
| POST | `/api/contact-form/:slug` | Submit contact form |
| GET | `/api/sites/by-slug/:slug/build-context` | Get build context |
| GET | `/api/sites/by-slug/:slug/chat` | Get chat context |
| GET | `/api/sites/by-slug/:slug/research.json` | Get research data |
| GET | `/api/domains/search` | Search available domains |
| POST | `/api/domains/purchase` | Purchase domain |
| GET | `/api/admin/domains` | Admin: list all domains |
| POST | `/api/publish/bolt` | Publish from bolt |

### Media Library — `/api/media/*` (auth required)
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/media/assets` | List assets with `kind/source/q` filters |
| GET | `/api/media/assets/:id` | Single asset metadata |
| GET | `/api/media/assets/:id/raw` | Stream the R2 object |
| POST | `/api/media/upload` | Multipart upload (25 MB cap; exempt from 256 KB global limit) |
| DELETE | `/api/media/assets/:id` | Soft delete |
| POST | `/api/media/stock/search` | Federated Unsplash/Pexels/Pixabay search |
| POST | `/api/media/stock/save` | Persist a candidate to the library |
| POST | `/api/media/generate/image` | DALL·E 3 generation |
| POST | `/api/media/generate/video` | Queued Sora / Veo (workflow callback flips status) |
| POST | `/api/media/generate/podcast` | ElevenLabs / OpenAI TTS |
| POST | `/api/media/send-to-bolt` | Mint a signed URL the bolt iframe consumes |

### AI Env Vars — `/api/env-vars/*` (auth required)
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/env-vars` | List org+site+mcp env vars (decrypted values hidden) |
| POST | `/api/env-vars` | Create scoped env var (org / site / mcp) |
| PATCH | `/api/env-vars/:id` | Update value or label |
| DELETE | `/api/env-vars/:id` | Soft delete |
| POST | `/api/env-vars/import` | Bulk import (dotenv-style payload) |

### Task Tray (Inbox) — `/api/inbox/tasks/*` (auth required)
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/inbox/tasks` | List open tasks for the caller's org |
| POST | `/api/inbox/tasks/:id/resolve` | Resolve a task; fans event into waiting workflow |

### Error Response Format
```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Site not found",
    "request_id": "uuid"
  }
}
```

Error codes: `BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`,
`PAYLOAD_TOO_LARGE`, `RATE_LIMITED`, `VALIDATION_ERROR`, `INTERNAL_ERROR`,
`WEBHOOK_SIGNATURE_INVALID`, `WEBHOOK_DUPLICATE`, `STRIPE_ERROR`,
`DOMAIN_PROVISIONING_ERROR`, `AI_GENERATION_ERROR`

## Middleware Stack (execution order)
1. `requestId` — Generate/propagate `X-Request-ID`
2. `payloadLimit` — Reject bodies > 256KB
3. `securityHeaders` — CSP, HSTS, X-Frame-Options
4. `cors` (API only) — Allow bolt/sites domains + localhost
5. `auth` (API only) — Bearer token → session → userId/orgId
6. `errorHandler` — Catch all, format as JSON

## AI Workflow Pipeline (site-generation.ts)

```
Step 1 (sequential):  research-profile          → business_type needed for others
Step 1b (optional):   google-places-lookup      → enrich with Places API data
Step 2 (parallel):    research-social            → social links
                      research-brand             → logo, colors, fonts
                      research-selling-points    → USPs, hero content
                      research-images            → image strategies
Step 2.5 (sequential): move-uploaded-assets      → move user uploads to R2
                       generate-logo             → AI logo generation
                       generate-favicon-set      → favicon from logo
                       generate-section-images   → AI section images
                       discover-brand-images     → brand image discovery
                       discover-videos           → YouTube video discovery
                       store-build-context       → persist research to R2
Step 2.5b (optional): scrape-website             → deep-crawl existing site
Step 2.6 (optional):  seed-site-data             → seed per-site D1 tables
Step 3 (sequential):  structure-plan             → site structure plan (fast LLM)
Steps 4-5 (container build — single-prompt orchestrator):
  build-orchestrator     → Container call: orchestrator prompt fans out to
                           parallel subagents (visual-qa, seo-auditor,
                           accessibility-auditor, performance-profiler,
                           content-writer, security-reviewer, domain-builder,
                           validator-fixer) under one Claude Code session,
                           gates DONE on completeness-checker (~40min)
  upload-final           → upload to R2, update D1 status to 'published'
  visual-inspection-final → GPT-4o final scoring (non-blocking)
```

Each step has automatic retry (3x) with exponential backoff. Container builds use
Cloudflare Containers (Durable Object `SITE_BUILDER`) with custom Dockerfile pre-baking
Claude Code, skills, and template repos.

## Prompt Files (prompts/*.prompt.md)

15 prompt files in YAML frontmatter + Markdown format:

| File | Purpose |
|------|---------|
| `research_profile.prompt.md` | Deep business profile research |
| `research_social.prompt.md` | Social media + website discovery |
| `research_brand.prompt.md` | Logo, colors, fonts, personality |
| `research_selling_points.prompt.md` | 3 USPs + hero slogans |
| `research_images.prompt.md` | Image needs + search strategies |
| `generate_website.prompt.md` | Full website HTML from research data |
| `generate_multipage_site.prompt.md` | Multi-page site generation |
| `generate_legal_pages.prompt.md` | Privacy/terms pages |
| `plan_site_structure.prompt.md` | Site structure planning |
| `score_website.prompt.md` | 8-dimension quality scoring |
| `site_copy.prompt.md` | Marketing copy (variant A) |
| `site_copy_v3b.prompt.md` | Marketing copy (variant B) |
| `research_business.prompt.md` | Legacy business research (v2) |
| `generate_site.prompt.md` | Legacy generation (v2) |
| `score_quality.prompt.md` | Legacy scoring (v2) |

## D1 Database (16 tables)

All tables have: `id` (UUID), `created_at`, `updated_at`, `deleted_at` (soft delete).
Org-scoped tables include `org_id`.

**Core**: `orgs`, `users`, `memberships`, `sites`, `hostnames`
**Auth**: `sessions`, `magic_links`, `oauth_states` (`phone_otps` dropped in migration `0516_drop_phone_otps.sql` — phone feature removed)
**Billing**: `subscriptions`
**Infra**: `webhook_events`, `audit_logs`, `workflow_jobs`
**AI**: `research_data`, `confidence_attributes`
**Analytics**: `analytics_daily`, `funnel_events`, `usage_events`

Site status machine: `draft → collecting → imaging → generating → published | error | archived`

## D1 Query Helpers (services/db.ts)
```typescript
dbQuery<T>(db, sql, params)      // SELECT multiple → { data: T[] }
dbQueryOne<T>(db, sql, params)   // SELECT one → T | null
dbInsert(db, table, record)      // INSERT + auto timestamps
dbUpdate(db, table, updates, where, params) // UPDATE + auto updated_at
dbExecute(db, sql, params)       // Raw execute
```

## Site Serving Flow
1. Base domain (`projectsites.dev`) → serve `marketing/index.html` from R2
2. Subdomain (`{slug}.projectsites.dev`) → resolve from D1 → serve from R2
3. Unpaid sites → inject top bar after `<body>` tag
4. KV cache: `host:{hostname}` → site record (60s TTL)

## Env Bindings (wrangler.toml)
- `CACHE_KV`: KV namespace for caching
- `PROMPT_STORE`: KV namespace for prompt hot-patching
- `DB`: D1 database
- `SITES_BUCKET`: R2 bucket for static sites + per-org media (`media/{orgId}/...`)
- `QUEUE`: Queue (optional, commented out — not yet enabled on account)
- `SITE_WORKFLOW`: Cloudflare Workflow binding (site generation)
- `DRIVE_SYNC_WORKFLOW`: Resumable Google Drive ingest
- `IMAGE_GENERATION_WORKFLOW`: Resumable DALL·E → Stability fallback
- `SNAPSHOT_QUALITY_WORKFLOW`: Screenshot + composition + SEO + a11y matrix
- `SOCIAL_PUBLISH_WORKFLOW`: Per-account fan-out for pulse_posts rows
- `SITE_BUILDER`: Durable Object (Cloudflare Container) for Claude Code builds (production only)
- `APP_RUNTIME`: Durable Object for installed-app runtime (auto-restart 3/min, idle-30m hibernation)
- `AI`: Workers AI binding (Llama 3.3 70B FP8, BGE embeddings)
- `RAG_INDEX`: Vectorize binding (768-dim cosine, `projectsites-rag`). Create via
  `npx wrangler vectorize create projectsites-rag --dimensions=768 --metric=cosine`
  plus metadata indexes on `kind` and `orgId`. See `docs/DEPLOYMENT.md`.
- `AI_GATEWAY_ENABLED` (var): when `"true"` + `CF_ACCOUNT_ID` set, routes
  OpenAI + Anthropic via `gateway.ai.cloudflare.com/v1/{account}/projectsites/{provider}`.
  Falls back to direct vendor URL on 5xx. See `docs/AI_INTEGRATION.md`.
- `MCP_ENCRYPTION_KEY` (secret): AES-GCM master key for `ai_env_vars` +
  `mcp_connections`. Tier 1.5 data-at-rest — NEVER rotate without re-encryption.

## Testing
```bash
npm test                    # Jest unit tests (run from apps/project-sites; repo-root = babel trap)
npm run test:coverage       # with coverage
npx playwright test         # E2E tests (needs Chromium)
```

### E2E Test Files (38 spec files)
Key specs include:
- `e2e/golden-path.spec.ts` — Full user journey
- `e2e/homepage.spec.ts` — Homepage sections + auth screens
- `e2e/health.spec.ts` — Health, CORS, auth gates
- `e2e/site-serving.spec.ts` — Serving, security, webhooks
- `e2e/inline-editing.spec.ts` — Inline site editing
- `e2e/ai-workflow.spec.ts` — AI generation workflow
- `e2e/domain-management.spec.ts` — Domain provisioning
- `e2e/admin-and-billing.spec.ts` — Admin + billing flows
- `e2e/auth-and-signin.spec.ts` — Authentication flows
- Plus 29 additional spec files covering UI polish, modals, search, etc.

### Test Business for E2E
**Vito's Mens Salon** — 74 N Beverwyck Rd, Lake Hiawatha, NJ 07034

## Auth providers — Better Auth (§27, ADR-0006)

App auth runs through the `IdentityProvider` port (`platform/identity.ts`):

- **Better Auth** (`auth/better-auth.ts`) is the DEFAULT consumer-auth IdP (OIDC).
- **Better Auth** (`auth/better-auth.ts`) handles ENTERPRISE org-scoped SSO/SAML.
- `getIdentityProvider(env, { enterprise? })` (`middleware/identity.ts`) selects
  Better Auth for enterprise (when `BETTER_AUTH_*` set), else Better Auth (when `BETTER_AUTH_*` set),
  else **null** → the existing custom auth (magic-link + Google OAuth + D1 sessions
  in `auth.ts`) stays the live path.
- **Login routes** (`routes/auth_idp.ts`, mounted in `index.ts`): `GET /api/auth/:provider/login`
  302s to the IdP authorize URL (storing a one-time CSRF `state` in KV); `GET /api/auth/:provider/callback`
  verifies+consumes the state, calls `handleCallback`, then issues the D1 session and 302s to
  `https://projectsites.dev/?token=…&auth_callback=<provider>`. `:provider` ∈ {`betterauth`}; Better Auth
  is the enterprise path. Routes 404 (dark) when the provider's secrets are unset.
- After `handleCallback` returns a verified `AuthenticatedUser`, the EXISTING D1
  session machinery (`findOrCreateUser` → `createSession`) issues our session — the
  IdP replaces "how the user proves identity", not the session model.
- Ships DARK behind `BETTER_AUTH_*`/`BETTER_AUTH_*`; enabling is a config flip, reversible by
  unsetting the secret. Activation: `docs/runbooks/auth-better-auth.md`.

## MCP OAuth Layer (`src/routes/mcp_oauth.ts`)

Per-site connections to Mailchimp, Stripe, HubSpot, GitHub, Slack, Notion,
Linear, Discord, Google Calendar, Calendly + paste-key fallback for Resend
and any provider missing OAuth credentials.

| Method | Path | Behaviour |
|--------|------|-----------|
| GET | `/api/mcp/:provider/connect` | Build authorize URL with PKCE state; returns paste-key spec when provider lacks OAuth |
| GET | `/api/mcp/:provider/callback` | Exchange code, encrypt + upsert into `mcp_connections`, redirect to dashboard |
| POST | `/api/mcp/:provider/paste` | Paste-key flow for providers without OAuth (Resend, internal webhooks) |

**Naming convention going forward:** `{PROVIDER}_OAUTH_CLIENT_ID` + `_OAUTH_CLIENT_SECRET`.
Historical aliases (`MAILCHIMP_CLIENT_ID`, `HUBSPOT_CLIENT_ID`, `STRIPE_CONNECT_CLIENT_ID`,
`GITHUB_CLIENT_ID`, `GOOGLE_CLIENT_ID`) kept as fallbacks so existing secrets keep working.
When ALL configured keys are empty, `/connect` returns `501 oauth_not_configured` so the
UI can render a paste-key form instead of opening a broken popup.

Tables: `mcp_oauth_states` (one-shot state + code_verifier per pending auth),
`mcp_connections` (one row per (site_id, provider), upsert on conflict).

## Known Issues & Gotchas

1. **CSP**: Homepage uses inline `<script>` — CSP MUST include `'unsafe-inline'` in script-src
2. **MIME bug**: Use `marketingPath` not `path` for content-type detection (path='/' has no extension)
3. **console.log blocked**: Use `console.warn` for structured JSON logs
4. **Payload format**: Frontend sends nested v2 format, backend accepts both v1 (flat) and v2 (nested)
5. **Queues**: Not yet enabled on CF account — binding is optional, code falls back to Workflows
6. **Jest config**: Must be `.cjs` not `.js` (ESM module type)
7. **Registry KV match**: Uses `startsWith('prompt:${id}@')` to avoid false partial matches
8. **MCP OAuth fallback** — `/api/mcp/:provider/connect` returns `501 oauth_not_configured`
   when the provider's `{PROVIDER}_OAUTH_CLIENT_ID` is missing — surface a paste-key toast,
   never open a broken popup.
10. **Zod-validation drift in `src/routes/features.ts`** (tracked 2026-06-02): the ~33
    POST handlers in the "50 experimental features" grab-bag read bodies as
    `(await c.req.json().catch(() => ({}))) as { … }` — a TypeScript `as`-cast with NO
    runtime validation, which [[zod-everywhere]] + [[contract-first-ai]] forbid at a
    boundary. Low live-risk today (every endpoint is `requireFlag`-gated on a
    `default_enabled:false` flag, so they 404 in prod), but each should get a colocated
    Zod schema + `zValidator` (or `safeParse` + `badRequest`) before its flag is promoted
    to beta/stable. Do NOT mass-retrofit blind — convert per-feature as each flag is
    enabled, with a unit test per endpoint. Same `as`-cast pattern exists (smaller) in
    `media.ts`, `env_vars.ts`, and the un-validated portion of `ai_admin.ts`.
    **Verified dormant (re-checked this wave): `features.ts` has 123 flag-gated
    handlers; cross-referencing the registry's 12 enabled flags (default_enabled:true
    or stage beta/stable — all core_* sentinels + speculation_rules /
    structured_data_autopilot / quotable_answer_block / llms_txt / mcp_server /
    public_api / cli_tool / accessibility_statement) against the features.ts gated
    set returns ZERO overlap. So every features.ts handler 404s in prod → the gap has
    no live exposure; the per-feature-on-promotion defer is correct, NOT a hidden live
    gap. Mass-retrofit remains forbidden.**
11. **Worker test mock paths** — a `jest.mock('…/src/…')` inside
    `libs/features/<slug>/__tests__/` needs FOUR `../` to reach `src/`
    (`'../../../../src/…'`). Three resolves to `libs/features/` → "Could not locate
    module" → the WHOLE suite fails to load (not one test). Handlers, one dir up, use
    three correctly. (Fixed page_audio_summary + generative_ui_stream 2026-06-21.)
12. **`@swc/jest` mock hoisting needs the GLOBAL `jest`** — this repo transforms tests
    with `@swc/jest` (`jest.config.cjs`), which only hoists `jest.mock(...)` above the
    imports when it sees the global `jest` identifier. `import { jest } from
    '@jest/globals'` leaves the `jest.mock` call BELOW the handler import → the real
    module loads first → the mock silently no-ops (e.g. the real `isFlagOn` runs and
    blows up on an empty env). Drop `jest` from the `@jest/globals` import and use the
    injected global (every passing handler+flag test does). Symptom:
    `mockX.mockResolvedValue is not a function` OR a real-code crash inside a "mocked"
    dep. Related pitfall: a `buildApp(userId = 'x')` default means `buildApp(undefined)`
    re-applies the default — use `null` as the explicit "no value" sentinel. (Fixed
    figma_import 2026-06-21.)

## Homepage SPA (public/index.html)

4-screen state machine: `search → signin → details → waiting`
- Vanilla JS, no framework
- CDN deps: Uppy (file upload), Lottie (animations), Google Fonts (Inter)
- 300ms debounced search, min 2 chars
- Parallel API calls on search: `/api/search/businesses` + `/api/sites/search`

---

## Feature Modules, Flags & Drift

Every post-launch capability is a feature module behind a typed flag; drift is a merge-blocker. Full rules: global `feature-module-architecture.md` + `feature-flags.md` + `drift-detection.md` (and root `CLAUDE.md` PART 23). Reference impl: `libs/features/donations_engine/` + `libs/core/feature-flags/`. Validate with `npm run validate:features`.
