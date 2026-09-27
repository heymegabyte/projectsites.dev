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
  viewChild,
} from '@angular/core';

/**
 * @module pages/admin/bolt-veil
 *
 * HBO-level cinematic loading veil for the admin's embedded bolt.diy editor.
 *
 * Renders a full-viewport WebGL fragment shader (a slow, domain-warped FBM
 * nebula with a pulsing energy core, hash-based star sparkle, vignette and
 * film grain) behind a glassy brand card. It replaces the old inline
 * {@link AdminComponent} `.bolt-veil` markup — same testid, roles and fade
 * behaviour, but the flat CSS aurora is now a genuine shader.
 *
 * WHY a component (not inline CSS): the shader needs a managed WebGL lifecycle
 * (context creation, a RAF loop, resize + DPR handling, context-loss recovery,
 * and teardown). Keeping that beside the admin shell's 1000-line template would
 * be unreadable and leak GPU work; a self-contained OnPush component owns it and
 * disposes it deterministically via {@link DestroyRef}.
 *
 * Cost discipline — the RAF is PAUSED whenever the veil is gone
 * ({@link editorReady} true) or the tab is hidden, and NEVER started under
 * `prefers-reduced-motion: reduce` (one static frame instead). If WebGL is
 * unavailable the host falls back to a tasteful CSS aurora (never a blank
 * canvas), toggled by the `bolt-veil--no-webgl` host class.
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
        <span class="bolt-veil__ring"></span>
        <span class="bolt-veil__core"></span>
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
      <div class="bolt-veil__sub">{{ stage() }}<span class="bolt-veil__dots"><i></i><i></i><i></i></span></div>
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
      .bolt-veil__glyph {
        position: absolute;
        inset: 0;
        margin: auto;
        width: 30px;
        height: 30px;
        color: #00e5ff;
        filter: drop-shadow(0 0 9px rgba(0, 229, 255, 0.55));
        animation: boltVeilBreathe 3s cubic-bezier(0.4, 0, 0.2, 1) infinite;
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

      /* Reduced motion — kill the chrome animation; the shader RAF is already
         disabled in TS (one static frame). The spinner ring keeps a slow,
         non-strobing rotation so the "working" affordance survives. */
      @media (prefers-reduced-motion: reduce) {
        .bolt-veil__aurora,
        .bolt-veil__core,
        .bolt-veil__glyph,
        .bolt-veil__dots i {
          animation: none;
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

  // ── WebGL state ────────────────────────────────────────────────────────────
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private uResolution: WebGLUniformLocation | null = null;
  private uTime: WebGLUniformLocation | null = null;
  private rafId = 0;
  private startTs = 0;
  private running = false;
  private reducedMotion = false;
  private resizeObs?: ResizeObserver;
  private mqlMotion?: MediaQueryList;
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
   * Fragment shader — the cinematic backdrop.
   *  - value-noise + 3-octave FBM, domain-warped (coords displaced by another
   *    FBM sample) → flowing, organic nebula instead of flat gradient bands;
   *  - palette ramp cyan → steel-blue → violet, driven by nebula density, kept
   *    mostly dark so bright cyan filaments glow;
   *  - a soft radial energy core above centre that pulses on a ~6s sine;
   *  - hash-based star twinkle in the darker regions;
   *  - vignette + faint time-varied film grain for the finish.
   */
  private static readonly FRAG = [
    'precision highp float;',
    'uniform vec2 uResolution;',
    'uniform float uTime;',
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
    'float fbm(vec2 p) {',
    '  float sum = 0.0;',
    '  float amp = 0.5;',
    '  for (int i = 0; i < 3; i++) {',
    '    sum += amp * valueNoise(p);',
    '    p *= 2.02;',
    '    amp *= 0.5;',
    '  }',
    '  return sum;',
    '}',
    '',
    'void main() {',
    '  vec2 uv = gl_FragCoord.xy / uResolution.xy;',
    '  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution.xy) / uResolution.y;',
    '  float t = uTime;',
    '',
    // Domain warp: displace the sampling coords by a slow FBM so the nebula flows.
    '  vec2 q = vec2(fbm(p * 1.4 + vec2(0.0, t * 0.03)), fbm(p * 1.4 + vec2(5.2, -t * 0.025)));',
    '  vec2 warped = p * 1.7 + q * 1.3 + vec2(t * 0.015, -t * 0.01);',
    '  float density = fbm(warped);',
    '  density = pow(clamp(density, 0.0, 1.0), 1.7);',
    '',
    // Palette ramp: near-black base → steel-blue → cyan → violet by density.
    '  vec3 base = vec3(0.024, 0.024, 0.063);',       // #060610
    '  vec3 steel = vec3(0.314, 0.667, 0.890);',      // #50AAE3
    '  vec3 cyan = vec3(0.0, 0.898, 1.0);',           // #00E5FF
    '  vec3 violet = vec3(0.486, 0.227, 0.929);',     // #7C3AED
    '  vec3 col = base;',
    '  col = mix(col, steel, smoothstep(0.30, 0.72, density) * 0.55);',
    '  col = mix(col, cyan, smoothstep(0.55, 0.95, density) * 0.65);',
    '  col = mix(col, violet, smoothstep(0.45, 0.85, fbm(warped * 1.6 + 9.0)) * 0.35);',
    '',
    // Bright cyan filaments — thin high-density ridges that glow.
    '  float fil = smoothstep(0.78, 0.98, density);',
    '  col += cyan * fil * 0.9;',
    '',
    // Energy core: soft radial bloom slightly ABOVE centre, pulsing on ~6s sine.
    '  vec2 corePos = vec2(0.0, 0.10);',
    '  float d = length(p - corePos);',
    '  float pulse = 0.82 + 0.18 * sin(t * (6.2831853 / 6.0));',
    '  float core = exp(-d * d * 7.5) * pulse;',
    '  col += mix(cyan, steel, 0.35) * core * 1.15;',
    '  col += violet * exp(-d * d * 2.2) * pulse * 0.28;',       // wide violet halo
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
    // Vignette — pull the frame edges toward black for a cinematic frame.
    '  float vig = smoothstep(1.15, 0.35, length(uv - 0.5));',
    '  col *= mix(0.55, 1.0, vig);',
    '',
    // Film grain — faint time-varied hash so flat areas never look banded/dead.
    '  float grain = hash21(gl_FragCoord.xy + fract(t) * 137.0) - 0.5;',
    '  col += grain * 0.025;',
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
    this.startTs = performance.now();

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
    gl.useProgram(this.program);
    if (this.uResolution) gl.uniform2f(this.uResolution, canvas.width, canvas.height);
    if (this.uTime) gl.uniform1f(this.uTime, t);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // ── Teardown — no leaks ───────────────────────────────────────────────────

  private dispose(): void {
    this.stopLoop();
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.mqlMotion?.removeEventListener) {
      this.mqlMotion.removeEventListener('change', this.onMotionChange);
    }
    this.resizeObs?.disconnect();
    this.resizeObs = undefined;

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
  }
}
