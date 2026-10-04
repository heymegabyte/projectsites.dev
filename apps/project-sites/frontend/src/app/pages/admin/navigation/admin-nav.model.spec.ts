/**
 * @module pages/admin/navigation/admin-nav.model.spec
 *
 * Locks the ONE nav model: every advertised admin route stays present, operator
 * gating is honoured, and the group structure the three presentations rely on
 * holds. A regression here means a sidebar destination silently vanished.
 */
import {
  ADMIN_NAV_GROUPS,
  visibleNavGroups,
  navItemTestId,
  allNavRoutes,
  type AdminNavItem,
} from './admin-nav.model';

describe('admin-nav.model', () => {
  it('groups the nav in the intended order', () => {
    expect(ADMIN_NAV_GROUPS.map((g) => g.id)).toEqual([
      'workspace',
      'capabilities',
      'operations',
      'account',
    ]);
  });

  it('preserves every admin destination (routes never silently dropped)', () => {
    const routes = allNavRoutes();
    for (const r of [
      '/admin',
      '/admin/sites',
      '/admin/editor',
      '/admin/snapshots',
      '/admin/analytics',
      '/admin/forms',
      '/admin/apps',
      '/admin/site-features',
      '/admin/social',
      '/admin/voice',
      '/admin/logs',
      '/admin/feature-flags',
      '/admin/leads',
      '/admin/system-services',
      '/admin/kv-inspector',
      '/admin/r2-inspector',
      '/admin/vectorize-inspector',
      '/admin/queues-inspector',
      '/admin/docs',
      '/admin/billing',
      '/admin/settings',
      '/admin/super-admin',
    ]) {
      expect(routes).withContext(`missing route ${r}`).toContain(r);
    }
  });

  it('every item carries a route, a label, and an icon', () => {
    for (const g of ADMIN_NAV_GROUPS) {
      for (const i of g.items) {
        expect(i.route).withContext(`${i.id} route`).toBeTruthy();
        expect(i.label.length).withContext(`${i.id} label`).toBeGreaterThan(0);
        expect(i.icon).withContext(`${i.id} icon`).toBeTruthy();
      }
    }
  });

  it('has exactly one exact-match, accented home item (Dashboard)', () => {
    const flat = ADMIN_NAV_GROUPS.flatMap((g) => g.items);
    const exacts = flat.filter((i) => i.exact);
    expect(exacts.length).toBe(1);
    expect(exacts[0]?.id).toBe('dashboard');
    expect(exacts[0]?.accent).toBeTrue();
    expect(exacts[0]?.route).toBe('/admin');
  });

  // DEFECT-A (money-funnel top): `/create` — the START of the revenue funnel — was
  // reachable only by typing the URL. The sidebar MUST carry an obvious one-click
  // Create entry, testid `nav-create`, as the visually-dominant primary CTA.
  describe('Create CTA (nav-create — money-funnel top)', () => {
    const flat = ADMIN_NAV_GROUPS.flatMap((g) => g.items);
    const create = flat.find((i) => i.id === 'create');

    it('exists as a nav item', () => {
      expect(create).withContext('create nav item must exist').toBeTruthy();
    });

    it('carries the nav-create testid', () => {
      expect(navItemTestId(create!)).toBe('nav-create');
    });

    it('routes to the admin create overlay (/admin/create, masked to /create)', () => {
      expect(create!.route).toBe('/admin/create');
      expect(allNavRoutes()).toContain('/admin/create');
    });

    it('is flagged the primary CTA (cyan-accent) and labelled for a non-technical owner', () => {
      expect(create!.cta).withContext('create must be the primary CTA').toBeTrue();
      expect(create!.label).toBe('New site');
    });

    it('is the FIRST item in the workspace group (top of the funnel, top of the nav)', () => {
      const workspace = ADMIN_NAV_GROUPS.find((g) => g.id === 'workspace');
      expect(workspace?.items[0]?.id).toBe('create');
    });

    it('is visible to every viewer (never operator-gated)', () => {
      const routes = allNavRoutes(visibleNavGroups(ADMIN_NAV_GROUPS, false));
      expect(routes).toContain('/admin/create');
    });
  });

  describe('visibleNavGroups()', () => {
    const sysAdminRoutes = ['/admin/feature-flags', '/admin/leads', '/admin/system-services'];

    it('hides operator-only items from non-sys-admins', () => {
      const routes = allNavRoutes(visibleNavGroups(ADMIN_NAV_GROUPS, false));
      for (const r of sysAdminRoutes) expect(routes).not.toContain(r);
      // …but keeps every non-operator destination.
      expect(routes).toContain('/admin/logs');
      expect(routes).toContain('/admin/settings');
    });

    it('shows operator-only items to sys-admins', () => {
      const routes = allNavRoutes(visibleNavGroups(ADMIN_NAV_GROUPS, true));
      for (const r of sysAdminRoutes) expect(routes).toContain(r);
    });

    it('drops a group that becomes empty after filtering', () => {
      const groups = [
        {
          id: 'ops',
          label: 'Ops',
          items: [
            { id: 'x', label: 'X', icon: 'logs', route: '/x', sysAdminOnly: true } as AdminNavItem,
          ],
        },
      ];
      expect(visibleNavGroups(groups, false)).toEqual([]);
      expect(visibleNavGroups(groups, true).length).toBe(1);
    });

    it('is pure — never mutates the source model', () => {
      const before = JSON.stringify(ADMIN_NAV_GROUPS);
      visibleNavGroups(ADMIN_NAV_GROUPS, false);
      expect(JSON.stringify(ADMIN_NAV_GROUPS)).toBe(before);
    });
  });

  describe('navItemTestId()', () => {
    it('uses an explicit testid when present', () => {
      expect(
        navItemTestId({
          id: 'features',
          label: 'Features',
          icon: 'features',
          route: '/x',
          testid: 'nav-features',
        }),
      ).toBe('nav-features');
    });
    it('falls back to nav-<id>', () => {
      expect(navItemTestId({ id: 'voice', label: 'Voice', icon: 'voice', route: '/x' })).toBe(
        'nav-voice',
      );
    });
  });
});
