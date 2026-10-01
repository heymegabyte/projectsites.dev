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
}

const VERT = `attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}`;

// Fragment shader: domain-warped fbm nebula in a purple→cyan→pink palette.
const FRAG = `
precision highp float;
uniform vec2 u_res; uniform float u_time; uniform vec2 u_ptr;
uniform float u_prog; uniform float u_reduced;
// hash + value noise + fbm
float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}
float fbm(vec2 p){float v=0.,a=.5;mat2 m=mat2(1.6,1.2,-1.2,1.6);
  for(int i=0;i<6;i++){v+=a*n(p);p=m*p;a*=.5;}return v;}
// heart signed field (faint organic density knot)
float heart(vec2 u){u.x=abs(u.x);float a=u.x*u.x+u.y*u.y-1.;return a*a*a-u.x*u.x*u.y*u.y*u.y;}
void main(){
  vec2 uv=(gl_FragCoord.xy-.5*u_res)/u_res.y;
  float t=u_time*(u_reduced>.5?0.0:1.0);
  vec2 ptr=(u_ptr-.5*u_res)/u_res.y;
  // domain warp
  vec2 q=vec2(fbm(uv*1.4+t*.05),fbm(uv*1.4-t*.04+5.2));
  vec2 r=vec2(fbm(uv*2.0+q*1.6+t*.06),fbm(uv*2.0+q*1.6+vec2(3.1,1.7)-t*.05));
  float d=fbm(uv*1.8+r*1.8);
  // pointer attraction: brighten toward cursor
  d+=0.10*exp(-3.5*length(uv-ptr));
  // faint heart knot drifting
  float hv=heart((uv-vec2(0.,-0.05))*1.9);
  d+=0.06*smoothstep(0.06,-0.02,hv)*(0.6+0.4*sin(t*.6));
  d=clamp(d,0.,1.);
  // palette: deep space -> violet -> cyan -> hot pink
  vec3 space=vec3(0.02,0.01,0.05);
  vec3 violet=vec3(0.36,0.12,0.72);
  vec3 cyan=vec3(0.0,0.90,1.0);
  vec3 pink=vec3(1.0,0.24,0.60);
  vec3 col=space;
  col=mix(col,violet,smoothstep(0.30,0.72,d));
  col=mix(col,cyan,smoothstep(0.55,0.95,d)*0.65);
  col=mix(col,pink,smoothstep(0.70,1.0,d)*0.55);
  // soft star field
  float st=h(floor((uv+t*.002)*vec2(u_res.y*.5)));
  col+=vec3(0.8,0.85,1.0)*step(0.9992,st)*0.9;
  // plasma wisps + bloom lift by progress
  col+=cyan*0.05*pow(d,3.)*(1.0+u_prog*1.4);
  col*=0.85+0.55*u_prog;
  // vignette
  col*=smoothstep(1.25,0.25,length(uv));
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

export const NebulaLoader = memo(({ progress }: NebulaLoaderProps) => {
  const ref = useRef<HTMLCanvasElement>(null);
  const progRef = useRef(0);
  progRef.current = typeof progress === 'number' ? Math.max(0, Math.min(1, progress)) : 0;

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
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // reduced-motion: render ONE calm frame, then stop.
      raf = reduced ? 0 : requestAnimationFrame(frame);
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
