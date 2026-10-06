import { MockModeService } from './mock-mode.service';

/**
 * MockModeService — detects + holds mock mode from the URL at construction.
 * Contract: OFF unless `?mock=1` (REAL is the prod default); `&state=` selects the
 * demo state (default `populated`, unknown → `populated`); read ONCE then held in
 * signals so it persists across SPA nav; SSR/no-window safe (never throws).
 *
 * The service reads the URL via its overridable `readSearch()` seam in the
 * constructor; the test subclass feeds a fixed search string (so we drive the parse
 * without fighting the browser's non-configurable `window.location.search` accessor).
 */
// A module-level slot the test subclass reads from. `super()` (which calls
// readSearch() during construction) runs BEFORE subclass field initializers, so the
// fed value must live OUTSIDE the instance — a closure var set just before `new`.
let nextSearch: string | null = '';

class TestMockModeService extends MockModeService {
  protected override readSearch(): string | null {
    return nextSearch;
  }
}

/** Construct a service as if the page loaded with the given `location.search`. */
function withSearch(search: string | null): MockModeService {
  nextSearch = search;
  return new TestMockModeService();
}

describe('MockModeService (URL-driven, held, REAL-by-default)', () => {
  it('is DISABLED by default (no ?mock=1) — REAL is the prod default', () => {
    expect(withSearch('').enabled()).toBe(false);
  });

  it('is DISABLED for unrelated params (no mock flag)', () => {
    expect(withSearch('?foo=bar&state=empty').enabled()).toBe(false);
  });

  it('is DISABLED (never throws) in a no-window / SSR context', () => {
    expect(withSearch(null).enabled()).toBe(false);
  });

  it('ENABLES on ?mock=1', () => {
    expect(withSearch('?mock=1').enabled()).toBe(true);
  });

  it('ENABLES on ?mock=true and bare ?mock', () => {
    expect(withSearch('?mock=true').enabled()).toBe(true);
    expect(withSearch('?mock').enabled()).toBe(true);
  });

  it('stays DISABLED on ?mock=0 / ?mock=false', () => {
    expect(withSearch('?mock=0').enabled()).toBe(false);
    expect(withSearch('?mock=false').enabled()).toBe(false);
  });

  it('defaults state to "populated" when enabled without &state=', () => {
    expect(withSearch('?mock=1').state()).toBe('populated');
  });

  it('parses &state=empty / error / loading', () => {
    expect(withSearch('?mock=1&state=empty').state()).toBe('empty');
    expect(withSearch('?mock=1&state=error').state()).toBe('error');
    expect(withSearch('?mock=1&state=loading').state()).toBe('loading');
  });

  it('falls back to "populated" on an unknown &state= value', () => {
    expect(withSearch('?mock=1&state=bogus').state()).toBe('populated');
  });

  it('HOLDS the parsed value in a signal (read once, not re-derived per access)', () => {
    // Held — repeated reads return the same captured value regardless of any later
    // URL change (the SPA can navigate to a param-less route; mock mode persists).
    const svc = withSearch('?mock=1&state=empty');
    expect(svc.enabled()).toBe(true);
    expect(svc.state()).toBe('empty');
    expect(svc.enabled()).toBe(true); // stable on re-read
    expect(svc.state()).toBe('empty');
  });

  it('exposes a human badge label that reflects the state', () => {
    expect(withSearch('?mock=1').badgeLabel()).toBe('DEMO · mock data');
    expect(withSearch('?mock=1&state=empty').badgeLabel()).toBe('DEMO · empty state');
    expect(withSearch('?mock=1&state=error').badgeLabel()).toBe('DEMO · error state');
  });
});
