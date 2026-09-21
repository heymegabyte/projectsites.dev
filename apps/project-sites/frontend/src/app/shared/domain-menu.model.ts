/**
 * domain-menu.model.ts — pure model builder for the NAVBAR URL / DOMAIN picker (Brian's
 * repeatedly-named item). The navbar dropdown shows the site's live URL and lets the owner pick /
 * activate a domain. This is the pure brain the Angular component renders:
 *
 *  - a synthesized DEFAULT row `{slug}.projectsites.dev` (always present, home-glyph, link-out),
 *  - one row per CUSTOM hostname (primary toggle + a ⋯ action menu: set-primary / unsubscribe / remove),
 *  - a "Connect a custom domain — $17/mo" CTA row merged into the same menu.
 *
 * Feeds off the existing hostname API (`GET /api/sites/:siteId/hostnames`,
 * `PUT …/hostnames/:id/primary`, `POST …/hostnames/reset-primary`, `POST …/:id/unsubscribe`,
 * `DELETE …/:id`). Pure — data in, menu model out; the component does the fetch (SWR-cached) + renders.
 * Values are sanitized (slug + host char-gated) so user content never lands in an unsafe href/DOM.
 */

/** Provisioning state of a custom hostname (from the hostnames API). */
export type HostnameStatus = 'active' | 'pending' | 'provisioning' | 'error' | (string & {});

/** A hostname row as returned by `GET /api/sites/:siteId/hostnames`. */
export interface HostnameRecord {
  id: string;
  hostname: string;
  isPrimary?: boolean;
  status?: HostnameStatus;
}

/** An action offered in a row's ⋯ menu. */
export type DomainRowAction = 'set_primary' | 'unsubscribe' | 'remove' | 'connect_custom';

export type DomainRowKind = 'default' | 'custom' | 'cta';

export interface DomainMenuRow {
  kind: DomainRowKind;
  /** Stable key for @for tracking. */
  key: string;
  /** Display label (the host, or the CTA text). */
  label: string;
  /** Absolute https URL to open (null for the CTA row). */
  url: string | null;
  isPrimary: boolean;
  status: HostnameStatus | null;
  /** Show the home glyph (the default subdomain row). */
  homeGlyph: boolean;
  /** ⋯ menu actions available on this row, in display order. */
  actions: DomainRowAction[];
  /** For the CTA row: the monthly price to surface. */
  priceMonthly?: number;
}

export interface DomainMenuModel {
  rows: DomainMenuRow[];
  /** The URL the navbar shows as the live/primary link. */
  primaryUrl: string;
  /** The synthesized default subdomain, always available. */
  defaultUrl: string;
  /** True when a custom-domain CTA row is present (no active custom primary yet). */
  showConnectCta: boolean;
}

export interface DomainMenuOptions {
  /** Base domain for the synthesized default (default `projectsites.dev`). */
  baseDomain?: string;
  /** Monthly custom-domain price to surface on the CTA (default 17). */
  customDomainPriceMonthly?: number;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HOST_RE = /^[a-z0-9.-]{1,253}$/i;

/** Sanitized default subdomain for a slug, e.g. `acme.projectsites.dev` — '' when the slug is invalid. */
export function defaultSubdomain(slug: string, baseDomain = 'projectsites.dev'): string {
  const s = String(slug ?? '').trim().toLowerCase();
  return SLUG_RE.test(s) ? `${s}.${baseDomain}` : '';
}

/** The ⋯ actions for one custom hostname: set-primary only when active + not already primary. */
function actionsFor(h: HostnameRecord): DomainRowAction[] {
  const acts: DomainRowAction[] = [];
  if (!h.isPrimary && (h.status ?? 'active') === 'active') acts.push('set_primary');
  acts.push('unsubscribe', 'remove');
  return acts;
}

/**
 * Build the navbar domain-menu model from the site's slug + its custom hostnames. The default
 * `{slug}.projectsites.dev` row is always synthesized and is primary UNLESS an active custom hostname
 * is primary. A "Connect a custom domain — $Nmo" CTA row is appended when there's no active custom
 * primary. Pure, never throws; invalid slugs/hosts are dropped safely.
 *
 * @param slug - the site slug
 * @param hostnames - custom hostname records from the API (may be empty/undefined)
 * @param opts - base domain + CTA price overrides
 * @returns the {@link DomainMenuModel} the navbar renders
 * @example buildDomainMenu('acme', []).primaryUrl // 'https://acme.projectsites.dev'
 * @example buildDomainMenu('acme', [{ id:'h1', hostname:'acme.com', isPrimary:true, status:'active' }]).primaryUrl // 'https://acme.com'
 */
export function buildDomainMenu(
  slug: string,
  hostnames: readonly HostnameRecord[] | null | undefined,
  opts: DomainMenuOptions = {},
): DomainMenuModel {
  const base = opts.baseDomain ?? 'projectsites.dev';
  const price = opts.customDomainPriceMonthly ?? 17;
  const sub = defaultSubdomain(slug, base);
  const defaultUrl = sub ? `https://${sub}` : `https://${base}`;

  const customs = (hostnames ?? []).filter((h) => h && HOST_RE.test(String(h.hostname ?? '')));
  const activePrimaryCustom = customs.find((h) => h.isPrimary && (h.status ?? 'active') === 'active');

  const rows: DomainMenuRow[] = [];

  // 1. Synthesized default subdomain — always present, home glyph, primary unless a custom primary is active.
  rows.push({
    kind: 'default',
    key: 'default',
    label: sub || base,
    url: defaultUrl,
    isPrimary: !activePrimaryCustom,
    status: 'active',
    homeGlyph: true,
    actions: activePrimaryCustom ? ['set_primary'] : [],
  });

  // 2. Custom hostnames.
  for (const h of customs) {
    rows.push({
      kind: 'custom',
      key: h.id,
      label: h.hostname,
      url: `https://${h.hostname}`,
      isPrimary: !!h.isPrimary,
      status: h.status ?? 'active',
      homeGlyph: false,
      actions: actionsFor(h),
    });
  }

  // 3. Connect-custom-domain CTA (merged wallet CTA) — shown until an active custom primary exists.
  const showConnectCta = !activePrimaryCustom;
  if (showConnectCta) {
    rows.push({
      kind: 'cta',
      key: 'connect-cta',
      label: 'Connect a custom domain',
      url: null,
      isPrimary: false,
      status: null,
      homeGlyph: false,
      actions: ['connect_custom'],
      priceMonthly: price,
    });
  }

  return {
    rows,
    primaryUrl: activePrimaryCustom ? `https://${activePrimaryCustom.hostname}` : defaultUrl,
    defaultUrl,
    showConnectCta,
  };
}
