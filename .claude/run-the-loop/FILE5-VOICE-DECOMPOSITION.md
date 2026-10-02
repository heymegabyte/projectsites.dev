# FILE 5 — CF-Native Voice Master Prompt · Compact Decomposition

> Full-fidelity drain of FILE 5 (archived: `downloads-intake-archive/ProjectSites-Cloudflare-native-master-prompt.md`).
> ~50 slices total; this is the compact parent — drain ONE slice per fire per `split-work-into-ledger`.

**Parent directive:** PENDING-DIRECTIVES §DIRECTIVE 2 (REALTIME-VOICE-DIRECTIVE) — not yet persisted verbatim.
**Absorbed:** fire-82 (BACKLOG § fire-82 replenish FILE-5 epic).
**Shape:** 5 workstreams · ~50 slices · 15-17 fires. Each workstream = feature-module + default-OFF flag (`enabled=0, rollout=0, stage='experimental'`) + Zod at every boundary + unit + E2E.
**Acceptance pattern (every slice):** a REAL user journey proven on PROD — homepage-start, navigate by UI, assert live state + store reconcile + 0 console errors. NEVER a mocked render. A slice is done only when its journey is GREEN against the live URL per `verification-loop`.

CF-native first (`cloudflare-lock-in-is-leverage`): Workers + Hono + D1 + R2 + KV + Durable Objects + Workflows + Browser Rendering; Twilio for PSTN voice/SMS; Stripe for paid provisioning; SES for email. Voice TTS = Piper (self-hosted) per doctrine.

---

## Workstream A — Voice / all-call media

Owner surface: `/admin/voice` (Angular) + worker `routes/voice*` + `src/services/twilio.ts` (VOICE kept; SMS-OTP auth removed, VOICE is not).

Representative slices (~10):
- **A1 Voice-tab UI consolidation** — retain the existing 7 tabs (Numbers, Conversations, Agent config, Test Console, MCPs, Share, …) + ADD **Recording** + **Reviews** tabs. One `DialogShellComponent`-consistent shell; no parallel editor. *(first-fire candidate)*
- **A2 Interactive Test Console** — place a real test call / simulate a turn from the browser; live transcript streams back (SSE/WebSocket from a DO), 0 console errors.
- **A3 Per-call browser session + timeline** — each call opens a Browser Rendering session; a synchronized call-detail timeline (audio + transcript + events) replays per call.
- **A4 Twilio dual-channel WAV → R2** — capture both legs as dual-channel WAV, store at `calls/{callId}/audio.wav` in R2 (versioned), linked from the call detail.
- **A5 Consent / disclosure gate** — a recording-consent + disclosure step enforced before any capture; stored consent record; honest UI copy.
- Also: rrweb DOM capture per call · synchronized audio∥video∥terminal∥browser-event playback · Agent-config editor (prompt + tools, Zod-validated) · Numbers list live-updating (no manual refresh) · Reviews moderation workflow fields.

Acceptance (A1 example): homepage → sign in → `/admin/voice` → all 7 prior tabs present + Recording + Reviews reachable, each renders real state, axe-clean @6bp, 0 console errors; prod-verified.

---

## Workstream B — Twilio / SMS / Stripe

Owner surface: worker `routes/voice*` + billing routes + D1 call ledger.

Representative slices (~10):
- **B1 Number search + quote** — search available Twilio numbers by area code; show a TRUTHFUL price quote (real Twilio pricing, not a guess).
- **B2 Stripe checkout → Twilio purchase (idempotent)** — real quote → Stripe payment → number activation; idempotency-keyed so a retried webhook never double-buys. (approval-required tier: charging money — gate per `autonomous-engineering`.)
- **B3 Pricing page truthful matrix** — a pricing surface whose per-minute / per-SMS / per-number matrix matches the real cost table; no inflated or stubbed figures.
- **B4 D1 call ledger + Stripe metering** — every call/SMS writes a durable D1 ledger row; usage meters into Stripe (seat/usage) for billing reconciliation.
- **B5 SMS state machine** — inbound/outbound SMS as a typed state machine (queued→sent→delivered→failed), Zod payloads, idempotent transitions.

Acceptance (B2 example): homepage → sign in → Voice → Numbers → search → pick → Stripe checkout (test card in E2E only) → number shows ACTIVE + a D1 ledger row exists (store reconcile) + a replayed webhook does NOT double-charge; prod-verified.

---

## Workstream C — Editor / Claude-Code / Sandbox / browser

Owner surface: the bolt.diy editor (`app/`) + CF Container (Sandbox) + Browser Rendering Live View.

Representative slices (~10):
- **C1 Claude Code workspace launcher** — launch a Claude Code job against a site's workspace from the editor (one obvious action), job bound to a CF Container.
- **C2 Split terminal + Browser Run Live View** — the editor shows the job's terminal AND a live browser view side-by-side; both stream in real time.
- **C3 Timestamped terminal events → R2** — every terminal event is timestamped + persisted to R2 for replay; a later session replays the run.
- **C4 Git snapshot + versioned diff** — the job snapshots the repo pre/post; a versioned diff is viewable in the editor.
- **C5 Durable job checkpoints + resume** — the job checkpoints to a DO; a dropped connection resumes from the last checkpoint, never restarts.

Acceptance (C2 example): homepage → sign in → editor → launch a Claude Code job → terminal streams live AND Browser Run Live View renders the running preview → 0 console errors; a reload resumes the same job (store reconcile on the DO checkpoint); prod-verified.

---

## Workstream D — ProjectSites MCP broker

Owner surface: a versioned MCP endpoint (Streamable HTTP + OAuth 2.1) + per-site authorization (D1).

Representative slices (~8):
- **D1 Versioned MCP endpoint** — Streamable HTTP MCP server with OAuth 2.1 + Resource Indicators (RFC 8707); versioned path.
- **D2 Site × operation authorization matrix** — a D1 matrix of which site may invoke which operation; the broker enforces it.
- **D3 Per-site resource mapping** — each site's R2/D1/KV resources mapped to MCP resources, scoped so no site sees another's.
- **D4 Tool-invocation authorization (intersect)** — an invocation is allowed only at the INTERSECTION of (caller entitlement ∩ site grant ∩ operation matrix); deny → structured error.
- **D5 Transaction preview + human approval** — mutating tool calls render a preview + require explicit human approval before executing (no silent side effects).

Acceptance (D4 example): a real MCP client with a scoped OAuth token invokes a tool for site X → allowed only when all three grants intersect; an out-of-scope site/operation → structured 403-class error (store reconcile on the authorization matrix); proven against the live MCP endpoint.

---

## Workstream E — CF-native surfaces

Owner surface: admin Catalog + sidebar surfaces, each a feature-module behind a flag.

Representative slices (~10):
- **E1 EmDash CMS in Catalog** — a CMS surface reachable from the Catalog, CF-native.
- **E2 Email sidebar via SES** — an email surface wired to Amazon SES (the sole send rail; no Resend).
- **E3 Dashboard health widget** — a service-health widget on the Dashboard (real status, auto-refresh, no manual reconcile button per `real-time-data-no-manual-refresh`).
- **E4 Automations React Flow canvas** — a visual automation/workflow canvas (React Flow) driving CF Workflows.
- **E5 Buckets Uppy + R2** — a Buckets surface: Uppy upload + R2 object listing/delete/versioning (overlaps FILE-1 GP-13 / WLK-10/11/16/17).
- Also: **Slink** short-links · **OpenSEO** checks + add-on (SEO audit surface).

Acceptance (E3 example): homepage → sign in → Dashboard → the health widget shows real service status, self-updates (no refresh button), reconciles vs the authoritative status source; axe-clean, 0 console errors; prod-verified.

---

## Drain discipline

- ONE slice per fire. Each slice: failing E2E/journey FIRST (RED) → implement → deploy → prod-verify (GREEN) → tick its BACKLOG line → append LEDGER.
- Money-touching slices (B2, B4 metering) are approval-required (charging money) — gate per `autonomous-engineering`; everything else is autonomous on reversible prod.
- Cross-links: `split-work-into-ledger` · `predictive-completeness` · `feature-module-architecture` · `feature-flags` · `verification-loop` · `real-time-data-no-manual-refresh` · `embarrassingly-easy-to-use`.
