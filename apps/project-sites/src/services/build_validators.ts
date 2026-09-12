/**
 * Build validators — programmatic enforcement of post-build quality gates.
 *
 * Runs after the container uploads to R2 and before D1 status flips to `published`.
 * Each gate maps 1:1 to a BUILD-BREAKING entry in skill 15 quality-gates.md.
 *
 * Modes: `strict` throws on any error-severity violation (site stays `error`);
 * `report` collects violations to the D1 audit and never throws.
 */

export type Severity = 'error' | 'warn' | 'info';

export interface Violation {
  code: string;
  severity: Severity;
  message: string;
  file?: string;
  detail?: string;
}

export interface BuildFile {
  /** Path relative to dist root, e.g. "index.html", "assets/index-abc.js" */
  path: string;
  /** Decoded text content for HTML/JS/CSS/JSON/XML/SVG/TXT, undefined for binary */
  text?: string;
  size: number;
}

export interface ValidationReport {
  ok: boolean;
  errors: Violation[];
  warnings: Violation[];
  infos: Violation[];
  summary: string;
}

const BANNED_WORDS = [
  'limitless',
  'revolutionize',
  'game-changing',
  'cutting-edge',
  'next-generation',
  'world-class',
  'best-in-class',
  'turnkey',
  'synergy',
  'leverage',
  'utilize',
  'seamless',
  'robust',
  'state-of-the-art',
  'paradigm',
  'holistic',
  'spearhead',
  'tapestry',
  'plethora',
  'myriad',
  'supercharge',
];

const ALLOWED_EXTERNAL_HOSTS = new Set([
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'images.unsplash.com',
  'images.pexels.com',
  'res.cloudinary.com',
  'api.mapbox.com',
  'www.google.com',
  'maps.googleapis.com',
  'cdn.jsdelivr.net',
  'unpkg.com',
  'i.ytimg.com',
  'img.youtube.com',
  'www.youtube.com',
  'player.vimeo.com',
  'www.gstatic.com',
  'projectsites.dev',
]);

const HTML_EXTENSIONS = ['.html', '.htm'];
const TEXT_EXTENSIONS = [
  '.html',
  '.htm',
  '.css',
  '.js',
  '.mjs',
  '.json',
  '.xml',
  '.txt',
  '.svg',
  '.webmanifest',
];

const isHtml = (p: string) => HTML_EXTENSIONS.some((e) => p.toLowerCase().endsWith(e));
const isText = (p: string) => TEXT_EXTENSIONS.some((e) => p.toLowerCase().endsWith(e));
const isPng = (p: string) => p.toLowerCase().endsWith('.png');
const isFavicon = (p: string) => /favicon|apple-touch-icon|icon-\d+x\d+/i.test(p);
const isOgImage = (p: string) => /og-image|opengraph|social-card/i.test(p);

const stripScripts = (html: string) =>
  html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');

const matchAll = (html: string, re: RegExp): string[] => {
  const out: string[] = [];
  for (const m of html.matchAll(re)) {
    if (m[1]) out.push(m[1]);
  }
  return out;
};

const isInternalRef = (ref: string): boolean => {
  if (!ref || ref.startsWith('data:') || ref.startsWith('blob:') || ref.startsWith('#'))
    return false;
  if (ref.startsWith('mailto:') || ref.startsWith('tel:') || ref.startsWith('javascript:'))
    return false;
  if (ref.startsWith('//') || ref.match(/^https?:\/\//i)) return false;
  return true;
};

const normalizeRef = (ref: string): string => {
  let p = ref.split('?')[0].split('#')[0];
  if (p.startsWith('./')) p = p.slice(2);
  if (p.startsWith('/')) p = p.slice(1);
  return p;
};

const externalHost = (ref: string): string | null => {
  const m = ref.match(/^https?:\/\/([^/]+)/i);
  return m ? m[1].toLowerCase() : null;
};

const collectRefs = (html: string): string[] => {
  const refs: string[] = [];
  refs.push(
    ...matchAll(
      html,
      /<(?:img|source|video|audio|iframe|script|link)[^>]+(?:src|href)=["']([^"']+)["']/gi,
    ),
  );
  refs.push(...matchAll(html, /url\(["']?([^"')]+)["']?\)/gi));
  return refs;
};

/** Asset existence — every internal ref MUST resolve to a file, else the page ships broken images/links. */
export const validateAssetExistence = (files: BuildFile[]): Violation[] => {
  const out: Violation[] = [];
  const fileSet = new Set(files.map((f) => f.path));
  for (const file of files) {
    if (!isHtml(file.path) || !file.text) continue;
    const refs = collectRefs(file.text);
    for (const ref of refs) {
      const host = externalHost(ref);
      if (host) {
        if (!ALLOWED_EXTERNAL_HOSTS.has(host) && !host.endsWith('.projectsites.dev')) {
          out.push({
            code: 'asset.external_host_not_allowed',
            severity: 'warn',
            message: `External host not in allowlist: ${host}`,
            file: file.path,
            detail: ref,
          });
        }
        continue;
      }
      if (!isInternalRef(ref)) continue;
      const norm = normalizeRef(ref);
      if (!norm) continue;
      if (!fileSet.has(norm)) {
        out.push({
          code: 'asset.missing',
          severity: 'error',
          message: `Referenced asset not in build output: /${norm}`,
          file: file.path,
          detail: ref,
        });
      }
    }
  }
  return out;
};

/** Image format vs size — PNG > 200KB ships slow (high LCP) and must be re-encoded WebP/JPEG. */
export const validateImageFormat = (files: BuildFile[]): Violation[] => {
  // A PNG with an AVIF/WebP sibling is an intentional fallback from the image pipeline — not a violation even when large.
  const pathSet = new Set(files.map((f) => f.path));
  const hasOptimizedSibling = (pngPath: string): boolean => {
    const base = pngPath.replace(/\.png$/i, '');
    return pathSet.has(`${base}.avif`) || pathSet.has(`${base}.webp`);
  };
  return files
    .filter(
      (f) =>
        isPng(f.path) && !isFavicon(f.path) && f.size > 200 * 1024 && !hasOptimizedSibling(f.path),
    )
    .map((f) => ({
      code: 'image.png_too_large',
      severity: 'error' as Severity,
      message: `PNG > 200KB must be WebP/JPEG: ${f.path} (${Math.round(f.size / 1024)}KB)`,
      file: f.path,
    }));
};

/** OG image — must exist, ≤100KB (fast social unfurl), branded 1200×630 card (not a raw photo). */
export const validateOgImage = (files: BuildFile[]): Violation[] => {
  const out: Violation[] = [];
  const og = files.find((f) => isOgImage(f.path));
  if (!og) {
    out.push({
      code: 'og.missing',
      severity: 'error',
      message: 'No og-image found (need 1200×630 branded card)',
    });
    return out;
  }
  if (og.size > 100 * 1024) {
    out.push({
      code: 'og.too_large',
      severity: 'error',
      message: `og-image > 100KB: ${og.path} (${Math.round(og.size / 1024)}KB)`,
      file: og.path,
    });
  }
  return out;
};

/** apple-touch-icon — 180×180 mandatory at root (iOS home-screen add). */
export const validateAppleTouchIcon = (files: BuildFile[]): Violation[] => {
  const has = files.some((f) => f.path === 'apple-touch-icon.png');
  return has
    ? []
    : [
        {
          code: 'icon.apple_touch_missing',
          severity: 'error',
          message: 'apple-touch-icon.png (180×180) required at root',
        },
      ];
};

const titleText = (html: string): string => {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? m[1].trim() : '';
};
const titleLength = (html: string): number => titleText(html).length;

const metaDescText = (html: string): string => {
  // Match the description tag (any attribute order), then extract `content` using a backreference
  // so the capture respects the value's OWN delimiter — a plain [^"'] class truncates a valid
  // double-quoted value at the first apostrophe (content="Vito's Salon…" → "Vito").
  const tag = html.match(/<meta\s+[^>]*\bname=["']description["'][^>]*>/i);
  if (!tag) return '';
  const c = tag[0].match(/\bcontent=(["'])([\s\S]*?)\1/i);
  return c ? c[2].trim() : '';
};
const metaDescLength = (html: string): number => metaDescText(html).length;

/** Title 50-60 chars, description 120-156 chars — the SEO-optimal lengths Google shows un-truncated. */
export const validateMetaLengths = (files: BuildFile[]): Violation[] => {
  const out: Violation[] = [];
  for (const file of files) {
    if (!isHtml(file.path) || !file.text) continue;
    const t = titleLength(file.text);
    if (t < 50 || t > 60) {
      out.push({
        code: 'meta.title_length',
        severity: 'error',
        message: `<title> must be 50-60 chars (got ${t})`,
        file: file.path,
      });
    }
    const d = metaDescLength(file.text);
    if (d < 120 || d > 156) {
      out.push({
        code: 'meta.description_length',
        severity: 'error',
        message: `meta description must be 120-156 chars (got ${d})`,
        file: file.path,
      });
    }
  }
  return out;
};

/**
 * Per-page `<title>` + `<meta description>` UNIQUENESS across a multi-page build.
 *
 * `validateMetaLengths` checks length but NOT uniqueness — a build where every route ships
 * the homepage's title/description passes every gate while being an SEO duplicate-content
 * failure: search engines collapse duplicate `<title>`s, so sub-pages never rank for their
 * OWN keywords, and browser tabs / share cards all read the homepage label.
 *
 * Flags a title (error) or description (warn) shared by ≥2 distinct HTML pages. Comparison
 * collapses whitespace + lowercases so trivial formatting differences don't mask a duplicate.
 */
export const validateUniquePageTitles = (files: BuildFile[]): Violation[] => {
  const out: Violation[] = [];
  const htmlFiles = files.filter((f) => isHtml(f.path) && f.text);
  if (htmlFiles.length < 2) return out; // single-page site can't collide

  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const push = (map: Map<string, string[]>, key: string, path: string): void => {
    const list = map.get(key);
    if (list) list.push(path);
    else map.set(key, [path]);
  };

  const byTitle = new Map<string, string[]>();
  const byDesc = new Map<string, string[]>();
  for (const f of htmlFiles) {
    const title = titleText(f.text as string);
    const desc = metaDescText(f.text as string);
    if (title) push(byTitle, norm(title), f.path);
    if (desc) push(byDesc, norm(desc), f.path);
  }

  for (const paths of byTitle.values()) {
    if (paths.length >= 2) {
      out.push({
        code: 'meta.title_duplicate',
        severity: 'error',
        message: `${paths.length} pages share the identical <title> — each route needs a unique, keyword-targeted title for SEO`,
        file: paths.slice(0, 6).join(', '),
      });
    }
  }
  for (const paths of byDesc.values()) {
    if (paths.length >= 2) {
      out.push({
        code: 'meta.description_duplicate',
        severity: 'warn',
        message: `${paths.length} pages share the identical meta description — each route needs a unique description`,
        file: paths.slice(0, 6).join(', '),
      });
    }
  }
  return out;
};

/**
 * JSON-LD structural integrity. `validateJsonLdCount` only counts the block string, so a site
 * can ship 4 EMPTY or MALFORMED blocks and pass, then fail Google Rich Results (no rich snippets
 * → less SEO traffic → fewer leads). This parses each block and asserts valid JSON carrying
 * `@context` + `@type` (handling a top-level array and `@graph` containers). Warn, per block.
 */
const JSONLD_BLOCK = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const jsonLdNodeOk = (node: unknown): boolean =>
  typeof node === 'object' && node !== null && '@type' in (node as Record<string, unknown>);
export const validateJsonLdStructure = (files: BuildFile[]): Violation[] => {
  const out: Violation[] = [];
  for (const file of files) {
    if (!isHtml(file.path) || !file.text) continue;
    for (const m of file.text.matchAll(JSONLD_BLOCK)) {
      const raw = (m[1] ?? '').trim();
      if (!raw) {
        out.push({
          code: 'jsonld.malformed',
          severity: 'warn',
          message: 'Empty JSON-LD block (no content) — fails Rich Results.',
          file: file.path,
        });
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        out.push({
          code: 'jsonld.malformed',
          severity: 'warn',
          message: 'JSON-LD block is not valid JSON — fails Rich Results.',
          file: file.path,
        });
        continue;
      }
      const root = parsed as Record<string, unknown>;
      const nodes = Array.isArray(parsed)
        ? parsed
        : Array.isArray(root['@graph'])
          ? (root['@graph'] as unknown[])
          : [parsed];
      const hasContext =
        (typeof root === 'object' && root !== null && '@context' in root) ||
        nodes.some((n) => typeof n === 'object' && n !== null && '@context' in (n as object));
      if (!hasContext) {
        out.push({
          code: 'jsonld.missing_required_field',
          severity: 'warn',
          message: 'JSON-LD block missing @context — fails Rich Results.',
          file: file.path,
        });
      }
      if (!nodes.every(jsonLdNodeOk)) {
        out.push({
          code: 'jsonld.missing_required_field',
          severity: 'warn',
          message: 'JSON-LD block has a node missing @type — fails Rich Results.',
          file: file.path,
        });
      }
    }
  }
  return out;
};

/** JSON-LD — ≥4 blocks per HTML page (WebSite + Organization + WebPage + BreadcrumbList minimum). */
export const validateJsonLdCount = (files: BuildFile[]): Violation[] => {
  const out: Violation[] = [];
  for (const file of files) {
    if (!isHtml(file.path) || !file.text) continue;
    const count = (file.text.match(/application\/ld\+json/gi) || []).length;
    if (count < 4) {
      out.push({
        code: 'jsonld.count_below_threshold',
        severity: 'error',
        message: `JSON-LD blocks below 4 (got ${count}). Need WebSite+Organization+WebPage+BreadcrumbList minimum.`,
        file: file.path,
      });
    }
  }
  return out;
};

/** Exactly one <h1> in the prerendered HTML shell — the single-topic signal crawlers key on. */
export const validateH1InShell = (files: BuildFile[]): Violation[] => {
  const out: Violation[] = [];
  for (const file of files) {
    if (!isHtml(file.path) || !file.text) continue;
    const stripped = stripScripts(file.text);
    const count = (stripped.match(/<h1[\s>]/gi) || []).length;
    if (count !== 1) {
      out.push({
        code: 'html.h1_count',
        severity: 'error',
        message: `Exactly 1 <h1> required in HTML shell (got ${count})`,
        file: file.path,
      });
    }
  }
  return out;
};

/**
 * Shipped HTML must never reference a raw dev-source module (`.tsx`/`.ts`/`.jsx`/
 * `.mts`/`.cts`) as a `<script src>`. Browsers can't execute TS/JSX, so this is
 * the signature of an UNBUILT Vite dev `index.html` (points at `/src/main.tsx`)
 * published instead of the `vite build` output — the module serves as
 * `application/octet-stream` (or 404s), never executes, and the site renders a
 * blank shell for every visitor. A correct build references hashed `/assets/*.js`.
 *
 * Reference incident: `megabytespace.projectsites.dev` shipped the dev index.html
 * (`/src/main.tsx` → octet-stream 200) → 249-char blank shell, 0 images.
 */
export const validateNoDevSourceModules = (files: BuildFile[]): Violation[] => {
  const out: Violation[] = [];
  const DEV_MODULE = /<script[^>]+\bsrc=["']([^"']+\.(?:tsx|ts|jsx|mts|cts))(?:\?[^"']*)?["']/gi;
  for (const file of files) {
    if (!isHtml(file.path) || !file.text) continue;
    DEV_MODULE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = DEV_MODULE.exec(file.text)) !== null) {
      out.push({
        code: 'html.dev_source_module',
        severity: 'error',
        message: `Shipped HTML references a raw dev-source module "${m[1]}" — browsers can't execute TS/JSX. This is an unbuilt Vite index.html; publish the "vite build" output (dist/, referencing /assets/*.js), not the source.`,
        file: file.path,
        detail: m[1],
      });
    }
  }
  return out;
};

/** color-scheme meta required so the browser paints the right chrome/scrollbars on dark sites. */
export const validateColorScheme = (files: BuildFile[]): Violation[] => {
  const out: Violation[] = [];
  for (const file of files) {
    if (!isHtml(file.path) || !file.text) continue;
    // Attribute-order-robust: `<meta content="dark" name="color-scheme">` is valid — the meta
    // name must not be forced to the FIRST attribute (same class as the metaDescLength bug).
    if (!/<meta\s+[^>]*\bname=["']color-scheme["']/i.test(file.text)) {
      out.push({
        code: 'meta.color_scheme_missing',
        severity: 'warn',
        message: 'Missing <meta name="color-scheme"> (use "dark" or "dark light")',
        file: file.path,
      });
    }
  }
  return out;
};

/**
 * Canonical integrity. Every indexable route HTML file must carry a `<link rel="canonical">`
 * (warn when absent), AND distinct routes must NOT share one canonical href — a site-wide
 * `canonical=/` collapse de-dupes every page to a single indexable URL, so sub-pages drop out
 * of the index. Non-route HTML (offline / 404 / 500 / error shells) is excluded — those
 * legitimately share or omit a canonical and are not indexable targets.
 */
const NON_ROUTE_HTML = /(?:^|\/)(?:offline|404|500|error)\.html$/i;
const canonicalHref = (html: string): string | undefined => {
  const m =
    html.match(/<link\s+[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["']/i) ??
    html.match(/<link\s+[^>]*href=["']([^"']*)["'][^>]*rel=["']canonical["']/i);
  return m?.[1]?.trim() || undefined;
};
export const validateCanonical = (files: BuildFile[]): Violation[] => {
  const out: Violation[] = [];
  const byHref = new Map<string, string[]>();
  for (const file of files) {
    if (!isHtml(file.path) || !file.text || NON_ROUTE_HTML.test(file.path)) continue;
    const href = canonicalHref(file.text);
    if (!href) {
      out.push({
        code: 'meta.canonical_missing',
        severity: 'warn',
        message:
          'Missing <link rel="canonical"> — every indexable route needs a self-referencing canonical.',
        file: file.path,
      });
      continue;
    }
    byHref.set(href, [...(byHref.get(href) ?? []), file.path]);
  }
  // Collapse signature: ≥2 distinct route files sharing one canonical href. Only meaningful for
  // multi-route sites (a single page legitimately points its lone canonical at itself).
  const routeCount = [...byHref.values()].reduce((n, list) => n + list.length, 0);
  if (routeCount > 1) {
    for (const [href, list] of byHref) {
      if (list.length < 2) continue;
      for (const path of list) {
        out.push({
          code: 'meta.canonical_collapsed',
          severity: 'error',
          message: `${list.length} routes share canonical "${href}" — each route must self-reference its own URL (site-wide canonical collapse).`,
          file: path,
        });
      }
    }
  }
  return out;
};

/**
 * Conversion-path integrity. A generated BUSINESS site must give visitors at least ONE way to
 * act on / contact the business somewhere across its routes — a `tel:` / `mailto:` link, a
 * `<form>`, or a contact / booking link. A site with NO reachable contact affordance converts
 * $0 for the owner → the owner sees no ROI → churns. Site-level warn: emit ONE violation only
 * when the ENTIRE site lacks any affordance (per-page would false-positive on `/about` etc.).
 * Non-route shells (404 / 500 / offline) are excluded from the judgement.
 */
const CONTACT_AFFORDANCE =
  /href=["']\s*(?:tel:|mailto:)|<form[\s>]|href=["'][^"']*(?:\/contact|\/book|\/appointment|\/schedule|\/quote|calendly\.com|cal\.com|wa\.me)/i;
export const validateContactPath = (files: BuildFile[]): Violation[] => {
  const routeHtml = files.filter((f) => isHtml(f.path) && f.text && !NON_ROUTE_HTML.test(f.path));
  if (routeHtml.length === 0) return [];
  const hasAffordance = routeHtml.some((f) => CONTACT_AFFORDANCE.test(f.text!));
  if (hasAffordance) return [];
  return [
    {
      code: 'conversion.contact_path_missing',
      severity: 'warn',
      message:
        'No contact/conversion affordance found anywhere on the site (tel:/mailto:/<form>/contact|booking link) — visitors have no way to act, so the site converts $0 for the business owner.',
    },
  ];
};

/**
 * Per-route image-weight budget (CWV / LCP → conversion). A route whose total referenced internal
 * image bytes exceed the budget ships slow — high LCP, poor mobile CWV — which depresses conversion
 * (fewer leads → lower ROI → churn). `validateImageFormat` flags a single oversized PNG; this
 * catches the OTHER failure mode: many individually-OK images summing to a heavy page. Warn, per
 * route; non-route shells excluded. Budget per quality-metrics.md (images ≤ 500KB total/route).
 */
const IMAGE_WEIGHT_BUDGET = 500 * 1024;
const isImageRef = (p: string) => /\.(png|jpe?g|webp|avif|gif|svg)$/i.test(p);
export const validateImageWeightBudget = (files: BuildFile[]): Violation[] => {
  const sizeByPath = new Map(files.map((f) => [f.path, f.size]));
  const out: Violation[] = [];
  for (const file of files) {
    if (!isHtml(file.path) || !file.text || NON_ROUTE_HTML.test(file.path)) continue;
    let total = 0;
    const seen = new Set<string>();
    for (const ref of collectRefs(file.text)) {
      if (!isInternalRef(ref) || !isImageRef(ref)) continue;
      const norm = normalizeRef(ref);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      total += sizeByPath.get(norm) ?? 0;
    }
    if (total > IMAGE_WEIGHT_BUDGET) {
      out.push({
        code: 'image.route_weight_over_budget',
        severity: 'warn',
        message: `Route images total ${Math.round(total / 1024)}KB (budget ${IMAGE_WEIGHT_BUDGET / 1024}KB) — heavy page → high LCP → lower conversion.`,
        file: file.path,
      });
    }
  }
  return out;
};

/** Sitemap — every <url> must carry <lastmod> so crawlers know what changed. */
export const validateSitemapLastmod = (files: BuildFile[]): Violation[] => {
  const sitemap = files.find((f) => f.path === 'sitemap.xml');
  if (!sitemap?.text)
    return [
      {
        code: 'sitemap.missing',
        severity: 'error',
        message: 'sitemap.xml not found in build output',
      },
    ];
  const urlBlocks = sitemap.text.match(/<url>[\s\S]*?<\/url>/g) || [];
  const out: Violation[] = [];
  for (const block of urlBlocks) {
    if (!/<lastmod>/i.test(block)) {
      const loc = block.match(/<loc>([^<]+)<\/loc>/);
      out.push({
        code: 'sitemap.missing_lastmod',
        severity: 'error',
        message: `<url> missing <lastmod>: ${loc ? loc[1] : 'unknown'}`,
        file: 'sitemap.xml',
      });
    }
  }
  return out;
};

/**
 * Sitemap ↔ build-routes drift guard. `validateSitemapLastmod` proves the sitemap EXISTS + every
 * `<url>` has a `<lastmod>` — but NOT that each `<loc>` route actually has a page in the build. A
 * sitemap that lists `/services` when the build shipped no `services.html` is worse than a plain
 * 404: the SPA fallback in `serveSiteFromR2` returns the HOMEPAGE shell with a 200 for any
 * sitemap-listed extensionless route → crawlers follow the sitemap, get 200, and index DUPLICATE
 * homepage content under that URL (self-competing, crawl-budget waste). This flags every sitemap
 * route with no dedicated HTML file, mirroring `serveSiteFromR2`'s resolution order exactly
 * (`X/index.html` → `X.html` → flat `a-b.html` for `/a/b`).
 */
export const validateSitemapRoutesExist = (files: BuildFile[]): Violation[] => {
  const sitemap = files.find((f) => f.path === 'sitemap.xml');
  if (!sitemap?.text) return []; // validateSitemapLastmod owns the missing-sitemap error
  const htmlPaths = new Set(files.filter((f) => isHtml(f.path)).map((f) => f.path));
  const out: Violation[] = [];
  const seen = new Set<string>();
  for (const raw of sitemap.text.match(/<loc>[^<]+<\/loc>/g) ?? []) {
    const url = raw.replace(/<\/?loc>/g, '').trim();
    let pathname: string;
    try {
      pathname = new URL(url).pathname;
    } catch {
      pathname = url.startsWith('/') ? url : `/${url}`;
    }
    const route = pathname.replace(/\/+$/, '') || '/'; // strip trailing slash; '' → '/'
    if (seen.has(route)) continue;
    seen.add(route);
    // Candidate dist files that would serve this route (mirror serveSiteFromR2).
    const bare = route.replace(/^\//, '');
    const candidates =
      route === '/'
        ? ['index.html']
        : [`${bare}.html`, `${bare}/index.html`, `${bare.replace(/\//g, '-')}.html`];
    if (!candidates.some((c) => htmlPaths.has(c))) {
      out.push({
        code: 'sitemap.orphan_route',
        severity: 'error',
        message: `sitemap lists ${route} but the build has no page for it — the SPA fallback soft-404s it (200 homepage shell), so crawlers index duplicate homepage content under this URL`,
        file: 'sitemap.xml',
        detail: route,
      });
    }
  }
  return out;
};

/**
 * Per-industry content-pack DEFAULT hero headlines — source of truth is the template's
 * `scripts/gen-content-packs.mjs` (`hero[0]` of each vertical). A generated site whose <h1>
 * is one of these VERBATIM shipped the un-customized industry default, so the #1 conversion
 * element is generic + COLLIDES across same-industry sites (reproduced live: a coffee roaster
 * AND a cocktail lounge both "Fresh flavors, made from scratch"; two gyms both "Get stronger…").
 * Heroes change rarely; if the template edits one, update here (drift is a `warn`, not a break).
 * Ref: memory `generated-site-hero-h1-is-industry-pack-default`. AL-193.
 */
const PACK_DEFAULT_HEROES = [
  'Trusted primary care for every age',
  'Gentle dental care for your whole family',
  'Move, breathe, and feel restored',
  'Get stronger, one session at a time',
  'Trusted counsel when it matters most',
  'Fresh flavors, made from scratch',
  'Reliable service, done right the first time',
  'Together, we can do more',
  'Gear built for how you live',
  'Ship faster with less busywork',
  'Find the home that fits your life',
  'Ideas that move the needle',
  'Work I am proud to share',
];

/**
 * Generic-hero detector — the rendered <h1> must be the REAL business's value proposition, not
 * the per-industry content-pack DEFAULT shipped un-customized. `warn` (advisory) so it TRACKS
 * the class to the D1 audit without breaking builds; the real fix lives in site-gen (apply the AI
 * `hero_headline` from `openai_research.ts`, or derive a business-specific hero on the fallback
 * path), after which this goes silent. Complements {@link validateH1InShell} (count) with H1
 * QUALITY. Ref: memory `generated-site-hero-h1-is-industry-pack-default`. AL-193.
 */
export const validateHeroNotPackDefault = (files: BuildFile[]): Violation[] => {
  const out: Violation[] = [];
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const defaults = new Set(PACK_DEFAULT_HEROES.map(norm));
  for (const file of files) {
    if (!isHtml(file.path) || !file.text) continue;
    const m = stripScripts(file.text).match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (!m) continue;
    const raw = m[1].replace(/<[^>]+>/g, '').trim();
    if (defaults.has(norm(raw))) {
      out.push({
        code: 'copy.generic_pack_hero',
        severity: 'warn',
        message: `Hero <h1> "${raw}" is the un-customized industry content-pack default — the #1 conversion element is generic/colliding copy, not this business's real value. Apply the AI hero_headline / derive a business-specific hero.`,
        file: file.path,
      });
    }
  }
  return out;
};

/** Banned slop words anywhere in HTML body text — enforces concrete copy over AI filler. */
export const validateBannedWords = (files: BuildFile[]): Violation[] => {
  const out: Violation[] = [];
  for (const file of files) {
    if (!isHtml(file.path) || !file.text) continue;
    const stripped = stripScripts(file.text);
    for (const word of BANNED_WORDS) {
      const re = new RegExp(`\\b${word}\\b`, 'gi');
      const matches = stripped.match(re);
      if (matches?.length) {
        out.push({
          code: 'copy.banned_word',
          severity: 'warn',
          message: `Banned slop word "${word}" appears ${matches.length}× — replace with concrete language`,
          file: file.path,
        });
      }
    }
  }
  return out;
};

/**
 * Brand-name match — the LLM invents business names ("Hearth & Crumb") despite the materialized
 * _brand.json, so the title MUST contain the real name. Only enforced when the caller passes
 * `expectedBusinessName`. Also catches the `..projectsites.dev` double-dot canonical (a template
 * token replaced with an already-suffixed slug).
 */
export const validateBrandNameMatch = (
  files: BuildFile[],
  expectedBusinessName?: string,
): Violation[] => {
  if (!expectedBusinessName) return [];
  const out: Violation[] = [];
  const expected = expectedBusinessName.trim();
  for (const file of files) {
    if (!isHtml(file.path) || !file.text) continue;
    const stripped = stripScripts(file.text);
    const title = stripped.match(/<title>([^<]*)<\/title>/i);
    if (!title) continue;
    const t = title[1].trim();
    if (!t) continue;
    const norm = (x: string) =>
      x
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
    const tNorm = norm(t);
    const eNorm = norm(expected);
    // The FULL name is required on the homepage. Sub-pages must stay inside the 50-60 char SEO
    // title cap, so they legitimately use the brand SHORT name (first word of the expected name):
    // "Cedar Ridge FAQ | …" is CORRECT for a sub-page of "Cedar Ridge Bakeshop".
    const firstWord = eNorm.split(' ')[0] ?? '';
    const pageKind = file.path.toLowerCase();
    const isHome = pageKind === 'index.html' || pageKind.endsWith('/index.html');
    const expectedForPage = isHome ? eNorm : firstWord;
    // Accept verbatim containment OR title STARTS with the expected form ("Cedar Ridge Bakeshop — Menu").
    if (!tNorm.includes(expectedForPage) && !tNorm.startsWith(expectedForPage)) {
      out.push({
        code: 'brand.name_mismatch',
        severity: 'error',
        message: `Site title "${t}" does not contain the real business name "${expectedForPage}"`,
        file: file.path,
      });
    }

    // Canonical URL sanity — guard the double-dot / unresolved-token hostname.
    const canonical = stripped.match(/<link\s+rel="canonical"\s+href="([^"]*)"/i);
    if (canonical) {
      const href = canonical[1];
      if (href.includes('..') || href.includes('{BUSINESS') || href.includes('undefined')) {
        out.push({
          code: 'brand.bad_canonical',
          severity: 'error',
          message: `Malformed canonical URL "${href}" — template token replacement produced a broken hostname`,
          file: file.path,
        });
      }
    }
  }
  return out;
};

/** Brand-placeholder leak — an unreplaced `{BUSINESS_*}` token or the generic "Business" fallback
 * means _brand.json never materialized; a hard gate is the only reliable enforcement (LLM
 * instructions alone let these reach production). */
export const validateNoBrandPlaceholders = (files: BuildFile[]): Violation[] => {
  const out: Violation[] = [];
  for (const file of files) {
    if (!isHtml(file.path) || !file.text) continue;
    const stripped = stripScripts(file.text);
    for (const token of [
      '{BUSINESS_NAME}',
      '{BUSINESS_TAGLINE}',
      '{BUSINESS_SHORT_NAME}',
      '{BUSINESS_DESCRIPTION}',
    ]) {
      if (stripped.includes(token)) {
        out.push({
          code: 'brand.placeholder_leak',
          severity: 'error',
          message: `Brand placeholder "${token}" shipped to production — the container must use the materialized _brand.json`,
          file: file.path,
        });
      }
    }
    // The template defaults the title to "Business" when _brand.json is missing/invalid.
    const title = stripped.match(/<title>([^<]*)<\/title>/i);
    if (title && /^Business\b/.test(title[1].trim())) {
      out.push({
        code: 'brand.generic_name',
        severity: 'error',
        message:
          'Site title starts with the generic "Business" fallback — _brand.json did not materialize',
        file: file.path,
      });
    }
  }
  return out;
};

/** JS chunk size — no single chunk > 750KB raw (~250KB gzipped), else the route ships too much JS. */
export const validateJsBundleSize = (files: BuildFile[]): Violation[] => {
  const out: Violation[] = [];
  for (const file of files) {
    if (!file.path.toLowerCase().endsWith('.js')) continue;
    if (file.size > 750 * 1024) {
      out.push({
        code: 'js.chunk_too_large',
        severity: 'error',
        message: `JS chunk > 750KB raw (~250KB gzipped): ${file.path} (${Math.round(file.size / 1024)}KB)`,
        file: file.path,
      });
    }
  }
  return out;
};

/** Lightbox presence — JS bundle must contain data-zoomable AND data-gallery markers, else the
 * gallery/lightbox component isn't shipping. */
export const validateLightboxPresence = (files: BuildFile[]): Violation[] => {
  const jsFiles = files.filter((f) => f.path.toLowerCase().endsWith('.js') && f.text);
  if (!jsFiles.length) return [];
  const haystack = jsFiles.map((f) => f.text || '').join('\n');
  const hasZoomable = haystack.includes('data-zoomable');
  const hasGallery = haystack.includes('data-gallery');
  const out: Violation[] = [];
  if (!hasZoomable) {
    out.push({
      code: 'lightbox.zoomable_missing',
      severity: 'error',
      message: 'No data-zoomable string in JS bundle — lightbox component not shipping',
    });
  }
  if (!hasGallery) {
    out.push({
      code: 'lightbox.gallery_missing',
      severity: 'error',
      message: 'No data-gallery string in JS bundle — gallery wrappers/lightbox missing',
    });
  }
  return out;
};

/**
 * Theme-font loader presence — the JS bundle MUST contain the `ps-theme-fonts`
 * marker, i.e. the template's `injectThemeFonts()` (called from `applyBrand`,
 * template commit 58b4fa4) ships.
 *
 * Root-cause guard (2026-09-08): `applyBrand` sets `--font-heading: 'Playfair
 * Display', …` but `index.html` hardcodes ONLY the default trio (Inter / Space
 * Grotesk / JetBrains). Without the runtime font-loader, every themed site NAMES
 * its theme font yet loads no file → headings silently fall back to system-ui —
 * the #1 theme signal, dead. A real-browser probe of 4 live sites (lumen-oak,
 * aurelia, ironhaus, emberline) confirmed the regression: h1 computed
 * `"Playfair Display", system-ui` but only the default trio was loaded.
 * `injectThemeFonts` adds a `<link id="ps-theme-fonts">` for the ACTIVE brand
 * fonts (real-browser verified: Playfair + Lato `document.fonts.check === true`).
 * This mirrors {@link validateLightboxPresence}: a static bundle-grep that fails
 * the build if the template drops the injector, so the theme's typography can
 * never go dark again. `ps-theme-fonts` is a string literal → survives minification.
 */
export const validateThemeFontLoader = (files: BuildFile[]): Violation[] => {
  const jsFiles = files.filter((f) => f.path.toLowerCase().endsWith('.js') && f.text);
  if (!jsFiles.length) return [];
  const haystack = jsFiles.map((f) => f.text || '').join('\n');
  if (haystack.includes('ps-theme-fonts')) return [];
  return [
    {
      code: 'theme.font_loader_missing',
      severity: 'error',
      message:
        'No ps-theme-fonts string in JS bundle — the theme-font loader (injectThemeFonts) is not shipping, so themed headings will fall back to system-ui.',
    },
  ];
};

/** Required well-known files — the PWA/SEO/crawler baseline every site must ship. */
export const validateRequiredFiles = (files: BuildFile[]): Violation[] => {
  const required = [
    'site.webmanifest',
    'robots.txt',
    // llms.txt — the AI-search/GEO crawler directive (skill-16 §5 mandates it alongside
    // robots/security.txt). The template ships it + deployed sites serve it (200), but it
    // was NOT enforced here — a template regression dropping it would silently de-list the
    // site from AI crawlers. Now a build-breaking invariant like the other well-known files. (C.4)
    'llms.txt',
    'humans.txt',
    'sitemap.xml',
    'browserconfig.xml',
    '.well-known/security.txt',
    'favicon.ico',
    'favicon-16x16.png',
    'favicon-32x32.png',
    'apple-touch-icon.png',
  ];
  const set = new Set(files.map((f) => f.path));
  return required
    .filter((p) => !set.has(p))
    .map((p) => ({
      code: 'manifest.required_file_missing',
      severity: 'error' as Severity,
      message: `Required file missing: ${p}`,
    }));
};

/**
 * Fail builds that under-recreate the source sitemap. Skill 15 mandates 1:N route mapping —
 * never cap a 200-page source at 4–8. `sourceRouteCount` comes from
 * `_scraped_content.json.routes[].length`.
 *
 * Floor: thin sources (< 4 routes) skip the check — the 4-page floor handles those.
 * Ceiling: sourceRouteCount is clamped to 1000 (sanity cap against runaway crawls).
 */
export const validateRouteCount = (files: BuildFile[], sourceRouteCount: number): Violation[] => {
  if (sourceRouteCount < 4) return [];
  const expected = Math.min(sourceRouteCount, 1000);
  const builtRoutes = files.filter(
    (f) =>
      f.path.endsWith('.html') &&
      !/(^|\/)(404|500|offline)\.html$/i.test(f.path) &&
      !f.path.startsWith('admin/'),
  );
  if (builtRoutes.length >= expected) return [];
  return [
    {
      code: 'route.count_below_source_count',
      severity: 'error' as Severity,
      message: `Built ${builtRoutes.length} HTML route(s); source has ${sourceRouteCount} (expected ≥ ${expected}). Skill 15 requires 1:N source-sitemap mapping up to 1000 — never cap at 4–8 pages.`,
      detail: `built=${builtRoutes.length} expected=${expected} source=${sourceRouteCount}`,
    },
  ];
};

/**
 * High-confidence, SERVER-ONLY secret patterns. Deliberately conservative (false-negative over
 * false-positive per validator-precision-discipline): publishable/browser keys MEANT to be
 * client-side — Stripe `pk_*`, Google Maps/browser `AIza*` (referrer-restricted) — are
 * intentionally absent.
 */
const CLIENT_SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'Stripe secret key', re: /sk_live_[A-Za-z0-9]{16,}/ },
  { name: 'Stripe restricted key', re: /rk_live_[A-Za-z0-9]{16,}/ },
  { name: 'OpenAI API key', re: /sk-(?:proj-)?[A-Za-z0-9_-]{40,}/ },
  { name: 'AWS access key id', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: 'SendGrid API key', re: /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/ },
  { name: 'Slack token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'Anthropic API key', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

/**
 * Scan client-served files (HTML / JS) for embedded server-only secrets — the #1 vibe-coded-app
 * vulnerability class (keys hardcoded in the bundle). Every hit is an `error`: secrets belong in
 * Workers Secrets, never the client bundle. The detail is masked (first 8 + last 3 chars) so the
 * validator never logs the full secret.
 */
export const validateNoClientSecrets = (files: BuildFile[]): Violation[] => {
  const out: Violation[] = [];
  for (const f of files) {
    if (!f.text || !/\.(?:html?|m?js)$/i.test(f.path)) continue;
    for (const { name, re } of CLIENT_SECRET_PATTERNS) {
      const m = re.exec(f.text);
      if (m) {
        const hit = m[0];
        out.push({
          code: 'security.client_secret_exposed',
          severity: 'error',
          message: `Possible ${name} embedded in a client-served file — secrets must stay server-side (Workers Secrets), never in the bundle.`,
          file: f.path,
          detail: `${hit.slice(0, 8)}…${hit.slice(-3)}`,
        });
        break; // one finding per file is enough to fail the gate
      }
    }
  }
  return out;
};

/** Run every gate and return a structured report. */
/**
 * Wrong-vertical CONVERSION framing on a QUICK-SERVE site — "Reserve a table" /
 * "Reservations welcome" on an ice cream / coffee / bakery / juice counter reads like a
 * mis-templated full-service restaurant and LOSES to the real business (§ C.7 beat-source),
 * exactly like a wrong-vertical H1. The seeded surfaces (hero CTAs, FAQ) are fixed by the
 * quickserve CommerceMode + HERO_CTA seed (AL-420); this catches the AI-generated SECTION
 * copy (trust chips / feature blocks / process steps) the conversion brief can't reliably
 * govern on the fast path. Report-mode (warn) — surfaces to the D1 audit + guides the
 * validator-fixer, never blocks. Prod probe: `e2e/site-quality/verify-conversion-framing.mjs`.
 *
 * Precision (validator-precision-discipline): a STRONG quickserve signal from the shell H1 +
 * <title> (never an incidental body mention — a steakhouse's "ice cream dessert" won't match)
 * COEXISTING with AFFIRMATIVE reservation framing in any HTML/JS text (AI sections bundle as
 * string literals). Negated forms ("no reservation needed", "walk-ins welcome") are the
 * CORRECT quickserve copy and are stripped before matching.
 */
export const validateConversionFraming = (files: BuildFile[]): Violation[] => {
  const shell = files.find((f) => f.path === 'index.html')?.text ?? '';
  const h1 = (shell.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? '').replace(/<[^>]+>/g, ' ').trim();
  const title = shell.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '';
  const QUICKSERVE =
    /\b(ice\s?cream|gelato|frozen\s?yogurt|froyo|creamer(?:y|ies)|coffee\s?(?:shop|house|bar)|\bcafe\b|café|espresso\s?bar|bakery|bakeries|patisserie|\bdonut|doughnut|juice\s?bar|smoothie|\bdeli\b|delicatessen|sandwich\s?(?:shop|bar)|food\s?truck|bubble\s?tea|\bboba\b)\b/i;
  if (!QUICKSERVE.test(`${h1} ${title}`)) return [];
  const RESERVATION =
    /\b(reserve a table|reservations?\s+welcome|book (?:a|your) table|easy reservations?|make a reservation|table reservations?)\b/i;
  const NEGATED =
    /\b(no reservations?(?:\s+(?:needed|required|necessary))?|without a reservation|walk[- ]?ins?\s+welcome)\b/gi;
  for (const f of files) {
    if (!f.text || !/\.(html|js)$/i.test(f.path)) continue;
    const m = f.text.replace(NEGATED, ' ').match(RESERVATION);
    if (m) {
      return [
        {
          code: 'conversion.reservation_on_quickserve',
          severity: 'warn',
          message: `Quick-serve site (${h1.slice(0, 40)}) uses full-service reservation framing "${m[0]}" — a walk-up counter takes orders, never table reservations. Rewrite the section to quick-serve (Order online / Visit us / See our flavors / Today's specials).`,
          file: f.path,
          detail: m[0],
        },
      ];
    }
  }
  return [];
};

export const validateBuild = (
  files: BuildFile[],
  opts: { sourceRouteCount?: number; expectedBusinessName?: string } = {},
): ValidationReport => {
  const all: Violation[] = [
    ...validateRequiredFiles(files),
    ...validateAssetExistence(files),
    ...validateImageFormat(files),
    ...validateOgImage(files),
    ...validateAppleTouchIcon(files),
    ...validateMetaLengths(files),
    ...validateUniquePageTitles(files),
    ...validateJsonLdCount(files),
    ...validateJsonLdStructure(files),
    ...validateH1InShell(files),
    ...validateNoDevSourceModules(files),
    ...validateColorScheme(files),
    ...validateCanonical(files),
    ...validateSitemapLastmod(files),
    ...validateSitemapRoutesExist(files),
    ...validateBannedWords(files),
    ...validateHeroNotPackDefault(files),
    ...validateNoBrandPlaceholders(files),
    ...validateBrandNameMatch(files, opts.expectedBusinessName),
    ...validateJsBundleSize(files),
    ...validateLightboxPresence(files),
    ...validateThemeFontLoader(files),
    ...validateNoClientSecrets(files),
    ...validateContactPath(files),
    ...validateImageWeightBudget(files),
    ...validateConversionFraming(files),
    ...(typeof opts.sourceRouteCount === 'number'
      ? validateRouteCount(files, opts.sourceRouteCount)
      : []),
  ];
  const errors = all.filter((v) => v.severity === 'error');
  const warnings = all.filter((v) => v.severity === 'warn');
  const infos = all.filter((v) => v.severity === 'info');
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    infos,
    summary: `${errors.length} error(s), ${warnings.length} warning(s), ${infos.length} info`,
  };
};

/**
 * Read every file under `prefix` from R2 into memory as BuildFile[].
 *
 * Decodes text-ish files (HTML/JS/CSS/JSON/XML/SVG/TXT) with TextDecoder; binary files
 * (PNG/JPG/WebP/etc.) are returned with `text: undefined` and only their byte size.
 */
export const loadBuildFromR2 = async (bucket: R2Bucket, prefix: string): Promise<BuildFile[]> => {
  const files: BuildFile[] = [];
  let cursor: string | undefined;
  const decoder = new TextDecoder();
  do {
    const list = await bucket.list({ prefix, cursor, limit: 1000 });
    cursor = list.truncated ? list.cursor : undefined;
    for (const obj of list.objects) {
      const path = obj.key.startsWith(prefix)
        ? obj.key.slice(prefix.length).replace(/^\/+/, '')
        : obj.key;
      const size = obj.size;
      let text: string | undefined;
      if (isText(path) && size < 1.5 * 1024 * 1024) {
        try {
          const got = await bucket.get(obj.key);
          if (got) {
            const buf = await got.arrayBuffer();
            text = decoder.decode(buf);
          }
        } catch {}
      }
      files.push({ path, size, text });
    }
  } while (cursor);
  return files;
};

/**
 * Deterministically repair the `..projectsites.dev` double-dot hostname in a build's text files,
 * returning the repaired copies.
 *
 * The build LLM writes the canonical as `https://<slug>..projectsites.dev` (slug already
 * dot-suffixed in its model) DURING the build — after the container's token pass ran. This repair
 * runs in finalize-build AFTER upload, so the gate sees corrected text. Pure — does NOT mutate the
 * input array.
 *
 * @returns [repairedFiles, repairedCount]
 */
export const repairDoubleDotCanonical = (files: BuildFile[]): [BuildFile[], number] => {
  const BAD = '..projectsites.dev';
  let repaired = 0;
  const fixed = files.map((f) => {
    if (typeof f.text !== 'string' || !f.text.includes(BAD)) return f;
    repaired++;
    return { ...f, text: f.text.split(BAD).join('.projectsites.dev') };
  });
  return [fixed, repaired];
};

/**
 * Collapse the dangling 'NAME — ' the LLM writes when the tagline is empty.
 *
 * The seed tagline is '' and the LLM composes '<title>{NAME} — {TAGLINE}' during the build (same
 * mid-build authorship as the double-dot class), so the pre-build token pass cannot catch it. Runs
 * in finalize-build AFTER upload, before the brand gate. Pure — no input mutation.
 */
export const repairDanglingEmDash = (files: BuildFile[]): [BuildFile[], number] => {
  let repaired = 0;
  const fixed = files.map((f) => {
    if (typeof f.text !== 'string') return f;
    let t = f.text;
    const fixedTitle = t.replace(/(<title>[^<]*?)\s*\u2014\s*(<\/title>)/gi, '$1$2');
    if (fixedTitle !== t) {
      repaired++;
      t = fixedTitle;
    }
    const fixedH1 = t.replace(/(<h1[^>]*>[^<]*?)\s*\u2014\s*(<\/h1>)/gi, '$1$2');
    if (fixedH1 !== t) {
      repaired++;
      t = fixedH1;
    }
    return repaired > 0 && t !== f.text ? { ...f, text: t } : f;
  });
  // Recount precisely — the map mutates `repaired` per file, but only the final changed set counts.
  const changed = fixed.filter((f, i) => f.text !== files[i]?.text).length;
  return [fixed, changed];
};

export interface SeoFinalizeContext {
  /** Real business name (params.businessName) — the fallback for the JSON-LD `name`. */
  businessName: string;
  /** Canonical site origin, e.g. `https://vanta-strength-austin.projectsites.dev` (no trailing slash). */
  hostname: string;
}

export interface SeoFinalizeReport {
  jsonLdInjected: number;
  escapesRepaired: number;
  descExpanded: number;
  titleClamped: number;
}

const truncateAtWord = (s: string, max: number): string => {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:—–-]+$/, '');
};

/** Unescape invalid `\'` OUTSIDE `<script>`/`<style>` — a backslash-apostrophe is never valid in
 * HTML (and never valid JSON either), so a `content="Houston\'s …"` meta ships literal `Houston\'s`
 * to crawlers. Script/style bodies are left untouched (a JS `'it\'s'` string IS valid there). */
const unescapeApostrophesOutsideScripts = (html: string): { text: string; count: number } => {
  let count = 0;
  const text = html.replace(
    /(<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>)|\\(')/gi,
    (m, block) => {
      if (block) return block;
      count++;
      return "'";
    },
  );
  return { text, count };
};

/** Read a meta/og/twitter description value with a delimiter-respecting backreference (same fix as
 * metaDescText — a plain `[^"']*` truncates a valid double-quoted value at its first apostrophe). */
const readAttrContent = (html: string, tagRe: RegExp): string => {
  const tag = html.match(tagRe);
  if (!tag) return '';
  const c = tag[0].match(/\bcontent=(["'])([\s\S]*?)\1/i);
  return c ? c[2].trim() : '';
};

/** Swap the `content=` value of the FIRST tag matching `tagRe`. No-op when the tag is absent. */
const setAttrContent = (html: string, tagRe: RegExp, value: string): string => {
  const tag = html.match(tagRe);
  if (!tag) return html;
  const safe = value.replace(/"/g, '&quot;');
  const replaced = tag[0].replace(/\bcontent=(["'])[\s\S]*?\1/i, `content="${safe}"`);
  return html.replace(tag[0], replaced);
};

const collectJsonLdTypes = (html: string): { count: number; types: Set<string> } => {
  const types = new Set<string>();
  let count = 0;
  for (const m of html.matchAll(JSONLD_BLOCK)) {
    const raw = (m[1] ?? '').trim();
    if (!raw) continue;
    count++;
    try {
      const parsed = JSON.parse(raw) as unknown;
      const nodes = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as Record<string, unknown>)?.['@graph'])
          ? ((parsed as Record<string, unknown>)['@graph'] as unknown[])
          : [parsed];
      for (const n of nodes) {
        const t = (n as Record<string, unknown>)?.['@type'];
        if (typeof t === 'string') types.add(t);
      }
    } catch {
      // malformed block still counts toward the total (validateJsonLdStructure owns quality)
    }
  }
  return { count, types };
};

/**
 * Deterministic SEO-invariant finalizer — the structured-data + meta backstop for C.1.
 *
 * The build LLM reliably UNDER-delivers three C.1 invariants (verified on prod 2026-09-07:
 * deployed sites ship ZERO real JSON-LD blocks — the template carries the "open-now" CONSUMER
 * widget that reads `script[type=application/ld+json]` but the build never EMITS the data — plus
 * sub-120-char descriptions and JS-string `\'` escapes leaking into meta content). Report-mode
 * validators log all of it but never block, so it ships live. This runs in finalize-build AFTER
 * upload (same mid-build-authorship class as repairDoubleDotCanonical / repairDanglingEmDash),
 * sourcing every value from signals ALREADY in the shell (og:title, canonical, meta description,
 * og:image) + the real business name — no fabrication, no new plumbing. Pure — no input mutation.
 *
 * Per route HTML file (404/500/offline excluded), in order:
 *   1. Unescape invalid `\'` outside script/style.
 *   2. Description: expand <120 to 120-156 with clean name-derived CTAs (no fabricated facts);
 *      truncate >156 at a word boundary. Rewrites meta + og + twitter descriptions in lockstep.
 *   3. Title: truncate >60 at a word boundary (a <50 title needs city/category the shell lacks —
 *      the build-prompt mandate owns lengthening; this only clamps the over-long case).
 *   4. JSON-LD: when <4 real blocks, inject the missing standard blocks (WebSite + Organization +
 *      WebPage + BreadcrumbList) built from the shell — accurate for every business site,
 *      JSON.stringify-escaped, before </head>.
 *
 * @returns [repairedFiles, report]
 */
export const finalizeSeoInvariants = (
  files: BuildFile[],
  ctx: SeoFinalizeContext,
): [BuildFile[], SeoFinalizeReport] => {
  const report: SeoFinalizeReport = {
    jsonLdInjected: 0,
    escapesRepaired: 0,
    descExpanded: 0,
    titleClamped: 0,
  };
  const rootUrl = `${ctx.hostname.replace(/\/+$/, '')}/`;
  const brandName = (ctx.businessName || 'Business').trim();

  const fixed = files.map((f) => {
    if (!isHtml(f.path) || !f.text || NON_ROUTE_HTML.test(f.path)) return f;
    let text = f.text;

    // 1. Invalid `\'` escapes outside script/style.
    const esc = unescapeApostrophesOutsideScripts(text);
    if (esc.count > 0) {
      report.escapesRepaired += esc.count;
      text = esc.text;
    }

    // Shell signals (read AFTER the escape repair so values are clean).
    const ogTitle = readAttrContent(text, /<meta\s+[^>]*\bproperty=["']og:title["'][^>]*>/i);
    const titleTag = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? '';
    const rawName = (ogTitle || titleTag || brandName).split(/\s+[—–|]\s+/)[0]?.trim() || brandName;
    const canonical =
      text.match(/<link\s+[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["']/i)?.[1]?.trim() ||
      text
        .match(/<meta\s+[^>]*\bproperty=["']og:url["'][^>]*>/i)?.[0]
        ?.match(/content=["']([^"']*)["']/i)?.[1]
        ?.trim() ||
      '';
    const pageUrl = canonical || rootUrl;
    const image = readAttrContent(text, /<meta\s+[^>]*\bproperty=["']og:image["'][^>]*>/i);

    // 2. Description length 120-156.
    const desc = readAttrContent(text, /<meta\s+[^>]*\bname=["']description["'][^>]*>/i);
    let finalDesc = desc;
    if (desc && (desc.length < 120 || desc.length > 156)) {
      if (desc.length > 156) {
        finalDesc = truncateAtWord(desc, 156);
      } else {
        const ctas = [
          `Visit ${rawName} to learn more and get in touch today.`,
          `Explore our services and see how ${rawName} can help you.`,
        ];
        let out = (desc.length >= 30 ? desc : titleTag || desc).trim();
        for (const cta of ctas) {
          if (out.length >= 120) break;
          if (!/[.!?]$/.test(out)) out = `${out}.`; // clean sentence break before the CTA
          out = `${out} ${cta}`.trim();
        }
        finalDesc = out.length > 156 ? truncateAtWord(out, 156) : out;
      }
      if (finalDesc !== desc && finalDesc.length >= 120 && finalDesc.length <= 156) {
        text = setAttrContent(text, /<meta\s+[^>]*\bname=["']description["'][^>]*>/i, finalDesc);
        text = setAttrContent(
          text,
          /<meta\s+[^>]*\bproperty=["']og:description["'][^>]*>/i,
          finalDesc,
        );
        text = setAttrContent(
          text,
          /<meta\s+[^>]*\bname=["']twitter:description["'][^>]*>/i,
          finalDesc,
        );
        report.descExpanded++;
      }
    }

    // 3. Title clamp when >60 (leave <50 lengthening to the build-prompt mandate).
    if (titleTag && titleTag.length > 60) {
      const clamped = truncateAtWord(titleTag, 60);
      if (clamped && clamped.length <= 60 && clamped !== titleTag) {
        text = text.replace(/(<title[^>]*>)[\s\S]*?(<\/title>)/i, `$1${clamped}$2`);
        text = setAttrContent(text, /<meta\s+[^>]*\bproperty=["']og:title["'][^>]*>/i, clamped);
        text = setAttrContent(text, /<meta\s+[^>]*\bname=["']twitter:title["'][^>]*>/i, clamped);
        report.titleClamped++;
      }
    }

    // 4. JSON-LD ≥4 blocks — inject the missing standard types before </head>.
    const { count, types } = collectJsonLdTypes(text);
    if (count < 4 && /<\/head>/i.test(text)) {
      const wantDesc = finalDesc || desc || rawName;
      const candidates: Array<{ type: string; node: Record<string, unknown> }> = [
        {
          type: 'WebSite',
          node: {
            '@context': 'https://schema.org',
            '@type': 'WebSite',
            name: rawName,
            url: rootUrl,
          },
        },
        {
          type: 'Organization',
          node: {
            '@context': 'https://schema.org',
            '@type': 'Organization',
            name: rawName,
            url: rootUrl,
            ...(image ? { logo: image } : {}),
          },
        },
        {
          type: 'WebPage',
          node: {
            '@context': 'https://schema.org',
            '@type': 'WebPage',
            name: titleTag || rawName,
            ...(wantDesc ? { description: wantDesc } : {}),
            url: pageUrl,
            isPartOf: { '@type': 'WebSite', name: rawName, url: rootUrl },
          },
        },
        {
          type: 'BreadcrumbList',
          node: {
            '@context': 'https://schema.org',
            '@type': 'BreadcrumbList',
            itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Home', item: rootUrl }],
          },
        },
      ];
      const toAdd: string[] = [];
      let total = count;
      for (const c of candidates) {
        if (total >= 4) break;
        if (types.has(c.type)) continue;
        toAdd.push(`<script type="application/ld+json">${JSON.stringify(c.node)}</script>`);
        total++;
      }
      if (toAdd.length > 0) {
        text = text.replace(/<\/head>/i, `${toAdd.join('\n')}\n</head>`);
        report.jsonLdInjected += toAdd.length;
      }
    }

    return text === f.text ? f : { ...f, text };
  });

  return [fixed, report];
};
