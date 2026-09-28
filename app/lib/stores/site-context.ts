import { atom } from 'nanostores';

/**
 * Persistence keys for the active site context. The editor iframe frequently
 * re-loads WITHOUT the `?slug=` query — e.g. reopening a persisted chat at
 * `/chat/{id}`, or an in-app navigation that drops the param — which used to
 * leave the Preview address bar with NO domain (it renders only when a slug is
 * known). Persisting the last-known slug/host to the iframe origin's
 * localStorage lets the address bar recover the site URL on any reload, so it's
 * shown as soon as the editor has EVER been booted for a site. (Brian 2026-09-28.)
 */
const SLUG_KEY = 'ps.editor.siteSlug';
const HOST_KEY = 'ps.editor.primaryHost';

/** Fail-soft localStorage read — SSR (no `localStorage`), private-mode, and opaque-origin safe. */
function readPersisted(key: string): string | undefined {
  try {
    if (typeof localStorage === 'undefined') {
      return undefined;
    }

    const value = localStorage.getItem(key);

    return value && value.trim().length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Fail-soft localStorage write/remove — never throws (private mode / quota / opaque origin). */
function writePersisted(key: string, value: string | undefined): void {
  try {
    if (typeof localStorage === 'undefined') {
      return;
    }

    if (value) {
      localStorage.setItem(key, value);
    } else {
      localStorage.removeItem(key);
    }
  } catch {
    /* persistence is best-effort — a failed write must never break the editor */
  }
}

/**
 * The slug of the projectsites.dev site currently open in the editor.
 *
 * Published by {@link ../../components/chat/Chat.client} the moment the slug is
 * known — from the `?slug=` query the admin opens the editor with, or from the
 * `PS_*` embed messages the parent posts. Initialized from persisted localStorage
 * so it survives a chat reopen / reload that carries no `?slug=`. `undefined` only
 * when the editor has never been booted for a site (true standalone).
 */
export const siteSlugAtom = atom<string | undefined>(readPersisted(SLUG_KEY));

/**
 * Publish (or clear) the active site slug + persist it. Trims + treats blank as
 * absent so the Preview address bar never renders an empty `.projectsites.dev` host.
 *
 * @param slug - The site slug, or `undefined`/blank to clear.
 * @example
 * setSiteSlug('russ-and-daughters'); // siteSlugAtom → 'russ-and-daughters' (+ persisted)
 * setSiteSlug('   ');                 // siteSlugAtom → undefined
 */
export function setSiteSlug(slug: string | null | undefined): void {
  const next = typeof slug === 'string' ? slug.trim() : '';
  const value = next.length > 0 ? next : undefined;
  siteSlugAtom.set(value);
  writePersisted(SLUG_KEY, value);
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
export function primarySiteUrl(slug: string | undefined, primaryHost?: string | undefined): string | undefined {
  /*
   * Prefer the site's ACTUAL primary hostname (a custom/attached domain) when the admin supplies it, so
   * the Preview address bar reflects the REAL public URL instead of always the default slug host. Falls
   * back to `{slug}.projectsites.dev` when no primary host is known yet.
   */
  const host = primaryHost
    ?.trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');

  if (host) {
    return `https://${host}`;
  }

  if (!slug) {
    return undefined;
  }

  return `https://${slug}.projectsites.dev`;
}

/**
 * The site's ACTUAL primary hostname (a custom/attached domain), published by the admin over the
 * `?primaryHost=` bootstrap / PS bridge. Initialized from persisted localStorage so it survives a
 * reload; {@link primarySiteUrl} falls back to the default slug host when absent.
 */
export const primaryHostAtom = atom<string | undefined>(readPersisted(HOST_KEY));

/** Publish (or clear) the site's primary hostname + persist it (strips scheme + trailing slash; blank → undefined). */
export function setPrimaryHost(host: string | null | undefined): void {
  const next = (host ?? '')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  const value = next.length > 0 ? next : undefined;
  primaryHostAtom.set(value);
  writePersisted(HOST_KEY, value);
}
