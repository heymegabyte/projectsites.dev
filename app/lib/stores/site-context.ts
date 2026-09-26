import { atom } from 'nanostores';

/**
 * The slug of the projectsites.dev site currently open in the editor.
 *
 * Published by {@link ../../components/chat/Chat.client} the moment the slug is
 * known — from the `?slug=` query the admin opens the editor with, or from the
 * `PS_*` embed messages the parent posts. `undefined` when the editor is running
 * standalone (no site context).
 */
export const siteSlugAtom = atom<string | undefined>(undefined);

/**
 * Publish (or clear) the active site slug. Trims + treats blank as absent so the
 * Preview address bar never renders an empty `.projectsites.dev` host.
 *
 * @param slug - The site slug, or `undefined`/blank to clear.
 * @example
 * setSiteSlug('russ-and-daughters'); // siteSlugAtom → 'russ-and-daughters'
 * setSiteSlug('   ');                 // siteSlugAtom → undefined
 */
export function setSiteSlug(slug: string | null | undefined): void {
  const next = typeof slug === 'string' ? slug.trim() : '';
  siteSlugAtom.set(next.length > 0 ? next : undefined);
}

/**
 * The site's primary public URL base (no trailing slash, no path) for a slug —
 * the URL the finished site is served at. Used as the read-only prefix in the
 * Preview address bar so the path the user browses reads like the real URL.
 *
 * @param slug - The site slug (from {@link siteSlugAtom}).
 * @returns `https://<slug>.projectsites.dev`, or `undefined` when slug is absent.
 * @example
 * primarySiteUrl('russ-and-daughters'); // "https://russ-and-daughters.projectsites.dev"
 * primarySiteUrl(undefined);            // undefined
 */
export function primarySiteUrl(slug: string | undefined): string | undefined {
  if (!slug) {
    return undefined;
  }

  return `https://${slug}.projectsites.dev`;
}
