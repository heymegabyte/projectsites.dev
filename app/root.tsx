import { useStore } from '@nanostores/react';
import type { LinksFunction } from '@remix-run/cloudflare';
import { Links, Meta, Outlet, Scripts, ScrollRestoration } from '@remix-run/react';
import tailwindReset from '@unocss/reset/tailwind-compat.css?url';
import { themeStore } from './lib/stores/theme';
import { stripIndents } from './utils/stripIndent';
import { createHead } from 'remix-island';
import { useEffect } from 'react';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { ClientOnly } from 'remix-utils/client-only';
import { cssTransition, ToastContainer } from 'react-toastify';

import reactToastifyStyles from 'react-toastify/dist/ReactToastify.css?url';
import globalStyles from './styles/index.scss?url';
import xtermStyles from '@xterm/xterm/css/xterm.css?url';
import { EditorLoadingScreen } from './components/chat/EditorLoadingScreen';
import { editorFilesReady } from './lib/stores/editor-boot';

import 'virtual:uno.css';

const toastAnimation = cssTransition({
  enter: 'animated fadeInRight',
  exit: 'animated fadeOutRight',
});

export const links: LinksFunction = () => [
  {
    rel: 'icon',
    href: '/favicon.svg',
    type: 'image/svg+xml',
  },
  { rel: 'stylesheet', href: reactToastifyStyles },
  { rel: 'stylesheet', href: tailwindReset },
  { rel: 'stylesheet', href: globalStyles },
  { rel: 'stylesheet', href: xtermStyles },
  {
    rel: 'preconnect',
    href: 'https://fonts.googleapis.com',
  },
  {
    rel: 'preconnect',
    href: 'https://fonts.gstatic.com',
    crossOrigin: 'anonymous',
  },
  {
    rel: 'stylesheet',
    href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap',
  },
];

/**
 * Must run before WebContainer.boot() to override the iframe URL.
 * The default /headless endpoint may 404 with older internal package
 * versions. Setting WEBCONTAINER_API_IFRAME_URL ensures the correct
 * origin is used for the headless runtime.
 */
const webcontainerIframeOverride = stripIndents`
  globalThis.WEBCONTAINER_API_IFRAME_URL = "https://stackblitz.com";
`;

/*
 * The ProjectSites editor is dark-first (brand). Force data-theme="dark" on the
 * document so EVERY bolt-elements-* token AND every `dark:` utility resolves to
 * the dark palette. Otherwise a light OS preference (or a stale `bolt_theme`)
 * leaves the document in light/unset mode, where `bg-white`-based surfaces stay
 * white inside the dark admin shell — the "white background in dark mode" bug.
 * The theme toggle is hidden in the embedded editor, so there's nothing to honor.
 */
const inlineThemeCode = stripIndents`
  document.querySelector('html')?.setAttribute('data-theme', 'dark');
`;

export const Head = createHead(() => (
  <>
    <meta charSet="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <Meta />
    <Links />
    <script dangerouslySetInnerHTML={{ __html: webcontainerIframeOverride }} />
    <script dangerouslySetInnerHTML={{ __html: inlineThemeCode }} />
  </>
));

export function Layout({ children }: { children: React.ReactNode }) {
  const theme = useStore(themeStore);

  useEffect(() => {
    document.querySelector('html')?.setAttribute('data-theme', theme);
  }, [theme]);

  return (
    <>
      {/*
       * Full-surface editor loading screen. Rendered OUTSIDE ClientOnly so it
       * is in the initial HTML and paints before hydration ("as early as
       * possible"), then fades out — background and all — once the editor's
       * files are loaded. Self-managing + SSR-safe (starts visible, no slug).
       */}
      <EditorLoadingScreen />
      <ClientOnly>{() => <DndProvider backend={HTML5Backend}>{children}</DndProvider>}</ClientOnly>
      <ToastContainer
        closeButton={({ closeToast }) => {
          return (
            <button className="Toastify__close-button" onClick={closeToast}>
              <div className="i-ph:x text-lg" />
            </button>
          );
        }}
        icon={({ type }) => {
          switch (type) {
            case 'success': {
              return <div className="i-ph:check-bold text-bolt-elements-icon-success text-2xl" />;
            }
            case 'error': {
              return <div className="i-ph:warning-circle-bold text-bolt-elements-icon-error text-2xl" />;
            }
          }

          return undefined;
        }}
        position="bottom-right"
        pauseOnFocusLoss
        transition={toastAnimation}
        autoClose={3000}
      />
      <ScrollRestoration />
      <Scripts />
    </>
  );
}

import { logStore } from './lib/stores/logs';

export default function App() {
  const theme = useStore(themeStore);

  useEffect(() => {
    logStore.logSystem('Application initialized', {
      theme,
      platform: navigator.platform,
      userAgent: navigator.userAgent,
      timestamp: new Date().toISOString(),
    });

    // Initialize debug logging with improved error handling
    import('./utils/debugLogger')
      .then(({ debugLogger }) => {
        /*
         * The debug logger initializes itself and starts disabled by default
         * It will only start capturing when enableDebugMode() is called
         */
        const status = debugLogger.getStatus();
        logStore.logSystem('Debug logging ready', {
          initialized: status.initialized,
          capturing: status.capturing,
          enabled: status.enabled,
        });
      })
      .catch((error) => {
        logStore.logError('Failed to initialize debug logging', error);
      });

    /*
     * Cross-iframe handshake with the projectsites.dev admin shell.
     * - PS_CURSOR: forward every pointermove (throttled to RAF) so the
     *   admin's circular cursor follower keeps tracking even when the
     *   user's pointer is over our iframe (iframes normally swallow
     *   parent mouseevents).
     * - PS_BOLT_CHAT_READY: post once when the chat input placeholder
     *   "Build a professional website for" has painted, so the admin
     *   can dismiss its loading overlay.
     * - PS_BOLT_FILES_LOADED: post once when every project file is in the
     *   editor, so the admin veil dismisses in sync with the in-iframe loader
     *   (accurate — as soon as files are in — instead of a blind timeout).
     */
    if (typeof window === 'undefined' || window.parent === window) {
      return;
    }

    const PARENT_ORIGIN = 'https://projectsites.dev';

    /*
     * Fire PS_BOLT_FILES_LOADED once the editor holds every project file (the
     * same signal that fades the in-iframe EditorLoadingScreen). Files are
     * parser-driven, so this can fire before or around the chat-ready probe
     * below. The subscription unsubscribes itself after the single emit.
     */
    const unsubscribeFilesLoaded = editorFilesReady.subscribe((filesLoaded) => {
      if (!filesLoaded) {
        return;
      }

      unsubscribeFilesLoaded();
      window.parent.postMessage({ type: 'PS_BOLT_FILES_LOADED' }, PARENT_ORIGIN);
      window.parent.postMessage(
        { type: 'PS_TELEMETRY', event: 'editor.files_loaded', props: { embedded: true } },
        PARENT_ORIGIN,
      );
    });
    const INTERACTIVE = 'a, button, input, textarea, select, [role="button"], [data-tooltip]';
    let pendingFrame = 0;
    let lastX = 0;
    let lastY = 0;
    let lastHover = false;

    const send = () => {
      pendingFrame = 0;
      window.parent.postMessage({ type: 'PS_CURSOR', x: lastX, y: lastY, hover: lastHover }, PARENT_ORIGIN);
    };

    const onMove = (ev: PointerEvent | MouseEvent) => {
      lastX = ev.clientX;
      lastY = ev.clientY;
      lastHover = !!(ev.target as HTMLElement | null)?.closest?.(INTERACTIVE);

      if (!pendingFrame) {
        pendingFrame = requestAnimationFrame(send);
      }
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('mousemove', onMove, { passive: true });

    /*
     * Watch for the chat placeholder text to mount. The chat textarea uses
     * a dynamic placeholder ending in "Build a professional website for…",
     * so once any element on the page carries that string we know the
     * editor shell is up enough to invite input.
     */
    const READY_TEXTS = ['Build a professional website for', 'What are we shipping?', 'What are we discussing?'];
    const fireReady = () => {
      window.parent.postMessage({ type: 'PS_BOLT_CHAT_READY' }, PARENT_ORIGIN);

      /*
       * Item 48: editor.boot_done — second event in the PostHog funnel,
       * fires the moment the chat placeholder paints (the same signal the
       * admin uses to dismiss its loading overlay).
       */
      window.parent.postMessage(
        { type: 'PS_TELEMETRY', event: 'editor.boot_done', props: { embedded: true } },
        PARENT_ORIGIN,
      );
    };
    const probe = () =>
      READY_TEXTS.some((t) => document.body?.innerText?.includes(t)) ||
      READY_TEXTS.some((t) => !!document.querySelector(`[placeholder*="${t}"]`));

    if (probe()) {
      fireReady();
    } else {
      const observer = new MutationObserver(() => {
        if (probe()) {
          fireReady();
          observer.disconnect();
        }
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['placeholder'],
      });

      // Safety net — fire after 25s even if we never spot the string.
      setTimeout(() => {
        fireReady();
        observer.disconnect();
      }, 25_000);
    }
  }, []);

  return (
    <Layout>
      <Outlet />
    </Layout>
  );
}
