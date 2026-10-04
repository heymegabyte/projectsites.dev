# Operating Principles — /run-the-loop

> Durable, non-negotiable invariants every fire obeys. Distilled from
> `apps/project-sites/_LOOP_CHARTER.md`, root `_LOOP.md` §2, and `.claude/loop.md`. The
> lifecycle + roster live in `./README.md`; the live queue in `./BACKLOG.md`; system shape
> in `./ARCHITECTURE.md`. Concise bullets, no padding.

## Canonical answers (Brian, 2026-09-29)

- **Loop docs canonical home = `/.claude/run-the-loop/`.** This dir is the entry point.
- **PRIORITY journey = the money path** — search → signin → AI build → view live → edit →
  publish. Secondary work waits while the revenue journey has any gap/dead-end/stub.
- **WfP = the DEFAULT serving path** — `x-ps-serve: wfp` + styled 200; R2 is byte-identical
  fail-soft; new sites born on WfP preview + prod; serving flag-gated during rollout.
- **AUTONOMY = full on reversible prod** — flag rollout, strict-validator flip, additive
  migrations, deploys: just DO them + prod-verify. Pause ONLY for truly destructive/
  irreversible: drop tables, bulk data mutation, secret rotation, mass outreach,
  billing/pricing.

## Open question — prod-off-by-default vs canonical answer #3 (Brian to reconcile)

> Surfaced fire-89 from the `~/Downloads` v7 master prompts. NOT applied — behavior is
> UNCHANGED (canonical answer #3 + `brian-preferences` prod-pre-authorized still bind). This
> is a flagged CONTRADICTION awaiting Brian's call, never a silent policy change.

- **v7 position:** production deployment should be **OFF by default** — the loop delivers a working
  PREVIEW, and promotion to production requires an **explicit single-release grant**; CI hooks should
  be audited so a plain `main` push CANNOT auto-promote to prod.
- **Canonical position (answer #3 above + `brian-preferences`):** autonomy is FULL on reversible prod
  actions — `wrangler deploy` is standing-authorized, work is never held "awaiting authorization."
- **These directly conflict.** Until Brian reconciles, keep current behavior (deploy stays
  pre-authorized). **Likely scope when resolved:** the OFF-by-default grant most plausibly applies to
  **customer-SITE publish** + **platform homepage promotion** (visitor-facing, one-way-ish), NOT
  necessarily the worker `wrangler deploy` of the control plane — so the two positions may be
  reconcilable by SURFACE rather than being globally exclusive. Do not pre-decide; flag it.

## Canonical paths (do-not-hunt cheatsheet)

> Verified 2026-10-01. Don't re-discover these — `loop-fire-lock.mjs` lives at REPO-ROOT
> `scripts/`, NOT `apps/project-sites/scripts/` (a prior fire burned 3 tool calls finding that).
> Paths are repo-relative from the repo root.

- **fire lock** — repo-root `scripts/loop-fire-lock.mjs` (claim/heartbeat/release). It is
  repo-root-relative: INVOKE from repo-root (or `"$(git rev-parse --show-toplevel)"/scripts/loop-fire-lock.mjs`).
  `node scripts/loop-fire-lock.mjs release <id>` from a SUBDIR (e.g. `.claude/run-the-loop/`) misses
  the relative path → Node prints its version footer (`Node.js vXX`, module-not-found) + SILENTLY
  fails to release — the recurring "manual `rm .fire-lease.json` after release" was THIS, not a script
  bug (the lease PATH is CWD-proof via `__dirname`; only the SCRIPT path is CWD-sensitive). `FIRE_LEASE_PATH=<file>` overrides the lease path for tests (`scripts/__tests__/loop-fire-lock.smoke.mjs`).
- **recipient allowlist** — `apps/project-sites/scripts/recipient-allowlist.mjs` (+ `.recipient-allowlist.local.json` (verify) — local override not present in a clean tree)
- **deep UI explorer** — `apps/project-sites/e2e/deep-ui-explorer/` (`explorer.mjs` · `vision-review.mjs` · `coverage-ledger.json`)
- **carried-blocker re-confirm (BATCH)** — `node apps/project-sites/scripts/reconfirm-carried-blockers.mjs` reads `apps/project-sites/e2e/carried-blockers.json` (header/endpoint/shell checks) → PASS(retire) | STILL-OPEN | ERROR, exit 0 iff all resolved; run it BEFORE assigning ANY fix-agent to a carried blocker (§ Carried-blocker re-confirm). Singular single-header variant: `reconfirm-carried-blocker.mjs`.
- **long-trail checkpoint** — `apps/project-sites/e2e/long-trail/checkpoint-case-001.json`
- **canonical home** — `.claude/run-the-loop/` (`README` · `OPERATING-PRINCIPLES` · `BACKLOG` · `LEDGER` · `DISCOVERIES` · `ARCHITECTURE` · `CONSTITUTION` · `GENOME` · `GOLDEN-PATHS` · `VISUAL-COVERAGE` · `BROWSER-OPERATING-LAYER`)
- **recent-fire recency** — `node scripts/loop-recent-fires.mjs` (repo-root `scripts/`; `--n <N>` / `--json`) — the ONLY trustworthy recent-fire read; LEDGER fire headers are NOT sorted, so eyeballing them gives stale recency (fire-88: orient reported "last 5 = 73-77" while git showed fire-87). Prints last N newest-first + cross-checks `git log` + flags mismatch.
- **worker deploy** — `cd apps/project-sites && npx wrangler deploy --env production`
- **prod D1** — `project-sites-db-production` (`ea3e839a-c641-4861-ae30-dfc63bff8032`)

## Prime directive (coding & delivery)

- Every fire's PRIMARY deliverable is a COMPLETE, REAL, end-to-end user journey proven on
  PROD — never a detector, smoke check, or mocked interaction.
- Detectors + unit tests are a BYPRODUCT — ship one only after a real journey caught a real
  bug and you want its class to stop regressing.
- "Ensure full flows happen" = COMPLETE the flow — build the missing product until the
  journey completes for real. Completing beats gating.
- Verify REAL prod, never a compile — deploy → prod-E2E the changed routes → only then DONE.
- No completion claim without FRESH command-output evidence this turn. Green local build ≠
  done; toast "success" ≠ persisted outcome; 200 ≠ correct data; rendering ≠ working.
- Every fire ships MORE than the last — several dimensions at once (feature + error-handling
  + structured logging + the journey test), accelerating while every gate stays green.

## Design & UX principles

- **gorgeous-by-default** — every UX iteration measurably more beautiful: cinematic motion,
  brand-locked, bento/asymmetry, refined fluid type. Never "functional but plain"; pair
  every backend feature with a frontend worth demoing to investors.
- **embarrassingly-easy-to-use** — every iteration EASIER than before (adding a step is a
  regression). AI does the work, the user confirms. Zero-config defaults · one obvious
  primary action per screen · ≤3 steps to any outcome · inline guidance not manuals ·
  instant feedback + undo on every mutation · empty states are first-action launchpads ·
  never a dead/doomed control (disable with the reason + fix, or hide) · the user's words,
  never internal jargon.
- **real-time data** — no manual Refresh/Reconcile/Sync buttons; visibility-aware poll /
  WebSocket / SSE / optimistic + background reconcile; freshness is invisible.
- **Brand** — black `#060610` (`--ps-bg`) + cyan `#00E5FF` (`--ps-accent`), cinematic;
  hard-coded brand colors are flagged; ONE `DialogShellComponent` primitive for every admin
  modal; feature icons float (no boxes/borders; `stroke=currentColor`).
- Logo luminance drives light/dark theme; white-text logos need dark backing; navbar
  wordmark single-line + prominent.

## Architecture principles

- **Cloudflare-first** — Workers/Hono/D1/R2/KV/DO/Queues/Workflows before Neon (Postgres
  escape hatch) / Upstash (Redis escape hatch) / Fly (stateful-VM escape hatch). Deep CF
  lock-in is the feature — no portability layer. AI Gateway on EVERY model call; Analytics
  Engine is the high-volume metrics backend.
- **Feature-module architecture** — every post-launch capability is `libs/features/<slug>/`
  (7-field `manifest.ts` + flag + Zod schemas + service + handlers + README + colocated
  tests). A scattered handler / module without a manifest = drift = merge-blocker.
- **Feature flags default-OFF** — `enabled=0, rollout=0, stage='experimental'`; server
  returns **404 (never 403)** when off; UI returns null; new flag → registry + manifest +
  docs (3 places); frontend flag-off MUST match the worker 404 (a `// (flag:X)` comment is
  NOT a gate); no dead flags, nothing permanently-on at launch.
- **Contract-first + Zod everywhere** — every runtime boundary (env, API in/out, params,
  forms, webhooks, queues, DO messages, AI outputs, tool in/out, storage reads) guarded by a
  Zod schema; infer types via `z.infer`, never hand-duplicate; OpenAPI derived from Zod.
- **Typed errors** — one uniform RFC7807 envelope across ALL endpoints (`code` +
  `correlationId` + `errors[]` + what-to-do-next); never leak secrets/stack-traces.
- **Interconnectedness — no orphan code** — every built unit reachable in the UI
  (import→render / route / nav / registration); built-but-unwired = not done; wire adjacent
  orphans while in-context (`scripts/detect-orphans.mjs`); recycle proven code over a thinner
  reimplementation; never de-reference a substantial unit without deleting it deliberately
  or re-wiring it the same fire.
- **Consistency primitives** — one dialog, one design-token source, one confirm service, one
  empty-state, one API service, one markdown renderer; re-implementing a primitive = drift.
- **Eliminate architectural drift in-turn** — competing generations (old/new Angular,
  observables where signals fit, custom UI vs Spartan, duplicate clients/models/schemas):
  choose the superior direction, migrate usage, delete the obsolete one. Never document both
  approaches forever.
- Editor extends bolt.diy — never a parallel editor. ONE chat surface (the editor).

## Testing principles (TDD-first, real journeys)

- Failing test FIRST → watch RED → implement → GREEN. Bug fix = failing regression first. No
  feature without ≥1 test; no fix without ≥1 regression.
- Every major E2E STARTS at the homepage, logs in via the real E2E UI method, navigates by
  CLICKING the interface — never `page.goto()` after first load, never token/cookie/
  storageState injection as a login shortcut.
- Acceptance tests test STORIES not pages — mutate → navigate away → return → hard-refresh →
  assert persistence → assert the cross-feature effect. Never stop at "toast says success".
- Deterministic (web-first assertions, condition-based waits, NEVER `waitForTimeout`/sleeps),
  parallel-safe, stable selectors (`data-testid`/role/text), 6 breakpoints
  (375/390/768/1024/1280/1920) × real browsers.
- Console + network cleanliness gate every flow: `console.error`/`warn`, page exceptions,
  `requestfailed`, unexpected 4xx/5xx/CSP/Trusted-Types = build fail. Empty allowlist is the
  target; never allowlist CORP / SW "Failed to fetch" / CSP.
- BROWSER-VERIFY = a human-like admin click-around (open interactive surfaces: domain picker,
  switcher, dialogs, ⌘K), not a route sweep. Layer 2 Stagehand/Browserbase explores; every
  discovery becomes a deterministic Playwright regression.
- Reconcile display-vs-store on every data surface — ground-truth `SELECT COUNT(*)` for the
  REAL account vs what the UI shows; `groundTruth>0 && display==0` = lying-empty. Causal
  probe for trackable surfaces (do X → store records it → UI shows it).
- Maintain `e2e/FEATURES.md` + `e2e/COVERAGE.yml`; a feature/sub-action without a passing
  journey spec = build fail. `assertSiteOwned` + a CI gate row on every new
  `/api/sites/:siteId` handler.
- Unit tests are real units (no browser, no absurd mocking — absurd mocking = wrong
  architecture). Quality > coverage %: 10 meaningful tests beat 100 trivial ones.

## Documentation & AI-context principles

- Docs ship in the SAME commit as the code; docs for a deleted feature deleted same commit.
- ADR (`docs/decisions/NNNN-title.md`) per one-way-door decision; JSDoc (intent, not types)
  on every export; per-feature README; `ARCHITECTURE.md` current.
- Docs are CURRENT-STATE only — strip history, delete drift; every doc claim matches the code.
- Keep globally-loaded `CLAUDE.md`/rules HIGH-SIGNAL + ACCURATE (routes/tables/gotchas match
  the code); narrow rules path-scoped; one canonical owner per rule; a memory naming a fixed
  issue as open is stale — update it. Don't let `CLAUDE.md` become a novel.
- Human-curated context files (LLM-generated ones give ~0 benefit, can cut success ~3% +
  raise cost ~20%).

## Loop discipline — shared skills ownership + dogfooding boundary (fire-89)

- **Shared `skills/` + `run-the-loop` are platform-owned + READ-ONLY in cloud runs.** A project
  OVERLAYS them LOCALLY (project `.claude/` wins per conflict resolution) and PROPOSES patches to the
  maintainer — it NEVER auto-publishes to `heymegabyte/claude-skills` and NEVER hot-reloads the shared
  layer mid-run. Edit the project overlay; upstream the lesson as a proposal, not a push.
- **Opportunistic dogfooding has a boundary.** Use the platform's OWN products (ProjectSites/GitLink/
  Megabyte/Sink/etc.) only when they MATERIALLY help the task at hand. NEVER force extra network calls
  or extra agents purely to claim dogfooding, and ALWAYS preserve a bootstrap-recovery path when a
  product is broken — the loop must still make progress when the dogfood is down.

## AI-agent principles

- **AI is the primary developer + a permanent product foundation** — never "AI-optional".
  When AI can make a surface easier/faster/safer/clearer, ship it.
- Prefer tool-calling → registered-component GenUI over free-form chat for AI surfaces
  (return a preview card / chart / editable form); NEVER ship runtime-LLM markup to owners.
- Inline/no-chat AI beats a bolted-on sidebar — edit-in-place, insight panels, prefill.
- Contract-first: every model output through a typed schema + repair-or-reject + fallback +
  trace; no raw model text consumed as truth. AI-heavy behavior has eval cases + rubrics +
  regression tracking; the prompt registry is versioned.
- Reinforce the VERIFIER leg (the #1 researched agent failure) — gate DONE on executed tests
  + prod-E2E asserting real content, never self-report; MAX_ITERATIONS cap, reflection
  between retries, kill/reassign after ~3 stuck iterations, hard token budget.
- Tools are APIs — narrow, Zod in + out, safe-by-default, idempotent, tested; no
  `runAnything`/`deployNow` mega-tools.
- Fan out by default (monitor-orchestration) — parallel agents in ONE message; ≤6-wide
  mutating, read-only sweeps free; fresh 150–300-word briefs, primary deliverable written
  FIRST; main thread orchestrates + folds + deploys once + verifies, never implements when
  saturated. Never bare `general-purpose` when a specialist fits; run the Agent Diversity
  Review gate before DONE.

## Hygiene & simplicity principles

- **Aggressive toward code, conservative toward required product behavior + data.** Net
  deletion is a success metric when capability is preserved.
- Every significant refactor ENDS with a deletion pass — old implementation, adapters, dead
  flags, unused imports/exports, stale CSS, obsolete tests/docs, compat layers. A rewrite
  that leaves the old architecture beside it is incomplete; no permanent half-migrations.
- KISS · YAGNI · high cohesion / low coupling · single source of truth · composition ·
  compiler-enforced invariants · boring standard framework capabilities · minimal public
  APIs. Earn every abstraction (write it twice, then extract) — one use case doesn't justify
  one. Thin shared infra (`middleware/` ≤200 lines/file, no business logic), deep feature
  modules.
- No transient prefixes (`waveN`/`sprintN`/`phaseN`) or vibe names (`brilliant`/`magic`/
  `ultimate`) in durable identifiers; ONE term per concept; kebab files · PascalCase types ·
  CONSTANT_CASE consts. Config-only chronology lives in migration filenames + commits.
- No silent regression — compare before/after (build, runtime, bundle, a11y, console,
  network, deps, TS strictness, CSS); a justified regression records why.
- TS strictness is a ratchet — never weaken it to ease a refactor; reduce `any`/casts/non-
  null assertions; prefer `unknown`, discriminated unions, exhaustive handling.
- TODOs/FIXMEs in source are allowed roadmap markers (banned only in shipped user-visible
  strings + as a substitute for critical-path work); architecture-drift TODOs ship-in-turn.
- No freeform `console.log` — structured JSON logs (`level`, `ts`, `msg`, `traceId`/
  `requestId`, `tenantId`); `console.warn` for logs (ESLint blocks `console.log`).

## Git & shipping principles

- **main-only, auto-push same turn** — no dev/release/feature branches; worktrees for
  isolation; merge + delete every worktree AND branch the round its work lands; NEVER
  force-push main; `git add -f` (`.gitignore` blocks `*.md`); conventional-commit + gitmoji
  IS the PR description.
- **Prod is pre-authorized** — gates green → deploy → prod-verify; never hold committed-but-
  dark work "awaiting authorization". `--env production` MANDATORY on the worker deploy or
  every `/api/*` 500s. NEVER modify already-set CF secrets.
- ONE fold, ONE build, ONE deploy per fire — agents never build/commit/deploy independently.
- Watch divergence (`git rev-list --left-right --count origin/main...HEAD`) each round;
  same non-`main` branch two rounds running or growing `behind` → integrate to `main` NOW.
- GUARDRAILS: git status first; `git pull --rebase --autostash` before push; commit ONLY
  your files. NEVER touch `.claude/loop.md`, `.claude/scheduled_tasks.json`,
  `src/generated/app_js.ts`, `src/services/analytics_events.ts`.

## Security principles

- Auth on every protected route; org/tenant scope from SERVER context (`c.get('orgId')`),
  NEVER a client header. `assertSiteOwned` on every `/api/sites/:siteId` handler (IDOR); a
  new site-id handler needs the guard + a CI gate row.
- No secrets in code; every self-generable secret auto-provisioned (HMAC/session/CSRF/JWT/
  salt); data-at-rest `*_ENCRYPTION_KEY` NEVER auto-rotated (destroys persisted data);
  `*_encrypted` columns actually encrypted; never log raw tokens.
- Parameterized SQL only (no Supabase client); Zod-validate + rate-limit + Turnstile public
  endpoints; verify webhook signatures THEN parse; validate + size + type every upload;
  SSRF revalidate every redirect hop against the host allowlist.
- CSP Level 3 strict-dynamic + per-response nonce + Trusted Types; HSTS, X-Content-Type-
  Options, Referrer-Policy, Permissions-Policy, COOP/COEP/CORP; CHIPS `Partitioned` on
  cross-site cookies; SRI on external scripts.
- Removed — never reintroduce: Supabase · phone-OTP (Twilio VOICE kept) · Lago/Unkey/Nango/
  Inngest/Novu (psnotify replaces Novu) · AI Agents (`ai_endpoints`/dispatcher — Functions
  on WfP replace it) · Resend send rail (SES sole, SendGrid break-glass; per-site Resend MCP
  is a separate kept customer feature).

## Accessibility principles (WCAG 2.2 AA)

- axe-core 0 violations is NECESSARY, not SUFFICIENT (axe auto-tests only 2.5.8 of the 9 new
  criteria) — the 6 AA criteria (2.4.11, 2.5.7, 2.5.8, 3.2.6, 3.3.7, 3.3.8) need MANUAL
  review every a11y pass.
- Exactly one `<h1>` per view + logical heading order (axe is blind to page-has-heading-one);
  a folded tab needs its own single `<h1>`.
- Contrast ≥4.5:1 from tokens (no undefined-var fallback shipping a failing value);
  focus-visible rings; focus restored on close (2.4.3); 24px min target (bordered chips/
  pills/badges are box controls, not inline-exempt); `prefers-reduced-motion` gates all
  motion; every string through the i18n layer (no hardcoded user-facing copy).
- Serious axe/WCAG failures are bugs; accessibility is part of E2E (keyboard nav, focus
  order/visibility, dialogs/menus/tooltips, ARIA, form labels + validation messages).

## Performance principles

- CWV cinematic targets: **LCP ≤2.0s · INP ≤100ms (>200ms = fail) · CLS ≤0.05**; FCP ≤1.2s.
  Budgets: JS ≤200KB gz/route (no chunk >250KB gz), CSS ≤30KB gz, fonts ≤100KB woff2.
- SSR/SSG mandatory; ZERO client-side data waterfalls (no `useEffect`→fetch→render for
  above-fold); LCP image `fetchpriority="high"` + explicit `width`/`height`; lazy-load
  non-LCP images + heavy chunks; AVIF/WebP + `srcset`; `font-display:swap` + subset.
- Last-write-wins cancellation on any re-triggerable fetch (`switchMap`/AbortController);
  debounce; no request storms / duplicate requests / eager route loading / huge DOM.
- Worker CPU ≤50ms p99; measure when practical (don't build caching infra for hypothetical
  perf); no orphaned CF resource; rollback-ready (wrangler rollback + D1 Time Travel + R2
  versioning); per-request cost stays sane on the hot path.

## Data & migrations principles

- Applied migrations are IMMUTABLE; zero schema drift (a referenced column MUST exist — a
  swallowed SQL error is a silent 404); orphan columns removed or documented-inert; indexes
  cover hot queries; UUIDv7 records / v4 tokens; write-table == read-table (admin writes the
  table the consumer reads).
- Per-site data isolation — the editor's per-site D1 is server-resolved (`resolveSiteDataDb`
  reads `site_database_allocations` for the OWNED site, lazy-provisions, denylists shared
  platform ids); a customer's Tables surface NEVER touches the shared/another site's DB.
- Optimistic UI + async backing where safe to delay (non-financial/auth/security); every
  mutation reversible (undo); idempotency key on money/site-mutation POSTs; premature
  terminal status + no retry strands rows.

## Convergence discipline

- ONE coherent slice per workstream per fire — never split a multi-faceted brief into
  one-section-per-turn.
- The queue never runs dry — every fire the discovery/product/E2E roles append deduplicated,
  evidence-backed next-wave tasks to `./BACKLOG.md`; zero-append = under-scan.
- A workstream is DONE only when Acceptance passes + ledger consolidated + no dead refs +
  prod proof. A dimension all-green ≥2 fires ⇒ maintenance-only (healthy no-op).
- Never pure-terminate on a quiet tree — advance the highest standing track (money path →
  site-gen quality → decomposition → docs). Reserve "converged" for the rare fire where
  every rung has no clean next step.
- Category budget (see `./README.md`): 30–45% product/features/bugs · 15–25% testing/golden-
  paths · 10–20% architecture · 5–15% UX/a11y · 5–15% cleanup/compression · 5–10% docs ·
  5–10% discovery · 5% loop-improvement.
- Context budget — main thread NEVER reads giant ledgers wholesale; delegate inventory reads
  to a fresh Explore agent (≤150-line cap).
- Auto-integrate-recs — anything <2h with no design call ships INLINE; the Recs list is only
  for genuine >2h / design-conversation / external-blocker / irreversible items.
- Backlog-hygiene — evidence cuts BOTH ways. A replenished item promoted to a LEAD/North-Star
  priority MUST carry file:line (or store/query) evidence the gap EXISTS; EQUALLY, a gap DISMISSED
  as "phantom" MUST confirm ABSENCE across the FULL relevant tree (`src/` + `templates/` + the remote
  template repo), never a partial grep. A vision/discovery verdict — positive OR negative — stays a
  candidate until confirmed against the full source + store. Fire-70: a scout searched only `src/`,
  missed `apps/project-sites/templates/webgl/WebGLHero.tsx` (real, built, unwired into site-generation),
  and wrongly called the real WebGL P0 a phantom; the adversarial-review phase caught the false-negative
  before it retired a live item.
- Carried-blocker re-confirm (deterministic, fire-79) — before assigning a fix agent to any carried
  blocker, re-confirm it LIVE: `node apps/project-sites/scripts/reconfirm-carried-blocker.mjs <url>
  <header-substring> --contains <needle>` → `RESOLVED` (exit 0) retires the stale item, `STILL-BLOCKED`
  (exit 1) justifies the fix, `ERROR` (exit 2, usually a CF bot challenge — retries UA-only) escalates
  to a real-browser check. NEVER assign off a stale checkpoint. Fire-79: case-001's checkpoint claimed
  the editor `frame-ancestors` block was live (RESOLVED fire-72) AND the D-boot `test.fixme` still set
  (removed fire-63) — a doubly-stale note that nearly burned a case-owner on already-done work.
  Fire-80: the SAME editor `frame-ancestors` blocker (BACKLOG infra #10) was formally RETIRED after a
  live `curl -sI https://editor.projectsites.dev` confirmed the CSP includes BOTH `http://localhost:4200`
  AND `http://localhost:4300` — the item had lingered OPEN in the backlog for ~20 fires after the fix
  shipped (fire-60 `9077b8ebb`). Lesson reinforced: a blocker reconfirmed-RESOLVED must be MARKED
  resolved in the backlog the SAME fire, not left open to re-tempt a fix-agent.
  Fire-85 (RECURRENCE — the rule restated as a hard invariant): the case-001 checkpoint STILL carried the
  stale editor-CSP "blocker" and nearly burned a fix-agent a THIRD time. A carried blocker/finding from a
  PRIOR fire MUST be re-confirmed LIVE THIS fire (curl the header / hit the endpoint / load the view) BEFORE
  any fix-agent touches it — a deployed fix makes the carried note stale, so a stale note is the DEFAULT
  expectation, not the exception. Correct the stale note (checkpoint + backlog) the SAME fire you disprove it.

## Failure taxonomy vs HARD-STOP (recover vs checkpoint — never conflate)

A worker AGENT failing is normal fan-out attrition — RECOVER + keep the loop running. The
LEAD (orchestrator) failing is the ONLY checkpoint trigger. These are two DIFFERENT things;
treating an agent's transient death as the session HARD-STOP wrongly checkpoints a healthy loop.

- **Transient single-agent failure → RECOVER, keep the loop running.** ONE agent hits
  ECONNRESET / a network drop returns `subagent_tokens:0` for that one agent / one agent's
  output is cut off mid-stream. This is attrition, not saturation. Do NOT checkpoint the
  session. Instead: (1) **salvage its work FIRST** — if the agent pushed/committed, `git show
  <branch-tip>` BEFORE deleting the worktree branch; cherry-pick any COMPLETE, verified commit
  (never `git branch -D` an agent's branch unshown — fire-51 nearly lost a complete verified
  fix `4334a853e` this way); (2) **re-queue** its unfinished slice as a `BACKLOG.md` item; (3)
  **continue** the fire with the remaining agents. Never re-fan-out for repair — fix-forward or
  ONE targeted agent (`parallel-subagent-economy`).
- **Genuine LEAD saturation → THEN checkpoint to a fresh session.** The ORCHESTRATOR itself
  hits "Prompt is too long", an `autocompact thrashing` notice fires on the LEAD (context
  refilled to the limit within a few turns, repeatedly), or the main thread can no longer spawn.
  THIS is the HARD STOP: checkpoint to `progress.md` + continue in a FRESH session. Never retry
  in place.
- **Rule of thumb:** an *agent* failing is expected + recoverable (salvage + re-queue +
  continue); the *lead* failing is the only signal to checkpoint. `subagent_tokens:0` from a
  network drop on one agent ≠ lead saturation — read WHICH thing failed before deciding.

## Browser-role execution contract (roles 16 & 17 — never bends)

The STANDING browser roles — role 16 (Long-Trail TDD case-owner) + role 17 (Deep UI Explorer) —
run Playwright/CF-Browser-Run against a LIVE local stack, so their execution environment is fixed:

- **MAIN checkout, NEVER a fleet auto-worktree.** A fleet auto-worktree gets sparse/absent
  `node_modules` (no local D1, no `.dev.vars`), so Playwright + the local stack can't boot and the
  role falsely reports BLOCKED / zero CF coverage (fire-56 proved 3 role-16 deaths; fire-64 BLOCKED
  role 17 the same way). Route both roles to the MAIN checkout (full node_modules + local D1 +
  `.dev.vars`); do NOT pass `isolation:"worktree"`.
- **Assert deps BEFORE claiming coverage.** The lead/role runs
  `test -d node_modules && test -d apps/project-sites/node_modules` (+ `.dev.vars` present) FIRST.
  A missing-deps launch = **BLOCKED with the exact missing prerequisite**, never "passed" — a worktree
  with no deps can never count as passed CF/browser coverage.
  - Deterministic preflight (run this, not the ad-hoc `test -d`): `node apps/project-sites/scripts/browser-role-preflight.mjs`
    — resolves the repo root via `git rev-parse`, asserts root + worker `node_modules/` + `.dev.vars`,
    WARNs on a `.claude/worktrees/` cwd, prints `OK` (exit 0) or `BLOCKED: <missing prereq>` (exit 1). Fire-74.
- **Authed journeys SOURCE `E2E_TEST_PASSWORD` — it EXISTS, never report it "missing" (fire-113).** The test-login seam (`/signin?test=1` → `POST /api/auth/test-login`, email `brian@megabyte.space`) authenticates the money-path golden + the authed `/create`/admin visual checks. The password IS provisioned — in `get-secret E2E_TEST_PASSWORD` (len 48) AND `apps/project-sites/.dev.vars`. An authed agent MUST load it into its process env first (`export E2E_TEST_PASSWORD="$(/Users/Apple/.local/bin/get-secret E2E_TEST_PASSWORD)"`), then submit it at the seam. fire-112's golden-path agent reported "BLOCKED — E2E_TEST_PASSWORD not in env" and `test.skip`'d the whole money-path spec — a FALSE blocker (it never sourced the available secret). Never emit that false-BLOCKED again: if authed browser verification is needed, source the secret, don't skip. (The test seam also needs an Angular-hydration wait — `browser_wait_for` the `[data-testid="test-signin-panel"]`, not `domcontentloaded`.)
- **Write-capable specialist only.** When the role must edit code/specs/checkpoints
  (role 16 always; role 17's same-fire repair hand-off), the specialist is `test-writer` or
  `general-purpose` — NEVER `visual-qa` (read-only, no Write; mis-assigning it strands the fire,
  fire-63). This covers role 17's DISCOVERY pass too: it is NOT read-only in the harness sense — it RUNS `explorer.mjs` (Bash) + WRITES `coverage-ledger.json`, so a `visual-qa` agent spawned into a plan-mode/read-only context cannot execute it and returns a recon-only PLAN, not real CF Browser Run coverage (fire-79). Assign role 17 to `test-writer`/`general-purpose`, NEVER `visual-qa`.
- **ONE real-browser driver per fire — serialize, never share.** The single shared Playwright-MCP
  browser must NOT be driven by concurrent agents + the lead at once; serialize real-browser
  verification to ONE driver per fire (the lead owns prod-verify, OR exactly ONE browser agent) —
  else the sessions collide (navigation/snapshot races on a shared context).
- Roles 16/17 MUST run the preflight FIRST — canonical `node apps/project-sites/scripts/browser-role-preflight.mjs` (the `.claude/scripts/` path is a thin shim to it) — and treat exit 1 as BLOCKED (never "passed"), citing the exact failing check (D-85-b, fire-86).
- **THE MECHANISM — match the role to its environment; the "fresh context" is a fresh AGENT, NEVER a human session.** Two cases: (a) a role that boots the LOCAL dev stack (local `npm run dev` + local D1) needs the MAIN checkout's full `node_modules` — run it via the LEAD's own Bash, or a main-checkout agent, since the fleet auto-worktrees spawned agents into sparse copies (fires 101-103). (b) a role that targets PROD — the Deep-UI-Explorer / the live golden-path journey driving Playwright or CF-Browser-Run against the LIVE URL — does NOT boot a local stack, so a SPAWNED fresh-context agent runs it fine (the sparse-worktree issue is irrelevant). Case (b) is the autonomous way to run the heavy browser pass when the lead is context-heavy: spawn a fresh agent, don't do it on the tired lead. (fire-104 → corrected fire-106)
- **When the lead is context-heavy, DELEGATE the browser pass to a fresh agent — NEVER defer it to "a fresh session" or recommend Brian clear/restart context.** The roles slipped across fires 101-106 because the lead reached them saturated and fell back to "queued / run fresh" — a stop-and-ask failure that violates `full-autonomy` + `[[loop-is-autonomous-never-recommend-fresh-session]]`. Correct behavior: run the browser budget EARLY (right after §0 orient) while lean, OR spawn a fresh-context agent for it mid-fire. Context saturation is the AGENT's problem, solved by delegation (`[[delegate-when-saturated]]`); the HARD-STOP "checkpoint + continue in a fresh session" is an INTERNAL orchestrator move the agent executes ITSELF — it is NEVER a human action, and "run in a fresh session" must NEVER appear in a report. (fire-104 → corrected fire-106)

## Deep UI Explorer / Visual Intelligence (role 17 — invariants)

Full role contract: `.claude/commands/run-the-loop.md` §1.17. Execution env: see § Browser-role
execution contract above (MAIN checkout, assert deps, Write-capable specialist). The invariants that never bend:

- **Honest coverage semantics.** Cloud test proof = Cloudflare Browser Run CDP with recorded
  provider + session id. Browserbase/local Chromium = `FALLBACK`; missing credential, failed
  login, role redirect, wrong tenant = `BLOCKED` with the exact missing prerequisite. None of
  these ever reports as passed Cloudflare coverage — the run manifest is the receipt.
- **States, not URLs.** The interface is a graph: route · role · selected site · active tab ·
  nested subview · open menu/overlay · scroll region · flag/data condition · iframe context.
  One settled screenshot after EVERY meaningful action; the preceding state id is recorded so
  reviewers compare before/after. The coverage ledger
  (`apps/project-sites/e2e/deep-ui-explorer/coverage-ledger.json`) is the resumable cursor.
- **Real vision on every capture, honestly.** Every screenshot gets a schema-validated verdict
  from an actual vision model via AI Gateway; reviewer failures are recorded, never silently
  skipped; a clean screen with zero findings is a valid result — manufacturing defects to fill
  the backlog is a violation. Architecture claims from pixels stay HYPOTHESES until source +
  store inspection confirms them.
- **Read-only discovery; same-fire repair by owners.** The explorer never mutates product code
  mid-pass. Confirmed findings hand off as reproducible state paths; the owning role fixes via
  RED → root cause → GREEN → replay the exact breadcrumb → re-capture → continue the journey.
- **Privacy at the boundary.** Password inputs masked before capture; token-shaped strings
  scrubbed from any context leaving the machine; artifacts stay in gitignored run dirs.
- **Fallback-vision severity is clamped — Workers-AI positives never p0/p1.** When the active
  vision provider is the tier-3 Workers-AI Llama Scout fallback (OpenAI 429 + Anthropic $0), it
  over-labels positive/neutral/aesthetic observations as p0/p1, flooding the backlog with
  false-criticals. A fallback verdict's finding may remain p0/p1 ONLY if it names a CONCRETE,
  reproducible defect (broken layout, contrast/AA failure, console/JS error, dead/doomed control,
  4xx/5xx); every positive / neutral / aesthetic-nice observation is demoted to p3. OpenAI + Anthropic
  verdicts are trusted uncapped. Enforced in `vision-review.mjs` (`clampFallbackSeverity`, applied only
  when `provider === 'workers-ai-via-ai-gateway'`); regression-guarded by `node vision-review.mjs --selftest`.

## Fire mutual exclusion (the lease)

`scripts/loop-fire-lock.mjs` serializes fires: claim at §0 (exit 3 = live fire running →
coalesce this tick), heartbeat per phase, release at §10. A stale lease (heartbeat >20 min)
is reclaimed — a dead lead never wedges the loop. One fire at a time means one browser
fleet, one deploy stream, no conflicting commits.

- **Heartbeat INLINE per phase — NEVER background a detached `while true; heartbeat; sleep`
  loop.** Such a loop outlives its dead fire and refreshes the heartbeat forever, holding the
  lease LIVE and coalescing EVERY future tick — a permanent deadlock no later fire can
  self-heal (fire-66 reclaimed exactly such a zombie: owner PID dead, lease fresh). Backstops
  the lock now ships: lease age is capped at `MAX_AGE_MS` (90 min) regardless of heartbeat, and
  `status` reports `ageMs`. If you ever hit a BUSY lease whose owner PID is dead (`ps -p <pid>`),
  reap the stray — `pkill -f 'loop-fire-lock.mjs heartbeat <fireId>'` — then reclaim.

## Wedged-agent protocol (proven fire-57, codified fire-58)

- A background agent whose output-file mtime is SILENT >20 min is presumed wedged (two cases fire-57: both stuck in reading phase). Protocol: (1) check mtime vs now; (2) SendMessage nudge ("land the smallest green slice now"); (3) bounded 90s wait — mtime unchanged → (4) TaskStop, salvage check (worktree branch tip + `git status` for its paths; a reading-phase agent has nothing to salvage), (5) respawn FRESH with an exact-file brief (name the files to read — an agent told to explore is an agent that can wedge). Never leave a wedged agent running alongside its replacement (duplicate-surface collision).

## Parallel-migration numbering (collision class, fire-57)

- Two parallel agents were each told "migration after 0648" → both created 0649_*. When >1 spawned agent MAY add a migration in the same fire, the LEAD pre-assigns each a distinct number in the brief (e.g. "yours is 0651"). An agent discovering it needs an unplanned migration takes `max(existing)+2` (gap absorbs a concurrent sibling) and reports it. Convergence always runs `ls migrations | tail` and renumbers dupes BEFORE any deploy (rename file + update tests referencing the filename — they execute the DDL by path).

## Shared-primitive fan-out recipe (proven 4× — editor-panel-ui-rearch waves A→D, fires 107-110)

The deterministic way to migrate N surfaces onto a shared primitive family (panels→`panel/`, cards, dialogs, any "one chrome for all" extraction) without agents colliding:

- **Lead extracts the primitive(s) FIRST** (or confirms they exist) with a colocated vitest spec (`renderToStaticMarkup` — no testing-lib dep). The spec is the regression lock every wave re-runs.
- **Fan out ≤6 worktree agents on DISJOINT surfaces** (one agent per 2-3 panels, grouped so no two touch the same file). Each brief: the mechanical before→after pattern + "EDIT-ONLY, do NOT build, commit ONLY your named files, NEVER `git add -A`."
- **Barrel-collision avoidance (the load-bearing trick):** when a wave also CREATES a new primitive, the creating agent imports it **directly** (`import { PanelX } from './panel/PanelX'`) and does **NOT** touch `panel/index.ts` or the spec. The LEAD adds the barrel export + the spec cases at convergence. This lets parallel agents create siblings without racing the one hot barrel/spec file.
- **Lead converges ONCE:** cherry-pick each agent's single commit onto `main` (disjoint files → zero conflicts), add barrel exports + spec cases, `npx vitest run panel.spec` (must stay green), `npm run build` (the authoritative TSX gate), deploy ONCE to Pages `bolt-diy`, prune every worktree + branch.
- **Adversarial grep before deploy — cover REMOVED *and* RENAMED contracts, repo-wide (not just owned files):** `grep -rn "<removed-symbol>\|<old-testid>\|<renamed-selector>"` across the WHOLE repo (esp. `**/__tests__/*.spec.tsx` + `e2e/`), because a worktree agent only sees the files it owns — a testid/selector/exported-symbol it RENAMES silently breaks a sibling spec it never opened. fire-110 caught a REMOVED `Spinner`; fire-112 caught a RENAMED testid (`database-subnav-*`→`panel-segnav-*` via PanelSegmentedNav broke `DatabasePanel.spec.tsx`, which the wave-f-1 agent didn't own) — both fixed in-thread before deploy. When an agent reports "I renamed testid X→Y / changed contract Z," the lead MUST grep the repo for the OLD name and update every consumer at convergence. The grep also doubles as the next wave's target list.
- **Headless visual QA of the primitives goes through the non-authed `/_preview` gallery on the pages.dev URL** (`https://bolt-diy-8jf.pages.dev/_preview`, shipped fire-111) — NOT the Access-guarded `editor.projectsites.dev` custom domain (which 403s browser navigations; see § Editor-origin prod-verify). The gallery mounts every primitive (Shell/Header/Loading-nebula/Empty) so each wave screenshots + AI-vision-scores the spine without the authed-journey budget; add any new primitive's frame to it the same wave. The in-CONTEXT authed states (panels inside the real WebContainer editor) remain the Deep-UI-Explorer's separate journey — don't burn a visual-qa budget fighting the Access wall for the isolated-primitive check the gallery already covers.

## Prod D1 migrations apply (standing)

- `wrangler d1 migrations apply` on prod is BLOCKED by ancient untracked backlog (references dropped tables, e.g. ai_endpoints). Apply new migrations via targeted `wrangler d1 execute --file=migrations/<new>.sql --remote`, then verify via `SELECT name FROM sqlite_master WHERE name IN (...)`. Do NOT attempt to bulk-reconcile the historical migration ledger mid-fire.

## Constitution era (fire-59, 2026-09-30)

`./CONSTITUTION.md` now GOVERNS the loop. Where it conflicts with this file or `./README.md`,
the constitution wins; where it is silent on an operational safety fact, these principles
bind unchanged. The old README lifecycle → CONSTITUTION § The 15-Minute Heartbeat.

- **Three nested loops** — MICRO (create → render → experience → critique → modify →
  compare, on the thing in front of you) · PRODUCT (make the surrounding workflow simpler/
  clearer/more beautiful — removing the thing just polished is a valid outcome) ·
  ORGANIZATION (ask why the system produced something inferior; improve prompt / Skill /
  agent / golden path / the loop itself — a local improvement teaches the whole org).
- **Default ten-pass rule** — important artifacts (major UI, components, prompts, Skills,
  plans, architecture, golden paths, agent definitions) get ~10 substantive improvement
  rounds under DIFFERENT lenses; stop when marginal value drops below improving another
  part of the product.
- **Standing artifacts** — Visual Coverage (`./VISUAL-COVERAGE.md`), Stub Debt
  (ABSENT → VISUALIZED → SIMULATED → … → OPERATED; SIMULATED is never "done"), Delight
  Debt, and the Completion Frontier are maintained continuously. Golden paths
  (`./GOLDEN-PATHS.md`) are executable product design — a journey may demand capabilities
  that don't exist yet (record CAPABILITY GAP; never shrink the journey to pass).
- **Every worker = BUILDER + REVIEWER + SCOUT + LEARNER** — complete the work, critique
  what it produced, report nearby/systemic opportunities, return durable lessons.
- **Creator ≠ final judge** — significant changes get independent evaluation (functional /
  visual / human-simulator / business / security, chosen intelligently); champion/
  challenger applies to designs, prompts, plans, and this constitution itself.
- **Each cycle must touch reality AND learn** — a cycle ending with only analysis, or with
  only code and no promoted lesson, is incomplete.
- **Anti-stagnation circuit breaker** — enormous effort + little observable product
  progress = STOP; audit the improvement system (premature micro-polish, repeated
  research, context pollution, duplicate agents, too much factory-building) before
  pouring more intelligence through it.
- **Harness subtraction** — periodically delete loop scaffolding (roles, prompt
  instructions, review stages, context docs, routing) that no longer increases quality;
  the organization gets more capable while its operating system gets simpler.

**Still binding from this file (unchanged by the constitution):** § Fire mutual exclusion
(the lease), § Failure taxonomy vs HARD-STOP (worker attrition ≠ lead saturation),
worktree isolation + main-only shipping (§ Git & shipping), category budgets
(§ Convergence discipline), § Wedged-agent protocol, § Parallel-migration numbering,
§ Prod D1 migrations apply, and § Deep UI Explorer invariants.

## § Verify/Ship addendum — push ≠ deploy (fire-92, 2026-10-02)

A SINGLE red worker unit test silently SKIPS the deploy jobs in `project-sites.yaml`
("Deploy to Staging"/"Deploy to Production" are downstream of the "Unit Tests" job), so a fire
can push to `main` + report "shipped" while NO deploy ran. fire-86→fire-91 all pushed worker
changes that never deployed because `feature_flags_docs.test.ts` was red (the `pricing_config_v2`
flag was registered without its `FLAG_DOCS` entry). **Discipline (every worker-touching fire, §9):**
after pushing, confirm `gh run --workflow=project-sites.yaml --limit 1` shows ✓ "Unit Tests" AND a
"Deploy to Production" job that actually executed (not skipped) — a green push is NOT a green deploy.
Unit Tests red → the deploy is dark; fix the failing test before claiming shipped.

## § Verify/Ship addendum — confirm the deploy CONCLUDED + flake-recovery (fire-98, 2026-10-03)

Extends the fire-92 "push ≠ deploy" rule. A worker push can fail `project-sites.yaml` "Test worker package" on a FLAKE (noisy error-path tests — places-429, D1 "no such table" — occasionally trip CI while the full suite passes locally). fire-97 pushed RES-AUTO slice 1, reported "deploying," and the flake stranded the deploy for a whole fire. **Discipline:** after a worker push, confirm the deploy run CONCLUDED green THIS fire (`gh run watch` / re-check), not just that it kicked off. On a "Test worker package" failure, FIRST run the FULL worker suite locally (`npx jest`); if it's green, the CI failure is a flake → `gh run rerun --failed <id>` immediately rather than leaving the slice dark. (Durable fix candidate: auto-retry the test job in CI, or quarantine the flaky error-path tests.)

## § Requirement registry = the EXISTING chain, never a competing store (Continuity & Beauty Directive, fire-99)
The directive's "requirement registry" (source→requirement→experience→implementation→verification→disposition) is realized by STRENGTHENING the stores that already exist — NOT a new file/scheduler/memory:
- source · requirement · acceptance · disposition → `BACKLOG.md` ([ ]/[x] frontier items + acceptance + cadence + discovered_by) + `MASTER-PROMPT.md` (adopted specs).
- verification contract · status → `gp-register.json` (golden-path `status_vocabulary`).
- evidence · SHA · prod-proof → `LEDGER.md` (per fire).
Canonical disposition vocab (apply across the above): **verified · partial · missing · unverified · blocked · deferred · superseded · rejected**. Requirement status ≠ task status — a closed task ≠ a satisfied requirement; verification must match the promise (a screenshot ≠ persistence; a unit test ≠ usability; a component file ≠ discoverability; a documented integration ≠ a working one). Invalidate evidence when impl/config/deps/shared-primitives/acceptance change; preserve historical evidence without presenting it as current. Do NOT create a second backlog/scheduler/registry/memory store — the directive's explicit anti-pattern. The recurring auditors (BACKLOG CBD-1..CBD-6) operate ON this chain.

## § Editor-origin prod-verify — curl LIES GREEN; the Access guard fingerprints browser navigations (fire-111)

`editor.projectsites.dev` sits behind a Cloudflare Access / bot guard that fires **only on the browser-navigation fingerprint** (`Sec-Fetch-Mode: navigate` + `Accept: text/html`). Consequence (fire-111, the `/_preview` gallery): **plain `curl` → 200 with the real route HTML, while a REAL browser navigation → 403 → the "Open the editor from your dashboard" gate.** A curl prod-verify of the editor custom domain is therefore NOT proof a user/headless-browser can reach the page — it is the god-tier "Workers assets-first swallows browser navigations / curl lies green" class.

**Discipline for editor (`app/` → Pages `bolt-diy`) prod-verify:**
- **Headless browser QA (visual-qa, Deep-UI-Explorer, Playwright) MUST target the pages.dev production URL `https://bolt-diy-8jf.pages.dev/<path>`** — it has NO Access guard (verified fire-111: `bolt-diy-8jf.pages.dev/_preview` → 200 to a real browser nav; `editor.projectsites.dev/_preview` → 403 to the same nav). The custom domain is for authed humans; the pages.dev URL is the headless path.
- **When curl-verifying the custom domain, send browser-nav headers** (`-H 'Sec-Fetch-Mode: navigate' -H 'Accept: text/html'`) to reproduce what a user actually gets — a bare `curl` understates the guard.
- The non-authed `/_preview` panel-primitive gallery is the standing headless visual gate for the editor spine — screenshot it on the **pages.dev URL** each fire. (Open item: exempt `/_preview` from the custom-domain guard so BOTH origins serve it to a browser.)

## § §0.5 drain — `rm` must be `command rm -f` + re-stat (fire-111)

The interactive shell aliases `rm` → `rm -i`; a plain `rm ~/Downloads/<file>` in a §0.5 drain is **silently intercepted** (the "deleted" echo prints but the file survives) — which is how a this-repo prompt marked "Source DELETED" in fire-101b re-appeared in fire-111's scan and re-triggered the intake. **Discipline:** delete intake files with `command rm -f <path>` (bypass the alias) and ALWAYS re-stat (`ls`/`test -e`) to CONFIRM absence before flipping the queue row to `absorbed`/`deleted`. Companion to the fire-101b zsh-glob fix — both are "the shell lied about a file op; confirm the result, never trust the echo."

## § MASTER-PROMPT.md is an ABSORBED intake, not a standing source file (GAP-0, fire-100)
CBD-1's first recall run flagged that `MASTER-PROMPT.md` is referenced as the "source" by `gp-register.json`, `ECOSYSTEM-CONTEXT.md` §86, `BACKLOG.md` §AWOS, and ADR-0057 — but the FILE does not exist (absent from the working tree, never committed, and `.md`-gitignored). This is NOT missing data: the AWOS master prompt (REV-2026-10-02-awos-master) was an INTAKE artifact that was ABSORBED into the durable stores per fire-99's extend-not-compete decision — its 52 golden paths live in `gp-register.json`, its work items in `BACKLOG.md` §AWOS, its product map in `ECOSYSTEM-CONTEXT.md`. Those stores ARE the authoritative homes; the standalone file was an intake (like the `~/Downloads` master prompts), correctly deleted after absorption. Treat "source: MASTER-PROMPT.md §…" as a provenance label for the adopted revision, NOT a live file to read. Future CBD-1 runs: do NOT re-flag MASTER-PROMPT.md as a drift — reconcile against gp-register + BACKLOG §AWOS + ECOSYSTEM-CONTEXT directly.

## § Provisioning preflight — query a named prod resource's existence BEFORE fanning out to build its artifacts (fire-115)
Before a fire fans out agents to BUILD the artifacts for a to-be-provisioned NAMED prod resource (a demo site at a fixed slug, a seeded org/row, a reserved hostname), the LEAD checks IN ORIENT whether that resource ALREADY exists — a concurrent 15-min cron fire, a prior process, or Brian may have created it. fire-115 built a gorgeous `demo-site/` bundle + an idempotent seed for slug `projectsites`, then the seed's slug-guard FATAL'd: `projectsites.projectsites.dev` was ALREADY a live published site (`63ad9ff6`, org `org-brian-001`, created the same hour) — the bundle work was spent on an already-satisfied goal. The seed's own preflight guard (refuse-to-clobber) was the last line of defense (worked perfectly), but a one-line existence query in ORIENT (`SELECT id FROM sites WHERE slug=?`) would have revealed it BEFORE the fan-out, letting the fire pivot. **Rule:** any "seed/create/provision a named prod resource" slice runs its existence check in orient, not just inside the seed script; if it exists + you didn't create it, do NOT clobber — adopt/surface per look-before-overwrite + `[[check-origin-before-reimplementing-concurrent-loop-shipped-it]]`. The seed script MUST still carry the refuse-to-clobber guard (defense in depth).

## § Long-browser roles COMMIT the spec + findings FIRST, not last (fire-116)
Golden-Path / Long-Trail / Deep-UI browser agents run LONG (300K+ tokens, 30-50+ actions) and are the MOST likely to be cut off mid-run — fires 112, 113, 116 each had one truncate AFTER the journey ran but BEFORE it wrote its spec + returned findings, forcing a resume-for-findings (the findings survived in-transcript, but the spec write was lost). Per `[[agent-resilience-discipline]]` Pattern A (primary artifact FIRST), these briefs MUST: (1) WRITE the spec file skeleton + a running `findings` note EARLY (right after auth lands, before the deep journey), then APPEND + commit as each phase passes — never batch the spec write to the end; (2) commit incrementally (a per-phase commit is fine) so a cutoff preserves a real artifact, not just screenshots. The lead's salvage path when one IS cut off: resume via SendMessage for the ≤40-line findings (no re-run), check `e2e/screenshots/<journey>/` for evidence, and re-queue the unwritten spec. A cut-off browser agent is fan-out attrition (salvage + continue), NEVER a lead HARD-STOP.

## § Read-only audit/visual sweeps = ONE surface per agent (fire-117 refinement of fire-116's browser-commit-first)
Multi-surface read-only sweeps (accessibility-auditor / visual-qa axe-ing 3 surfaces × 3 breakpoints) run LONG and are cut off before the final report — fire-116 AND fire-117 each lost an a11y/visual agent to a mid-sweep truncation (findings in-transcript, lost; the resumed agent cut off AGAIN in fire-117). Read-only auditors have NO Write tool, so they CAN'T checkpoint findings to a file (unlike the golden-path/long-trail roles, which MUST write their spec early per fire-116) — their only output is the returned text, and a long sweep never reaches it. **Rule:** spawn read-only audit/visual sweeps as ONE SURFACE per agent (a single route × its breakpoints), not a 3-surface batch — each returns in <1 min, well under the cutoff, and a lost one costs one surface not three. Batch the surfaces as PARALLEL single-surface agents (read-only sweeps are uncapped), not one serial multi-surface agent. If a multi-surface auditor IS cut off, resume-for-findings ONCE; if it cuts off again, re-run the UNFINISHED surface as its own single-surface agent rather than resuming a third time.

## § NEVER fan out concurrent Playwright-MCP browser agents — they SHARE one browser + collide (fire-118, root-caused)
fire-118 spawned 4 browser agents at once (3 single-surface a11y + 1 click-spec). ALL cut off mid-work; two reported the SAME phantom — `projectsites.projectsites.dev` "redirects to projectsites.dev" + the homepage "auto-navigates away." CURL disproved any redirect (200, self-canonical, no 30x, no inline JS redirect) — the "redirect" was a SIBLING agent navigating the **shared `mcp__playwright__*` browser** (the Playwright MCP server manages ONE browser context per server; N concurrent agents calling it drive the SAME tab → navigations collide, pages vanish under each other, every agent loops + cuts off). **Rule:** browser-driving agents (`mcp__playwright__*`) run **SEQUENTIALLY — ONE live browser agent at a time**, never in a parallel fan-out batch. If you need N browser checks, run them as sequential waves of ONE, OR give each an ISOLATED Cloudflare Browser Run session (its own CDP endpoint — not the shared MCP). This OVERRIDES the "fan out the roster in ONE message" default FOR browser agents specifically: non-browser agents (worker/frontend edits, audits-via-curl) still fan out freely; browser agents serialize. Pairs with § single-surface-audit (fire-117) + § browser-commit-first (fire-116): small surface + commit-early + ONE-at-a-time.

## § Salvage a cut-off agent's UNCOMMITTED worktree edits (fire-119 extends the failure taxonomy)
The failure-taxonomy salvage path ("salvage its commit via `git show <branch-tip>`") assumes the cut-off agent COMMITTED. But a worktree agent often cuts off AFTER editing + BEFORE committing (fire-119: the cleanup agent removed 191 lines of dead code, then cut off "let me run the gate" — 0 commits, but the edits sat UNCOMMITTED in its worktree). Don't discard that work. Salvage path for uncommitted worktree edits: (1) `git -C .claude/worktrees/agent-<id> status --short` → if it shows `M`/`A` files, the edits are recoverable; (2) commit them FROM the worktree: `git -C .claude/worktrees/agent-<id> add <paths> && git -C … commit -m "… (salvaged from cut-off agent)" --no-verify` (--no-verify because the agent's pre-commit already ran, or you'll re-verify at convergence); (3) cherry-pick onto main + **VERIFY the gates yourself** (the agent cut off BEFORE its own verify — a removed symbol may have a hidden caller; run tsc + the touched tests + validate:features; revert the specific change if red). This turned a fire-119 "attrition" into a landed 191-line cleanup. Check BOTH `git rev-list --count main..<branch>` (committed) AND `git -C <worktree> status` (uncommitted) before concluding an agent produced nothing.
