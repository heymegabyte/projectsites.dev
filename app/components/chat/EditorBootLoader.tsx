import { memo } from 'react';
import { EditorLoadingVisual } from './EditorLoadingVisual';

/**
 * Pre-hydration / chat-hydrating boot loader for the embedded bolt.diy editor.
 *
 * Shown as the `ClientOnly` fallback in `_index.tsx` and while the chat history
 * hydrates in `Chat.client.tsx`. It renders the SAME full-surface loading
 * visual as the self-managing {@link EditorLoadingScreen} (which sits above it
 * at `z-9999`), so whichever paints first, the look is identical — a solid
 * #060610 field with a breathing orb — with zero seam against the parent shell.
 *
 * Mount/unmount is controlled by the parent (`ready` flag); this component does
 * not self-dismiss.
 *
 * @example
 * {!ready && <EditorBootLoader />}
 */
export const EditorBootLoader = memo(() => <EditorLoadingVisual />);
