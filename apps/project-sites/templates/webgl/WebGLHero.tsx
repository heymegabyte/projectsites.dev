/**
 * WebGLHero.tsx — React 19 wrapper for the ambient industry-themed WebGL hero layer.
 *
 * Usage (template Hero section — layer sits BEHIND the hero content):
 *
 *   <section className="relative ...">
 *     <WebGLHero vertical={brand.vertical} webgl={brand.webgl} />
 *     <div className="relative z-[1] ...">headline / CTA / imagery</div>
 *   </section>
 *
 * Guarantees:
 * - NEVER the LCP element: decorative aria-hidden canvas behind content; GL init is
 *   deferred until window `load` + idle (rIC, 2s timeout), so pre-LCP main thread is free.
 * - `prefers-reduced-motion: reduce` → no GL at all; the static CSS gradient fallback
 *   (always rendered underneath) is the whole treatment.
 * - No WebGL / context loss → same graceful gradient fallback, zero errors.
 * - Styling via linked CSS ONLY (`webgl-hero.css`) — no inline <style> strings
 *   (React 19 drops raw style-string children client-side); palette reaches CSS
 *   through element-level custom properties.
 */
import { useEffect, useRef } from 'react';
import { createWebGLHero } from './webgl-hero-core.mjs';
import { resolveWebGLPreset } from './presets.mjs';
import './webgl-hero.css';

export interface WebGLHeroConfig {
  variant?: 'ember' | 'rays' | 'glint' | 'grid';
  background?: string;
  palette?: string[];
  speed?: number;
  intensity?: number;
  density?: number;
  grain?: number;
}

export interface WebGLHeroProps {
  /** Vertical/industry key, e.g. 'restaurant' | 'nonprofit' | 'retail' | 'professional-services'. */
  vertical?: string;
  /** Pack-level override block (vertical.json → `webgl`, or _brand.json → `webgl`). */
  webgl?: WebGLHeroConfig;
  /**
   * Optional CSS custom properties to pull the live theme palette from
   * (e.g. ['--brand-primary','--brand-accent','--brand-muted']); any that resolve
   * to a #rrggbb value override the preset palette slot-for-slot.
   */
  paletteCssVars?: string[];
  className?: string;
}

function readCssPalette(el: HTMLElement, vars: string[] | undefined): string[] | undefined {
  if (!vars || vars.length === 0) return undefined;
  const cs = getComputedStyle(el);
  const out: string[] = [];
  let any = false;
  for (const v of vars) {
    const raw = cs.getPropertyValue(v).trim();
    if (/^#[0-9a-fA-F]{6}$/.test(raw)) {
      out.push(raw);
      any = true;
    } else {
      out.push('');
    }
  }
  return any ? out.map((c) => c || '') : undefined;
}

export function WebGLHero({ vertical, webgl, paletteCssVars, className }: WebGLHeroProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let handle: ReturnType<typeof createWebGLHero> | null = null;
    let cancelled = false;
    let idleId: number | undefined;

    const init = () => {
      if (cancelled || reduced.matches || handle) return;
      const cssPalette = readCssPalette(host, paletteCssVars);
      const overrides: WebGLHeroConfig = { ...(webgl ?? {}) };
      if (cssPalette) {
        // Slot-wise: live theme token wins, then pack override; '' slots fall back to preset.
        overrides.palette = [0, 1, 2].map((i) => cssPalette[i] || webgl?.palette?.[i] || '');
      }
      const preset = resolveWebGLPreset(vertical, overrides);
      host.style.setProperty('--webgl-hero-bg', preset.background);
      host.style.setProperty('--webgl-hero-a', preset.palette[0]);
      host.style.setProperty('--webgl-hero-b', preset.palette[1]);
      handle = createWebGLHero(host, preset);
      // ok:false (no WebGL) → the CSS gradient fallback underneath is the treatment.
    };

    const schedule = () => {
      if (cancelled) return;
      if (typeof window.requestIdleCallback === 'function') {
        idleId = window.requestIdleCallback(init, { timeout: 2000 });
      } else {
        window.setTimeout(init, 350);
      }
    };

    // Set fallback-gradient palette immediately (cheap, pre-GL) so the static layer is themed.
    const pre = resolveWebGLPreset(vertical, webgl ?? {});
    host.style.setProperty('--webgl-hero-bg', pre.background);
    host.style.setProperty('--webgl-hero-a', pre.palette[0]);
    host.style.setProperty('--webgl-hero-b', pre.palette[1]);

    if (document.readyState === 'complete') schedule();
    else window.addEventListener('load', schedule, { once: true });

    const onMotionChange = () => {
      if (reduced.matches) {
        handle?.destroy?.();
        handle = null;
      } else {
        schedule();
      }
    };
    reduced.addEventListener?.('change', onMotionChange);

    return () => {
      cancelled = true;
      window.removeEventListener('load', schedule);
      reduced.removeEventListener?.('change', onMotionChange);
      if (idleId !== undefined && typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(idleId);
      handle?.destroy?.();
      handle = null;
    };
  }, [vertical, webgl, paletteCssVars]);

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      data-testid="webgl-hero-layer"
      className={['webgl-hero-layer', className].filter(Boolean).join(' ')}
    />
  );
}

export default WebGLHero;
