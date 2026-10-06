/**
 * @module mocks/mock-mode
 *
 * @description
 * Detects + holds "mock mode" for the admin SPA. Mock mode flips the app into
 * FIXTURE mode — the {@link import('../interceptors/mock-api.interceptor').mockApiInterceptor}
 * short-circuits any registered `/api/*` route and serves realistic mock data so a
 * surface is fully demoable with ZERO backend. **REAL is the production default** —
 * mock mode is OFF unless `?mock=1` is present (honesty mandate: mock never reaches
 * prod as real; a mocked surface is a visible demo, never fake-real).
 *
 * @remarks
 * - The URL is read ONCE at construction (the service is `providedIn:'root'`, so it's
 *   a singleton) and the result held in signals — so mock mode PERSISTS across SPA
 *   navigation even if the `?mock=1` param drops off a later route. A link that lands
 *   with `?mock=1` keeps the whole session in mock mode.
 * - `&state=empty|error|loading|populated` selects the demo state every fixture
 *   exposes (default `populated`). Unknown values fall back to `populated`.
 * - SSR/no-window safe: every `window`/`location` read is in a try/catch (mirrors
 *   `AuthService`'s localStorage guards) so a server/prerender context can't throw —
 *   it simply resolves to "off".
 */
import { Injectable, computed, signal } from '@angular/core';
import { MOCK_STATES, type MockState } from './fixtures/index';

@Injectable({ providedIn: 'root' })
export class MockModeService {
  /** Whether `?mock=1` was present at load (read once, then held). */
  private readonly enabledSignal = signal<boolean>(false);
  /** The demo state from `&state=…` (held; default `populated`). */
  private readonly stateSignal = signal<MockState>('populated');

  constructor() {
    const parsed = this.readUrlOnce();
    this.enabledSignal.set(parsed.enabled);
    this.stateSignal.set(parsed.state);
  }

  /**
   * TRUE only when `?mock=1` was present at app load. REAL is the default — a
   * production visitor (no `?mock=1`) is NEVER in mock mode, so the interceptor
   * passes every request straight through.
   */
  readonly enabled = this.enabledSignal.asReadonly();

  /** The active demo state (`populated` unless `&state=…` said otherwise). */
  readonly state = this.stateSignal.asReadonly();

  /** A human badge label, e.g. `"DEMO · mock data"` or `"DEMO · empty state"`. */
  readonly badgeLabel = computed(() => {
    const s = this.stateSignal();
    return s === 'populated' ? 'DEMO · mock data' : `DEMO · ${s} state`;
  });

  /**
   * The raw `location.search` string (e.g. `"?mock=1&state=empty"`), or `null` in a
   * no-window / SSR context. Isolated into an overridable method so a unit test can
   * drive the parse without fighting the browser's non-configurable
   * `window.location.search` accessor (production reads the real value once).
   */
  protected readSearch(): string | null {
    if (typeof window === 'undefined' || !window.location) return null;
    return window.location.search;
  }

  /**
   * Read `?mock=1` + `&state=…` from the current URL exactly once. Accepts `mock=1`
   * (and the equivalents `mock=true` / bare `mock`) as the enable signal. SSR-safe:
   * any throw (no `window`, opaque origin) resolves to disabled.
   */
  private readUrlOnce(): { enabled: boolean; state: MockState } {
    try {
      const search = this.readSearch();
      if (search == null) {
        return { enabled: false, state: 'populated' };
      }
      const params = new URLSearchParams(search);
      const raw = params.get('mock');
      // `?mock` (present, no value) → '' ; `?mock=1`|`true` → enabled. `0`/`false`/absent → off.
      const enabled = raw === '' || raw === '1' || raw === 'true';
      const stateRaw = params.get('state');
      const state: MockState =
        stateRaw && (MOCK_STATES as readonly string[]).includes(stateRaw)
          ? (stateRaw as MockState)
          : 'populated';
      return { enabled, state };
    } catch {
      return { enabled: false, state: 'populated' };
    }
  }
}
