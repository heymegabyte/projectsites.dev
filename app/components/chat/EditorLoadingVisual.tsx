import { memo, useEffect, useState } from 'react';
import { classNames } from '~/utils/classNames';
import { NebulaLoader } from './NebulaLoader';

interface EditorLoadingVisualProps {
  /** When true the whole screen (background included) fades out. */
  leaving?: boolean;

  /** Fires when the fade-out transition ends — the controller unmounts on this. */
  onTransitionEnd?: React.TransitionEventHandler<HTMLDivElement>;

  /** 0..1 real progress when known; lifts nebula luminosity + shows a hairline bar. */
  progress?: number;

  /** Override the rotating status; omit to cycle the ambient messages. */
  message?: string;
}

/** Concise, catchy 2–5 word ambient statuses — prefer a real `message` prop when known. */
const MESSAGES = [
  'Building your universe…',
  'Igniting the nebula…',
  'Making pixels behave…',
  'Summoning stardust…',
  'Bending a little light…',
  'Warming the plasma…',
  'Rendering…',
  'Almost there…',
];

/**
 * The full-surface editor loading screen: a living purple/cyan/pink WebGL nebula
 * ({@link NebulaLoader}) behind a deliberately tiny foreground — one small spinner
 * glyph and a short rotating status. The nebula IS the experience; the UI only
 * says what's happening. (Nebula Waiting Experience, revision 1.)
 *
 * Presentation only. Mount/unmount + the `leaving` fade are owned by the caller.
 * Foreground styling is global (`ps-editor-loader*` / `ps-nebula*` in
 * `styles/index.scss`) — never an inline `<style>`, which React 19 can drop.
 *
 * @remarks `role="status"` announces the load; the nebula + message both freeze
 *   under `prefers-reduced-motion: reduce`, leaving a static, legible field.
 */
export const EditorLoadingVisual = memo(
  ({ leaving = false, onTransitionEnd, progress, message }: EditorLoadingVisualProps) => {
    const [idx, setIdx] = useState(0);
    const [burst, setBurst] = useState(0);
    const reduced =
      typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    useEffect(() => {
      if (message || reduced) {
        return undefined;
      }

      const id = setInterval(() => setIdx((i) => (i + 1) % MESSAGES.length), 2600);

      return () => clearInterval(id);
    }, [message, reduced]);

    // Completion burst: when the screen starts leaving, flare the nebula (cyan/pink
    // energy pulse) then let it dissolve into the editor beneath the parent fade.
    useEffect(() => {
      if (!leaving) {
        return undefined;
      }

      let raf = 0;
      const start = performance.now();
      const tick = (now: number) => {
        const k = Math.min(1, (now - start) / 680);
        setBurst(k < 1 ? Math.sin(k * Math.PI) : 0); // rise then settle
        raf = k < 1 ? requestAnimationFrame(tick) : 0;
      };
      raf = requestAnimationFrame(tick);

      return () => cancelAnimationFrame(raf);
    }, [leaving]);

    const status = message ?? MESSAGES[idx];

    return (
      <div
        className={classNames('ps-editor-loader', 'ps-editor-loader--nebula', {
          'ps-editor-loader--leaving': leaving,
        })}
        data-leaving={leaving ? 'true' : 'false'}
        role="status"
        aria-live="polite"
        aria-busy={!leaving}
        aria-label="Loading your editor"
        onTransitionEnd={onTransitionEnd}
      >
        <NebulaLoader progress={progress} burst={burst} />

        {/* Tiny CSS fallback mark — visible only if WebGL never paints. */}
        <span className="ps-editor-loader__orb ps-editor-loader__orb--fallback" aria-hidden="true" />

        <div className="ps-nebula-ui" aria-hidden="true">
          <span className="ps-nebula-ui__spin" />
          <span key={status} className="ps-nebula-ui__msg">
            {status}
          </span>
          {typeof progress === 'number' && (
            <span className="ps-nebula-ui__bar" style={{ ['--p' as string]: Math.max(0, Math.min(1, progress)) }} />
          )}
        </div>
      </div>
    );
  },
);
