/**
 * @module pages/admin/navigation/admin-nav.model
 *
 * The SINGLE typed source of truth for the admin sidebar navigation. Every
 * presentation (mobile drawer, 72px compact rail, 272px expanded sidebar)
 * renders from this one model — the markup is never duplicated per form factor.
 *
 * Router owns active-state: the templates bind `routerLinkActive` /
 * `ariaCurrentWhenActive` off each item's {@link AdminNavItem.route}, so
 * back/forward, nested routes, and route prefixes light the correct item
 * without any manually-maintained boolean.
 *
 * Icons are keys into {@link NavIconComponent}'s inline-SVG registry (the app
 * ships no icon font/library — icons are hand-authored Lucide-weight SVGs), so
 * the model stays serialisable + unit-testable without touching the DOM.
 *
 * Keep this in lockstep with the admin child routes in `app.routes.ts` and the
 * route→label map in `admin-section-labels.ts` (same labels, same routes).
 */

/** Icon registry keys — one per {@link NavIconComponent} `@switch` branch. */
export type NavIconName =
  | 'dashboard'
  | 'editor'
  | 'snapshots'
  | 'analytics'
  | 'forms'
  | 'apps'
  | 'features'
  | 'social'
  | 'voice'
  | 'logs'
  | 'feature-flags'
  | 'leads'
  | 'system-services'
  | 'docs'
  | 'settings'
  | 'super-admin';

/** One navigable admin destination. */
export interface AdminNavItem {
  /** Stable id — used for `@for` tracking + `data-testid` fallback. */
  readonly id: string;
  /** Human label — shown expanded, and used verbatim as the rail tooltip. */
  readonly label: string;
  /** Icon registry key. */
  readonly icon: NavIconName;
  /** Router path (every current item is directly navigable). */
  readonly route?: string;
  /** Exact route match (Dashboard `/admin` must not stay active on `/admin/*`). */
  readonly exact?: boolean;
  /** Cyan-tinted "home" emphasis (Dashboard). */
  readonly accent?: boolean;
  /** Operator-only — hidden unless the signed-in identity is a platform sys-admin. */
  readonly sysAdminOnly?: boolean;
  /** Explicit `data-testid` (falls back to `nav-<id>` when absent). */
  readonly testid?: string;
}

/** A labelled section of the sidebar (e.g. "Workspace", "Operations"). */
export interface AdminNavGroup {
  readonly id: string;
  readonly label: string;
  readonly items: readonly AdminNavItem[];
}

/**
 * The admin navigation, faithfully mirroring the prior hand-authored sidebar
 * (`admin.component.html`) — same routes, same order, same operator gating,
 * same labels. Do not add a route here without adding it to `app.routes.ts`.
 */
export const ADMIN_NAV_GROUPS: readonly AdminNavGroup[] = [
  {
    id: 'workspace',
    items: [
      {
        accent: true,
        exact: true,
        icon: 'dashboard',
        id: 'dashboard',
        label: 'Dashboard',
        route: '/admin',
      },
      { icon: 'editor', id: 'editor', label: 'Editor', route: '/admin/editor' },
      { icon: 'snapshots', id: 'snapshots', label: 'Snapshots', route: '/admin/snapshots' },
      { icon: 'analytics', id: 'analytics', label: 'Analytics', route: '/admin/analytics' },
    ],
    label: 'Workspace',
  },
  {
    id: 'capabilities',
    items: [
      { icon: 'forms', id: 'forms', label: 'Forms', route: '/admin/forms' },
      { icon: 'apps', id: 'apps', label: 'Apps', route: '/admin/apps' },
      {
        icon: 'features',
        id: 'features',
        label: 'Features',
        route: '/admin/site-features',
        testid: 'nav-features',
      },
      { icon: 'social', id: 'social', label: 'Social', route: '/admin/social' },
      { icon: 'voice', id: 'voice', label: 'Voice', route: '/admin/voice' },
    ],
    label: 'Capabilities',
  },
  {
    id: 'operations',
    items: [
      { icon: 'logs', id: 'logs', label: 'Logs', route: '/admin/logs' },
      {
        icon: 'feature-flags',
        id: 'feature-flags',
        label: 'Feature Flags',
        route: '/admin/feature-flags',
        sysAdminOnly: true,
        testid: 'nav-system-admin',
      },
      {
        icon: 'leads',
        id: 'leads',
        label: 'Lead Scanner',
        route: '/admin/leads',
        sysAdminOnly: true,
        testid: 'nav-lead-scanner',
      },
      {
        icon: 'system-services',
        id: 'system-services',
        label: 'System Services',
        route: '/admin/system-services',
        sysAdminOnly: true,
        testid: 'nav-system-services',
      },
      {
        // KV Inspector — read-only platform KV browser. Component + route shipped
        // (a00e1143e) but was never nav-linked → reachable only by typing the URL.
        icon: 'system-services',
        id: 'kv-inspector',
        label: 'KV Inspector',
        route: '/admin/kv-inspector',
        sysAdminOnly: true,
        testid: 'nav-kv-inspector',
      },
      {
        // R2 Inspector — read-only platform R2 object browser. Same built-but-unwired
        // gap as KV; wired here so both shipped data-resource inspectors are discoverable.
        icon: 'system-services',
        id: 'r2-inspector',
        label: 'R2 Inspector',
        route: '/admin/r2-inspector',
        sysAdminOnly: true,
        testid: 'nav-r2-inspector',
      },
      {
        // Vectorize Inspector — read-only vector-index browser. Shipped but un-nav-linked.
        icon: 'system-services',
        id: 'vectorize-inspector',
        label: 'Vectorize Inspector',
        route: '/admin/vectorize-inspector',
        sysAdminOnly: true,
        testid: 'nav-vectorize-inspector',
      },
      {
        // Queues Inspector — read-only queue/backlog browser. Shipped but un-nav-linked.
        icon: 'system-services',
        id: 'queues-inspector',
        label: 'Queues Inspector',
        route: '/admin/queues-inspector',
        sysAdminOnly: true,
        testid: 'nav-queues-inspector',
      },
    ],
    label: 'Operations',
  },
  {
    id: 'account',
    items: [
      { icon: 'docs', id: 'docs', label: 'Docs', route: '/admin/docs' },
      { icon: 'settings', id: 'settings', label: 'Settings', route: '/admin/settings' },
      // Previously tucked inside a "More tools" disclosure — promoted to a
      // first-class Account destination (route unchanged) so it renders cleanly
      // in every mode without an overflow-clipped rail flyout.
      { icon: 'super-admin', id: 'super-admin', label: 'Super admin', route: '/admin/super-admin' },
    ],
    label: 'Account',
  },
] as const;

/**
 * Filter the nav for a given viewer: drop operator-only items for non-sys-admins,
 * then drop any now-empty group. Pure + deterministic — unit-tested and safe to
 * call inside a computed signal.
 */
export function visibleNavGroups(
  groups: readonly AdminNavGroup[],
  isSysAdmin: boolean,
): AdminNavGroup[] {
  return groups
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.sysAdminOnly || isSysAdmin) }))
    .filter((g) => g.items.length > 0);
}

/** The `data-testid` for a nav item — explicit `testid` or the `nav-<id>` default. */
export function navItemTestId(item: AdminNavItem): string {
  return item.testid ?? `nav-${item.id}`;
}

/** Every route reachable from the nav model (for coverage/lockstep tests). */
export function allNavRoutes(groups: readonly AdminNavGroup[] = ADMIN_NAV_GROUPS): string[] {
  const out: string[] = [];
  for (const g of groups) for (const i of g.items) if (i.route) out.push(i.route);
  return out;
}
