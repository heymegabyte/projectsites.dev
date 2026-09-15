# Loop Charter — the universal contract EVERY projectsites.dev loop obeys

> Every scheduled `/loop` cron reads this at fire time. It is the SSOT for what a
> "good fire" is. Loop-specific prompts add their SPECIALTY on top; this charter is
> the floor none may fall below. (Brian directive 2026-09-15: "ensure the entire
> application and all of its various sub actions are fully tested in full user
> journeys … loops should also progressively enhance … feature implementation,
> enhancing, debugging, error handling, and log enhancing.")

## Three mandates, every fire, no exceptions

### 1. Full-user-journey coverage of ALL sub-actions

- The surface a fire touches is proven through a **complete real-user journey**, never an isolated unit. Start at the homepage (or the real entry route), navigate by **clicks / keyboard only** (no `page.goto` after first load), and drive the flow end-to-end against **PROD** in real Chromium.
- Cover the flow's **sub-actions** — every clickable, form field, nav link, modal, keyboard shortcut, empty/loading/error/success state, and API call on the path — not just the happy click. A journey that skips the error state or the empty state is incomplete.
- Seed `ps_session` from `get-secret E2E_API_KEY` (ENV, never inline). 0 console errors + axe-clean at 6 breakpoints (375/390/768/1024/1280/1920). Deterministic (`waitFor`, never sleeps).
- Maintain `e2e/FEATURES.md` (authoritative feature list) + `e2e/COVERAGE.yml` (feature→spec). A feature/sub-action without a passing journey spec = build fail — write the spec that turn.
- The canonical journeys (extend, never delete):
  - **Guest acquisition** → search business → create-from-search → build → published → view live site → analytics records it.
  - **Owner** → sign-in → edit (bolt editor) → publish → claim → pay/checkout → manage domains/SEO/MCP/voice/forms.
  - **Returning** → sign-in → dashboard → site switch → settings → notifications.
  - **Every admin section** → open → mutate → causal-verify (READ-back reconciles the write vs the store, per verify-against-source-of-truth) → undo.
  - **Public site** → contact form → /admin/forms · page-audio · chat · voice.

### 2. Progressive enhancement across FIVE dimensions

Every fire advances **at least one**, and over a cohort of fires a loop touches **all five**:

- **Feature implementation** — build a missing capability at root cause, behind a feature flag (`enabled=0, rollout=0, stage='experimental'`) + Zod + 7-field manifest + tests + docs. Embarrassingly-easy (AI does the work; the owner does nothing).
- **Enhancing** — make an existing surface measurably better (gorgeous UI, cinematic motion, faster CWV, clearer copy, fewer clicks) without changing its contract.
- **Debugging** — reproduce a real defect with a failing test FIRST, fix at root cause, keep the regression. No symptom patches.
- **Error handling** — every boundary fails soft in prod (typed RFC7807 envelope: `code` + `correlationId` + `errors[]` + what-to-do-next) and fails fast in build/CI. Every empty/loading/error state is graceful + actionable. Turnstile + rate-limit public endpoints.
- **Log enhancing** — every code path a fire touches emits **structured JSON** logs (`level`, `ts`, `msg`, `traceId`/`requestId`, `tenantId`) with correlation IDs; `error`/`fatal` forward to Sentry; PII redacted; PostHog/Analytics-Engine events on key moments; a derived insight surfaced where it adds value. Freeform `console.log("msg")` is drift — fix in-turn. Add the log/trace/event that would have made the last incident diagnosable in one query.

### 3. Faster pace — MORE every fire, accelerating

- Every fire ships **more than the last** — not one minimal slice. In a single fire, advance **several** of mandate #2's five dimensions at once (e.g. a polished feature **plus** its error-handling **plus** its structured logging **plus** the full-journey test that proves it).
- **Fan out 4-6 parallel specialist agents** (worktree isolation) to raise throughput each fire — decompose first, parallelize by default, main thread orchestrates + folds + verifies (per monitor-orchestration + parallel-subagent-economy).
- **Escalate velocity + ambition over successive fires** — each fire's scope should out-reach the previous one's, while every gate stays green. Depth of coverage and polish compounds; the loop never plateaus into churn.
- Pace never trades away correctness: the `verification-loop` (deploy → prod-E2E) + display-vs-store reconciliation still gate every fire. Faster means more-per-verified-fire, never skipping verification.

## Cross-cutting (inherited from global rules)

- **Verify REAL prod, never a compile.** Deploy → prod-E2E the changed routes (curl/Playwright) → only then DONE (`verification-loop`).
- **Reconcile display vs store** on every data surface (`verify-against-source-of-truth`) — a clean render can still show wrong/empty data.
- **One coherent slice per fire; never idle.** Append findings + closures to `_LOOP_LEDGER.md`.
- **GUARDRAILS:** git status first; `git pull --rebase --autostash` before push; commit ONLY your files; NEVER touch `.claude/loop.md`, `.claude/scheduled_tasks.json`, `src/generated/app_js.ts`, `src/services/analytics_events.ts`. Worker+container via CI on push; FE via `cd apps/project-sites/frontend && npm run build:prod && npm run deploy:production`. Approval-required ONLY for DROP TABLE / secret rotation / bulk customer mutation.

## Active loop roster (the best-10, each carrying this charter)

1. **FULL-JOURNEY TDD** (`9bbc1347`, 3h :03) — drive to 100% real-journey coverage of every sub-action.
2. **COMPLETENESS + GAP-IMPLEMENTATION** (`635c5af1`, 3h :19) — build what's missing (prompt scheduler, scheduled publishing, backup/restore, bulk ops, …).
3. **STREAMING BUILD THEATER** (`7ac7c7cd`, 6h :33) — pipe live Claude Code stdout → gorgeous /waiting terminal.
4. **GENERATED-SITE QUALITY** — the delivered sites beat their source; cohort-freshness triage.
5. **GOLDEN-JOURNEY DELIVERY** — deliver a real business end-to-end + email-verify.
6. **ADMIN INTEGRITY + QUALITY** — admin sections reconcile display vs store; a11y/perf/security app-wide.
7. **CODE-QUALITY SWEEP** (`1534cb49`, hourly :53) — every file, every dimension incl. error-handling + structured logging.
8. **CINEMATIC-3D** (`840b9800`, 2h) — immersive, entice-to-register templates.
9. **EMBARRASSINGLY-EASY** — remove friction so the app is embarrassingly easy to use.
10. **BLEEDING-EDGE** — scan the frontier, ship one AI-native feature behind a flag.

Every one of the above ALSO obeys mandates #1 and #2 above — that is the point of this charter.
