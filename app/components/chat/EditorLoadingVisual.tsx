import { memo } from 'react';
import { classNames } from '~/utils/classNames';

interface EditorLoadingVisualProps {
  /** When true the whole screen (background included) fades out. */
  leaving?: boolean;

  /** Fires when the fade-out transition ends — the controller unmounts on this. */
  onTransitionEnd?: React.TransitionEventHandler<HTMLDivElement>;
}

/**
 * The full-surface editor loading screen: a solid brand-dark field with a
 * breathing cyan→violet orb inside a slowly rotating accent ring and a thin
 * indeterminate shimmer. Wordless and calm — the animation IS the loader.
 *
 * Presentation only. Mount/unmount + the `leaving` fade are owned by the
 * caller ({@link EditorLoadingScreen} self-manages; the pre-hydration
 * `EditorBootLoader` renders it persistently). All styling is global
 * (`ps-editor-loader*` in `styles/index.scss`) — never an inline `<style>`,
 * which React 19 can silently drop on the client.
 *
 * @remarks `role="status"` announces the load; every animation is disabled
 *   under `prefers-reduced-motion: reduce`, leaving a static, legible mark.
 */
export const EditorLoadingVisual = memo(({ leaving = false, onTransitionEnd }: EditorLoadingVisualProps) => {
  return (
    <div
      className={classNames('ps-editor-loader', { 'ps-editor-loader--leaving': leaving })}
      data-leaving={leaving ? 'true' : 'false'}
      role="status"
      aria-live="polite"
      aria-busy={!leaving}
      aria-label="Loading your editor"
      onTransitionEnd={onTransitionEnd}
    >
      <div className="ps-editor-loader__stage" aria-hidden="true">
        <span className="ps-editor-loader__ring" />
        <span className="ps-editor-loader__orb" />
      </div>
      <div className="ps-editor-loader__shimmer" aria-hidden="true">
        <span />
      </div>
    </div>
  );
});
