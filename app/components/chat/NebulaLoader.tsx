import { memo, useEffect, useRef } from 'react';

/**
 * NebulaLoader — a tiny procedural WebGL nebula for the editor loading state.
 *
 * Purple + cyan + hot-pink cosmic-romance energy field: deep near-black space,
 * domain-warped fbm plasma, soft star field, faint organic heart-density knots,
 * gentle bloom + vignette. The nebula IS the experience; the foreground UI is
 * only a tiny spinner + a short rotating status message (owned by the caller).
 *
 * Revision 1 of the Nebula Waiting Experience (see `progress.md` for the 2–14
 * polish ladder). Raw WebGL — zero dependencies, tiny footprint.
 *
 * @remarks
 *   - Lazy GL init; graceful no-op when WebGL is unavailable (caller keeps its
 *     CSS fallback mark visible beneath).
 *   - `requestAnimationFrame` loop; PAUSES when the tab/page is hidden.
 *   - `prefers-reduced-motion: reduce` → the beautiful field is preserved but
 *     animation is frozen to a single calm frame (no travel, no flashing).
 *   - Adaptive device-pixel-ratio (capped) for smooth motion on mobile.
 *   - `progress` (0..1, optional) lifts nebula luminosity as real work advances.
 */
export interface NebulaLoaderProps {
  /** 0..1 real progress when known; raises luminosity. Omit for indeterminate. */
  progress?: number;

  /** 0..1 completion burst — a cyan/pink energy flash as the nebula dissolves. */
  burst?: number;
}

const VERT = `attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}`;

// Fragment shader: HBO-grade cinematic nebula — double domain-warped fbm, ACES
// filmic tone-map, film grain, chromatic edge-bleed, a hot-pink "love explosion"
// core pulse, parallax stars, and a completion burst. Purple/cyan/hot-pink.
const FRAG = `
precision highp float;
uniform vec2 u_res; uniform float u_time; uniform vec2 u_ptr;
uniform float u_prog; uniform float u_reduced; uniform float u_burst;
float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}
float fbm(vec2 p){float v=0.,a=.5;mat2 m=mat2(1.6,1.2,-1.2,1.6);
  for(int i=0;i<7;i++){v+=a*n(p);p=m*p;a*=.5;}return v;}
float heart(vec2 u){u.x=abs(u.x);float a=u.x*u.x+u.y*u.y-1.;return a*a*a-u.x*u.x*u.y*u.y*u.y;}
// ACES filmic tonemap — the cinematic grade.
vec3 aces(vec3 x){return clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14),0.,1.);}
// nebula density at a given uv (so we can sample it per-channel for chromatic bleed)
float density(vec2 uv,float t){
  vec2 q=vec2(fbm(uv*1.4+t*.05),fbm(uv*1.4-t*.04+5.2));
  vec2 r=vec2(fbm(uv*2.0+q*1.7+t*.06),fbm(uv*2.0+q*1.7+vec2(3.1,1.7)-t*.05));
  float d=fbm(uv*1.9+r*1.9+q*.4);
  return d;
}
void main(){
  vec2 uv=(gl_FragCoord.xy-.5*u_res)/u_res.y;
  float t=u_time*(u_reduced>.5?0.0:1.0);
  vec2 ptr=(u_ptr-.5*u_res)/u_res.y;
  float rad=length(uv);
  // chromatic edge-bleed: sample density with a tiny radial offset per channel
  float ca=0.010+0.05*u_burst;
  vec2 dir=uv*ca;
  float dr=density(uv+dir,t), dg=density(uv,t), db=density(uv-dir,t);
  float d=dg;
  // pointer attraction — a warm gravity well
  float pd=exp(-3.2*length(uv-ptr));
  d+=0.12*pd; dr+=0.12*pd; db+=0.12*pd;
  // the LOVE EXPLOSION: a hot core that breathes + bursts on completion
  float core=exp(-2.6*rad);
  float pulse=0.5+0.5*sin(t*0.9-rad*3.0);
  float love=core*(0.35+0.4*pulse) + u_burst*exp(-1.4*rad)*2.2;
  float hv=heart((uv-vec2(0.,-0.04))*1.9);
  love+=0.10*smoothstep(0.05,-0.03,hv)*(0.6+0.4*sin(t*.6));
  d+=love; dr+=love; db+=love;
  d=clamp(d,0.,1.4); dr=clamp(dr,0.,1.4); db=clamp(db,0.,1.4);
  // palette — haunting cold space, warm pink heart
  vec3 space=vec3(0.015,0.008,0.04);
  vec3 violet=vec3(0.40,0.13,0.80);
  vec3 cyan=vec3(0.0,0.92,1.0);
  vec3 pink=vec3(1.0,0.22,0.58);
  vec3 col=space;
  col=mix(col,violet,smoothstep(0.28,0.72,d));
  // cyan + pink layered per chromatic channel for a filmic bleed at the edges
  col+=cyan*smoothstep(0.55,0.98,dg)*0.75;
  col+=pink*vec3(smoothstep(0.66,1.05,dr),smoothstep(0.70,1.05,dg),smoothstep(0.74,1.05,db))*0.80;
  // plasma cores bloom, lifted by real progress + the completion burst
  col+=cyan*0.06*pow(d,3.0)*(1.0+u_prog*1.6+u_burst*3.0);
  col+=pink*0.08*love;
  // parallax star fields (two depths), gentle twinkle
  for(int L=0;L<2;L++){
    float sc=u_res.y*(0.35+float(L)*0.42);
    vec2 g=(uv*(1.0+float(L)*0.5))*sc + t*(2.0+float(L)*4.0);
    float st=h(floor(g));
    float tw=0.6+0.4*sin(t*2.0+st*30.0);
    col+=vec3(0.8,0.86,1.0)*step(0.9994-float(L)*0.0002,st)*0.9*tw;
  }
  col*=0.80+0.6*u_prog;               // progress lifts the whole field
  col*=smoothstep(1.35,0.20,rad);     // haunting deep vignette
  col=aces(col*1.15);                  // cinematic tonemap
  col=pow(col,vec3(0.4545));           // gamma
  col+=(h(gl_FragCoord.xy+t)-0.5)*0.035; // film grain
  gl_FragColor=vec4(col,1.0);
}`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type);

  if (!s) {
    return null;
  }

  gl.shaderSource(s, src);
  gl.compileShader(s);

  return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
}

export const NebulaLoader = memo(({ progress, burst }: NebulaLoaderProps) => {
  const ref = useRef<HTMLCanvasElement>(null);
  const progRef = useRef(0);
  const burstRef = useRef(0);
  progRef.current = typeof progress === 'number' ? Math.max(0, Math.min(1, progress)) : 0;
  burstRef.current = typeof burst === 'number' ? Math.max(0, Math.min(1, burst)) : 0;

  useEffect(() => {
    const canvas = ref.current;

    if (!canvas) {
      return undefined;
    }

    const gl = (canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' }) ||
      canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;

    if (!gl) {
      return undefined; // caller keeps its CSS fallback mark
    }

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 1 : 0;
    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    const prog = gl.createProgram();

    if (!vs || !fs || !prog) {
      return undefined;
    }

    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(prog, 'u_res');
    const uTime = gl.getUniformLocation(prog, 'u_time');
    const uPtr = gl.getUniformLocation(prog, 'u_ptr');
    const uProg = gl.getUniformLocation(prog, 'u_prog');
    const uBurst = gl.getUniformLocation(prog, 'u_burst');
    const uReduced = gl.getUniformLocation(prog, 'u_reduced');
    gl.uniform1f(uReduced, reduced);

    const ptr = { x: 0.5, y: 0.5 };
    const dpr = Math.min(window.devicePixelRatio || 1, window.innerWidth < 640 ? 1 : 1.5);

    const resize = () => {
      const w = canvas.clientWidth || window.innerWidth;
      const h = canvas.clientHeight || window.innerHeight;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      gl.viewport(0, 0, canvas.width, canvas.height);
      ptr.x = canvas.width / 2;
      ptr.y = canvas.height / 2;
    };

    resize();
    window.addEventListener('resize', resize);

    const onMove = (e: PointerEvent) => {
      ptr.x = e.clientX * dpr;
      ptr.y = (canvas.clientHeight - e.clientY) * dpr;
    };
    window.addEventListener('pointermove', onMove, { passive: true });

    let raf = 0;
    let start = 0;
    const frame = (ts: number) => {
      if (!start) {
        start = ts;
      }

      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, (ts - start) / 1000);
      gl.uniform2f(uPtr, ptr.x, ptr.y);
      gl.uniform1f(uProg, progRef.current);
      gl.uniform1f(uBurst, burstRef.current);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // reduced-motion: render ONE calm frame, then stop (unless a burst is animating).
      raf = reduced && burstRef.current <= 0 ? 0 : requestAnimationFrame(frame);
    };

    const onVis = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
        raf = 0;
      } else if (!raf && !reduced) {
        raf = requestAnimationFrame(frame);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('visibilitychange', onVis);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, []);

  return <canvas ref={ref} className="ps-nebula-canvas" aria-hidden="true" />;
});
