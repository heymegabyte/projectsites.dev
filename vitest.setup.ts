/**
 * Vitest global setup — runs BEFORE any test file is imported, and therefore
 * before the module graph is collected.
 *
 * Why this exists: Node 22 defines `globalThis.localStorage` /
 * `globalThis.sessionStorage` as experimental getters that warn and resolve to
 * `undefined` unless the process was started with `--localstorage-file`.
 * Vitest's jsdom environment copies jsdom's globals onto `globalThis` but skips
 * keys that already exist, so the bare identifier `localStorage` resolved to
 * Node's undefined binding even though `window.localStorage` was a real jsdom
 * Storage.
 *
 * That bites any module which touches storage at MODULE SCOPE — e.g.
 * `app/lib/stores/logs.ts` instantiates `LogStore` at module scope, and its
 * constructor reads `localStorage.getItem(...)`. The crash happens during
 * collection, so a spec's own `??=` stub (which runs after the import graph
 * loads) cannot protect it. Defining the bindings here fixes the ordering.
 */

/** Minimal in-memory Storage, used only when no real implementation exists. */
const memoryStorage = new Map<string, string>();

const memoryStorageStub: Storage = {
  getItem: (key: string) => memoryStorage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    memoryStorage.set(key, value);
  },
  removeItem: (key: string) => {
    memoryStorage.delete(key);
  },
  clear: () => {
    memoryStorage.clear();
  },
  key: () => null,
  get length() {
    return memoryStorage.size;
  },
};

/**
 * Resolve a Web Storage binding for `globalThis`.
 *
 * Prefers the environment's real implementation (jsdom's `window.localStorage`)
 * and falls back to the in-memory stub. jsdom throws a `SecurityError` when the
 * document origin is opaque (e.g. `about:blank`), hence the try/catch.
 */
function resolveStorage(kind: 'localStorage' | 'sessionStorage'): Storage {
  try {
    const real = (globalThis as { window?: Window }).window?.[kind];

    if (real) {
      return real;
    }
  } catch {
    // Opaque origin — jsdom refuses access. Fall through to the stub.
  }

  return memoryStorageStub;
}

for (const kind of ['localStorage', 'sessionStorage'] as const) {
  // Leave a genuinely working binding alone (e.g. a Node run started with
  // --localstorage-file); otherwise install one that is actually defined.
  if (globalThis[kind]) {
    continue;
  }

  Object.defineProperty(globalThis, kind, {
    configurable: true,
    writable: true,
    value: resolveStorage(kind),
  });
}

/**
 * The WebContainer singleton chain probes these while booting. Nothing in the
 * unit suite boots a container; the real UI behaviour is covered by the
 * Playwright E2E suite.
 */
const globalStub = globalThis as unknown as Record<string, unknown>;

globalStub.crossOriginIsolated ??= false;

/**
 * jsdom ships no canvas backend (the `canvas` npm package is not installed), so
 * `HTMLCanvasElement.prototype.getContext` hits jsdom's not-implemented path:
 * it emits a "Not implemented: HTMLCanvasElement.prototype.getContext" error to
 * the virtual console AND returns `null` on EVERY call.
 *
 * Editor components that progressively-enhance with a canvas — e.g.
 * `app/components/chat/NebulaLoader.tsx` probes `getContext('webgl')` at mount —
 * already guard the null return and fall back to CSS, so the context being
 * absent is correct test behaviour. The ONLY effect of the not-implemented path
 * is a FLOOD of benign errors on every workbench/chat suite that mounts such a
 * component — noise that would camouflage a genuine canvas failure
 * (cf. canvas-mount-probe-blind-to-black-broken-shader).
 *
 * Return `null` explicitly — the exact value the components already handle — so
 * the not-implemented path never fires. No unit test can depend on a real
 * context today (jsdom provides none), so this is strictly behaviour-preserving:
 * same return value, minus the stderr flood.
 */
if (typeof HTMLCanvasElement !== 'undefined' && HTMLCanvasElement.prototype) {
  HTMLCanvasElement.prototype.getContext =
    function getContext(): null {
      return null;
    } as typeof HTMLCanvasElement.prototype.getContext;
}
