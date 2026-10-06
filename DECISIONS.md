# Architecture Decision Records — projectsites.dev v2

> **Format:** [MADR 3.0](https://adr.github.io/madr/). Append-only. Never edit an accepted ADR's Decision — supersede with a new ADR. Numbering: zero-padded, monotonic, never reused.
> **⚠️ Two ADR series live in THIS file — do not conflate.** The v2 *architecture* series (ADR-0001…0011) is above; a SEPARATE *convergence* series (0003, 0005, 0006, 0019, 0030, 0033, 0035, 0046, 0047, 0053, 0054) is below under "Convergence ADR series" — **its numbers are the ones app code + `service-registry.md` reference** (e.g. "ADR-0006" = Better Auth, not RxJS). The low numbers collide by accident; resolve any "ADR-00xx" by which series/topic it names, not the number alone.
> **Owner:** Architect. Co-signed by Brian Zalewski for any change to `Status: Accepted`.

## Index — v2 architecture series

| #    | Title                                                    | Status   | Date       |
| ---- | -------------------------------------------------------- | -------- | ---------- |
| 0001 | Adopt Nx 20 monorepo as workspace shell                  | Accepted | 2026-05-26 |
| 0002 | Angular 21 + standalone + signals + zoneless             | Accepted | 2026-05-26 |
| 0003 | ~~PrimeNG 18~~ → Spartan UI + Tailwind v4                 | Superseded | 2026-06-17 |
| 0004 | Stripe Link exclusively for all payment capture          | Accepted | 2026-05-26 |
| 0005 | Cloudflare-native runtime: Workers + D1 + R2 + DO        | Accepted | 2026-05-26 |
| 0006 | RxJS-first at the backend edge, signals at the template  | Accepted | 2026-05-26 |
| 0007 | Server-Sent Events as the default real-time transport    | Accepted | 2026-05-26 |
| 0008 | One D1 database per tenant site, auto-provisioned        | Accepted | 2026-05-26 |
| 0009 | Cost guardrails + deferred scope                         | Accepted | 2026-06-17 |
| 0010 | Descoped features (trim)                                 | Accepted | 2026-06-17 |
| 0011 | Voice answering service: call-gpt on Fly.io              | Accepted | 2026-06-24 |

---

## ADR-0001 — Adopt Nx 20 monorepo as workspace shell

- **Status:** Accepted · **Date:** 2026-05-26 · **Tags:** `tooling`, `monorepo`, `build`

**Decision:** Adopt **Nx 20** as the workspace shell. Migrate the three existing packages into `apps/web`, `apps/control-plane`, `libs/shared`, `libs/ui`, `libs/data-access`, and seed `apps/tenant-runtime`, `apps/mobile`, `apps/cli` under the same graph. Enable **Nx Cloud** for remote caching (per-org token). Use `nx g @nx/angular:app` / `nx g @nx/angular:lib` for every new surface — never `ng new` directly. (Chosen over Turborepo, Rush, pnpm workspaces, Bazel — Nx has first-class `@nx/angular` generators + affected graph + local+remote cache.)

**Consequences:** PR CI runs only affected projects; `nx graph` catches architectural drift via module-boundary lint rules; schematics enforce stack defaults (signals, zoneless, standalone, ESLint flat, Vitest, Tailwind v4). Cost: `nx.json` config layer + Nx Cloud (~$30/mo) + one-time path migration (`apps/project-sites` → `apps/control-plane`). Mitigate with `nx affected:graph` in CI artifacts + `nx repair` as a `predeploy` step.

**References:** `~/.claude/plugins/heymegabyte-claude-skills/rules/angular-nx-monorepo.md`; ADR-0002.

---

## ADR-0002 — Angular 21 + standalone + signals + zoneless

- **Status:** Accepted · **Date:** 2026-05-26 · **Tags:** `frontend`, `angular`, `reactivity`

Angular is Brian's explicit pin for projectsites.dev (a named exception to the React default). Decision fixes the configuration to avoid later-stage migrations.

**Decision:** Adopt **Angular 21** with:

- **Standalone components only.** No NgModules. `bootstrapApplication(AppComponent)` with `provideRouter`, `provideHttpClient(withFetch(), withInterceptors([...]))`, `provideAnimationsAsync()`, `provideZonelessChangeDetection()` in `app.config.ts`.
- **Signals for component + service state** (`signal`, `computed`, `effect`, `linkedSignal`, `resource`). No RxJS subjects in component state.
- **RxJS for HTTP / WebSocket / event streams only** (boundary rule in ADR-0006).
- **Zoneless change detection**; drop `zone.js` from polyfills.
- **Typed Reactive Forms** (`FormGroup<T>`, `FormControl<T>`). No template-driven forms.
- **`@defer` blocks** for below-the-fold + role-conditional rendering.
- **Every route lazy** (`loadComponent` / `loadChildren`).
- **Modern control flow** (`@if`, `@for`, `@switch`, `@defer`) — never `*ngIf` / `*ngFor`.

**Consequences:** Fine-grained change detection without Zone.js; standalone removes NgModule ceremony; ~30 KB gzipped runtime cut + cleaner Sentry traces; typed forms catch shape drift at compile time. Cost: NgModule-only third-party libs need shims (maintain `libs/ui/legacy-module-shim`, audit quarterly); zoneless surfaces latent `setTimeout`/unhandled-promise issues (one-time audit + "zoneless smoke" CI gate). Signals↔RxJS interop mental model mitigated by ADR-0006.

**References:** ADR-0001; ADR-0006; `angular-nx-monorepo.md`.

---

## ADR-0003 — PrimeNG 18 + Tailwind v4 as the UI substrate

ADR-0003 PrimeNG 18 + Tailwind v4 — **superseded (2026-06-17): PrimeNG fully removed.** The admin uses **Spartan UI** (`@spartan-ng/brain` + helm wrappers) + Angular CDK + Tailwind v4 as the only UI kit — no PrimeNG, no `providePrimeNG`/CockpitPreset. Per `package-preference-registry`, PrimeNG/Material are rejected (mixing kits). W3C DTCG `tokens.json` remains the design source of truth; Tailwind v4 CSS-first config in `app.css` (no `tailwind.config.ts`); custom components wrap primitives in `libs/ui/`, never shipping raw kit components to product surfaces.

---

## ADR-0004 — Stripe Link exclusively for all payment capture

- **Status:** Accepted · **Date:** 2026-05-26 · **Tags:** `payments`, `billing`, `pci`

v2 captures money across three rails (SaaS subscription, tenant-marketplace bookings, one-off addons). Doctrine collapses all to **Stripe Link exclusively** (documents Brian's Stripe exception to `payments-routing.md`): single integration surface, Link's ~14% conversion lift, and Connect Express is mandatory for the marketplace (tenants = merchant of record; Square has no equivalent).

**Decision:** **Stripe Link** as the sole payment-capture surface for all rails:

- **SaaS subscriptions** — Stripe Billing + Link: `stripe.subscriptions.create` with `payment_settings.payment_method_types: ['link']`.
- **Tenant marketplace bookings** — Stripe Connect Express; tenants onboard via Express; end-users pay via Link with `application_fee_amount` per BILLING.md; tenants are merchant of record.
- **One-off addons** — Stripe Payment Links with Link enabled.
- **Webhook handler** — single `/webhooks/stripe`, signature verification, D1 `payment_events(event_id UNIQUE, …)` idempotency table, 5-minute replay window.
- **Connect Express onboarding** — embedded via `stripe.accountLinks.create` (`type: 'account_onboarding'`), no off-platform redirect.
- **No Square. No Payment Element. No alternative methods.** Contingency (Square Web Payments fallback) lives in BACKLOG.md.

**Consequences:** Single SDK / CSP entry / API key; PCI `SAQ-A` (Link tokenizes client-side); conversion lift compounds; Stripe Tax + Identity bolt on cleanly. Cost: higher fees on sub-$10 transactions (monitor in PostHog, revisit if >20% GMV); Connect unavailable in ~20 countries (exclusion list in BILLING.md § 6 + friendly geo-IP message at checkout).

**References:** ADR-0005; BILLING.md; `payments-routing.md`.

---

## ADR-0005 — Cloudflare-native runtime: Workers + D1 + R2 + DO

- **Status:** Accepted · **Date:** 2026-05-26 · **Tags:** `infrastructure`, `runtime`, `cloudflare`

v2 commits hard to the Cloudflare-native default (edge-deploy global, scale-to-zero, per-tenant isolation, storage co-located with compute). Chosen over AWS/Vercel/Fly/Render/bare-metal.

**Decision:** Cloudflare-native runtime for v2:

- **Compute:** Workers running Hono v4 for all API surfaces; Angular SSR via SSR worker.
- **Relational data:** D1 — one platform DB for control-plane state; one D1 per tenant site (ADR-0008). Read replicas via Sessions API where justified.
- **Object storage:** R2 — `sites/{slug}/{version}/`, `marketing/`, `documents/{tenant}/`. Standard → Infrequent Access after 30 days for archives.
- **Durable state:** Durable Objects (SQLite-backed) for per-site log streams, per-job chat rooms, per-user notification queues, per-tenant rate-limit windows.
- **Background jobs:** Cloudflare Workflows v2 (AI site generation, email digest, nightly D1→R2 backup).
- **AI inference:** Workers AI (Llama 3.3 70B FP8 Fast) first-pass; AI Gateway for premium routing (Claude, GPT-4o) with caching + rate limiting + fallback.
- **Edge cache:** KV for 60s host-resolution, prompt hot-patch overrides, feature-flag snapshots.
- **Auth:** Clerk (M2M JWT at edge via `CLERK_JWT_KEY`). Sessions in D1 backed by KV cache. *(Superseded for the platform by convergence ADR-0006 Better Auth.)*
- **Domains:** Cloudflare for SaaS custom hostnames; `*.projectsites.dev` wildcard default.

**Banned by this ADR:** any AWS/GCP/Azure runtime; any DB not D1 or Neon (Neon fallback-only, not v1); any S3-compatible storage other than R2; any job runner other than Workflows v2 or Inngest (Inngest reserved for cross-account fan-out, not v1).

**Consequences:** One account/bill/observability dashboard; global edge deploy default, ~5ms cold starts; all bindings direct to the Worker (no inter-service HTTP); Stripe webhooks land + verify + write D1 in one isolate (sub-50ms); generous free-tier headroom. Cost: D1 is SQLite (no PG extensions/RLS — per-tenant D1 replaces RLS per ADR-0008); single-vendor risk accepted; Workflows v2 younger than Step Functions (saga = explicit compensation steps). Backups: D1 Time Travel (30-day PIT) + nightly D1→R2 + quarterly restore drill.

**References:** ADR-0008; `code-style.md` § Stack.

---

## ADR-0006 — RxJS-first at the backend edge, signals at the template boundary

- **Status:** Accepted · **Date:** 2026-05-26 · **Tags:** `angular`, `reactivity`

Signals (pull-based, render-aware, current-value) and RxJS (push-based, time-aware, composable) specialize complementary roles. Strict boundary rule prevents all-RxJS and all-signals failure modes. Full rule: `.claude/rules/rxjs-first-angular.md`.

**Decision:**

**At the backend edge** (HTTP, WebSocket, SSE, EventSource, intervals, document events): all async I/O is an `Observable<T>`. HTTP via `HttpClient.get<T>()` (never `fetch()` in a service); SSE wrapped in `new Observable(...)` with teardown; WebSocket via `webSocket<T>()`; polling via `interval(N).pipe(switchMap(...))`; all operators (`switchMap`, `debounceTime`, `retry`, `catchError`, `share`, `shareReplay`) compose at the service layer.

**At the template boundary:** convert to a signal via `toSignal(obs$, { initialValue, requireSync, equal })`; templates read the signal (`@if (data(); as d) {...}`); `computed()` over multiple signals; `effect()` for side effects.

**Interop (one-directional preferred):** `Observable → Signal` (`toSignal`) is the default; `Signal → Observable` (`toObservable`) only when feeding a downstream RxJS pipeline. Never nest `toSignal(toObservable(toSignal(...)))`.

**Banned:** `BehaviorSubject` in component state (use `signal()`); `Subject` in services unless fundamentally event-bus-shaped; manual subscription management in components; `async` pipe (use `toSignal`).

**Consequences:** each tool used for its strength; zero subscription leaks (`toSignal` ties teardown to injector context); signal-pure templates (fine-grained, zoneless-friendly); service layer stays RxJS-composable. Cost: two reactivity systems + small interop boilerplate (mitigated by the one-paragraph boundary rule + ESLint rule forbidding `BehaviorSubject` in `*.component.ts`).

**References:** `.claude/rules/rxjs-first-angular.md`; ADR-0002.

---

## ADR-0007 — Server-Sent Events as the default real-time transport

- **Status:** Accepted · **Date:** 2026-05-26 · **Tags:** `realtime`, `transport`

Five real-time surfaces (site-generation progress, build logs, job tracking, chat, notifications); four are server-push-dominant, only chat is bidirectional (and can be SSE-down + POST-up). Chosen over polling-everywhere and WebSocket-everywhere.

**Decision:** **Server-Sent Events** as the default real-time transport:

- **All server→client streams** via SSE (Workers support SSE via `ReadableStream` + `Content-Type: text/event-stream`).
- **All client→server commands** via plain `POST`. No `WebSocket.send`.
- **WebSocket reserved** for true bidirectional bursty surfaces — none in v1.
- **Polling is the floor** — when EventSource can't reconnect, fall back to a 30s poll.

Pattern: Worker `app.get('/api/jobs/:id/stream', ...)` returns a `ReadableStream` with SSE headers (`Cache-Control: no-cache`, `Connection: keep-alive`); Angular `sseStream<T>(url)` wraps `EventSource` as an `Observable<T>` (`onmessage` → `next`, `onerror` → `error`, teardown → `close()`).

**Consequences:** single transport / reconnect strategy / auth pattern / observability span for all push surfaces; EventSource auto-reconnects; plays with HTTP/2 multiplexing; Workers don't bill long-lived SSE differently. Cost: one-directional (bidirectional needs a parallel POST channel); some corporate proxies strip `text/event-stream` (polling fallback); no IE11/old-Edge support. Mitigate with polling fallback + a 30s silence heartbeat.

**References:** MDN EventSource; ADR-0006 (SSE wrapped in Observable).

---

## ADR-0008 — One D1 database per tenant site, auto-provisioned

- **Status:** Accepted · **Date:** 2026-05-26 · **Tags:** `data`, `multitenancy`, `isolation`

D1 is SQLite with no row-level security; a shared-schema `tenant_id` model fails open (one forgotten `WHERE` leaks every tenant). Competing local businesses on one platform make any leak reputationally fatal. Database-per-tenant is the strongest isolation. Chosen over shared-D1+`tenant_id` and (unsupported) schema-per-tenant.

**Decision:**

- **One platform D1** — `projectsites-platform` — owns tenants, users, sessions, subscriptions, payment events, audit logs, feature flags, system jobs.
- **One D1 per tenant site** — `projectsites-tenant-{slug}` — owns tenant content (pages, blog, products), submissions (form leads, bookings, contact messages), analytics (page views, conversions).
- **Provisioning** — on signup, the control-plane Worker calls the D1 REST API (`POST /accounts/{id}/d1/database`), then runs `tenant-schema.sql` via `db.exec()`. ~2–4s. Idempotent/retry-safe.
- **Binding** — the tenant runtime Worker binds its tenant DB at deploy time; the DB ID is stored in platform D1 `tenants.d1_database_id` (cached in KV, 5-min TTL).
- **Backups** — D1 Time Travel (30-day PIT) per database + nightly `wrangler d1 export` to R2 `backups/{date}/{tenant}.sql.gz`, 90-day retention.

**Consequences:** hardware-level isolation (a cross-tenant table literally doesn't exist in that Worker's binding); per-tenant scaling + Time Travel + GDPR/CCPA right-to-delete (drop the DB) + per-tenant export. Cost: cross-tenant queries impossible at the DB layer (platform-wide reports fan out + a nightly aggregation Workflow writes summaries to platform D1); schema migrations fan out (`migrate-all-tenants.ts` Workflow, parallel batches of 50 with Time Travel snapshots, gated by a per-DB `migrations-applied` table); per-account DB count limit (100k, v1 fits).

**References:** ADR-0005; D1 REST API + Time Travel docs; ARCHITECTURE.md § Tenant data plane.

---

## ADR-0009 — Cost guardrails + deferred scope

- **Status:** Accepted · **Date:** 2026-06-17 (merged from WONT_BUILD_YET.md)

**Cost guardrails** (enforced in `src/services/build_limits.ts` + `token_burn_meter`):
- Max LLM spend **$20/day** (AI Gateway + org backstop) · max **20 sites/day** · max **25 emails/day**
- Max compute **5 min/job** · max **5 queued retries** · storage **100 MB free / 500 MB paid** per tenant

**Still-deferred** (UI/enforcement pending): TOTP/WebAuthn MFA UI · Chatwoot email-channel config.

**Since shipped** (were "won't build yet", now done): registrar domain purchasing (domain-picker + Buy flow), rich admin dashboards, A/B via feature flags, PostHog. Source doc `WONT_BUILD_YET.md` removed; this ADR is the record.

---

## ADR-0010 — Descoped features (trim)

- **Status:** Accepted · **Date:** 2026-06-17

Cut to focus the loop on the money path (payments → booking → conversion).

- **Code removed** (modules + flags + index.ts mounts + manifests): `figma_import`, `page_audio_summary`, `generative_ui_stream`.
- **Descoped — do not build** (recorded so the loop won't scaffold them): `brand_voice_clone`, `media_library` (owner DAM — duplicates builder `media.ts`+R2), `i18n_localization` as a platform module (do i18n at generation time), `enterprise_sso`/`enterprise_plan` (Clerk is auth — revisit on a real deal), `site_mcp_server`, conversational generative-admin-UI.
- **Marketplace sprawl → keep one:** keep `template_marketplace`; descope `plugin_marketplace`, `integration_directory`, `stripe_marketplace`/`stripe_app_status`. Where already built+deployed, they stay **deprecated-in-place** (never deleted mid-convergence-loop); remove in a quiet window if desired.
- **Heavy commerce:** keep the lightweight D1+Square storefront (`storefront_ecommerce`, TIER 0); descope the Medusa/`ecommerce_engine` path (Neon+Upstash+Docker) — opt-in for a rare heavy-commerce tenant.
- **Kept (deprioritized, NOT cut):** AI voice receptionist (high MRR), `membership_paywall` (recurring revenue).

---

## ADR-0011 — Voice answering service: twilio-labs/call-gpt on Fly.io (iad), autoscaled, multi-number

- **Status:** Accepted · **Date:** 2026-06-24 · **Tags:** `voice`, `infra`, `fly.io`, `twilio`, `one-way-door`

The Voice receptionist needs a long-lived bidirectional sub-second audio WebSocket (Twilio Media Streams) — the doctrine's explicit **Fly.io** escape hatch (poor fit for Workers/Containers).

**Decision:**

- **Foundation = a fork of `twilio-labs/call-gpt`** (Node/Express + Twilio Media Streams → TwiML `<Stream>` → WS, Deepgram STT, TTS, BYO-LLM, `function-manifest.js` tool calls). Fork lives in the monorepo (`apps/voice-gateway/`) as the ProjectSites voice runtime.
- **Deploy: Fly.io**, region **`iad`** (Ashburn, VA), co-located with Twilio US1 for lowest PSTN latency.
- **Autoscale by concurrent calls** (`fly-autoscaler` on active-WS metric, or `min_machines_running` + concurrency limits) — scales up under call load, back toward 0/1 idle.
- **One deployment answers EVERY number** — a single `/incoming` webhook on all account numbers; the handler reads the dialed `To` and resolves per-number settings from the Worker via authenticated `GET /api/voice/number-config?to=+1…` (agent prompt, voice, MCP allow-list, hours, escalation, consent config). The fork is stateless config-wise.
- **Persona parity** — same `ai_concierge` persona as web chat + Forms router, with a voice-only delta (brevity, spell-out, no markdown).

**Consequences:** full latency-loop control (turn detection, barge-in, filler tokens); reuses Deepgram/OpenAI stack; one deploy serves all tenants; Fly autoscale keeps idle cost low. Locked-in: a new load-bearing vendor (Fly.io) + non-CF surface to secure (CF Access / signed Twilio webhooks) + observe; Twilio Media Streams is 8kHz G.711 (ASR/TTS ceiling). Twilio ConversationRelay kept as a documented swap-in for the STT/TTS/orchestration layer. Build sequence tracked as the **V0 Voice-engine foundation epic** in `apps/project-sites/_LOOP_LEDGER.md`; requires `FLY_API_TOKEN` + Twilio/Deepgram/OpenAI secrets.

*(TTS: per `package-preference-registry`, migrate ElevenLabs → self-hosted Piper.)*

---

## Process notes

### Adding an ADR

1. Next number = highest `ADR-NNNN` + 1. 2. Copy the template. 3. `Status: Proposed`. 4. PR. 5. On Brian co-sign, flip to `Accepted`. 6. A later ADR supersedes an earlier one via `Status: Superseded by ADR-NNNN` — never edit its Decision.

- **New ADR** when the architectural commitment changes (new framework, DB, auth).
- **Amend in place** for typos, link rot, always-true clarifications.
- **Never** rewrite an accepted Decision.

### Template

```md
## ADR-NNNN — Title
- **Status:** Proposed | Accepted | Superseded by ADR-NNNN | Deprecated
- **Date:** YYYY-MM-DD · **Tags:** `tag1`, `tag2`

### Decision
What we chose and why (one paragraph).

### Consequences
Positive / Negative / Mitigations.

### References
Docs, RFCs, sibling ADRs.
```

### Cross-links

- [ARCHITECTURE.md](./docs/ARCHITECTURE.md) — current topology reflecting all accepted ADRs
- [BILLING.md](./BILLING.md) — implements ADR-0004
- [SECURITY.md](./SECURITY.md) — shipped vs deferred

---

# Convergence ADR series (folded from apps/project-sites/docs/adr/, 2026-06-27)

> One-file-per-ADR series merged here. Referenced by NUMBER in code (e.g. "ADR-0019"). SEPARATE series from the v2 ADRs above (0001-0011) — numbers collide by accident; resolve by topic.

---

## 0003 — Workflow/job routing: Cloudflare Workflows → Inngest → Hatchet Cloud

- **Status:** accepted · **Date:** 2026-06-20 · **Deciders:** Brian Zalewski

**Decision:** A pure `WorkflowRouter` (`src/platform/workflow-router.ts`) owns the choice:

- `chooseWorkflowBackend(flags)` — CF-native + light → `cloudflare-workflows`; event-driven + light → `inngest`; anything heavy/browser/filesystem/stateful → `hatchet`; default (unflagged) → `hatchet`.
- `JOB_DEFINITIONS` — every job kind + routing flags + reliability contract (`maxRetries`, `timeoutSeconds`, `requiresIdempotency`, `producesArtifacts`, `costCategory`). Each `defaultBackend` is **asserted by unit test** to equal `chooseWorkflowBackend(def)` — declaration and policy can never diverge.
- `routeJob(kind)` — recomputes the backend from live policy.

Strict preference order (§76): **Workflows first, Inngest second, Hatchet last.** App code calls `routeJob(kind)`, never a vendor SDK.

**Consequences:** one place to change routing; cost/retry/idempotency declared per job; testable in isolation. Backend adapters (`CloudflareWorkflowProvider`/`InngestProvider`/`HatchetProvider` implementing `ProjectSitesJobProvider`) are still to build — this slice is the routing brain. `JOB_DEFINITIONS` is the SSOT for the admin job catalog (§66). Existing CF Workflows (`SiteGenerationWorkflow` et al.) keep running; `site-generation` routes to `hatchet` (its true heavy home) via a gated, incremental adapter migration. Each adapter is feature-flagged (`workflows.cloudflare.enabled` / `.inngest.enabled` / `.hatchet.enabled`).

---

## 0005 — OpenFGA as the authorization graph (not authentication)

- **Status:** accepted · **Date:** 2026-06-20 · **Deciders:** Brian Zalewski

Authentication (who you are) is Better Auth's job (ADR-0006); authorization (what you may do) is a relationship-graph problem, not scattered `if (user.role === …)` checks.

**Decision:**

- Authorization flows through an `AuthorizationProvider` port (`src/platform/authorization.ts`): `check / batchCheck / writeRelationship / deleteRelationship / listObjects`. App code calls `authz.check({ user, relation, object })` on dashboard/API/admin/mutation paths.
- **Default deny.** Anything not explicitly granted is refused; unknown permissions resolve to false.
- The role→permission model is explicit (`PERMISSION_RULES`, the SSOT): owner publishes + manages billing/api-keys; editor edits but not billing; viewer reads; agency manages assigned client sites; platform_admin performs platform actions.
- `FakeAuthorizationProvider` (in-memory) is the local mode + test substrate; `DenyAllAuthorizationProvider` is the fail-closed default when OpenFGA is unconfigured (§58). The real `OpenFgaAuthorizationProvider` is the follow-on adapter.
- NOT on the public static hot path — only authenticated dashboard/API/admin.

**Consequences:** one place to reason about access; BOLA/object-level checks become `authz.check` calls; fail-closed safe. A real OpenFGA deployment + relationship-bootstrap (on user/org/site create + Stripe entitlement changes) is still to build. Chosen over hard-coded role checks and Casbin/custom-RBAC (OpenFGA's relationship-tuple model fits user→org→site→resource natively; the port keeps us swappable). OpenFGA outage → fail closed for mutations.

---

## 0006 — Better Auth is the only auth system (embedded)

- **Status:** accepted (supersedes the prior external-IdP federation design) · **Date:** 2026-06-27 · **Deciders:** Brian Zalewski

**Decision:** **Better Auth is the ONLY auth system, EMBEDDED in the main worker.** Runs inside `apps/project-sites` on the main D1 (Kysely D1 dialect) and OWNS sessions directly.

- Module: `src/auth/better-auth.ts` (`makeAuth(env)`), mounted at `/api/auth/*`.
- Methods: email+password, magic link (via the existing SES/Listmonk path), Google social, TOTP 2FA. Passkeys (WebAuthn) + SSO/SAML land in later slices.
- Tables: singular `user`/`session`/`account`/`verification` + plugin tables — no collision with the legacy plural `users`/`sessions` during migration.
- Cutover gated by the `better_auth` flag: ON → Better Auth owns `/api/auth/*`; OFF → legacy magic-link/Google/D1-session auth (`services/auth.ts`) stays live until the frontend sign-in UI + user-migration backfill land.

**Consequences:** one OSS auth system, fully owned, CF-native (D1, no external IdP); social + magic-link + 2FA + passkeys + SSO under one roof. A real migration (backfill users, swap session model) is required; one-way once cutover completes. **Removed:** the OIDC federation port (`platform/identity.ts`, `middleware/identity.ts`, `routes/auth_idp.ts` + adapters) and (later) the standalone `auth.projectsites.dev` worker.

---

## 0019 — Amazon SES + Listmonk for email (Resend excluded)

- **Status:** accepted · **Date:** 2026-06-20 · **Deciders:** Brian Zalewski

Convergence §4 forbids Resend; §42 mandates **Amazon SES** (transactional) + **Listmonk** (SES SMTP relay, newsletters/campaigns).

**Decision:**

- **Amazon SES** is the primary transactional provider (magic links, claim verification, receipts, billing/security/domain-verification, the Novu email channel, Listmonk's SMTP delivery). SigV4 raw-send from the Worker; no npm SDK.
- **Listmonk** (`mail.projectsites.dev`, CF Container) owns newsletters, campaigns, outreach lists, subscriber/segment management, unsubscribe — sending through SES SMTP.
- Behind `EmailProvider` / `MarketingEmailProvider` ports (`AmazonSesEmailProvider`, `ListmonkMarketingEmailProvider`) + a fake for local mode. Routing: transactional/critical → SES; bulk → Listmonk.
- **Resend is `deprecated`** in the service registry (`email-resend`) and **excluded** in `EXCLUDED_VENDORS`. New code MUST NOT import or call Resend.

**Consequences:** one delivery substrate (SES) for both rails, lower cost, deliverability owned (SPF/DKIM/DMARC on `projectsites.dev`). `scripts/check-architecture-fitness.mjs` reports Resend refs as `tracked-migration (ADR-0019)` (non-blocking) while the clean exclude-list (polar/trigger.dev/postmark/clay/socket.dev/chainguard = 0) is a hard regression guard. When Resend refs reach 0, drop the `documented` tag so reintroduction hard-fails CI. Chosen over keeping Resend (§4-excluded), Postmark (§4-excluded), SES-only (no campaign/subscriber manager).

**Migration progress (2026-06-23):** **Step 2 (transactional call-site cutover) — COMPLETE.** All 10 platform transactional senders route through the SES seam (`getEmailProvider`) as PRIMARY when AWS creds + `SES_FROM_EMAIL` are set; Resend/SendGrid remain fallback until SES is proven in prod (progressive degradation by env, no flag): `services/notifications.ts`, `services/auth.ts`, `services/contact.ts`, `routes/forms.ts`, `services/inbox.ts`, `services/credits.ts`, `routes/search.ts`, `services/form_router.ts`, `routes/ai_admin.ts`, `services/weekly_digest.ts`. Port added `replyTo` + `headers` (SES `Content.Simple.Headers`, one-click `List-Unsubscribe`).

**EXEMPT (customer-connected, NOT our rail — do NOT migrate):** `services/mcp_client.ts` (customer's Resend MCP) + `services/newsletter_dispatch.ts` `dispatchResend` (customer's Resend Audiences). §4 bans Resend as OUR rail, not as a customer integration.

**Remaining (prod-gated, steps 3-4):** provision AWS SES prod secrets + verify sending domain; send a real magic link from `noreply@projectsites.dev`; wire SES bounce/complaint events into `email_events`/`email_suppressions`; once verified, delete Resend fallback branches from the 10 files, drop the `documented` tag (hard-block), set `email-resend` registry status `removed`.

---

## 0030 — Unkey contract over the D1 api_tokens keystore (don't host Unkey)

- **Status:** accepted · **Date:** 2026-06-24 · **Deciders:** Brian Zalewski

§30 calls for Unkey. ProjectSites already owns a complete API-key system in `services/api_tokens` (`psk_<32-byte-hex>` keys, SHA-256 hash stored in D1 `api_tokens`, scopes/expiry/revoke/`last_used_at`/org ownership) — the live edge auth path. Hosting Unkey (a DB-backed container stack) is not a Worker artifact.

**Decision:** Expose the existing keystore through an **Unkey-style provider contract** — a thin in-house port, no vendor SDK, no hosting:

- `platform/api-keys.ts` — the port: `ApiKeyProvider` (`createKey` / `verifyKey` / `revokeKey`) with a structured `KeyVerificationResult` (`valid` + `code` + `keyId` + `ownerId` + `scopes`) + `FakeApiKeyProvider`.
- `middleware/api-keys.ts` — `D1ApiKeyProvider` delegating to `createApiToken`/`verifyApiToken`/`revokeApiToken` + `getApiKeyProvider(env)`.

`api_tokens` stays the source of truth + live verification path.

**Consequences:** vendor-neutral key API with zero new deps, Workers-native, no second keystore. A managed-Unkey adapter can slot into the factory behind `UNKEY_ROOT_KEY` later without touching call sites. Fail-soft (D1 error → `{ valid: false, code: 'NOT_FOUND' }`; existence never leaks). Not Unkey's product features (per-key ratelimit, analytics dashboards, roles/identities) — wire managed Unkey behind this same port if ever needed. No env secret; ships dark (nothing calls the port yet; additive + behavior-neutral).

---

## 0033 — OpenFeature contract over the D1 flag engine (not the vendor SDK)

- **Status:** accepted · **Date:** 2026-06-24 · **Deciders:** Brian Zalewski

§33 calls for OpenFeature. ProjectSites already owns a production flag engine in `modules/feature_flags` (D1 `flag_overrides` tenant/org/global scope + typed `FLAG_REGISTRY`, KV 60s cache, SHA-1 rollout-percent hashing, killswitch stage, `/admin/feature-flags` UI, audit log, `isFlagOn`/`resolveFlag`). Adopting `@openfeature/server-sdk` would add a dep + a parallel evaluation path over the same data.

**Decision:** Expose the engine through the OpenFeature **provider contract** (standard `ResolutionDetails<T>`: `value` + `reason` + `variant?` + `errorCode?` + `flagMetadata?`) — a thin in-house port, no external SDK:

- `platform/feature-evaluation.ts` — the port: `FeatureEvaluationProvider` + Zod `EvaluationContextSchema` (OpenFeature `targetingKey` + scope fields) + `FakeFeatureEvaluationProvider`.
- `middleware/feature-evaluation.ts` — `D1FlagEvaluationProvider` wrapping `isFlagOn` + `getFeatureEvaluationProvider(env)`.

The D1 store remains the single source of truth.

**Consequences:** standard OpenFeature evaluation surface, zero new deps, Workers-native, no second flag store; a future REMOTE OpenFeature provider can slot behind an env var. Fail-soft (KV/D1 fault → caller default with `reason: 'ERROR'`; unknown flags fail-closed to `false`). Not the literal SDK (no drop-in OpenFeature client hooks/event-bus/multi-provider — re-back with the real SDK if ever needed). No env secret; ships dark.

*(NOTE — later directive `feature-flags.md`: Cloudflare Flagship is the mandated flag service. Keep this D1 engine as the admin source-of-truth + fallback behind a `FlagshipEvaluationProvider` that PREFERS Flagship when bound. See `middleware/feature-evaluation.ts` + `scripts/sync-flags-to-flagship.mjs`.)*

---

## 0035 — OpenTelemetry span port over Workers Tracing (not the OTel SDK)

- **Status:** accepted · **Date:** 2026-06-24 · **Deciders:** Brian Zalewski

§35 calls for OpenTelemetry. ProjectSites already has CF Workers Tracing (`[observability]`, zero-config OTLP I/O spans) + `lib/log.ts` (structured logs with `traceId`/`requestId`) + Sentry + PostHog + AI Gateway. Missing: an app-level vendor-neutral `Tracer.startSpan(...)` + export of custom business spans (funnel steps, generation phases) to an OTLP backend. The full `@opentelemetry/*` SDK is heavy + Node-oriented + duplicates Workers Tracing's context.

**Decision:** A thin in-house **OTel-shaped span port**, no SDK:

- `platform/tracing.ts` — `Tracer` / `Span` / `TracerProvider` interfaces + `RecordingSpan` + `NoopTracerProvider` (zero-overhead default) + `FakeTracerProvider`.
- `middleware/tracing.ts` — `OtlpTracerProvider`: a fetch-based **OTLP/HTTP JSON** exporter (`buildOtlpPayload` → `resourceSpans/scopeSpans/spans`) + Zod-validated config + `getTracerProvider(env)`.

Spans complement (never replace) Workers Tracing; flush in `ctx.waitUntil(provider.flush())`.

**Consequences:** standard span API + OTLP export to any backend, zero new deps, Workers-native (pure fetch), backend swappable via one env var. Ships **dark** — no `OTEL_EXPORTER_OTLP_ENDPOINT` → `NoopTracerProvider` (inert, zero overhead); export fail-soft. Not the OTel SDK (no auto-instrumentation / W3C `traceparent` propagation — manual threading; acceptable, Workers Tracing auto-instruments I/O). Scaffolded until wired into hot handlers.

---

## 0046 — Homegrown OAuth connection layer (Nango deferred)

- **Status:** accepted · **Date:** 2026-06-24 · **Deciders:** Brian Zalewski

§46 calls for Nango. ProjectSites already owns two Worker-native OAuth connection layers doing the full authorize → callback → token-exchange → encrypted-storage → refresh lifecycle: `routes/mcp_oauth.ts` (per-site MCP connections, `mcp_connections`, paste-key fallback when `{PROVIDER}_OAUTH_CLIENT_ID` is absent) + `routes/social_oauth.ts` (social OAuth, paste-key fallback for Bluesky/Mastodon/Telegram/Discord) + `mcp_pkce.ts` + AES-GCM token encryption.

**Decision:** **Defer Nango.** Keep the homegrown layer as source of truth. Do NOT build a port now — unlike the flag/api-key/tracing cases there is no single clean call-site contract to wrap (these are full Hono route groups with provider-specific adapters + encryption + paste-key fallbacks). If a future need arises, introduce a managed-Nango adapter behind a new `OAuthConnectionProvider` port gated on `NANGO_SECRET_KEY`.

**Consequences:** zero new deps, no container, tokens stay AES-GCM-encrypted in our D1, paste-key fallback preserved. We maintain provider adapters ourselves (accepted — small stable set). Registry entry `oauth-nango` records deprecated-of-vendor / homegrown-live so the fitness scan doesn't flag §46 as missing.

---

## 0047 — Stainless SDK-codegen over the OpenAPI 3.1 spec

- **Status:** accepted · **Date:** 2026-06-24 · **Deciders:** Brian Zalewski

§47 (Stainless, typed client-SDK generation from OpenAPI) is the one targeted item with **no homegrown equivalent** — ProjectSites ships no client SDK today, but `routes/docs.ts` already serves an **OpenAPI 3.1** doc at `GET /api/admin/docs/openapi.json`.

**Decision:** A foundation-first **SDK-codegen port**:

- `platform/sdk-codegen.ts` — `SdkCodegenProvider` (`generate(spec)` → `SdkGenerationResult{status,project?,message?}`) + Zod `SdkCodegenConfigSchema` + `NoopSdkCodegenProvider` (dark default) + `FakeSdkCodegenProvider`.
- `middleware/sdk-codegen.ts` — `StainlessSdkCodegenProvider` (fetch-based POST of the spec, no SDK) + `getSdkCodegenProvider(env)`.
- `types/env.ts` — `STAINLESS_API_KEY` + `STAINLESS_PROJECT`.

Spec source is the existing `/api/admin/docs/openapi.json` — no second spec.

**Consequences:** real tested foundation feeding the existing spec; zero new deps; fetch-based. Ships **dark** — no `STAINLESS_API_KEY` → `NoopSdkCodegenProvider` (resolves `skipped`); fail-soft. The exact Stainless API path (`/api/spec`) + auth header shape are provisional until a key is provisioned — adapter is `scaffolded` until then. Not wired into CI yet (a `gen:sdk` step to add once the key exists).

---

## 0053 — Homegrown crawl + discovery (Deepcrawl deferred)

- **Status:** accepted · **Date:** 2026-06-24 · **Deciders:** Brian Zalewski

§53 calls for Deepcrawl (managed crawl / technical-SEO SaaS). ProjectSites already owns Worker-native crawl: `services/import_crawler.ts` (`crawlSiteForImport()` → typed `CrawlReport`/`InventoryUrl[]`, real UA per `fetch-defaults`, robots/sitemap/Wayback inventory, `estimateRebuildMinutes`) + image discovery + CF Browser Rendering (the `browser-gateway` service, `production` in the registry) for JS-rendered crawl/screenshots/extraction.

**Decision:** **Defer Deepcrawl.** Keep `import_crawler.ts` + image-discovery + CF Browser Rendering as the crawl/discovery layer. Do NOT build a port now — like ADR-0046, no single clean call-site contract (the crawler is a domain-specific import function, not a generic seam; Browser Rendering is already a registered CF-first service). If recurring large-scale technical-SEO auditing becomes a product feature, add a managed-Deepcrawl adapter behind a `CrawlAuditProvider` port gated on `DEEPCRAWL_API_KEY`.

**Consequences:** zero new deps, CF-first, real-UA fetch crawl already battle-tested in the import pipeline. No managed recurring-SEO-audit dashboard (accepted — not a current need; our crawl is import-scoped). Registry entry `crawl-deepcrawl` records the deviation so the fitness scan doesn't flag §53.

---

## ADR-0054 — Search engines (Orama/Typesense) + UI libraries (Floating UI / Sonner / Embla)

- **Status:** Accepted · **Date:** 2026-06-25 (Brian directive) · **Deciders:** Brian Zalewski · **Series:** convergence

Child sites, the AI concierge, and platform admin need search; the Angular admin + React generated-site template need shared tooltip/toast/carousel primitives. Free/zero-infra default with a paid escalation, CF-first hosting.

**Decision:**

**Search — tiered** (Orama base/free, Typesense advanced/paid on Fly.io):

| Surface / tier | Engine |
|---|---|
| Default child-site search (`{slug}.projectsites.dev`) | **Orama** — zero infra, on-device |
| Advanced paid search add-on (per child site) | **Typesense** (Fly.io) |
| ProjectSites.dev internal / global search (admin + platform) | **Typesense** (Fly.io) |
| AI concierge — base | **Orama + CF-native AI/RAG** (Workers AI + Vectorize/AutoRAG) |
| AI concierge — advanced | **Typesense** (hybrid) OR a dedicated vector layer |

- **Orama** (`@orama/orama` + `@orama/plugin-data-persistence`): build pipeline emits `public/search-index.json` per generated site from `_scraped_content.json.routes[]`; the React template's `<SiteSearch>` (Cmd+K) lazy-loads + restores the persisted index, searches on-device. Base AI concierge feeds CF-native RAG (`src/services/rag.ts`).
- **Typesense** (Fly.io stateful-VM escape hatch, persistent volume): `src/services/search_typesense.ts` indexes with the admin key server-side; mints scoped search-only keys for the frontend. Collections: `sites`, `docs`, `admin_entities` + per paid-child-site collections. Admin/global UI call a `/api/search?q=` proxy, never the admin key. Add-on is flag/entitlement-gated. Secrets: `TYPESENSE_HOST`, `TYPESENSE_ADMIN_API_KEY`, `TYPESENSE_SEARCH_ONLY_API_KEY`.

**UI libraries:**

| Lib | Angular admin (`frontend/`) | React generated sites (template repo) |
|---|---|---|
| Floating UI (default tooltip, virtual element) | `@floating-ui/dom` → `appTooltip` directive | `@floating-ui/react` |
| Sonner (toasts) | `ngx-sonner` / Spartan `hlm-sonner` | `sonner` |
| Embla (carousel) | `embla-carousel-angular` | `embla-carousel-react` |

**Consequences:** most child sites pay zero search infra (Orama on-device); paid tier + platform-global search escalate to one shared Typesense host. Adds Fly.io as the Typesense host (one more stateful-VM escape hatch under CF-first).

**Install homes:** Angular admin `frontend/package.json`: `@floating-ui/dom`, `embla-carousel-angular`, `ngx-sonner`. Worker `apps/project-sites/package.json`: `typesense`. React template repo: `@orama/orama`, `@orama/plugin-data-persistence`, `sonner`, `embla-carousel-react`, `@floating-ui/react`.

⚠️ `npm install` uses `--legacy-peer-deps`; never symlink+install in a worktree (corrupts main).

---

## ADR-0055 — Code Functions on Workers-for-Platforms (AI Agents section removed)

- **Status:** Accepted · **Date:** 2026-08-28 (Brian directive) · **Deciders:** Brian Zalewski · **Series:** convergence

The UI-authored "AI Agents" admin section (`/admin/ai-endpoints`, D1 `ai_endpoints`, `routes/ai_endpoints_public.ts` dispatcher, `libs/features/ai_endpoints/`) let owners define AI-backed API endpoints via a dashboard form. Brian's directive: owners should define endpoints **in their site code** instead.

**Decision:** Remove "AI Agents"; replace with code-defined **Functions** — a `functions/` folder in the site (Pages-Functions-style file-based routing, JS/TS, npm allowed) bundled + hosted on **Cloudflare Workers for Platforms** (`USER_DISPATCH` namespace), dispatched at `{slug}.projectsites.dev/api/*` (platform reserves `/api/contact-form` + `/api/_ps/*`). Paid-plan entitlement-gated; bindings `env.AI`/`env.DATA`/`env.KV`/`env.R2`/`env.SECRETS`; deploy on Publish; preview at `/api/test-publish`; versioned via snapshots; logs → Traces. **Full spec:** `apps/project-sites/docs/decisions/0035-custom-code-endpoints-wfp.md` (folder ADR — referenced here BY PATH; the folder-ADR "0035" is a SEPARATE artifact from this file's OTel-0035, per the dual-series note at the top). **Convergence ledger:** `apps/project-sites/docs/FUNCTIONS-CONVERGENCE.md`.

**Consequences:** endpoint authoring moves from a dashboard CRUD form to the in-editor `functions/` folder (more powerful — real code + npm deps — but requires code). WfP plumbing (`services/wfp_dispatch.ts` + `ai_endpoints_ide.test.ts`) is KEPT — reused by the Functions build (Stages 1-4). Removal shipped: Stage 0.1 frontend (`fb522f12`) + 0.2 backend (`1c87f17c`), both deployed + prod-verified; `DROP TABLE ai_endpoints` (Stage 0.3) is approval-gated test-data-only cleanup (6 test rows, 0 real customers). `token_burn_meter` flag KEPT (not ai-endpoints-specific).

---

## ADR-0056 — External dual-frontier research is billing-blocked; Workers AI is the meanwhile rung (WLK-39)

- **Status:** Accepted · **Date:** 2026-10-06 (Brian directive) · **Deciders:** Brian Zalewski · **Series:** convergence

The WLK-39 "Claude Code" editor panel and the Resolution Engine (`POST /api/resolve`) depend on the external frontier vendors (OpenAI + Anthropic). **Those accounts are currently credit-exhausted** — confirmed live: `POST /api/resolve` → `502 ALL_PROVIDERS_FAILED` with the Anthropic body *"Your credit balance is too low to access the Anthropic API"* (2026-10). A credit/quota error is a NEW terminal failure the fire-186 gateway-fallback ladder (gateway→direct-vendor on gateway-origin 401/403 + 5xx) did not yet handle — so AI surfaces died with a 502 instead of degrading.

**Decision:** When an external provider (openai/anthropic/deepseek) call fails with a **credit-balance / quota / insufficient-funds** error, fall back to the existing **Cloudflare `workers-ai` provider** (`env.AI` + Llama `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, free, CF-native) instead of returning a 502. This is a NEW rung on the SAME ladder: `gateway → direct vendor → (on credit/quota) Workers AI`.

- **Detection:** `isCreditQuotaError()` (`src/services/external_llm.ts`) matches the vendor-agnostic billing phrases (Anthropic "credit balance is too low", OpenAI `insufficient_quota`, DeepSeek `insufficient balance`, HTTP 402) over the thrown vendor error. A plain bad-key/validation 4xx is **NOT** credit/quota and keeps surfacing verbatim (same discipline as the edge-router 4xx-forwarding rule).
- **Rung:** `callExternalLLM` self-heals through `workersAiFallback()` (reusing the observed `lib/workers_ai.runObservedWorkersAI` seam) and returns a result with `provider:'workers-ai'` + `degraded:true`. Reachable by BOTH the editor-chat path (model_registry `/v1/chat/completions` + `/v1/messages` → `callExternalLLM`) AND the resolution path.
- **Resolution degrades HONESTLY (never 502):** when BOTH research legs are credit-exhausted, `/api/resolve` returns **200** with `degraded:true` + the note *"Using Cloudflare Workers AI — dual-frontier research (OpenAI + Anthropic) needs external credits"* and ONE Workers-AI research+answer pass. It does **NOT** fake dual-provider independence (no two identical Workers-AI legs dressed up as "independent"); a single flagged pass is the honest shape. A non-billing both-down failure still 502s.
- **Additive + self-healing:** default behavior is unchanged when the externals have credits; the rung stops firing automatically the moment the accounts are funded. Invariant #7 (true dual-provider independence) semantics are preserved for when the externals ARE funded.

**Reconsider when:** the OpenAI + Anthropic accounts are funded — at that point the external dual-frontier research path resumes automatically (the Workers-AI rung goes dormant) and no code change is needed. Re-evaluate whether to keep Workers AI as a permanent last-resort rung or gate it behind a flag.

**Consequences:** AI surfaces stay usable (real answers, free) while the external accounts are dry, at reduced quality — flagged `degraded:true` so the UI can tell the user. TDD: `src/__tests__/external_llm.test.ts` (credit/quota → workers-ai fallback; plain 4xx still surfaces) + `libs/features/resolution_engine/__tests__/resolve_route.test.ts` (both-externals-exhausted → 200 degraded, non-billing → honest 502). No new flag, no migration. Negative-knowledge: do not re-wire the external dual-frontier path as "broken" — it's billing-blocked, not defective.

**See also:** ADR-0057 — the INTERNAL agent-orchestration layer no longer needs funded external API keys at all (subscription CLIs + DeepSeek); this ADR's Workers-AI degradation remains the PRODUCT Resolution path's honest fallback.

## ADR-0057 — Internal agent orchestration: subscription CLIs + DeepSeek-via-OpenCode, never API keys

- **Status:** Accepted · **Date:** 2026-10-06 (Brian directive) · **Deciders:** Brian Zalewski · **Series:** convergence

Our INTERNAL development / research / agent-orchestration layer (the `/run-the-loop` agents, build tooling, self-improvement, reviews) must stop spending OpenAI/Anthropic **API** money when subscription CLIs or DeepSeek can do the work. This is a hard provider policy, distinct from customer-facing product features.

**Decision — two tiers, both off API keys:**
- **Frontier (architecture · research · judgment):** `claude` CLI (Claude subscription) = architect/integrator/final judge; `codex` CLI (ChatGPT subscription) = independent researcher/adversarial reviewer. Run both independently; Claude synthesizes. **Codex unauthed is NOT fatal** → Claude does an extra independent pass.
- **Throughput (routine implementation):** OpenCode + DeepSeek (API allowed via `get-secret DEEPSEEK_API_KEY`) — parallel shards, tests, refactors, migrations, docs, candidates; swarm when parallelizable.

**Hard rules (internal only):** never `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`; never the Responses/ChatCompletions/Messages API or SDK to make a model research/plan/review/code/expand when the CLI can; never silently fall back subscription→PAYG; never mint a key or touch CLI OAuth creds. Child `claude` must not inherit `ANTHROPIC_API_KEY`; child `codex` must not inherit `OPENAI_API_KEY` — launch via `with-subscription-cli.sh`.

**Canonical SSOT:** `~/.agentskills/rules/agent-provider-policy.md` (`heymegabyte/agent-skills@3b8c77c`). Enforcement tooling: `bin/provider-capability.sh` (capability/env-leak detector), `bin/with-subscription-cli.sh` (env-sanitizing launcher), `bin/check-required-keys.sh` (DeepSeek required; Anthropic/OpenAI env-presence = warning). `rules/model-routing.md` now points at the SSOT and the `ANTHROPIC_API_KEY` passive-fallback blessing is removed.

**Product boundary (PRESERVED):** customer-facing OpenAI/Anthropic features — the WLK-39 Resolution Engine (`/api/resolve`), model-registry `/v1/*`, editor chat router, voice/social/media owner AI, AI-Gateway + telemetry — stay, billed to the platform. ADR-0056's Workers-AI degradation remains the Resolution path's honest fallback.

**Supersedes:** the "defer internal dual-frontier research to credit top-up" disposition implied by ADR-0056 — internal frontier research is AVAILABLE NOW via `claude`+`codex` subscriptions (Codex ChatGPT-authed, confirmed live), no API funding needed.

**Live capability (2026-10-06, `provider-capability.sh`):** `claude` 2.1.197 ✓ · `codex` 0.144.3 ChatGPT-authed ✓ · `DEEPSEEK_API_KEY` present ✓ · no API-key env leak ✓ · `policy_ok=true`. Gap: `opencode` NOT installed (throughput tier unwired — tracked).

**Remaining campaign (subsequent fires):** install+wire OpenCode (throughput tier); migrate category-A code call sites (`scripts/container-server.mjs` build-agent Anthropic fallback, `bin/lint-auto-improve.sh --auto-draft`'s `api.anthropic.com` call, `src/services/retrospective.ts` Haiku, build visual-QA GPT-4o in `scripts/inspect.js` / `container/asset-collector.mjs` / `frontend/scripts/visual-inspection.mjs`, `.github/workflows/run-the-loop.yml` action, `infra/litellm` + `infra/payload`); insert hard-rule pointers into `CLAUDE.md` + `AGENTS.md`; reword category-C docs; remove dead `openai-mcp`. Phase 1 audit + Phase 2–4 artifacts landed this fire.
