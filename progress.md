# CHECKPOINT — Nebula Waiting Experience (continuing toward "50 loops", app-wide)

**SHIPPED + LIVE (editor loading):**
- Rev 1 `5fa7023c5` — zero-dep WebGL nebula replacing the CSS orb.
- Rev 2 `93ddfe3ed` — HBO-grade cinematic batch (folds ~10 loops): 7-octave double domain-warp
  fbm · ACES filmic tonemap + gamma · film grain · per-channel chromatic edge-bleed · breathing
  hot-pink love-explosion core · two parallax twinkling star layers · u_burst completion flash
  (ramps on `leaving`, dissolves into editor) · fuller catchy message set. Deployed editor Pages
  `801bcb78`; live bundle `EditorLoadingVisual-*.js` carries `u_burst` (verified).

**DOCTRINE (the "make all instructions embody this" ask) — DONE:**
- Global rule `~/.claude/plugins/heymegabyte-claude-skills/rules/nebula-waiting-experience.md`
  (`159f19d`, registered in `_packs/design.yml`): cinematic HBO-grade nebula is THE loading
  standard for EVERY waiting/generating/deploying/AI-thinking/navigating state everywhere;
  one shared primitive; perf + reduced-motion non-negotiables; the 7-question iteration doctrine.

## Continuing loops (fresh render-inspect session via CF Browser Run — vision ≥9/10 each)
Shader/UI polish on `app/components/chat/NebulaLoader.tsx` + `EditorLoadingVisual.tsx`:
- flow-field (curl) wisp advection so strands drift, not scroll
- pointer inertia (lerp u_ptr) + touch + device-orientation parallax
- progress→palette shift (violet→cyan as progress→1) + progress-reactive core intensity
- message blur-OUT on change (have blur-in); op-state-driven copy wired from the real loader controller
- adaptive octave/particle count by measured frame time; dynamic resolution (0.75x when budget blown)
- foreground shrink pass (drop the pill bg if nebula contrast suffices; smaller spinner)
- WebGPU enhancement path (feature-detect, WebGL fallback)
- a11y: AA message contrast over brightest nebula; richer reduced-motion static frame

## APPLY EVERYWHERE (the other half of the ask — adopt the shared primitive)
Extract `<NebulaWaiting progress message burst/>` from NebulaLoader and adopt on:
- site generation / build-stream loader · deploy state · AI thinking/streaming · route navigation
  (>400ms) · publish · long workflows. Each: replace its one-off spinner, verify 200 + reduced-motion.
Add a BACKLOG item for the extraction + per-surface adoption.

## Resume
Fresh session: read this + `NebulaLoader.tsx` + the global rule; open each loading surface via CF
Browser Run; screenshot → vision-critique → push further (never tether). Deploy editor:
`npm run build` → `wrangler pages deploy build/client --project-name=bolt-diy --branch=main` → 200.
