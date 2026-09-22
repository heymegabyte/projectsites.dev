import { cloudflareDevProxyVitePlugin as remixCloudflareDevProxy, vitePlugin as remixVitePlugin } from '@remix-run/dev';
import UnoCSS from 'unocss/vite';
import { fileURLToPath } from 'node:url';
import { defineConfig, type ViteDevServer } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { optimizeCssModules } from 'vite-plugin-optimize-css-modules';
import tsconfigPaths from 'vite-tsconfig-paths';
import { visualizer } from 'rollup-plugin-visualizer';
import * as dotenv from 'dotenv';

// Load environment variables from multiple files (first match wins per key)
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });
dotenv.config({ path: '.env.production' });
dotenv.config();

export default defineConfig((config) => {
  return {
    resolve: {
      // `~/*` -> `./app/*`, mirroring tsconfig `paths`. `vite-tsconfig-paths`
      // only resolves this during a build/dev transform; Vitest's module
      // resolver needs a real alias or `vi.mock('~/lib/stores/workbench')`
      // silently misses and the heavy WebContainer singleton chain loads.
      alias: {
        '~': fileURLToPath(new URL('./app', import.meta.url)),
      },
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV),
      // Item 49: Sentry release tracking — every deploy tags errors with
      // the commit SHA so Sentry can filter "errors since this release".
      // Falls back to 'dev' for local development.
      'import.meta.env.VITE_BUILD_SHA': JSON.stringify(process.env.GITHUB_SHA || process.env.CF_PAGES_COMMIT_SHA || 'dev'),
    },
    build: {
      target: 'esnext',
      rollupOptions: {
        output: {
          // Carve out the fattest vendor modules so they cache independently
          // and the main `index` bundle drops below the 250KB visibility line.
          // Findings (build/client/assets/ pre-split):
          //   index 960KB        — Shiki core + react-toastify + lucide-react + radix UI + nanostores + app shell
          //   Workbench 812KB    — xterm core + addons + CodeMirror + lucide-react
          //   constants 516KB    — all @ai-sdk providers concatenated (openai, anthropic, bedrock, google, mistral, deepseek, fireworks, cohere, cerebras, openrouter, ollama)
          //   workbench 320KB    — second workbench split (mostly CodeMirror lang grammars)
          //   components 252KB   — shared component primitives
          //   git 236KB          — isomorphic-git
          // Shiki language grammars (emacs-lisp 788KB, cpp 684KB, wasm 608KB, wolfram 264KB) already lazy-load per language — leave alone.
          manualChunks: (id: string) => {
            if (!id.includes('node_modules')) return undefined;

            // AI SDK providers: 11 packages, 516KB total — split into a single
            // vendor chunk that loads only when the chat actually needs them.
            if (
              id.includes('/@ai-sdk/') ||
              id.includes('/@openrouter/ai-sdk-provider/') ||
              id.includes('/ollama-ai-provider/')
            ) {
              return 'vendor-ai-sdk';
            }

            // xterm + addons: terminal-only, 79 hits in Workbench chunk.
            if (id.includes('/@xterm/') || id.includes('/xterm/')) {
              return 'vendor-xterm';
            }

            // CodeMirror: 16 packages bundled into Workbench — split to share
            // across editor + diff + code-block surfaces.
            if (id.includes('/@codemirror/') || id.includes('/codemirror/') || id.includes('/@lezer/')) {
              return 'vendor-codemirror';
            }

            // Shiki core ONLY — skip language grammars + theme JSONs so they
            // keep their per-language dynamic-import boundaries (those were
            // already lazy-loaded; bundling them all into one vendor chunk
            // produced a 9.2MB regression).
            if (
              (id.includes('/shiki/') || id.includes('/@shikijs/')) &&
              !id.includes('/languages/') &&
              !id.includes('/themes/') &&
              !id.includes('/langs/') &&
              !id.includes('/dist/langs') &&
              !id.includes('/dist/themes')
            ) {
              return 'vendor-shiki';
            }

            // isomorphic-git: 236KB, only used in git-related flows.
            if (id.includes('/isomorphic-git/')) {
              return 'vendor-git';
            }
          },
        },
      },
    },
    plugins: [
      nodePolyfills({
        include: ['buffer', 'process', 'util', 'stream'],
        globals: {
          Buffer: true,
          process: true,
          global: true,
        },
        protocolImports: true,
        exclude: ['child_process', 'fs', 'path'],
      }),
      {
        name: 'buffer-polyfill',
        transform(code, id) {
          if (id.includes('env.mjs')) {
            return {
              code: `import { Buffer } from 'buffer';\n${code}`,
              map: null,
            };
          }

          return null;
        },
      },
      config.mode !== 'test' && remixCloudflareDevProxy(),
      // The Remix Vite plugin owns the app's JSX transform through its preamble
      // and refuses to transform outside one ("can't detect preamble"). Vitest
      // runs with `mode === 'test'`, so disable the plugin there and let
      // esbuild's automatic JSX runtime handle `.spec.tsx` collection.
      config.mode !== 'test' &&
        remixVitePlugin({
          future: {
            v3_fetcherPersist: true,
            v3_relativeSplatPath: true,
            v3_throwAbortReason: true,
            v3_lazyRouteDiscovery: true,
          },
          ignoredRouteFiles: ['**/*.spec.ts', '**/*.spec.tsx', '**/*.test.ts', '**/*.test.tsx'],
        }),
      UnoCSS(),
      tsconfigPaths(),
      chrome129IssuePlugin(),
      config.mode === 'production' && optimizeCssModules({ apply: 'build' }),
      // Bundle-size visualizer — gated behind ANALYZE=1 so prod builds skip it.
      // Run: `ANALYZE=1 npm run build` then open `dist/bundle-analysis.html`.
      process.env.ANALYZE === '1' &&
        visualizer({
          filename: 'dist/bundle-analysis.html',
          template: 'treemap',
          gzipSize: true,
          brotliSize: true,
          open: false,
          emitFile: false,
        }),
    ],
    envPrefix: [
      'VITE_',
      'OPENAI_LIKE_API_BASE_URL',
      'OPENAI_LIKE_API_MODELS',
      'OLLAMA_API_BASE_URL',
      'LMSTUDIO_API_BASE_URL',
      'TOGETHER_API_BASE_URL',
    ],
    css: {
      preprocessorOptions: {
        scss: {
          api: 'modern-compiler',
        },
      },
    },
    test: {
      // Runs BEFORE any test file is imported, so browser globals exist before
      // the module graph is collected — see vitest.setup.ts for the why.
      setupFiles: ['./vitest.setup.ts'],
      // Root vitest runs ONLY the bolt.diy Remix app (app/). The sub-packages
      // have their own runners — apps/project-sites/* uses Jest, the Angular
      // frontend uses Karma/Jasmine — and their `describe`/`it` globals are not
      // vitest's, so scanning them yields "describe is not defined". Each
      // sub-package is tested via its own `npm test`.
      include: ['app/**/*.{test,spec}.{ts,tsx}'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/cypress/**',
        '**/.{idea,git,cache,output,temp}/**',
        '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*',
        '**/tests/preview/**', // Exclude preview tests that require Playwright
        // Agent worktrees under .claude/worktrees/ are full repo checkouts —
        // without this, vitest scans 50+ copies (5000+ duplicate/stale specs),
        // hanging `npm test`. Never run the worktree copies; only the real app/.
        '**/.claude/**',
      ],
    },
  };
});

function chrome129IssuePlugin() {
  return {
    name: 'chrome129IssuePlugin',
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const raw = req.headers['user-agent']?.match(/Chrom(e|ium)\/([0-9]+)\./);

        if (raw) {
          const version = parseInt(raw[2], 10);

          if (version === 129) {
            res.setHeader('content-type', 'text/html');
            res.end(
              '<body><h1>Please use Chrome Canary for testing.</h1><p>Chrome 129 has an issue with JavaScript modules & Vite local development, see <a href="https://github.com/stackblitz/bolt.new/issues/86#issuecomment-2395519258">for more information.</a></p><p><b>Note:</b> This only impacts <u>local development</u>. `pnpm run build` and `pnpm run start` will work fine in this browser.</p></body>',
            );

            return;
          }
        }

        next();
      });
    },
  };
}