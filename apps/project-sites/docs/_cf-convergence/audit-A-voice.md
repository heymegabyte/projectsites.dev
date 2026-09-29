# Audit A — Voice + all-call media (fire-1, 2026-09-28)

Read-only audit, Workstream A. Cited `file:line` under `apps/project-sites/`.

## Top gaps

1. **No recording (audio OR video) for any live LiveKit call.** Egress events logged, never
   persisted to R2 (`livekit_webhooks.ts:26-28,155`). Video never produced. Kills A3/A4/A6.
2. **Test Console token broken + wrong stack.** FE reads `r.data.token`; route returns top-level
   `{token,…}` (`voice.ts:1028` vs `test-console.ts:386`) → every test call fails. Uses Twilio-Client
   dial, NOT the default AI chat (A2).
3. **`voice_calls` row created only at call END** (`voice_transcript.ts:59`) — abandoned/failed calls
   leave zero record (breaks A3 "every-call session").
4. **206 route exists but bypassed** — FE `getBlob` buffers whole file (`conversations.ts:586`,
   `api.service.ts:211`); no range GETs/seek (A7).
5. **Voice consent spoken-only + unenforced** — `recording_opt_out` never read on the call path; SMS
   STOP is the only honored opt-out (A9).

## First slices (RED-testable, ≤15min)

1. Fix Test Console token shape → `{data:{token,identity,primary_number}}` in `voice.ts`. RED: assert
   `res.data.token` defined.
2. Create `voice_calls` row on LiveKit `room_started` in `livekit_webhooks.ts`. RED: post room_started
   → row exists status=in-progress.
3. Bind conversations `<audio>/<video src>` to `/recordings/:id/stream`. RED: playback issues 206.

## Blocks safe parallel work

- `routes/voice.ts` (1076 ln — every endpoint) and `conversations.component.ts` (29K, list+detail+media)
  — split by resource or serialize. `services/voice_agent.ts` shared with SMS — run full suite on edit.

## Architectural note

LiveKit currently OWNS the audio → worker-side dual-channel (A5) + CDP capture (A4) require
LiveKit-egress wiring, not a worker recording. This is the LiveKit vs CF-native conflict → **ADR 0056**
must decide. Flag `voice_receptionist` named in the ADR but never shipped; only the `pro` tier gates
the Voice section (no per-feature killswitch).
