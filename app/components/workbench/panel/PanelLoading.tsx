/**
 * @file PanelLoading — the shared in-panel loading primitive for the editor workbench panels.
 *
 * @remarks
 * The Nebula Waiting Experience, CONTAINED. Every editor panel's loading/fetching state renders
 * this instead of a generic gray spinner: a small, sized purple/cyan WebGL nebula
 * ({@link NebulaLoader}) centered in the panel body, with one short muted status label beneath.
 * The nebula IS the experience; the label only says what's happening (per the global
 * `nebula-waiting-experience` mandate — gorgeous black/cyan atmosphere, minimum interface, NEVER a
 * generic SaaS spinner).
 *
 * Sizing: a FIXED small box (~180px), NOT full-bleed — `NebulaLoader` renders a bare
 * `<canvas className="ps-nebula-canvas">` that fills its parent, so the parent's size IS the loader's
 * size. We wrap it in a `flex-1 min-h-0 grid place-items-center` container so it sits centered in the
 * panel body regardless of panel height.
 *
 * Reduced-motion: {@link NebulaLoader} already handles `prefers-reduced-motion: reduce` internally
 * (it reads the media query, freezes the shader to one calm static frame, and stops the RAF loop) —
 * so we do NOT need a separate static branch. We ALSO render a brand-consistent CSS fallback mark
 * (a cyan ring/dot on `--ps-bg`) layered BEHIND the canvas: it shows through if WebGL is unavailable
 * (the canvas never paints and `NebulaLoader` no-ops) OR if the shader is too heavy to paint — so the
 * bar is always gorgeous + on-brand, never a blank box and never a generic gray spinner. The CSS
 * pulse is gated by `motion-reduce:animate-none` so it, too, respects reduced-motion.
 *
 * Cheap + mount-only: the component renders ONLY while a panel is loading, so the WebGL context is
 * created on loading-start and torn down (via `NebulaLoader`'s effect cleanup + `WEBGL_lose_context`)
 * the moment the panel swaps to its ready state. No idle GPU cost.
 *
 * Style follows editor conventions (UnoCSS `bolt-elements-*` tokens, black + cyan, WCAG 2.2 AA —
 * the label clears AA on `--ps-bg`; `role="status" aria-live="polite"` announces the load).
 */
import { memo } from 'react';
import { NebulaLoader } from '../../chat/NebulaLoader';
import { classNames } from '~/utils/classNames';

export interface PanelLoadingProps {
  /** Short status beneath the nebula (e.g. "Loading your resources…"). Muted + AA-legible. */
  label?: string;

  /** 0..1 real progress when known — lifts the nebula's luminosity + shows a hairline bar. */
  progress?: number;

  /** Extra classes on the outer container (e.g. a `data-testid` is passed via props, not here). */
  className?: string;
}

/**
 * A contained, centered in-panel loader: a small sized Nebula + an optional short status label.
 * Drop into any panel's loading branch in place of an `animate-spin` / "Loading…" block.
 */
export const PanelLoading = memo(({ label, progress, className }: PanelLoadingProps) => (
  <div
    className={classNames('flex-1 min-h-0 grid place-items-center p-6', className)}
    role="status"
    aria-live="polite"
    aria-busy="true"
    data-testid="panel-loading"
  >
    <div className="flex flex-col items-center gap-3">
      {/* Sized nebula box — fixed small, never full-bleed. The CSS fallback ring sits BEHIND the
          canvas and shows through if WebGL never paints (graceful + on-brand, never a gray spinner). */}
      <div
        className="relative h-[180px] w-[180px] overflow-hidden rounded-2xl border border-bolt-elements-item-contentAccent/20 bg-[color:var(--ps-bg,#060610)] shadow-lg shadow-bolt-elements-item-contentAccent/5"
        aria-hidden="true"
      >
        {/* Brand CSS fallback mark — a cyan ring + pulsing core on near-black; visible only if the
            WebGL canvas above never paints. Respects reduced-motion. */}
        <span className="absolute inset-0 grid place-items-center">
          <span className="relative grid h-12 w-12 place-items-center">
            <span className="absolute inset-0 rounded-full border-2 border-bolt-elements-item-contentAccent/30" />
            <span className="h-2.5 w-2.5 rounded-full bg-bolt-elements-item-contentAccent animate-pulse motion-reduce:animate-none" />
          </span>
        </span>

        {/* The living nebula — fills this box; freezes to a calm static frame under reduced-motion. */}
        <NebulaLoader progress={progress} />
      </div>

      {label && (
        <span className="max-w-[240px] text-center text-[12px] font-medium text-bolt-elements-textSecondary">
          {label}
        </span>
      )}
    </div>
  </div>
));

PanelLoading.displayName = 'PanelLoading';
