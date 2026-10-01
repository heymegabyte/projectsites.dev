/**
 * webgl-hero-core.mjs — framework-free ambient WebGL hero layer (<15KB, zero deps).
 *
 * ONE fragment shader, FOUR industry "variants" selected by uniform — presets are DATA
 * (palette + motion character), never forked shader code. Designed to sit BEHIND hero
 * text/imagery as a decorative layer: the canvas is never an LCP candidate (canvas is
 * excluded from LCP element types) and init is deferred by the wrapper until after load.
 *
 * Variants:
 *   0 ember — warm rising embers + heat-haze smoke drift        (restaurant)
 *   1 rays  — soft volumetric light rays + lifting dust motes   (nonprofit)
 *   2 glint — diagonal product-glint sweep + sparkle points     (retail)
 *   3 grid  — calm receding depth grid + gentle swell           (professional-services)
 *
 * Safety: returns { ok:false } when WebGL is unavailable (caller keeps its CSS gradient
 * fallback); pauses on tab-hide + offscreen; DPR capped; context-loss → clean teardown.
 */

const VARIANTS = { ember: 0, rays: 1, glint: 2, grid: 3 };

const VERT = `
attribute vec2 p;
void main(){ gl_Position = vec4(p, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;
uniform vec2 u_res;
uniform float u_time;
uniform vec3 u_bg;
uniform vec3 u_colA;
uniform vec3 u_colB;
uniform vec3 u_colC;
uniform float u_speed;
uniform float u_intensity;
uniform float u_density;
uniform float u_grain;
uniform int u_variant;

float hash(vec2 q){ return fract(sin(dot(q, vec2(127.1, 311.7))) * 43758.5453123); }

float noise(vec2 q){
  vec2 i = floor(q); vec2 f = fract(q);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 q){
  float v = 0.0; float a = 0.5;
  for(int i = 0; i < 4; i++){ v += a * noise(q); q = q * 2.03 + vec2(17.1, 9.2); a *= 0.5; }
  return v;
}

/* Soft round particle field: cells of size 1/density, each cell owns one mote. */
float motes(vec2 uv, float t, float density, float size, float drift){
  vec2 g = uv * density;
  vec2 cell = floor(g);
  float m = 0.0;
  for(int y = -1; y <= 1; y++){
    for(int x = -1; x <= 1; x++){
      vec2 c = cell + vec2(float(x), float(y));
      float h = hash(c);
      float h2 = hash(c + 71.3);
      vec2 center = c + 0.5 + 0.38 * vec2(sin(t * (0.4 + h) + h * 6.28 + drift), cos(t * (0.3 + h2) + h2 * 6.28));
      float d = length(g - center);
      float tw = 0.55 + 0.45 * sin(t * (1.0 + 2.0 * h) + h * 40.0);
      m += smoothstep(size, 0.0, d) * tw * step(0.35, h2);
    }
  }
  return m;
}

/* ember (0): hearth glow at the base, embers rising with flicker, smoke curl. */
vec3 ember(vec2 uv, vec2 asp, float t){
  float smoke = fbm(asp * 2.2 + vec2(t * 0.05, -t * 0.22));
  vec3 col = u_bg + u_colC * smoke * 0.20;
  float hearth = pow(1.0 - uv.y, 2.6);
  float flicker = 0.88 + 0.12 * fbm(vec2(t * 0.9, uv.x * 3.0));
  col += u_colA * hearth * 0.55 * flicker * u_intensity;
  vec2 rise = vec2(asp.x + fbm(asp * 3.0 + t * 0.1) * 0.12, asp.y + t * 0.16);
  float em = motes(rise, t, u_density, 0.16, 1.7);
  float band = smoothstep(1.02, 0.05, uv.y);
  col += u_colB * em * band * 1.25 * u_intensity;
  col += u_colA * em * em * band * 0.6;
  return col;
}

/* rays (1): airy field, angled god-rays breathing through, dust motes lifting. */
vec3 rays(vec2 uv, vec2 asp, float t){
  float air = fbm(asp * 1.6 + vec2(t * 0.03, t * 0.015));
  vec3 col = u_bg + (u_colC - u_bg) * air * 0.55;
  vec2 src = vec2(0.72, 1.18);
  vec2 d = asp - vec2(src.x * (u_res.x / u_res.y), src.y);
  float ang = atan(d.x, -d.y);
  float beams = 0.0;
  beams += pow(max(0.0, sin(ang * 9.0 + t * 0.21)), 4.0) * 0.30;
  beams += pow(max(0.0, sin(ang * 16.0 - t * 0.13 + 1.7)), 6.0) * 0.18;
  beams *= fbm(vec2(ang * 3.0, t * 0.1)) * 0.7 + 0.45;
  float fall = smoothstep(2.6, 0.15, length(d));
  vec3 beamTint = mix(u_colA, u_colB, 0.14);
  col += beamTint * beams * fall * 0.26 * u_intensity;
  vec2 lift = vec2(asp.x, asp.y + t * 0.05);
  float dust = motes(lift, t * 0.7, u_density, 0.09, 0.0);
  col = mix(col, u_colB, clamp(dust, 0.0, 1.0) * 0.30 * u_intensity);
  return col;
}

/* glint (2): dark velvet, brushed diagonal sheen, periodic specular sweep, warm sparkles. */
vec3 glint(vec2 uv, vec2 asp, float t){
  float velvet = fbm(asp * 2.0 + vec2(t * 0.02, 0.0));
  vec3 col = u_bg + u_colC * velvet * 0.18;
  float diag = dot(asp, normalize(vec2(1.0, 0.85)));
  /* always-present brushed-metal diagonal energy */
  float brush = 0.5 + 0.5 * sin(diag * 3.1 - t * 0.35);
  col += u_colA * brush * brush * 0.085 * u_intensity;
  /* display-case under-glow */
  col += u_colA * pow(1.0 - uv.y, 3.0) * 0.11 * u_intensity;
  /* periodic specular pass */
  float period = 4.5 / max(u_speed, 0.2);
  float phase = fract(t / period);
  float pos = mix(-0.5, 2.4, phase);
  float sweep = exp(-pow((diag - pos) * 5.5, 2.0));
  float sheen = exp(-pow((diag - pos) * 2.0, 2.0)) * 0.20;
  col += u_colA * (sweep * 0.34 + sheen) * u_intensity;
  col += u_colB * sweep * sweep * 0.16 * u_intensity;
  /* warm star glints */
  vec2 g = asp * u_density;
  vec2 cell = floor(g);
  float h = hash(cell);
  vec2 center = cell + 0.5 + 0.30 * vec2(sin(h * 40.0), cos(h * 29.0));
  vec2 q = g - center;
  float star = smoothstep(0.08, 0.0, abs(q.x)) * smoothstep(0.24, 0.0, abs(q.y))
             + smoothstep(0.08, 0.0, abs(q.y)) * smoothstep(0.24, 0.0, abs(q.x));
  float tw = pow(max(0.0, sin(t * (0.8 + h * 2.4) + h * 44.0)), 6.0);
  col += u_colB * clamp(star, 0.0, 1.0) * tw * step(0.76, h) * 0.85 * u_intensity;
  return col;
}

/* grid (3): calm perspective floor grid, gentle swell, warm horizon glow.
   Horizon glow is LUMINANCE-AWARE: additive bloom on dark backgrounds, but a light
   background clamps additive color to white — there we MIX toward the accent instead
   (safety-orange horizon on blueprint paper stays orange, not a white band). */
vec3 grid(vec2 uv, vec2 asp, float t){
  vec3 col = u_bg;
  float horizon = 0.62;
  float glow = exp(-pow((uv.y - horizon) * 7.0, 2.0));
  float glowLine = exp(-pow((uv.y - horizon) * 36.0, 2.0));
  float bgLum = dot(u_bg, vec3(0.2126, 0.7152, 0.0722));
  vec3 addGlow = col + u_colB * (glow * 0.30 + glowLine * 0.22) * u_intensity;
  vec3 mixGlow = mix(col, u_colB, clamp((glow * 0.14 + glowLine * 0.26) * u_intensity, 0.0, 1.0));
  col = mix(addGlow, mixGlow, smoothstep(0.45, 0.7, bgLum));
  if(uv.y < horizon){
    float depth = (horizon - uv.y) / horizon;
    float z = 1.0 / max(depth, 0.012);
    float swell = sin(z * 0.9 - t * u_speed * 0.5) * 0.12;
    float gx = abs(fract((uv.x - 0.5) * z * 0.42 * u_density + 0.5) - 0.5);
    float gz = abs(fract(z * 0.55 + swell + t * u_speed * 0.12) - 0.5);
    float lw = 0.042 * (0.35 + depth);
    float lines = smoothstep(lw, 0.0, gx) + smoothstep(lw, 0.0, gz);
    float fade = smoothstep(0.0, 0.42, depth) * smoothstep(1.0, 0.25, depth);
    col = mix(col, u_colA, clamp(lines, 0.0, 1.0) * fade * 0.72 * u_intensity);
  } else {
    float sky = fbm(asp * 1.3 + vec2(t * 0.02, 0.0));
    col += (u_colC - u_bg) * sky * 0.18;
  }
  return col;
}

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 asp = vec2(uv.x * (u_res.x / u_res.y), uv.y);
  float t = u_time * u_speed;
  vec3 col;
  if(u_variant == 0){ col = ember(uv, asp, t); }
  else if(u_variant == 1){ col = rays(uv, asp, t); }
  else if(u_variant == 2){ col = glint(uv, asp, t); }
  else { col = grid(uv, asp, t); }
  float vig = smoothstep(1.35, 0.45, length(uv - 0.5));
  col = mix(u_bg, col, 0.35 + 0.65 * vig);
  col += (hash(gl_FragCoord.xy + fract(u_time)) - 0.5) * u_grain;
  gl_FragColor = vec4(col, 1.0);
}
`;

function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(v, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('webgl-hero shader: ' + log);
  }
  return sh;
}

/**
 * Mount the ambient layer into `container` (a positioned element).
 *
 * @param {HTMLElement} container
 * @param {{
 *   variant?: 'ember'|'rays'|'glint'|'grid',
 *   palette?: string[],
 *   background?: string,
 *   speed?: number, intensity?: number, density?: number, grain?: number,
 *   maxDpr?: number, timeOffset?: number, autoStart?: boolean,
 * }} [opts]
 * @returns {{ ok:boolean, reason?:string, canvas?:HTMLCanvasElement, start?:()=>void,
 *   pause?:()=>void, resume?:()=>void, destroy?:()=>void,
 *   sample?:(n?:number)=>number[][], renderAt?:(seconds:number)=>void }}
 */
export function createWebGLHero(container, opts = {}) {
  if (typeof document === 'undefined' || !container) return { ok: false, reason: 'no-dom' };
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.className = 'webgl-hero-canvas';
  const gl =
    canvas.getContext('webgl', { antialias: false, depth: false, stencil: false, alpha: false, powerPreference: 'low-power' }) ||
    canvas.getContext('experimental-webgl');
  if (!gl) return { ok: false, reason: 'no-webgl' };

  let prog;
  try {
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link failed');
  } catch (err) {
    return { ok: false, reason: String(err && err.message ? err.message : err) };
  }
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const U = {};
  for (const name of ['u_res', 'u_time', 'u_bg', 'u_colA', 'u_colB', 'u_colC', 'u_speed', 'u_intensity', 'u_density', 'u_grain', 'u_variant']) {
    U[name] = gl.getUniformLocation(prog, name);
  }
  const pal = opts.palette || ['#00e5ff', '#7c3aed', '#50aae3'];
  gl.uniform3fv(U.u_bg, hexToRgb(opts.background || '#060610'));
  gl.uniform3fv(U.u_colA, hexToRgb(pal[0]));
  gl.uniform3fv(U.u_colB, hexToRgb(pal[1] || pal[0]));
  gl.uniform3fv(U.u_colC, hexToRgb(pal[2] || pal[0]));
  gl.uniform1f(U.u_speed, opts.speed ?? 1.0);
  gl.uniform1f(U.u_intensity, opts.intensity ?? 1.0);
  gl.uniform1f(U.u_density, opts.density ?? 9.0);
  gl.uniform1f(U.u_grain, opts.grain ?? 0.02);
  gl.uniform1i(U.u_variant, VARIANTS[opts.variant] ?? 3);

  const maxDpr = opts.maxDpr ?? 1.5;
  const t0 = performance.now() - (opts.timeOffset ?? 0) * 1000;
  let raf = 0;
  let running = false;
  let destroyed = false;
  let visible = true;
  let inView = true;

  function size() {
    const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    const w = Math.max(1, Math.round(container.clientWidth * dpr));
    const h = Math.max(1, Math.round(container.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }

  function draw(seconds) {
    size();
    gl.uniform1f(U.u_time, seconds);
    gl.uniform2f(U.u_res, canvas.width, canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function frame(now) {
    if (destroyed || !running) return;
    draw((now - t0) / 1000);
    raf = requestAnimationFrame(frame);
  }

  function reconcile() {
    const should = !destroyed && visible && inView;
    if (should && !running) {
      running = true;
      raf = requestAnimationFrame(frame);
      canvas.classList.add('is-live');
    } else if (!should && running) {
      running = false;
      cancelAnimationFrame(raf);
    }
  }

  const onVis = () => { visible = !document.hidden; reconcile(); };
  document.addEventListener('visibilitychange', onVis);
  let io = null;
  if (typeof IntersectionObserver !== 'undefined') {
    io = new IntersectionObserver((entries) => {
      inView = entries.some((e) => e.isIntersecting);
      reconcile();
    });
    io.observe(container);
  }
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => { if (!running && !destroyed) draw((performance.now() - t0) / 1000); });
    ro.observe(container);
  }
  const onLost = (e) => { e.preventDefault(); destroy(); };
  canvas.addEventListener('webglcontextlost', onLost);

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    running = false;
    cancelAnimationFrame(raf);
    document.removeEventListener('visibilitychange', onVis);
    if (io) io.disconnect();
    if (ro) ro.disconnect();
    canvas.removeEventListener('webglcontextlost', onLost);
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    const ext = gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
  }

  container.appendChild(canvas);

  const handle = {
    ok: true,
    canvas,
    start() { reconcile(); },
    pause() { running = false; cancelAnimationFrame(raf); },
    resume() { reconcile(); },
    destroy,
    /** Deterministic render at an absolute shader time (for gates/screenshots). */
    renderAt(seconds) { draw(seconds); },
    /** Render one frame then read n sample pixels — the black-broken-shader gate. */
    sample(n = 64) {
      draw((performance.now() - t0) / 1000);
      const out = [];
      const px = new Uint8Array(4);
      for (let i = 0; i < n; i++) {
        const x = Math.floor(((i * 97) % 101) / 101 * (canvas.width - 1));
        const y = Math.floor(((i * 59) % 103) / 103 * (canvas.height - 1));
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        out.push([px[0], px[1], px[2], px[3]]);
      }
      return out;
    },
  };
  if (opts.autoStart !== false) handle.start();
  return handle;
}

export { VARIANTS };
