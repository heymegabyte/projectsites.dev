import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { AppsComponent } from './apps.component';
import { ApiService } from '../../../services/api.service';
import { APPS_CATALOG, APP_CATEGORIES, isAppSupported } from './apps-catalog.data';

/** Shared ApiService stub — install-counts fetch (A5) resolves to empty by default. */
const APPS_API_PROVIDER = {
  provide: ApiService,
  useValue: { get: () => of({ counts: { umami: 4 } }) },
};

/**
 * First spec for the Apps catalog section (convergence r24).
 * Covers the pure filter/lifecycle/search logic + the new a11y live-region
 * announcement. The template imports (RouterLink, Spartan tooltip) are stripped
 * so the constructor runs without a router/animation harness; ActivatedRoute is
 * stubbed with an empty queryParamMap so ngOnInit's subscribe is inert.
 */
function make(category?: string, tag?: string): AppsComponent {
  const params: Record<string, string> = {};
  if (category) params['category'] = category;
  if (tag) params['tag'] = tag;
  const queryParamMap = of(convertToParamMap(params));
  TestBed.configureTestingModule({
    imports: [AppsComponent],
    providers: [APPS_API_PROVIDER, { provide: ActivatedRoute, useValue: { queryParamMap } }],
  });
  TestBed.overrideComponent(AppsComponent, { set: { template: '<div></div>', imports: [] } });
  const fixture = TestBed.createComponent(AppsComponent);
  fixture.detectChanges();
  return fixture.componentInstance;
}

describe('AppsComponent (catalog filter + a11y)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('starts with the full catalog and no active filters', () => {
    const c = make();
    expect(c.filteredApps().length).toBe(APPS_CATALOG.length);
    expect(c.activeCategories().size).toBe(0);
    expect(c.lifecycle()).toBe('all');
  });

  it('live + soon counts partition the catalog exactly', () => {
    const c = make();
    expect(c.liveCount + c.soonCount).toBe(c.totalCount);
  });

  it('lifecycle="live" keeps only supported apps', () => {
    const c = make();
    c.setLifecycle('live');
    const filtered = c.filteredApps();
    expect(filtered.length).toBe(c.liveCount);
    expect(filtered.every((a) => isAppSupported(a.id))).toBe(true);
  });

  it('lifecycle="soon" keeps only unsupported apps', () => {
    const c = make();
    c.setLifecycle('soon');
    expect(c.filteredApps().every((a) => !isAppSupported(a.id))).toBe(true);
  });

  it('a single checked category narrows to that category only', () => {
    const c = make();
    const cat = APP_CATEGORIES[0].id;
    c.toggleCategory(cat);
    const filtered = c.filteredApps();
    expect(filtered.length).toBe(c.countByCategory(cat));
    expect(filtered.every((a) => a.category === cat)).toBe(true);
  });

  it('multi-select shows the UNION of all checked categories (brief #12)', () => {
    const c = make();
    const a = APP_CATEGORIES[0].id;
    const b = APP_CATEGORIES[1].id;
    c.toggleCategory(a);
    c.toggleCategory(b);
    expect(c.selectedCategoryCount()).toBe(2);
    const filtered = c.filteredApps();
    expect(filtered.length).toBe(c.countByCategory(a) + c.countByCategory(b));
    expect(filtered.every((app) => app.category === a || app.category === b)).toBe(true);
  });

  it('toggling a checked category off removes it from the filter', () => {
    const c = make();
    const a = APP_CATEGORIES[0].id;
    c.toggleCategory(a);
    expect(c.isCategoryActive(a)).toBe(true);
    c.toggleCategory(a);
    expect(c.isCategoryActive(a)).toBe(false);
    expect(c.activeCategories().size).toBe(0);
    expect(c.filteredApps().length).toBe(APPS_CATALOG.length);
  });

  it('clearCategories empties the multi-select back to all', () => {
    const c = make();
    c.toggleCategory(APP_CATEGORIES[0].id);
    c.toggleCategory(APP_CATEGORIES[1].id);
    c.clearCategories();
    expect(c.activeCategories().size).toBe(0);
    expect(c.filteredApps().length).toBe(APPS_CATALOG.length);
  });

  it('toggleCategoryMenu opens + closes the popover', () => {
    const c = make();
    expect(c.categoryMenuOpen()).toBe(false);
    c.toggleCategoryMenu();
    expect(c.categoryMenuOpen()).toBe(true);
    c.closeCategoryMenu();
    expect(c.categoryMenuOpen()).toBe(false);
  });

  it('an active tag narrows to apps that have that EXACT tag (cross-find)', () => {
    const c = make();
    const tag = APPS_CATALOG[0].tags[0];
    c.activeTag.set(tag);
    const filtered = c.filteredApps();
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((a) => a.tags.includes(tag))).withContext('exact tag match').toBeTrue();
  });

  it('clearTag() drops the tag filter back to the full catalog', () => {
    const c = make();
    c.activeTag.set(APPS_CATALOG[0].tags[0]);
    c.clearTag();
    expect(c.activeTag()).toBeNull();
    expect(c.filteredApps().length).toBe(APPS_CATALOG.length);
  });

  it('honours a ?tag= deep link (clicking a tag on an app lands here filtered)', () => {
    const tag = APPS_CATALOG[0].tags[0];
    const c = make(undefined, tag);
    expect(c.activeTag()).toBe(tag);
    expect(c.filteredApps().every((a) => a.tags.includes(tag))).toBeTrue();
  });

  it('search matches by name / tagline / id / tag', () => {
    const c = make();
    const sample = APPS_CATALOG[0];
    c.onSearchChange(sample.name.slice(0, 4));
    expect(c.filteredApps().some((a) => a.id === sample.id)).toBe(true);
  });

  it('a no-match search yields an empty grid + quoted empty title', () => {
    const c = make();
    c.onSearchChange('zzz-no-such-app-zzz');
    expect(c.filteredApps().length).toBe(0);
    expect(c.emptyTitle()).toContain('zzz-no-such-app-zzz');
  });

  it('resultAnnouncement reflects count + query for the live region (a11y)', () => {
    const c = make();
    expect(c.resultAnnouncement()).toBe(`Showing ${APPS_CATALOG.length} apps`);
    c.onSearchChange('zzz-no-such-app-zzz');
    expect(c.resultAnnouncement()).toBe('0 apps match "zzz-no-such-app-zzz"');
  });

  it('clearSearch + resetFilters restore the full catalog', () => {
    const c = make();
    c.toggleCategory(APP_CATEGORIES[0].id);
    c.onSearchChange('x');
    c.resetFilters();
    expect(c.activeCategories().size).toBe(0);
    expect(c.searchQuery()).toBe('');
    expect(c.filteredApps().length).toBe(APPS_CATALOG.length);
  });

  it('honours a single ?category= deep link from the route', () => {
    const validCat = APP_CATEGORIES[0].id;
    const c = make(validCat);
    expect(c.activeCategories().has(validCat)).toBe(true);
    expect(c.selectedCategoryCount()).toBe(1);
  });

  it('honours a comma-separated ?category= multi deep link', () => {
    const a = APP_CATEGORIES[0].id;
    const b = APP_CATEGORIES[1].id;
    const c = make(`${a},${b}`);
    expect(c.activeCategories().has(a)).toBe(true);
    expect(c.activeCategories().has(b)).toBe(true);
    expect(c.selectedCategoryCount()).toBe(2);
  });

  it('ignores an unknown ?category= deep link', () => {
    const c = make('not-a-real-category');
    expect(c.activeCategories().size).toBe(0);
  });
});

import { provideRouter } from '@angular/router';

/**
 * Cyan/black cohesion: the decorative category-chip + infra-pill glyphs must be
 * monochrome stroke SVGs (inherit the chip/pill colour), never the colourful
 * ✨ (U+2728) / ⚡ (U+26A1) emoji — both emoji-presentation by default.
 */
describe('AppsComponent (decorative glyphs are SVGs, not colourful emoji)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders the All-chip glyph as an SVG + leaks no ✨/⚡ emoji into the catalog', () => {
    TestBed.configureTestingModule({
      imports: [AppsComponent],
      providers: [
        APPS_API_PROVIDER,
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { queryParamMap: of(convertToParamMap({})) } },
      ],
    });
    const fx = TestBed.createComponent(AppsComponent);
    fx.detectChanges();
    const host = fx.nativeElement as HTMLElement;

    // Scope to the two DECORATIVE chrome glyphs only — the per-app/per-service
    // catalog glyphs (🐘/⚡/… on individual apps) are a separate deliberate icon
    // set (a big refactor with semantic loss), out of scope here.
    const chipGlyph = host.querySelector('.chip-glyph');
    expect(chipGlyph).withContext('All-chip glyph present').not.toBeNull();
    expect(chipGlyph?.querySelector('svg')).withContext('chip glyph is an SVG').not.toBeNull();
    expect(chipGlyph?.textContent ?? '').withContext('no ✨ emoji in the chip glyph').not.toContain('✨');
    host.querySelectorAll('.infra-pill--bare .infra-glyph').forEach((g) => {
      expect(g.querySelector('svg')).withContext('Stateless glyph is an SVG').not.toBeNull();
      expect(g.textContent ?? '').withContext('no ⚡ emoji in the Stateless glyph').not.toContain('⚡');
    });
  });
});

/**
 * a11y: the catalog grid is the primary content — a screen-reader user needs a
 * "list of N items" cue + per-card "item X of N" position. CSS `display:grid`
 * strips the implicit list role, so the grid carries an explicit `role="list"`
 * and every card carries `role="listitem"`. Without it, the grid reads as an
 * undifferentiated wall of links with no count/position affordance.
 */
describe('AppsComponent (catalog grid has semantic list markup)', () => {
  afterEach(() => TestBed.resetTestingModule());

  function render(): HTMLElement {
    TestBed.configureTestingModule({
      imports: [AppsComponent],
      providers: [
        APPS_API_PROVIDER,
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { queryParamMap: of(convertToParamMap({})) } },
      ],
    });
    const fx = TestBed.createComponent(AppsComponent);
    fx.detectChanges();
    return fx.nativeElement as HTMLElement;
  }

  it('exposes the apps grid as a list', () => {
    const host = render();
    const grid = host.querySelector('.apps-grid');
    expect(grid).withContext('apps grid present').not.toBeNull();
    expect(grid?.getAttribute('role')).withContext('grid is role=list').toBe('list');
  });

  it('exposes every catalog card as a listitem matching the visible card count', () => {
    const host = render();
    const cards = Array.from(host.querySelectorAll('.app-card'));
    expect(cards.length).withContext('at least one card rendered').toBeGreaterThan(0);
    cards.forEach((card) =>
      expect(card.getAttribute('role')).withContext('card is role=listitem').toBe('listitem'),
    );
    expect(host.querySelectorAll('.apps-grid [role="listitem"]').length).toBe(cards.length);
  });
});

/**
 * Display-correctness: a CF-native app (image `cf-native:*` — a real Worker on
 * D1 + R2, NO container) must NOT advertise container-only metadata on its card.
 * The RAM/Memory pill is meaningless for a serverless Worker; showing "128 MiB"
 * for Payload is misleading. Instead the card shows a concise
 * "CF-native · D1 + R2 + Worker — no container" badge. Container apps are
 * unchanged (RAM pill still shows).
 */
describe('AppsComponent (CF-native cards hide container metadata)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('isCfNative() is true only for image "cf-native:*"', () => {
    const c = make();
    const cfNative = APPS_CATALOG.find((a) => a.image.startsWith('cf-native:'));
    const container = APPS_CATALOG.find((a) => !a.image.startsWith('cf-native:'));
    expect(cfNative).withContext('a cf-native app exists in the catalog').toBeTruthy();
    expect(container).withContext('a container app exists in the catalog').toBeTruthy();
    expect(c.isCfNative(cfNative!)).toBeTrue();
    expect(c.isCfNative(container!)).toBeFalse();
  });

  function render(lifecycle?: 'all' | 'live' | 'soon'): HTMLElement {
    TestBed.configureTestingModule({
      imports: [AppsComponent],
      providers: [
        APPS_API_PROVIDER,
        provideRouter([{ path: '**', children: [] }]),
        { provide: ActivatedRoute, useValue: { queryParamMap: of(convertToParamMap({})) } },
      ],
    });
    const fx = TestBed.createComponent(AppsComponent);
    if (lifecycle) fx.componentInstance.setLifecycle(lifecycle);
    fx.detectChanges();
    return fx.nativeElement as HTMLElement;
  }

  it('a CF-native card shows the "no container" badge and NO RAM/MiB pill', () => {
    const host = render();
    const cfNative = APPS_CATALOG.find((a) => a.image.startsWith('cf-native:'))!;
    const card = host.querySelector(`[data-testid="apps-card-${cfNative.id}"]`);
    expect(card).withContext('cf-native card rendered').not.toBeNull();
    const badge = card!.querySelector('[data-testid="apps-cfnative-badge"]');
    expect(badge).withContext('cf-native badge present on card').not.toBeNull();
    expect(badge!.textContent ?? '').toContain('no container');
    expect(card!.querySelector('.mem-pill')).withContext('no RAM pill on cf-native card').toBeNull();
    expect(card!.textContent ?? '').withContext('no MiB text on cf-native card').not.toContain('MiB');
  });

  it('a container card still shows the RAM/MiB pill and NO cf-native badge', () => {
    const host = render();
    const container = APPS_CATALOG.find((a) => !a.image.startsWith('cf-native:'))!;
    const card = host.querySelector(`[data-testid="apps-card-${container.id}"]`);
    expect(card).withContext('container card rendered').not.toBeNull();
    expect(card!.querySelector('.mem-pill')).withContext('RAM pill present on container card').not.toBeNull();
    expect(card!.textContent ?? '').toContain('MiB');
    expect(card!.querySelector('[data-testid="apps-cfnative-badge"]'))
      .withContext('no cf-native badge on a container card')
      .toBeNull();
  });
});

/**
 * §17 (apps-filter delayed reveal): result cards must NOT carry `appReveal`.
 * `appReveal` starts a host at opacity:0 + translateY(16px) and animates it in —
 * a first-paint flourish. On the LIVE-filtered `@for (app of filteredApps())`
 * grid, that re-hides + re-animates every freshly-matched card on each filter
 * keystroke, so the list appears to "disappear / wait on stale animations".
 * First-paint reveal stays on the static header/result-bar; result cards render
 * IMMEDIATELY at full opacity. This guard locks that (real-DOM render).
 *
 * Lesson (banked to ~/.agentskills): animated filter/result lists need an
 * immediate-visible-state test — never put a from-hidden enter animation on a
 * per-item loop that re-renders on filter change.
 */
describe('AppsComponent (filter reveal — §17 immediate-visible-state)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('does NOT put appReveal on the per-card @for loop (cards render immediately on filter)', () => {
    TestBed.configureTestingModule({
      imports: [AppsComponent],
      providers: [
        APPS_API_PROVIDER,
        provideRouter([{ path: '**', children: [] }]),
        { provide: ActivatedRoute, useValue: { queryParamMap: of(convertToParamMap({})) } },
      ],
    });
    const fixture = TestBed.createComponent(AppsComponent);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelectorAll('.app-card').length)
      .withContext('catalog renders cards')
      .toBeGreaterThan(0);
    expect(host.querySelector('.app-card[appReveal]'))
      .withContext('result cards must not re-reveal on every filter change')
      .toBeNull();
    // First-paint reveal still lives on the static shell (cohesion preserved).
    expect(host.querySelector('[appReveal]'))
      .withContext('static header/result-bar keep first-paint reveal')
      .not.toBeNull();
  });
});
