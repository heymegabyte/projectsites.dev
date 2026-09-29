# 0056 — Voice runtime: LiveKit → Cloudflare-native

**Status:** Accepted (2026-09-29) · **Supersedes** the LiveKit Cloud transport/agent-hosting decision in `voice-architecture.md` (2026-06-27 amendment) and its LiveKit-Cloud pricing model.

## Context

- The voice receptionist (`voice-architecture.md`) has churned transports: Twilio Media Streams → Fly.io bridge → **LiveKit Cloud** (SIP ingress + LiveKit-Cloud agent hosting). Each pivot added a new **off-platform** vendor to the call path.
- LiveKit Cloud is a second always-on runtime + a per-minute + agent-hosting bill, sitting OUTSIDE Cloudflare. This violates the project North Star (`cloudflare-first.md`, memory `projectsites-cf-passthrough-vendor-model`): the hot path should terminate on CF primitives, and off-CF vendors are escape hatches, not defaults.
- Cloudflare now ships the pieces to run real-time voice natively: **CF Realtime** (WebRTC SFU/TURN, formerly Calls), **Workers + Durable Objects** for the persistent agent/turn state, **Workers AI + AI Gateway** for the LLM brain, and **R2/D1** for recordings + transcripts. Twilio Elastic SIP can terminate into a CF-hosted media endpoint instead of LiveKit SIP.
- `voice_receptionist` was named in the prior ADR but never shipped as a gate; it is now registered (default-OFF, experimental) so the CF-native build lands dark.

## Decision

**Move the voice receptionist off LiveKit to a Cloudflare-native runtime.** The persona/STT/LLM/TTS *choices* carry forward unchanged (Deepgram Flux STT, gpt-4o-mini brain, Piper TTS bundled in the image); only the **transport + agent hosting** change.

- **Media plane:** Twilio number → Twilio Elastic SIP → **CF Realtime** (WebRTC/TURN) room, replacing LiveKit Cloud SIP ingress.
- **Agent runtime:** a **Durable Object** (per-call, persistent for the call's lifetime) drives the turn loop (VAD → Deepgram Flux STT → gpt-4o-mini via AI Gateway → Piper TTS), replacing the LiveKit-Cloud-hosted `@livekit/agents` process. DO hibernation is scoped to the call, not idle-across-calls, so there is no dispatch-race.
- **Lifecycle:** on call end, the DO writes recording (R2) + transcript (D1) → admin **Conversations**. The existing signed lifecycle-webhook receiver is repointed from LiveKit events to the CF-native runtime's own callback (kept signed + idempotent).
- **Pricing model:** superseded — cost is now CF Realtime + Workers/DO + Workers-AI-metered, billed to our CF account (unified billing per `super-admin-credits-cloudflare-unified-billing-only`), NOT LiveKit-Cloud per-minute + agent hosting.
- **Gate:** the whole receptionist ships behind `voice_receptionist` (default-OFF, experimental) — 404 dark until verified.
- **Decommission:** tear down the LiveKit Cloud project + the `infra/voice-agent/` LiveKit agent; the Fly `voice/` bridge is already slated for teardown.

## Consequences

- **CF-native hot path** — voice terminates on Cloudflare, aligning with the passthrough-vendor North Star; one fewer off-platform vendor + one fewer per-minute bill.
- **One-way-ish door** — building the DO turn loop + CF Realtime SIP integration is real work; reversal means re-standing LiveKit. Mitigated: STT/LLM/TTS choices are portable (env-switchable), so only the transport is coupled.
- **New risk surface** — CF Realtime SIP + DO real-time media is less turnkey than LiveKit's batteries-included VAD/turn-detection/barge-in; those must be built in the DO loop. Latency + barge-in are the verification gates (target: first persona audio ≤1.2s, caller speech interrupts TTS).
- **Provisioning** — Twilio number stays; its SIP/webhook is repointed to the CF media endpoint. No carrier change.

## Alternatives considered

- **Stay on LiveKit Cloud** — turnkey (VAD/turn/barge-in/noise-cancel out of the box) but a permanent off-CF vendor + per-minute + agent-hosting cost; rejected against the CF-first North Star.
- **Twilio ConversationRelay / native voice AI** — locks STT/TTS/LLM into Twilio's per-minute stack, defeats the self-host-for-cost intent; rejected (same reason as the original ADR).
- **Fly.io bridge (the pre-LiveKit design)** — hand-rolled turn-taking/barge-in/reconnection is exactly what a production receptionist must NOT reinvent, and Fly is off-CF; rejected.

## Cross-refs

`voice-architecture.md` (superseded transport) · `docs/architecture/cloudflare-first.md` · flag `voice_receptionist` (registry + docs) · voice tables `0036b_voice.sql` · `[[deepseek-provider-tiers]]` (brain cost lever) · `[[secret-provisioning-recipe]]`.
