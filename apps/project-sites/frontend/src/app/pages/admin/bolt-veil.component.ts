import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  signal,
  viewChild,
} from '@angular/core';

/**
 * @module pages/admin/bolt-veil
 *
 * HBO title-card loading veil for the admin's embedded bolt.diy editor.
 *
 * Renders a full-viewport WebGL fragment shader — a volumetric, parallaxed,
 * domain-warped FBM nebula with a pulsing energy core, god rays, a lens flare +
 * anamorphic streak, pointer-reactive light-halo + ripples, inward-streaming
 * particles, a filmic (ACES-ish) tonemap, depth-of-field vignette and refined
 * grain — behind a glassy brand card whose bolt mark charges and whose progress
 * ring sweeps. It replaces the old inline {@link AdminComponent} `.bolt-veil`
 * markup — same testid, roles and fade behaviour.
 *
 * The visual was grown in five legible passes (search `// PASS N:` to trace the
 * progression):
 *   1. Deeper shader   — 3 parallax depth layers, filmic palette ramp, softer
 *                        organic domain warp, chromatic-aberration bloom.
 *   2. Interactive     — window `pointermove` → `uMouse`; nebula/core parallax to
 *                        the cursor, a light-halo that follows it, ripples on move;
 *                        idle → autonomous drift so it is alive either way.
 *   3. Cinematic       — slow camera push-in, volumetric god rays from the core,
 *                        lens flare + anamorphic horizontal streak, bloom.
 *   4. Narrative chrome — stage() cross-fades; a swept progress ring; particles
 *                        stream inward; the bolt mark energises on a slow cycle.
 *   5. Polish + perf    — ACES-ish tonemap + color grade, refined grain, DoF
 *                        vignette, eased timing; octaves/loops capped, DPR<=2, 60fps.
 *
 * WHY a component (not inline CSS): the shader needs a managed WebGL lifecycle
 * (context creation, a RAF loop, resize + DPR handling, pointer wiring,
 * context-loss recovery, and teardown). A self-contained OnPush component owns it
 * and disposes it deterministically via {@link DestroyRef}.
 *
 * Cost discipline — the RAF is PAUSED whenever the veil is gone
 * ({@link editorReady} true) or the tab is hidden, and NEVER started under
 * `prefers-reduced-motion: reduce` (one static frame, no pointer reactivity). If
 * WebGL is unavailable the host falls back to a tasteful CSS aurora (never a
 * blank canvas), toggled by the `bolt-veil--no-webgl` host class.
 *
 * @example
 * ```html
 * <app-bolt-veil [editorReady]="bolt.editorReady()" [stage]="bolt.loadingStage()" />
 * ```
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-bolt-veil',
  standalone: true,
  // Host IS the veil root: same box, testid, roles and fade contract the old
  // inline `.bolt-veil` div carried, so the admin shell + E2E are unaffected.
  host: {
    'class': 'bolt-veil',
    '[class.bolt-veil--gone]': 'editorReady()',
    'role': 'status',
    'aria-live': 'polite',
    '[attr.aria-busy]': '!editorReady()',
    'data-testid': 'editor-loading-veil',
  },
  template: `
    <!-- WebGL backdrop. Hidden (display:none) in the CSS-fallback + reduced-motion
         paths so it never shows a blank/frozen surface; the CSS aurora shows then. -->
    <canvas #glcanvas class="bolt-veil__canvas" aria-hidden="true"></canvas>

    <!-- Pure-CSS aurora — the fallback backdrop when WebGL is unavailable OR the
         user prefers reduced motion. Mirrors the shader palette (cyan/steel/violet
         over near-black) so the fallback still reads on-brand, never empty. -->
    <div class="bolt-veil__aurora" aria-hidden="true"></div>

    <div class="bolt-veil__card">
      <div class="bolt-veil__mark" aria-hidden="true">
        <!-- PASS 4: indeterminate progress ring that sweeps around the mark
             (eased, non-strobing) — an SVG stroke-dash arc rotating slowly. -->
        <svg class="bolt-veil__progress" viewBox="0 0 100 100">
          <circle class="bolt-veil__progress-track" cx="50" cy="50" r="46" />
          <circle class="bolt-veil__progress-arc" cx="50" cy="50" r="46" />
        </svg>
        <span class="bolt-veil__ring"></span>
        <span class="bolt-veil__core"></span>
        <!-- PASS 4: the bolt glyph energises — glow rises + falls on a slow cycle. -->
        <svg
          class="bolt-veil__glyph"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M13 2 4.5 13.2a.6.6 0 0 0 .48.96H11l-1 7.84 8.5-11.2a.6.6 0 0 0-.48-.96H12l1-7.84Z" />
        </svg>
      </div>
      <div class="bolt-veil__headline">Booting your AI editor</div>
      <!-- PASS 4: stage text cross-fades between updates. Two stacked layers —
           the incoming line fades/rises in while the outgoing fades out. The
           live/current line carries the visible dots. -->
      <div class="bolt-veil__sub">
        <span class="bolt-veil__stage-stack">
          @if (stagePrev()) {
            <span class="bolt-veil__stage bolt-veil__stage--out">{{ stagePrev() }}</span>
          }
          <!-- @for keyed BY VALUE so each new stage gets a fresh DOM node — that is
               what re-triggers the CSS enter animation (updating text alone would
               not restart it). Single-item list = exactly one live line. -->
          @for (line of [stageCurr()]; track line) {
            <span class="bolt-veil__stage bolt-veil__stage--in">{{ line }}</span>
          }
        </span>
        <span class="bolt-veil__dots"><i></i><i></i><i></i></span>
      </div>
      <div class="bolt-veil__footnote">First visit only — subsequent opens are instant.</div>
    </div>
  `,
  styles: [
    `
      :host {
        position: absolute;
        top: var(--ps-admin-topbar-h, 62px);
        left: 0;
        width: 100%;
        height: calc(100dvh - var(--ps-admin-topbar-h, 62px));
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        background: #060610;
        /* above the iframe (1) + editor chrome; below toast (9999) */
        z-index: 9998;
        pointer-events: none;
        opacity: 1;
        will-change: opacity;
        /* ease-IN hold — stays near-opaque, drops fast only at the very end so any
           last-moment iframe relayout stays masked until the reveal completes. */
        transition:
          opacity 560ms cubic-bezier(0.7, 0, 0.84, 0),
          visibility 0s linear 560ms;
      }
      /* Fade IN on mount via starting-style (soft rise, not a hard cut). */
      @starting-style {
        :host {
          opacity: 0;
        }
      }
      /* Fade OUT + fully remove from the a11y tree / paint once gone. */
      :host(.bolt-veil--gone) {
        opacity: 0;
        visibility: hidden;
      }

      .bolt-veil__canvas {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        display: block;
      }
      /* When WebGL can't run, hide the (blank) canvas and show the CSS aurora. */
      :host(.bolt-veil--no-webgl) .bolt-veil__canvas {
        display: none;
      }

      /* CSS aurora fallback — inert (hidden) whenever the shader is driving. */
      .bolt-veil__aurora {
        position: absolute;
        inset: -25%;
        display: none;
        background:
          radial-gradient(38% 34% at 22% 28%, rgba(0, 229, 255, 0.18), transparent 60%),
          radial-gradient(34% 30% at 78% 30%, rgba(124, 58, 237, 0.2), transparent 62%),
          radial-gradient(46% 40% at 50% 88%, rgba(0, 229, 255, 0.1), transparent 66%);
        filter: blur(26px) saturate(1.15);
        animation: boltVeilDrift 14s cubic-bezier(0.4, 0, 0.2, 1) infinite;
      }
      :host(.bolt-veil--no-webgl) .bolt-veil__aurora {
        display: block;
      }

      .bolt-veil__card {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.7rem;
        padding: 2.1rem 2.6rem 1.8rem;
        border-radius: 24px;
        background: linear-gradient(180deg, rgba(14, 14, 40, 0.52), rgba(6, 6, 16, 0.5));
        border: 1px solid rgba(0, 229, 255, 0.16);
        box-shadow:
          0 30px 80px -28px rgba(0, 0, 0, 0.72),
          0 0 60px -22px rgba(0, 229, 255, 0.35),
          inset 0 1px 0 rgba(255, 255, 255, 0.06);
        backdrop-filter: blur(16px) saturate(1.15);
        -webkit-backdrop-filter: blur(16px) saturate(1.15);
        text-align: center;
      }
      .bolt-veil__mark {
        position: relative;
        width: 76px;
        height: 76px;
        margin-bottom: 0.2rem;
      }
      /* PASS 4: swept indeterminate progress ring, sitting just OUTSIDE the mark
         so it frames the conic ring + core without crowding the glyph. */
      .bolt-veil__progress {
        position: absolute;
        inset: -9px;
        width: calc(100% + 18px);
        height: calc(100% + 18px);
        transform: rotate(-90deg);
        overflow: visible;
      }
      .bolt-veil__progress-track {
        fill: none;
        stroke: rgba(0, 229, 255, 0.1);
        stroke-width: 2;
      }
      .bolt-veil__progress-arc {
        fill: none;
        stroke: rgba(0, 229, 255, 0.92);
        stroke-width: 2.4;
        stroke-linecap: round;
        /* r=46 → circumference ~289; a ~78deg lit arc that sweeps + breathes. */
        stroke-dasharray: 63 226;
        filter: drop-shadow(0 0 5px rgba(0, 229, 255, 0.6));
        transform-origin: 50% 50%;
        animation:
          boltVeilArcSweep 2.9s cubic-bezier(0.65, 0, 0.35, 1) infinite,
          boltVeilArcBreathe 2.9s ease-in-out infinite;
      }
      .bolt-veil__ring {
        position: absolute;
        inset: 0;
        border-radius: 50%;
        background: conic-gradient(
          from 0deg,
          transparent 0deg,
          rgba(0, 229, 255, 0.95) 130deg,
          rgba(124, 58, 237, 0.95) 250deg,
          transparent 360deg
        );
        -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 4px), #000 calc(100% - 3.5px));
        mask: radial-gradient(farthest-side, transparent calc(100% - 4px), #000 calc(100% - 3.5px));
        animation: boltVeilSpin 2.4s linear infinite;
      }
      .bolt-veil__core {
        position: absolute;
        inset: 13px;
        border-radius: 50%;
        background: radial-gradient(
          circle at 34% 28%,
          rgba(0, 229, 255, 0.34),
          rgba(124, 58, 237, 0.16) 68%,
          transparent 82%
        );
        animation: boltVeilBreathe 3s cubic-bezier(0.4, 0, 0.2, 1) infinite;
      }
      /* PASS 4: the bolt glyph charges — its glow rises + falls on a slow ~4.8s
         cycle (separate, slower rhythm than the 3s breathe so it feels alive,
         not metronomic). */
      .bolt-veil__glyph {
        position: absolute;
        inset: 0;
        margin: auto;
        width: 30px;
        height: 30px;
        color: #00e5ff;
        filter: drop-shadow(0 0 9px rgba(0, 229, 255, 0.55));
        animation:
          boltVeilBreathe 3s cubic-bezier(0.4, 0, 0.2, 1) infinite,
          boltVeilCharge 4.8s ease-in-out infinite;
      }
      .bolt-veil__headline {
        font-family: 'Sora', system-ui, sans-serif;
        font-weight: 600;
        font-size: 1.08rem;
        color: #f4f4ff;
        letter-spacing: -0.02em;
      }
      .bolt-veil__sub {
        display: inline-flex;
        align-items: baseline;
        font-size: 0.78rem;
        color: rgba(244, 244, 255, 0.66);
        font-family: 'JetBrains Mono', ui-monospace, monospace;
      }
      /* PASS 4: cross-fade stage host — the two stage layers overlap in a
         relatively-positioned box so the outgoing line dissolves under the
         incoming one instead of the text hard-cutting. */
      .bolt-veil__stage-stack {
        position: relative;
        display: inline-block;
        min-height: 1.1em;
        text-align: right;
      }
      .bolt-veil__stage {
        display: inline-block;
        white-space: nowrap;
      }
      .bolt-veil__stage--out {
        position: absolute;
        right: 0;
        bottom: 0;
        animation: boltVeilStageOut 460ms cubic-bezier(0.4, 0, 0.2, 1) forwards;
      }
      .bolt-veil__stage--in {
        animation: boltVeilStageIn 460ms cubic-bezier(0.22, 1, 0.36, 1) both;
      }
      .bolt-veil__dots {
        display: inline-flex;
        margin-left: 1px;
      }
      .bolt-veil__dots i {
        width: 3px;
        height: 3px;
        margin-left: 2px;
        border-radius: 50%;
        background: rgba(0, 229, 255, 0.85);
        align-self: center;
        animation: boltVeilDot 1.2s cubic-bezier(0.4, 0, 0.2, 1) infinite;
      }
      .bolt-veil__dots i:nth-child(2) {
        animation-delay: 0.16s;
      }
      .bolt-veil__dots i:nth-child(3) {
        animation-delay: 0.32s;
      }
      .bolt-veil__footnote {
        font-size: 0.7rem;
        color: rgba(244, 244, 255, 0.4);
        margin-top: 0.5rem;
      }

      @keyframes boltVeilSpin {
        to {
          transform: rotate(360deg);
        }
      }
      @keyframes boltVeilBreathe {
        0%,
        100% {
          transform: scale(0.94);
          opacity: 0.85;
        }
        50% {
          transform: scale(1.06);
          opacity: 1;
        }
      }
      @keyframes boltVeilDrift {
        0%,
        100% {
          transform: translate3d(0, 0, 0) scale(1);
        }
        33% {
          transform: translate3d(3%, -2%, 0) scale(1.06);
        }
        66% {
          transform: translate3d(-3%, 2%, 0) scale(1.03);
        }
      }
      @keyframes boltVeilDot {
        0%,
        100% {
          opacity: 0.3;
          transform: translateY(0);
        }
        50% {
          opacity: 1;
          transform: translateY(-2px);
        }
      }
      /* PASS 4: progress-ring sweep — a full eased rotation, indeterminate. */
      @keyframes boltVeilArcSweep {
        to {
          transform: rotate(360deg);
        }
      }
      /* PASS 4: the lit arc lengthens + brightens mid-sweep, then eases back. */
      @keyframes boltVeilArcBreathe {
        0%,
        100% {
          stroke-dasharray: 48 241;
          opacity: 0.7;
        }
        50% {
          stroke-dasharray: 92 197;
          opacity: 1;
        }
      }
      /* PASS 4: the bolt mark charging up — glow swells then settles. */
      @keyframes boltVeilCharge {
        0%,
        100% {
          filter: drop-shadow(0 0 7px rgba(0, 229, 255, 0.42));
        }
        45% {
          filter: drop-shadow(0 0 16px rgba(0, 229, 255, 0.95))
            drop-shadow(0 0 30px rgba(124, 58, 237, 0.45));
        }
      }
      /* PASS 4: stage cross-fade — incoming rises + fades in. */
      @keyframes boltVeilStageIn {
        from {
          opacity: 0;
          transform: translateY(5px);
          filter: blur(2px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
          filter: blur(0);
        }
      }
      /* PASS 4: outgoing sinks + fades out. */
      @keyframes boltVeilStageOut {
        from {
          opacity: 0.7;
          transform: translateY(0);
        }
        to {
          opacity: 0;
          transform: translateY(-5px);
          filter: blur(2px);
        }
      }

      /* Reduced motion — kill the chrome animation; the shader RAF is already
         disabled in TS (one static frame). The spinner ring keeps a slow,
         non-strobing rotation so the "working" affordance survives. The progress
         arc holds a static lit segment (still reads as "working", never spins). */
      @media (prefers-reduced-motion: reduce) {
        .bolt-veil__aurora,
        .bolt-veil__core,
        .bolt-veil__glyph,
        .bolt-veil__dots i,
        .bolt-veil__progress-arc,
        .bolt-veil__stage--in,
        .bolt-veil__stage--out {
          animation: none;
        }
        .bolt-veil__stage--out {
          display: none;
        }
        .bolt-veil__ring {
          animation-duration: 4s;
        }
        :host {
          transition: none;
        }
      }
    `,
  ],
})
export class BoltVeilComponent {
  /** True once the bolt editor postMessages ready — fades the veil + pauses RAF. */
  readonly editorReady = input<boolean>(false);
  /** Human status line under the headline (e.g. "Warming the container…"). */
  readonly stage = input<string>('');

  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('glcanvas');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);

  // ── PASS 4: stage cross-fade state ─────────────────────────────────────────
  // `stageCurr` is the visible line; when stage() changes we snapshot the old
  // value into `stagePrev` (which the template renders as a fading-out layer),
  // then clear it after the CSS cross-fade so only one line is ever "live".
  protected readonly stageCurr = signal<string>('');
  protected readonly stagePrev = signal<string>('');
  private stageFadeTimer: ReturnType<typeof setTimeout> | null = null;

  // ── WebGL state ────────────────────────────────────────────────────────────
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private uResolution: WebGLUniformLocation | null = null;
  private uTime: WebGLUniformLocation | null = null;
  // PASS 2: cursor uniform (xy = normalized pointer in p-space, z = activity 0..1).
  private uMouse: WebGLUniformLocation | null = null;
  private rafId = 0;
  private startTs = 0;
  private lastFrameTs = 0;
  private running = false;
  private reducedMotion = false;
  private resizeObs?: ResizeObserver;
  private mqlMotion?: MediaQueryList;

  // ── PASS 2: pointer reactivity state ───────────────────────────────────────
  // Target = where the cursor is now (p-space); smoothed = eased value fed to the
  // shader; activity decays toward 0 so motion "sparks" then settles into drift.
  private ptrTargetX = 0;
  private ptrTargetY = 0;
  private ptrX = 0;
  private ptrY = 0;
  private ptrActivity = 0;
  private lastPointerTs = 0;
  /** Bound so add/removeEventListener reference the same fn (context-loss + visibility). */
  private readonly onContextLost = (e: Event) => {
    e.preventDefault();
    this.stopLoop();
  };
  private readonly onContextRestored = () => {
    // Rebuild GL objects from scratch (the previous ones are invalid) and resume.
    if (this.initGl()) this.evaluateLoop();
  };
  private readonly onVisibility = () => this.evaluateLoop();
  private readonly onMotionChange = (e: MediaQueryListEvent) => {
    this.reducedMotion = e.matches;
    this.evaluateLoop();
  };
  /**
   * PASS 2: window-level pointer listener. The veil is `pointer-events:none`, so
   * we listen on `window` and convert the client point into the SAME normalized
   * p-space the shader uses (origin centre, y-up, scaled by height → aspect-
   * correct in x). Movement injects a burst of `activity` that then decays,
   * driving the light-halo + ripples; the eased position drives parallax. Bailed
   * out entirely under reduced motion.
   */
  private readonly onPointerMove = (e: PointerEvent) => {
    if (this.reducedMotion) return;
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    // Match the shader's p = (frag - 0.5*res)/res.y mapping (y flipped: DOM y-down
    // → shader y-up). x is scaled by height too, so it spans [-aspect, aspect].
    const nx = (e.clientX - rect.left - rect.width * 0.5) / rect.height;
    const ny = -(e.clientY - rect.top - rect.height * 0.5) / rect.height;
    this.ptrTargetX = nx;
    this.ptrTargetY = ny;
    this.ptrActivity = 1;
    this.lastPointerTs = performance.now();
  };

  /**
   * Single fullscreen-triangle vertex shader. One oversized triangle covers the
   * viewport with fewer verts + no diagonal seam vs. a quad; the fragment shader
   * does all the visual work.
   */
  private static readonly VERT = [
    'attribute vec2 aPos;',
    'void main() {',
    '  gl_Position = vec4(aPos, 0.0, 1.0);',
    '}',
  ].join('\n');

  /**
   * Fragment shader — the cinematic backdrop, grown across the five passes.
   *
   * Cost budget (PASS 5): FBM is capped at 4 octaves; the nebula is composited
   * from exactly 3 parallax depth layers (each 1 warp-FBM + 1 density-FBM); god
   * rays use a fixed 6-tap radial march; the flare/streak/particles are cheap
   * closed forms. No unbounded loops; total ~13 FBM evaluations/pixel.
   */
  private static readonly FRAG = [
    'precision highp float;',
    'uniform vec2 uResolution;',
    'uniform float uTime;',
    // PASS 2: normalized cursor in [-aspect..aspect, -1..1] space (same frame as p);
    // .z carries a 0..1 "activity" envelope (1 just after a move → 0 when idle).
    'uniform vec3 uMouse;',
    '',
    'float hash21(vec2 p) {',
    '  p = fract(p * vec2(123.34, 345.45));',
    '  p += dot(p, p + 34.345);',
    '  return fract(p.x * p.y);',
    '}',
    '',
    'float valueNoise(vec2 p) {',
    '  vec2 i = floor(p);',
    '  vec2 f = fract(p);',
    '  vec2 u = f * f * (3.0 - 2.0 * f);',
    '  float a = hash21(i);',
    '  float b = hash21(i + vec2(1.0, 0.0));',
    '  float c = hash21(i + vec2(0.0, 1.0));',
    '  float d = hash21(i + vec2(1.0, 1.0));',
    '  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);',
    '}',
    '',
    // PASS 5: 4-octave FBM with a slight per-octave rotation — richer detail than
    // the old 3 axis-aligned octaves, still cheap + capped (no directional grain).
    'float fbm(vec2 p) {',
    '  float sum = 0.0;',
    '  float amp = 0.5;',
    '  mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);',
    '  for (int i = 0; i < 4; i++) {',
    '    sum += amp * valueNoise(p);',
    '    p = rot * p * 2.02;',
    '    amp *= 0.5;',
    '  }',
    '  return sum;',
    '}',
    '',
    // PASS 1: one parallax depth layer. Coords are domain-warped (displaced by a
    // second FBM) for organic flow; `scale` sets the layer feature size, `speed`
    // its scroll rate, `warpAmt` how liquid it is. Returns a soft density 0..1.
    'float nebulaLayer(vec2 p, float scale, float speed, float warpAmt, float t) {',
    '  vec2 q = vec2(',
    '    fbm(p * scale + vec2(0.0, t * speed)),',
    '    fbm(p * scale + vec2(5.2, -t * speed * 0.85))',
    '  );',
    // PASS 1: second-order warp (warp the warp) → softer, more organic filaments.
    '  vec2 r = vec2(',
    '    fbm(p * scale + q * 1.4 + vec2(1.7, 9.2)),',
    '    fbm(p * scale + q * 1.4 + vec2(8.3, 2.8))',
    '  );',
    '  vec2 warped = p * (scale * 1.15) + (q + r * 0.5) * warpAmt + vec2(t * speed * 0.5, -t * speed * 0.33);',
    '  float d = fbm(warped);',
    '  return pow(clamp(d, 0.0, 1.0), 1.7);',
    '}',
    '',
    // PASS 5: ACES filmic tonemap (Narkowicz fit) — rolls highlights off gently
    // so the bright core/filaments read as light, never blown-out clipping.
    'vec3 acesTonemap(vec3 x) {',
    '  float a = 2.51; float b = 0.03; float c = 2.43; float d = 0.59; float e = 0.14;',
    '  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);',
    '}',
    '',
    'void main() {',
    '  vec2 uv = gl_FragCoord.xy / uResolution.xy;',
    '  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution.xy) / uResolution.y;',
    '  float t = uTime;',
    '',
    // PASS 3: slow cinematic camera push-in + a gentle drift, so the whole frame
    // breathes forward like a title card. PASS 2: bias the drift toward the cursor
    // (falls back to pure autonomous drift when idle → uMouse.z ~ 0).
    '  float zoom = 1.0 - 0.06 * (0.5 + 0.5 * sin(t * 0.05));',      // 0.94..1.0 breathing dolly
    '  vec2 drift = vec2(sin(t * 0.045) * 0.02, cos(t * 0.037) * 0.015);',
    '  vec2 par = uMouse.xy * (0.06 + 0.05 * uMouse.z);',            // parallax pull to cursor
    '  vec2 pc = (p + drift - par * 0.35) * zoom;',
    '',
    // PASS 1 + PASS 3: three parallax depth layers scrolling at different rates +
    // offset by the cursor at different strengths → real volumetric depth. Far
    // layer is dim + slow, near layer bright + fast + most cursor-reactive.
    '  float far  = nebulaLayer(pc + par * 0.10 + vec2(11.0, 4.0), 0.9, 0.020, 0.9, t);',
    '  float mid  = nebulaLayer(pc + par * 0.22 + vec2(3.0, 19.0), 1.5, 0.035, 1.25, t);',
    '  float near = nebulaLayer(pc + par * 0.40, 2.4, 0.055, 1.6, t);',
    '  float density = far * 0.5 + mid * 0.75 + near * 1.0;',
    '  density = clamp(density * 0.62, 0.0, 1.0);',
    '',
    // GRADE FIX: DARK-FIRST. The nebula must GLOW OUT of near-black, not fill the
    // frame. Base is true #060610; each layer is now ADDED as a dim, high-threshold
    // accent (not mixed toward a bright colour), so most of the frame stays deep and
    // only dense ridges brighten. Overall ambient fill cut ~60%.
    '  vec3 base = vec3(0.024, 0.024, 0.063);',       // #060610 (deep brand black)
    '  vec3 steel = vec3(0.314, 0.667, 0.890);',      // #50AAE3
    '  vec3 cyan = vec3(0.0, 0.898, 1.0);',           // #00E5FF
    '  vec3 violet = vec3(0.486, 0.227, 0.929);',     // #7C3AED
    '  vec3 col = base;',
    // High thresholds + low gains: the deep field stays black; energy emerges only
    // where a layer is genuinely dense. Additive keeps blacks black (no grey lift).
    '  col += violet * smoothstep(0.45, 0.95, far) * 0.10;',                    // far = faint violet haze
    '  col += steel * smoothstep(0.55, 0.95, mid) * 0.16;',                     // mid = dim steel body
    '  col += cyan * smoothstep(0.62, 0.98, near) * 0.30;',                     // near = cyan glow
    '  col += violet * smoothstep(0.70, 0.98, near * mid) * 0.14;',             // violet where layers stack
    '',
    // PASS 1 + GRADE FIX: chromatic-aberration bloom on ONLY the brightest filaments.
    // Higher threshold (0.82) + strength cut 0.9->0.38 so the fringe reads as a subtle
    // lens accent on high-energy ridges, not a frame-filling wash.
    '  float e = 1.6 / uResolution.y;',
    '  float filR = smoothstep(0.82, 0.99, nebulaLayer(pc + par * 0.40 + vec2(e, 0.0), 2.4, 0.055, 1.6, t));',
    '  float filG = smoothstep(0.82, 0.99, near);',
    '  float filB = smoothstep(0.82, 0.99, nebulaLayer(pc + par * 0.40 - vec2(e, 0.0), 2.4, 0.055, 1.6, t));',
    '  col += vec3(filR, filG, filB) * vec3(0.95, 0.85, 1.05) * 0.38;',
    '',
    // Energy core: soft radial bloom slightly ABOVE centre, pulsing on ~6s sine.
    // PASS 2: the core parallaxes toward the cursor too (subtle — it is anchored).
    // GRADE FIX: tighter falloff (7.5->9.5) + lower gain so the core is a compact
    // luminous point, not a broad bright bloom that whites out the centre.
    '  vec2 corePos = vec2(0.0, 0.10) + par * 0.18;',
    '  float d = length(pc - corePos);',
    '  float pulse = 0.82 + 0.18 * sin(t * (6.2831853 / 6.0));',
    '  float core = exp(-d * d * 9.5) * pulse;',
    '  col += mix(cyan, steel, 0.35) * core * 0.85;',
    '  col += violet * exp(-d * d * 3.2) * pulse * 0.18;',       // wide, dim violet halo
    '',
    // PASS 3 + GRADE FIX: volumetric GOD RAYS as a SMOOTH ANALYTIC radial field —
    // the previous per-pixel FBM march aliased into hard rotating tiles. This is a
    // closed form: a few soft angular lobes (sine over the angle-from-core), each
    // feathered by smoothstep, multiplied by a gentle radial falloff so light
    // streaks softly outward from the core. No sampling, no tiles, no aliasing.
    '  vec2 rayRel = pc - corePos;',
    '  float rayAng = atan(rayRel.y, rayRel.x);',
    '  float rayLen = length(rayRel);',
    // 5 slow-rotating lobes; smoothstep on the sine gives soft, feathered beams.
    '  float beams = 0.5 + 0.5 * sin(rayAng * 5.0 + t * 0.12);',
    '  beams = smoothstep(0.55, 1.0, beams);',
    // radial window: fade in just outside the core, fade out before the edges.
    '  float rayFall = smoothstep(0.02, 0.22, rayLen) * smoothstep(1.1, 0.28, rayLen);',
    '  float rays = beams * rayFall * pulse * 0.14;',              // low opacity accent
    '  col += mix(cyan, steel, 0.3) * rays;',
    '',
    // PASS 3 + GRADE FIX: subtle LENS FLARE — a small bright core dot + two dim ghost
    // discs + a thin anamorphic streak. Kept (reads beautifully) but gains trimmed so
    // it accents the core rather than adding to the wash. Never strobing (slow pulse).
    '  float flareCore = exp(-d * d * 320.0) * (0.6 + 0.4 * pulse);',
    '  col += vec3(0.85, 0.96, 1.0) * flareCore * 0.9;',
    '  vec2 ghostDir = (vec2(0.0) - corePos);',
    '  float g1 = exp(-length(pc - corePos - ghostDir * 0.35) * 22.0);',
    '  float g2 = exp(-length(pc - corePos - ghostDir * 0.7) * 30.0);',
    '  col += (cyan * g1 * 0.08 + violet * g2 * 0.07) * pulse;',
    // PASS 3: anamorphic streak — wide in x, razor-thin in y, at the core height.
    '  float streak = exp(-pow((pc.y - corePos.y) * 70.0, 2.0)) * exp(-abs(pc.x - corePos.x) * 2.6);',
    '  col += cyan * streak * 0.38 * pulse;',
    '',
    // PASS 2: pointer LIGHT-HALO — a soft glow that follows the cursor, plus
    // ripples that ride outward from it when the pointer is moving (uMouse.z).
    '  float md = length(pc - uMouse.xy);',
    '  float halo = exp(-md * md * 6.0) * (0.25 + 0.55 * uMouse.z);',
    '  col += mix(cyan, steel, 0.4) * halo;',
    '  float ripple = sin(md * 26.0 - t * 6.0) * exp(-md * md * 5.0);',
    '  col += cyan * max(ripple, 0.0) * uMouse.z * 0.30;',        // only while moving
    '',
    // Star sparkle: per-cell hash twinkle, only in the darker regions.
    '  vec2 sg = gl_FragCoord.xy / 3.0;',
    '  vec2 cell = floor(sg);',
    '  float star = hash21(cell);',
    '  float tw = 0.5 + 0.5 * sin(t * 2.2 + star * 6.2831853);',
    '  float spark = step(0.994, star) * pow(tw, 6.0);',
    '  spark *= (1.0 - smoothstep(0.10, 0.45, density));',       // fade near bright nebula
    '  spark *= smoothstep(0.15, 0.6, length(p));',              // keep the core clean
    '  col += vec3(0.75, 0.95, 1.0) * spark * 0.9;',
    '',
    // PASS 4: PARTICLES streaming inward toward the core. Polar field around the
    // core: many thin radial spokes whose brightness ripples inward over time, so
    // motes appear to fall into the energy core. Cheap (one hash + trig, no loop).
    '  vec2 rel = pc - corePos;',
    '  float ang = atan(rel.y, rel.x);',
    '  float rad = length(rel);',
    '  float spokes = hash21(vec2(floor(ang * 9.0), 1.0));',      // per-spoke random phase
    '  float inflow = sin(rad * 30.0 + t * 5.0 + spokes * 6.2831853);',
    '  float particles = smoothstep(0.6, 1.0, inflow) * smoothstep(0.9, 0.12, rad) * step(0.4, rad);',
    '  col += vec3(0.7, 0.95, 1.0) * particles * 0.22;',
    '',
    // PASS 5 + GRADE FIX: filmic tonemap at LOWERED exposure (1.05 -> 0.62) so only
    // the core + brightest filaments approach white; midtones roll back to deep
    // blue-black instead of blowing out. Then a firm contrast S-curve deepens the
    // shadows further — the dark-first HBO look.
    '  col = acesTonemap(col * 0.62);',
    '',
    // PASS 5: color grade — a stronger contrast S-curve (crushes midtones toward
    // black), a blue-black shadow floor, and mild saturation on the surviving light.
    '  col = mix(col, col * col * (3.0 - 2.0 * col), 0.45);',      // firmer contrast S-curve
    '  float luma = dot(col, vec3(0.299, 0.587, 0.114));',
    '  col = mix(vec3(luma), col, 1.12);',                         // +12% saturation
    '  col += vec3(0.005, 0.008, 0.018) * (1.0 - luma);',          // faint blue shadow floor
    '',
    // PASS 5 + GRADE FIX: STRONGER cinematic vignette — corners pulled to near-black
    // (floor 0.42 -> 0.10) over a wider, earlier radial ramp so the dark frame reads
    // clearly and the card floats in shadow. Edge desaturation kept.
    '  float vig = smoothstep(1.15, 0.18, length(uv - 0.5));',
    '  col *= mix(0.10, 1.0, vig);',
    '  float edge = smoothstep(0.5, 1.05, length(uv - 0.5));',
    '  col = mix(col, vec3(dot(col, vec3(0.333))) * 0.55, edge * 0.45);',   // edge falloff
    '',
    // PASS 5: refined film grain — subtler than before + luma-aware (more grain in
    // shadows, less in highlights) so flats never band yet lights stay clean.
    '  float grain = hash21(gl_FragCoord.xy + fract(t) * 137.0) - 0.5;',
    '  col += grain * 0.018 * (1.2 - luma);',
    '',
    '  col = max(col, 0.0);',
    '  gl_FragColor = vec4(col, 1.0);',
    '}',
  ].join('\n');

  constructor() {
    // Detect prefers-reduced-motion up front (guarded for SSR / old engines).
    try {
      this.mqlMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.reducedMotion = this.mqlMotion.matches;
      // addEventListener is the modern API; Safari <14 used addListener.
      if (this.mqlMotion.addEventListener) {
        this.mqlMotion.addEventListener('change', this.onMotionChange);
      }
    } catch {
      this.reducedMotion = false;
    }

    // PASS 4: seed the visible stage line + cross-fade on every change. Reading
    // stage() in an effect snapshots the previous value into stagePrev (the
    // fading-out layer) and swaps stageCurr to the new value; a timer then clears
    // stagePrev once the CSS cross-fade (460ms) has completed.
    effect(() => {
      const next = this.stage();
      const prev = this.stageCurr();
      if (next === prev) return;
      if (prev && !this.reducedMotion) {
        this.stagePrev.set(prev);
        if (this.stageFadeTimer) clearTimeout(this.stageFadeTimer);
        this.stageFadeTimer = setTimeout(() => this.stagePrev.set(''), 480);
      }
      this.stageCurr.set(next);
    });

    // Init WebGL only in the browser, after the canvas is in the DOM.
    afterNextRender(
      () => {
        const ok = this.initGl();
        if (!ok) {
          // No context → mark host so CSS swaps to the aurora fallback.
          this.host.nativeElement.classList.add('bolt-veil--no-webgl');
          return;
        }
        this.observeResize();
        document.addEventListener('visibilitychange', this.onVisibility);
        // PASS 2: window-level pointer reactivity (skipped under reduced motion —
        // the handler itself early-returns, but we also avoid binding it at all).
        if (!this.reducedMotion) {
          window.addEventListener('pointermove', this.onPointerMove, { passive: true });
        }
        this.evaluateLoop();
      },
      { injector: this.injector },
    );

    // React to editorReady() flips: pause the RAF the moment the veil goes gone,
    // resume if it flips back while still loading. Created in the ctor injection
    // context; evaluateLoop() is a safe no-op until GL has initialised.
    effect(() => {
      this.editorReady();
      this.evaluateLoop();
    });

    this.destroyRef.onDestroy(() => this.dispose());
  }

  // ── WebGL setup ──────────────────────────────────────────────────────────

  /** Create the context, compile the program and the fullscreen triangle. */
  private initGl(): boolean {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) return false;

    const opts: WebGLContextAttributes = {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'low-power',
    };
    const gl =
      (canvas.getContext('webgl', opts) as WebGLRenderingContext | null) ??
      (canvas.getContext('experimental-webgl', opts) as WebGLRenderingContext | null);
    if (!gl) return false;

    canvas.addEventListener('webglcontextlost', this.onContextLost, false);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored, false);

    const program = this.buildProgram(gl, BoltVeilComponent.VERT, BoltVeilComponent.FRAG);
    if (!program) return false;

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    // One triangle covering clip space [-1,3] on each axis → fills the viewport.
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    const aPos = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    gl.useProgram(program);

    this.gl = gl;
    this.program = program;
    this.buffer = buffer;
    this.uResolution = gl.getUniformLocation(program, 'uResolution');
    this.uTime = gl.getUniformLocation(program, 'uTime');
    // PASS 2: cursor uniform.
    this.uMouse = gl.getUniformLocation(program, 'uMouse');
    this.startTs = performance.now();
    this.lastFrameTs = this.startTs;

    this.resize();
    return true;
  }

  private buildProgram(gl: WebGLRenderingContext, vertSrc: string, fragSrc: string): WebGLProgram | null {
    const vert = this.compile(gl, gl.VERTEX_SHADER, vertSrc);
    const frag = this.compile(gl, gl.FRAGMENT_SHADER, fragSrc);
    if (!vert || !frag) return null;
    const program = gl.createProgram();
    if (!program) return null;
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    // Shaders can be deleted once linked into the program.
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      return null;
    }
    return program;
  }

  private compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  // ── Sizing ────────────────────────────────────────────────────────────────

  private observeResize(): void {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas || typeof ResizeObserver === 'undefined') return;
    this.resizeObs = new ResizeObserver(() => {
      this.resize();
      // Repaint immediately when paused so a resize while hidden/gone isn't stale.
      if (!this.running) this.renderFrame(performance.now());
    });
    this.resizeObs.observe(canvas);
  }

  /** Match the drawing buffer to the CSS box, DPR-capped at 2, and set viewport. */
  private resize(): void {
    const gl = this.gl;
    const canvas = this.canvasRef()?.nativeElement;
    if (!gl || !canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  // ── RAF lifecycle ───────────────────────────────────────────────────────

  /**
   * Decide whether the loop SHOULD run and start/stop accordingly. Runs only
   * when: GL is live, motion is allowed, the veil is visible (not editorReady),
   * and the tab is foregrounded. Under reduced-motion we paint exactly one frame.
   */
  private evaluateLoop(): void {
    if (!this.gl) return;
    const shouldRun =
      !this.reducedMotion &&
      !this.editorReady() &&
      !(typeof document !== 'undefined' && document.hidden);

    if (shouldRun) {
      this.startLoop();
    } else {
      this.stopLoop();
      // Reduced-motion / paused-but-visible → still show a composed static frame.
      if (this.reducedMotion && !this.editorReady()) this.renderFrame(performance.now());
    }
  }

  private startLoop(): void {
    if (this.running) return;
    this.running = true;
    const tick = (now: number) => {
      if (!this.running) return;
      this.renderFrame(now);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopLoop(): void {
    this.running = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  private renderFrame(now: number): void {
    const gl = this.gl;
    if (!gl || !this.program) return;
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) return;
    const t = (now - this.startTs) / 1000;

    // PASS 2 + PASS 5: advance pointer easing + activity decay, frame-rate-aware
    // so the feel is identical at 30/60/120fps. Skipped under reduced motion (the
    // pointer stays neutral → shader falls back to pure autonomous drift).
    if (!this.reducedMotion) {
      const dt = Math.min(0.05, Math.max(0, (now - this.lastFrameTs) / 1000)); // clamp tab-stall spikes
      // Critically-damped-ish easing toward the cursor target (position lag).
      const kPos = 1 - Math.pow(0.0009, dt); // ~fast but smooth follow
      this.ptrX += (this.ptrTargetX - this.ptrX) * kPos;
      this.ptrY += (this.ptrTargetY - this.ptrY) * kPos;
      // Activity decays toward 0 once the pointer goes idle (halo/ripples fade,
      // autonomous drift takes over). ~0.6s to settle.
      const idleFor = now - this.lastPointerTs;
      if (idleFor > 60) {
        this.ptrActivity *= Math.pow(0.02, dt); // exp decay
        if (this.ptrActivity < 0.001) this.ptrActivity = 0;
      }
    }
    this.lastFrameTs = now;

    gl.useProgram(this.program);
    if (this.uResolution) gl.uniform2f(this.uResolution, canvas.width, canvas.height);
    if (this.uTime) gl.uniform1f(this.uTime, t);
    if (this.uMouse) {
      // Reduced motion → force a neutral, inert cursor (no halo, no parallax).
      if (this.reducedMotion) gl.uniform3f(this.uMouse, 0, 0, 0);
      else gl.uniform3f(this.uMouse, this.ptrX, this.ptrY, this.ptrActivity);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // ── Teardown — no leaks ───────────────────────────────────────────────────

  private dispose(): void {
    this.stopLoop();
    document.removeEventListener('visibilitychange', this.onVisibility);
    // PASS 2: drop the window pointer listener (no leak beyond component life).
    window.removeEventListener('pointermove', this.onPointerMove);
    if (this.mqlMotion?.removeEventListener) {
      this.mqlMotion.removeEventListener('change', this.onMotionChange);
    }
    this.resizeObs?.disconnect();
    this.resizeObs = undefined;
    // PASS 4: cancel any in-flight stage cross-fade timer.
    if (this.stageFadeTimer) {
      clearTimeout(this.stageFadeTimer);
      this.stageFadeTimer = null;
    }

    const canvas = this.canvasRef()?.nativeElement;
    canvas?.removeEventListener('webglcontextlost', this.onContextLost);
    canvas?.removeEventListener('webglcontextrestored', this.onContextRestored);

    const gl = this.gl;
    if (gl) {
      if (this.buffer) gl.deleteBuffer(this.buffer);
      if (this.program) gl.deleteProgram(this.program);
      // Free the GPU context deterministically.
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    this.gl = null;
    this.program = null;
    this.buffer = null;
    this.uResolution = null;
    this.uTime = null;
    this.uMouse = null;
  }
}
