FROM node:22-slim

# System deps — full build/media tooling pre-installed so AI-generated builds
# never have to apt-get during a job. One layer + cleanup keeps the image lean.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl wget jq unzip zip xz-utils \
      build-essential pkg-config python3 python3-pip python3-venv \
      ffmpeg imagemagick libvips-tools \
      optipng jpegoptim webp \
      fonts-dejavu-core fonts-liberation \
      openssh-client gnupg \
    && rm -rf /var/lib/apt/lists/*

# CLI tooling: Claude Code + common JS helpers used during builds (sharp for image
# processing, vite for ad-hoc builds, typescript for tsc, esbuild as a fast bundler).
RUN npm i -g \
      @anthropic-ai/claude-code \
      sharp-cli \
      svgo \
      vite \
      typescript \
      tsx \
      esbuild

# Common Python helpers for image/text processing during builds.
RUN pip3 install --no-cache-dir --break-system-packages \
      pillow requests beautifulsoup4 lxml pyyaml

# Non-root user for Claude Code (requires --dangerously-skip-permissions as non-root)
RUN useradd -m cuser

# Clone skills + template repos into cuser's home
RUN git clone --depth 1 https://github.com/megabytespace/claude-skills /home/cuser/.agentskills && \
    git clone --depth 1 https://github.com/HeyMegabyte/template.projectsites.dev /home/cuser/template

# Allow root (container-server.mjs runs as root) to fetch/pull cuser-owned repos.
# Without this, git refuses with "dubious ownership" and the boot refresh of
# claude-skills + template silently fails — leaving sites stuck on stale prompts.
RUN git config --system --add safe.directory /home/cuser/.agentskills && \
    git config --system --add safe.directory /home/cuser/template

# Pre-install template deps so npm install is near-instant during builds
RUN cd /home/cuser/template && npm install --legacy-peer-deps 2>/dev/null || true

# GPT-4o inspection script (called during build for design critique)
COPY scripts/inspect.js /home/cuser/inspect.js

# R2 upload script (uploads built files to Cloudflare R2 after build)
COPY scripts/upload-to-r2.mjs /home/cuser/upload-to-r2.mjs

# Container HTTP server with disk-persisted job state (survives container restart)
COPY scripts/container-server.mjs /home/cuser/container-server.mjs

# Validator runner + the validator module it imports. Lets the validator-fixer
# subagent invoke build_validators.ts without compiling TypeScript inside the
# build dir (tsx handles the .ts import at runtime).
COPY scripts/run-validators.mjs /home/cuser/run-validators.mjs
COPY src/services/build_validators.ts /home/cuser/build_validators.ts

# Functions (Stage 2.2a): the functions-build CLI bundles a published site's functions/
# folder into one WfP-ready worker script; container-server.mjs spawns it via tsx after a
# successful build and carries the result in the HMAC callback → the worker deploys it to
# Workers-for-Platforms. cli.ts → build-site-functions.ts → bundle.ts → codegen.ts, so BOTH
# dirs must be present (functions_deploy.ts is import-type-only, erased by tsx at runtime).
COPY scripts/functions-build /home/cuser/scripts/functions-build
COPY src/services/functions /home/cuser/src/services/functions

# Sync universal agents (visual-qa, performance-profiler, completeness-checker,
# seo-auditor, accessibility-auditor, content-writer, security-reviewer, test-writer,
# etc.) from ~/.agentskills/agents/ to ~/.claude/agents/ so the orchestrator can
# spawn them via Task tool. Then layer project-specific agents on top.
RUN mkdir -p /home/cuser/.claude/agents && \
    if [ -d /home/cuser/.agentskills/agents ]; then \
      cp /home/cuser/.agentskills/agents/*.md /home/cuser/.claude/agents/ 2>/dev/null || true; \
    fi
COPY .claude/agents/ /home/cuser/.claude/agents/

# Project-local learned rules accumulated from per-build retrospectives. Mounted
# at the standard skill path so the orchestrator picks them up via @-import in
# CLAUDE.md. Refreshed at image rebuild time only — runtime updates flow via the
# benchmark + retrospective loop writing to R2/D1, then PR-merged into the repo.
COPY .claude/skills/learned/ /home/cuser/.claude/skills/learned/

# Job state directory (persists across container hibernation)
RUN mkdir -p /var/jobs && chmod 755 /var/jobs

# Set up CLAUDE.md for cuser. Inherits the upstream CLAUDE.md from
# megabytespace/claude-skills (cloned at ~/.agentskills) via @-import, then
# layers project-specific orchestrator instructions on top. The same applies
# for AGENTS.md, _router.md, and platform meta files — projectsites inherits
# the entire claude-skills meta surface so changes upstream propagate via the
# 10-minute git-pull refresh in container-server.mjs.
RUN mkdir -p /home/cuser/.claude && \
    printf '@~/.agentskills/CLAUDE.md\n@~/.agentskills/AGENTS.md\n@~/.agentskills/_router.md\n@~/.claude/skills/learned/RULES.md\n\n# ProjectSites Build Orchestrator (overlay)\n\nThe block above pulls the full Emdash Skills v7.2 system (15 categories, 18 agents, 32 platform variants) from megabytespace/claude-skills. ProjectSites inherits ALL of it — skills, agents, conventions, profiles. The instructions below add project-specific orchestrator behavior on top of that base.\n\nYou are the build ORCHESTRATOR. You do not write components yourself — you delegate to specialist subagents in parallel via the Task tool, then route their findings to fix-capable specialists.\n\n## Inherited Skills\nFollow `~/.agentskills/_router.md` to load the smallest useful skill subset. For site generation always include `15-site-generation` (research pipeline, media acquisition, build prompts, quality gates, domain features, template system). Profile: SaaS Application (skill 15 + 06 + 07 + 08 + 09 + 10 + 12).\n\n## Template & Context\nTemplate: ~/template/ (Vite + React 19 + TypeScript + Tailwind + shadcn/ui + react-router-dom + Lucide). Copy first, customize from _-prefixed JSON.\nThe template pages (src/**/*.tsx, index.html, public/**, _brand.json) ship with single-brace {TOKEN} placeholders — {BUSINESS_NAME}, {BUSINESS_TAGLINE}, {HERO_HEADLINE}, {HERO_SUBHEADLINE}, {ABOUT_HEADLINE}, {ABOUT_DESCRIPTION}, {FEATURE_*}, {SERVICE_*}, {FAQ_*}, {STAT_*}, {TIER_*}, {BLOG_*}, {CS_*}, {TEAM_*}, etc. (~250 tokens). You MUST replace EVERY {TOKEN} with real business content from the context files. NOT double-brace {{...}} — single-brace {TOKEN}.\nContext files (read ALL before delegating): _research.json, _brand.json, _scraped_content.json, _assets.json, _image_profiles.json, _videos.json, _places.json, _form_data.json, _domain_features.json, _citations.json.\n\n## Available Subagents\nUniversal (synced from ~/.agentskills/agents/ at boot — re-synced every 10min):\n- visual-qa — screenshots 6 breakpoints + AI vision, audit-only.\n- performance-profiler — Lighthouse, CWV, bundle budgets, audit-only.\n- completeness-checker — Zero Recommendations Gate, final ship verdict.\n- seo-auditor — title/meta/H1/JSON-LD/OG/sitemap, audit-only.\n- accessibility-auditor — axe-core WCAG 2.2 AA at 6 breakpoints, audit-only.\n- content-writer — Emdash brand voice copy, Flesch >= 60.\n- security-reviewer — OWASP audit, audit-only.\n- test-writer — Playwright E2E + Vitest unit tests.\nProject-specific (~/.claude/agents/ overlay):\n- domain-builder — donation/menu/booking/medical/child-safety/local-business sections, NEW files only in src/components/sections/.\n- validator-fixer — runs scripts/run-validators.mjs, fixes the 13 build_validators violation codes.\n\n## Orchestration Loop\n1. Read every _ context file. Build a one-paragraph site brief in your head.\n2. PICK THE VERTICAL THEME FIRST (build-breaking). Classify the business into ONE vertical from _research.json/_brand.json (type, category, services): medical (doctor/dentist/clinic/vet/PT — dentists map here), wellness (yoga/pilates/spa/massage/meditation), legal (lawyer/attorney/accountant/CPA/financial-advisor/insurance), restaurant (restaurant/cafe/bakery/bar/brewery/catering), retail (store/boutique/e-commerce/outfitter/outdoor/hardware), local-service (plumber/electrician/HVAC/roofer/landscaper/cleaner/contractor/auto-repair — trades), saas (software/app/startup/dev-tool), agency (agency/studio/marketing/design/production), portfolio (freelancer/designer/photographer/artist/personal), nonprofit (nonprofit/NGO/charity/foundation/church/501c3). No clean fit -> closest; default local-service for a physical small business, saas for a digital product. Then COPY the matching preset over the site brand: `cp ~/template/examples/_brand.{vertical}.json ~/template/_brand.json` (run from the build dir if template was copied there) so the site wears that vertical'\''s ELABORATE theme — its palette + font pairing + radius/shadow mood. Each preset is deliberately DISTINCT and mostly NOT dark: medical=LIGHT white+cyan/teal (Poppins), wellness=LIGHT calm sage+clay pill-rounded (Fraunces), legal=LIGHT navy+gold serif (Cormorant/Lora), restaurant=LIGHT warm terracotta+olive (Playfair), retail=DARK rugged slate+safety-orange sharp (Oswald), local-service=LIGHT deep-blue+safety-orange industrial (Bebas Neue), saas=DARK violet->indigo gradient+cyan glow (Inter Tight), agency=DARK brutalist magenta+acid-yellow zero-radii (Archivo Black), portfolio=DARK violet+champagne-gold (Cabinet Grotesk), nonprofit=LIGHT green+coral humanist serif (Crimson Pro). LIGHT themes MUST render a light background + dark text; text on the accent must stay >=4.5:1. Then customize business.* in _brand.json AND fill content/images from the context files. Lean into the theme so it feels bespoke for THIS vertical — never a flat generic shell. This customization is the only work you do directly.\n3. FILL EVERY {TOKEN}. Walk src/**/*.tsx, index.html, public/**, and _brand.json and replace EVERY single-brace {TOKEN} placeholder with real business content from the context files (grounded in _research.json/_brand.json — real name, services, hours, copy; image tokens like {*_IMAGE_URL}/{*_PHOTO}/{*_COVER} get real /assets paths or are left for the template to hide). ZERO {TOKEN} may remain in the final site. A deterministic safety net runs after you and fills any you miss with safe fallbacks, and a post-build gate FAILS the build if any {TOKEN} survives into dist/ — so fill them all yourself for real content, do not rely on the fallback.\n4. `npm run build`. If build fails, fix and rebuild.\n5. PARALLEL FAN-OUT (single message, multiple Task tool calls):\n   - domain-builder (creates section components from _domain_features.json)\n   - visual-qa (screenshots + GPT-4o critique)\n   - seo-auditor (title/meta/JSON-LD/OG)\n   - accessibility-auditor (axe-core 6 breakpoints)\n   - performance-profiler (Lighthouse + bundle budgets)\n6. Collect reports. Route findings:\n   - Visual/copy/SEO issues -> content-writer for copy, validator-fixer for HTML/asset/meta/JSON-LD/sitemap/lightbox/js-chunk fixes.\n   - Accessibility/perf issues -> validator-fixer (it has Edit) using audit reports as input.\n7. Rebuild. Re-run validator-fixer until `blockers === 0`.\n8. completeness-checker as final gate. If it returns NOT_DONE, loop back to step 5.\n9. `node /home/cuser/upload-to-r2.mjs` to publish.\n\n## Hard Rules\n- ZERO {TOKEN} in the final site. Every single-brace {TOKEN} in src/**/*.tsx, index.html, public/**, and _brand.json MUST be replaced with real business content before build. The post-build gate FAILS the build if any {TOKEN} leaks into dist/.\n- Spawn parallel subagents in a SINGLE message with multiple Task calls.\n- File partition: domain-builder owns src/components/sections/, validator-fixer owns public/ + index.html shell + vite.config.ts + package.json + sitemap.xml.\n- Audit-only agents MUST NOT edit. Forward their reports to validator-fixer.\n- Stripe/Linear/Vercel-level polish. 10+ animations, 15+ images, WCAG 2.2 AA, 6 breakpoints (375/390/768/1024/1280/1920), zero console errors.\n- THEME BY VERTICAL, never generic-dark-on-everything (step 2). Use the matching examples/_brand.{vertical}.json preset: LIGHT for medical/wellness/legal/restaurant/local-service/nonprofit, DARK for retail/saas/agency/portfolio. A healthcare or law site shipped dark, or every business shipped in the same dark shell, is a FAILED build.\n- Validator outputs from scripts/run-validators.mjs are the source of truth. Do not declare DONE until blockers === 0 AND completeness-checker returns DONE.\n' > /home/cuser/.claude/CLAUDE.md && \
    chown -R cuser:cuser /home/cuser

# FORCE-REBUILD 24 2026-09-11: remove the temporary ps-build-diag.txt diagnostic + CONTAINER_BUILD_REV
# from applyThemeStyleSidecar — it served its purpose (proved worker seed + sidecar + _brand.json.themeStyle
# all correct at build-prep, isolating the theme bug to template brand.ts resolveTree, fixed AL-352
# template 1616f23). No longer ship a debug file to every generated site. Sidecar logic itself KEPT.
# FORCE-REBUILD 23 2026-09-11: applyThemeStyleSidecar re-stamps _brand.json.themeStyle from the
# IMMUTABLE _theme_style.txt sidecar AFTER the vertical-pack merge — completes FORCE-REBUILD 22's
# "orchestrator-cp path = sidecar, next fire." The orchestrator REWRITES _brand.json (fire-54 clobber,
# same reason _category.txt exists), so #22's _brand.json-based themeStyle preservation was a silent
# no-op → the pack default won (St. Elmo steakhouse→warm-not-luxe, Waterloo record-store→boutique-not-retro).
# The sidecar (seeded by the workflow, untouched by the orchestrator) is now the authoritative personality
# signal. Guarded live by e2e/site-quality/verify-theme-match.mjs (+st-elmo/waterloo regression cases).
# FORCE-REBUILD 22 2026-09-11: applyVerticalPreset PRESERVES the worker's deterministic
# _brand.json.themeStyle across a vertical-pack force-apply — a jeweler stays `luxe`, a bookstore
# `scholarly`, even when borrowing the retail CONTENT pack (was: retail's `boutique` clobbered both,
# AL-298 luna-felix + AL-322 booksweet live mis-theme). Pairs with theme_style.ts (bookstore→scholarly).
# Guarded live by e2e/site-quality/verify-theme-match.mjs. (Force-apply path; orchestrator-cp path = sidecar, next fire.)
# FORCE-REBUILD 21 2026-09-05: ensureWordmark — SECOND Ideogram logo: a stylized TEXT wordmark of the
# business name (transparent bg, NOT vision-gated — text is intended) → public/logo-wordmark.png,
# shown RIGHT of the square icon mark in the navbar (HTML-text fallback when absent). Two logos: icon + wordmark.
# FORCE-REBUILD 20 2026-09-05: ensureLogo vision-gate — magic_prompt_option AUTO→OFF (AUTO silently
# re-injected the business NAME as rendered text, so "no text" was ignored) + a Claude-vision check
# that REJECTS any AI icon containing text → deterministic monogram fallback. App-icon is now a
# text-free square mark; official/uploaded logos are used verbatim (user-context honored).
# FORCE-REBUILD 19 2026-09-04: container-server.mjs loadContentMap — BUSINESS_DESCRIPTION never
# ships empty (fallback: content-pack SEO_DESCRIPTION → composed "{Name} — {Tagline}. {Class} in
# {City}."). The 098b5eca5 change committed the code but did NOT bump this marker, so the cached
# image kept serving the old file → riverstone-family-dental shipped an EMPTY <meta description>.
# This bump forces the container-server.mjs COPY layer to rebuild. (loop — empty-meta fix)
# FORCE-REBUILD 18 2026-09-04: vertical classifier coverage audit (fire-85) closed 16 gaps —
# legal gains accountant/CPA/tax/bookkeeping/financial-advisor/insurance (the CLAUDE.md-mandated
# professional-services group); "soup kitchen" negative-lookbehind on restaurant's "kitchen" so it
# falls through to nonprofit (order-bug); +ice-cream→restaurant, +tree/appliance/pool→local-service,
# +animal-rescue/humane-society→nonprofit, +bookstore→retail, +property-mgmt/mortgage→real-estate,
# +martial-arts→fitness. Guarded by src/__tests__/vertical_classifier_coverage.test.ts (82 cases).
# Server-only change → needs the image rebuild. (loop FIRE-85)
# FORCE-REBUILD 17 2026-09-04: nonprofit classifier regex gains pantry|relief center|mutual aid|501c3
# — "food pantry" / "relief center" (legit nonprofit categories) were misclassified → dark/thin/0-h1
# builds (readiness F). Server-only change, needs the image rebuild. (loop FIRE-83)
# FORCE-REBUILD 16 2026-09-04: container-server.mjs retries `npm install --omit=dev` ONCE on a
# non-zero/null exit (network/resource flake ~1/3 of builds — bit twice in FIRE-78) before failing
# the job. Credit-free (post-claude), bounded 2×≤5min. Server-only change → needs the image rebuild.
# FORCE-REBUILD 15 2026-09-03: ensureLogo(dir, ideogramKey) runs before npm build — recovers the
# OFFICIAL logo from _brand.json.logo.* when online, else GENERATES an elegant brand ICON via the
# Ideogram API (real api.ideogram.ai/generate call, no simulation), written to public/apple-touch-icon.png
# (the navbar logo + PWA icon); generate-favicons.mjs guards a >4KB real logo from the monogram fallback.
# Worker threads _ideogramKey=IDEOGRAM_API_KEY into all 3 /build payloads. container-server.mjs COPY'd. (logo arc)
# FORCE-REBUILD 14 2026-09-02: applyResearchNarrative wires validated research profile.description
# + mission_statement → ABOUT_DESCRIPTION/ABOUT_MISSION_TEXT (content-uniqueness arc, fire-72) —
# strict publish-gate (len+≥2 sentences+no-slop+no-tokens+Flesch≥52) so bad/absent research falls
# back to the polished pack default; orchestrator > research > pack priority. container-server.mjs COPY'd.
# FORCE-REBUILD 13 2026-09-01: applyVerticalPreset carries the preset's business.businessClass
# onto the live brand when the orchestrator's is absent/'organization' → LocalBusiness JSON-LD
# emits the real subtype (Dentist/Restaurant/RealEstateAgent/…) + geo, not a generic Organization; fire-61.
# FORCE-REBUILD 12 2026-08-31: container-server.mjs classifier — real-estate rule moved BEFORE
# agency so "real estate agency" → real-estate (not a magenta AGENCY site); fire-50.
# FORCE-REBUILD 11 2026-08-31: Stage 6.1 scheduled/cron — bundle.ts/codegen.ts/runtime.ts/
# build-site-functions.ts wire functions/_scheduled.* (extract cron + reserved /api/_ps/scheduled
# invocation). COPY'd bundling logic → needs the image rebuild (else the cached image ignores it).
# FORCE-REBUILD 10 2026-08-31: container-server.mjs gains POST /bundle-functions (Stage 2.2d —
# bolt-editor publish bundles its functions/ subtree via the trusted platform codegen). COPY'd
# server-only change → needs the image rebuild (else CF reuses the cached image, green deploy no effect).
# FORCE-REBUILD 9 2026-08-30: bundle.ts resolves the functions runtime via existsSync of the
# FIXED container path (/home/cuser/src/services/functions/runtime.ts) — the FORCE-REBUILD-8
# import.meta.url approach was ineffective (tsx-CJS makes import.meta.url cwd-relative, so it
# still resolved into the site build dir). existsSync is robust across tsx-CJS + Jest + ESM.
# FORCE-REBUILD 8 2026-08-30: bundle.ts resolves the functions runtime relative to its OWN
# file (../../src/services/functions/runtime.ts, where the Dockerfile COPYs it) instead of
# process.cwd() (= the site build dir, which has no such file) — fixes the generated entry's
# "Could not resolve <buildDir>/src/services/..." esbuild error (functionsBuild {ok:false}).
# FORCE-REBUILD 7 2026-08-30: container-server.mjs functions-build step sets NODE_PATH=
# /usr/local/lib/node_modules so cli.ts's bundle.ts `import 'esbuild'` resolves to the GLOBAL
# esbuild (a bare import resolves relative to the importing file, NOT cwd:dir) + carries
# {ok:false,error} instead of null on failure. SERVER-ONLY change → MUST bump this marker to
# force the image rebuild: last fire's NODE_PATH deploy was green but CF reused the cached
# image (no Dockerfile change), so functionsBuild stayed null (the 2.2a positive-dispatch miss).
# FORCE-REBUILD 6 2026-08-24: orchestrator CLAUDE.md now classifies the business
# vertical + copies the matching examples/_brand.{vertical}.json ELABORATE preset
# (light for medical/wellness/legal/restaurant/local-service/nonprofit; dark for
# retail/saas/agency/portfolio) — replaces the old "dark theme by default" rule.
# FORCE-REBUILD 5 2026-08-20: hard 15-min time-box (process-group SIGKILL) in container-server.mjs — server-only change, needs the image rebuild
# (wrangler skipped the image rebuild on the server-only change).
# Surface upstream meta files at standard locations so other tools (Codex,
# Cursor, etc.) running inside the container also pick up the inherited
# instructions. These are symlinks — when container-server.mjs git-pulls
# ~/.agentskills every 10 min the symlink targets update automatically.
RUN ln -sf /home/cuser/.agentskills/AGENTS.md /home/cuser/AGENTS.md && \
    ln -sf /home/cuser/.agentskills/_router.md /home/cuser/_router.md && \
    ln -sf /home/cuser/.agentskills/CONVENTIONS.md /home/cuser/CONVENTIONS.md 2>/dev/null || true && \
    ln -sf /home/cuser/.agentskills/.editorconfig /home/cuser/.editorconfig 2>/dev/null || true

EXPOSE 8080
