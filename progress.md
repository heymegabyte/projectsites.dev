# CHECKPOINT — Nebula Waiting Experience (editor loading), revs 2–14

**Rev 1 SHIPPED + LIVE** (commit `5fa7023c5`, editor Pages `803c92dc`, editor 200):
- `app/components/chat/NebulaLoader.tsx` — zero-dep raw-WebGL nebula (domain-warped fbm,
  purple/cyan/pink palette, star field, faint heart knots, bloom, vignette; rAF +
  visibility-pause + adaptive DPR + pointer attraction + `u_prog` luminosity;
  reduced-motion = one calm frame; graceful no-WebGL return).
- `app/components/chat/EditorLoadingVisual.tsx` — nebula backdrop + TINY foreground (one
  spinner + rotating 2–5 word status + optional hairline bar); role=status; CSS-orb fallback.
- `app/styles/index.scss` — `ps-nebula-*` + `ps-editor-loader--nebula` (reduced-motion freezes).

**WHY CHECKPOINT (not thrash):** rev 1 built from near-full context (~186k/200k). Revs 2–14 are
visual render-inspect polish — each needs a REAL screenshot+critique cycle (CF Browser Run; the
deep-ui-explorer proved the authed editor embed boots there), run in a FRESH MAIN session (NOT a
background agent — Brian's standing correction). Apply the 7 self-critique questions per pass.

## Revs 2–14 ladder (each: edit → render via CF Browser Run → vision-critique → keep better)
2. Richer fbm (6→7 octaves + 2nd warp); keep 60fps at mobile DPR cap.
3. Hot-pink "love explosion": brighten heart-knot bloom + slow radial center pulse (energy, not emoji).
4. Plasma wisps: curl-ish flow-field advection so strands drift.
5. Star depth: 2–3 parallax layers + per-star twinkle; adaptive density.
6. Pointer attraction inertia (lerp u_ptr toward cursor).
7. progress→nebula: luminosity + palette shift to cyan as progress→1; wire real build/deploy progress into the prop.
8. Completion pulse: on `leaving`, cyan/pink burst + nebula expands/dissolves INTO the editor.
9. Messages on REAL op-state (Creating/Generating/Deploying/…); add blur-out to the crossfade.
10. Foreground shrink pass (7 questions; bias to LESS chrome — maybe drop the pill bg).
11. Perf: adaptive octave/particle count by measured frame time; dynamic resolution scaling.
12. WebGPU enhancement path (feature-detect, fall back to WebGL) only if it adds real richness.
13. A11y: reduced-motion still gorgeous (rich static frame); AA contrast on message over brightest nebula.
14. "Unmistakably this product": lock to brand tokens (#060610/#00e5ff/#7c3aed + hot pink); final vision ≥9/10.

## Reuse (prompt's broader intent)
Polished → extract a shared `<NebulaWaiting progress message/>` and adopt app-wide for
generation/deploy/AI-thinking/navigation waits (not just the editor). Add as a backlog item.

## Resume
Fresh session: read this + `NebulaLoader.tsx`, open the editor loading state via CF Browser Run,
screenshot, grind 2→14 with vision critique. Deploy: `npm run build` → `wrangler pages deploy
build/client --project-name=bolt-diy --branch=main` → verify editor 200.
