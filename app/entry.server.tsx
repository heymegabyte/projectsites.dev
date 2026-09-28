import type { AppLoadContext } from '@remix-run/cloudflare';
import { RemixServer } from '@remix-run/react';
import { isbot } from 'isbot';
import { renderToReadableStream } from 'react-dom/server';
import { renderHeadToString } from 'remix-island';
import { Head } from './root';
import { themeStore } from '~/lib/stores/theme';

/*
 * `~/lib/security` is actively used by 7 API route files via `withSecurity()`;
 * deleting it would break GitHub/GitLab/Vercel/Netlify/Supabase API integrations.
 * Wiring `createSecurityHeaders` here applies CSP/HSTS/Referrer-Policy/etc. to
 * every Remix response so standalone bolt.diy access (e.g. bolt-diy-8jf.pages.dev)
 * has the same headers the projectsites.dev worker proxy already injects.
 */
import { createSecurityHeaders } from '~/lib/security';

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  remixContext: any,
  _loadContext: AppLoadContext,
) {
  // await initializeModelList({});

  const readable = await renderToReadableStream(<RemixServer context={remixContext} url={request.url} />, {
    signal: request.signal,
    onError(error: unknown) {
      console.error(error);
      responseStatusCode = 500;
    },
  });

  const body = new ReadableStream({
    start(controller) {
      const head = renderHeadToString({ request, remixContext, Head });

      controller.enqueue(
        new Uint8Array(
          new TextEncoder().encode(
            `<!DOCTYPE html><html lang="en" data-theme="${themeStore.value}"><head>${head}</head><body><div id="root" class="w-full h-full">`,
          ),
        ),
      );

      const reader = readable.getReader();

      function read() {
        reader
          .read()
          .then(({ done, value }) => {
            if (done) {
              controller.enqueue(new Uint8Array(new TextEncoder().encode('</div></body></html>')));
              controller.close();

              return;
            }

            controller.enqueue(value);
            read();
          })
          .catch((error) => {
            controller.error(error);
            readable.cancel();
          });
      }
      read();
    },

    cancel() {
      readable.cancel();
    },
  });

  if (isbot(request.headers.get('user-agent') || '')) {
    await readable.allReady;
  }

  responseHeaders.set('Content-Type', 'text/html');
  // The editor is served inside a warm, session-persistent iframe (BoltEmbedService keeps it
  // alive across admin routes), so a heuristically-cached HTML shell PINS an OLD bundle — users
  // kept seeing pre-fix editor UI across deploys (white buttons already fixed in code never
  // reached the screen). Force the document to revalidate every load so a fresh iframe/session
  // always fetches the current chunks (assets are content-hashed, so only the shell re-checks).
  // (Brian 2026-09-27 — stale editor bundle behind the persistent iframe.)
  responseHeaders.set('Cache-Control', 'no-cache, must-revalidate');

  responseHeaders.set('Cross-Origin-Embedder-Policy', 'credentialless');
  responseHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');
  responseHeaders.set('Origin-Agent-Cluster', '?1');

  /*
   * Apply CSP/HSTS/X-Content-Type-Options/Referrer-Policy/Permissions-Policy
   * — only set if not already set so per-route headers can override.
   */
  for (const [key, value] of Object.entries(createSecurityHeaders())) {
    if (!responseHeaders.has(key)) {
      responseHeaders.set(key, value);
    }
  }

  return new Response(body, {
    headers: responseHeaders,
    status: responseStatusCode,
  });
}
