/**
 * Pure decision + URL builder for the "preview your already-built site" affordance on
 * the homepage hero search AND the /search page. Extracted from the page components so
 * the logic is deterministically unit-testable (mirrors the `create-funnel-nav` pattern).
 *
 * The product headline is "Your business website, already built and ready to claim." A
 * guest who searches and finds a PRE-BUILT result must be able to SEE that site is real
 * and gorgeous BEFORE the sign-in wall — the single most persuasive conversion moment.
 * Before this, clicking a prebuilt result routed straight to /signin, so the "already
 * built" proof was hidden behind auth. This helper gates a Preview link that opens the
 * live `{slug}.projectsites.dev` in a new tab; the card's primary click still routes to
 * the claim/sign-in funnel (proof-then-commit).
 */

/** The subset of a search result this helper reasons about. */
export interface PreviewableItem {
  /** Result kind — only `prebuilt` can be previewed. */
  readonly type: 'business' | 'prebuilt' | 'custom';
  /** The site's subdomain label, when it is a delivered site. */
  readonly slug?: string;
  /** The site's status; only a `published` (live) site is worth previewing. */
  readonly status?: string;
}

/** A slug must be a valid single subdomain label before we build a URL from it. */
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Whether a search result exposes a live site the guest can preview.
 *
 * True ONLY for a `prebuilt` result with a valid slug and `status === 'published'` — a
 * `building`/`draft`/`error` prebuilt has no live site yet, so previewing it would show a
 * 404 or a half-built page (a worse first impression than no preview at all).
 *
 * @param item - the search result to test.
 * @returns true when a Preview affordance should render for this result.
 * @example
 * canPreviewPrebuilt({ type: 'prebuilt', slug: 'acme-cafe', status: 'published' }); // true
 * canPreviewPrebuilt({ type: 'prebuilt', slug: 'acme-cafe', status: 'building' });   // false
 * canPreviewPrebuilt({ type: 'business', slug: undefined, status: undefined });      // false
 */
export function canPreviewPrebuilt(item: PreviewableItem | null | undefined): boolean {
  if (!item || item.type !== 'prebuilt' || item.status !== 'published') return false;
  return SLUG_RE.test((item.slug ?? '').trim().toLowerCase());
}

/**
 * Build the public URL for a delivered site's live preview.
 *
 * Returns `''` for an invalid/blank slug (defense-in-depth — never emit an `href` built
 * from an untrusted value); callers pair this with {@link canPreviewPrebuilt} so an empty
 * string is never rendered.
 *
 * @param slug - the site's subdomain label.
 * @returns `https://{slug}.projectsites.dev`, or `''` when the slug is invalid.
 * @example
 * prebuiltPreviewUrl('acme-cafe'); // 'https://acme-cafe.projectsites.dev'
 * prebuiltPreviewUrl('  ');        // ''
 */
export function prebuiltPreviewUrl(slug: string | undefined | null): string {
  const clean = (slug ?? '').trim().toLowerCase();
  return SLUG_RE.test(clean) ? `https://${clean}.projectsites.dev` : '';
}
