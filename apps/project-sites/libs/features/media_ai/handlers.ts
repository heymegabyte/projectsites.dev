/**
 * @module libs/features/media_ai/handlers
 *
 * @description
 * The AI media pipeline for the site-build flow: discover images + videos for a
 * generated site, AI-edit an image, and proxy external image URLs so the frontend
 * can render them without CORS/mixed-content failures. `discover-images` returns
 * URLs wrapped through `/api/image-proxy` (so the SSRF-guarded proxy is the single
 * fetch path for external/cloned media), which is why the proxy lives in the same
 * module — it shares the `isProxyableImageUrl` guard with `discover-images`.
 *
 * | Method | Path                    | Purpose                                                        |
 * | ------ | ----------------------- | -------------------------------------------------------------- |
 * | GET    | /api/image-proxy        | Public SSRF-guarded external-image proxy (CORS-enabled)        |
 * | POST   | /api/ai/discover-images | AI image discovery (logo/favicon/section/gallery) for a site  |
 * | POST   | /api/ai/discover-videos | AI video discovery (YouTube etc.) for a site                  |
 * | POST   | /api/ai/edit-image      | AI image edit → returns a proxied URL                          |
 *
 * Extracted VERBATIM from the `search.ts` monolith (route-decomposition
 * installment 26) — only the route-registration receiver changed (`search.` →
 * `mediaAi.`). The exclusive `isProxyableImageUrl` SSRF guard, the
 * `ImageQualityResult`/`DiscoveredImage` interfaces, and the `scrapePageImages`
 * helper (all used only by these four routes) moved here; `gatewayFetch` (the
 * AI-gateway fetch wrapper) and `DOMAINS` (for the `/api/image-proxy` base URL)
 * are re-imported. No `onError` — the routes return explicit JSON, matching the
 * app-level error handling exactly as before.
 *
 * @packageDocumentation
 */

import { Hono } from 'hono';
import { DOMAINS } from '@project-sites/shared';
import type { Env, Variables } from '../../../src/types/env.js';
import { gatewayFetch } from '../../../src/services/ai_gateway.js';

type AppContext = { Bindings: Env; Variables: Variables };

export const mediaAi = new Hono<AppContext>();

// 1×1 transparent PNG — returned by the image proxy when a source is
// unproxyable/blocked/errored so an <img> degrades to a blank pixel instead of a
// broken box. Carried verbatim from search.ts when the media routes were
// extracted here (route-decomposition installment 26); the extraction moved the
// handlers but this module-local const was left behind, so every image-proxy
// response referenced an undefined name (a latent ReferenceError on the live
// GET /api/image-proxy). Defined here now — the routes that use it live here.
const TRANSPARENT_PIXEL = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x00, 0x00, 0x02,
  0x00, 0x01, 0xe5, 0x27, 0xde, 0xfc, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
  0x60, 0x82,
]);

/**
 * SSRF guard for the image proxy. Allows http|https to a PUBLIC host only —
 * blocks localhost/.local, private/reserved IPv4, the cloud-metadata endpoint,
 * IPv6 loopback/link-local/ULA, and IPv4-mapped IPv6 (`::ffff:…`). Mirrors the
 * host blocks in {@link isSafeWebhookUrl} but permits http (legacy/cloned image
 * sources are often http) — exported so the SSRF contract is unit-tested.
 */
export function isProxyableImageUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return false; // IPv6 loopback
  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return false; // link-local / ULA
  if (host.startsWith('::ffff:') || host.startsWith('::')) return false; // IPv4-mapped / unspecified
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) || // link-local + cloud metadata 169.254.169.254
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 100 && b >= 64 && b <= 127) // CGNAT
    )
      return false;
  }
  return true;
}

/**
 * Image proxy — fetches external images and serves with CORS headers so the
 * frontend can display them, and we can later download them for site generation.
 */
mediaAi.get('/api/image-proxy', async (c) => {
  const imageUrl = c.req.query('url');
  if (!imageUrl) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Missing url parameter' } }, 400);
  }
  // SSRF guard: never let an unauthenticated caller proxy an internal/private
  // target (cloud metadata, loopback, RFC1918). Return the placeholder pixel —
  // never fetch — so the <img> degrades without leaking internal reachability.
  if (!isProxyableImageUrl(imageUrl)) {
    return new Response(TRANSPARENT_PIXEL, {
      headers: {
        'Content-Type': 'image/png',
        'Access-Control-Allow-Origin': '*',
        'X-Proxy-Status': 'blocked',
      },
    });
  }

  try {
    // Follow up to 3 redirects MANUALLY, re-running the SSRF guard on every hop —
    // otherwise a public URL could 302 to an internal target and bypass the
    // initial check. Legit CDN signed-URL redirects (public→public) still work.
    let current = imageUrl;
    let res: Response | null = null;
    for (let hop = 0; hop < 4; hop++) {
      res = await fetch(current, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ProjectSites/1.0; +https://projectsites.dev)',
          Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          Referer: current,
        },
        redirect: 'manual',
      });
      if (res.status < 300 || res.status >= 400) break; // not a redirect → done
      const loc = res.headers.get('location');
      if (!loc) break;
      const next = new URL(loc, current).toString();
      if (!isProxyableImageUrl(next)) {
        res = null;
        break;
      } // redirect to a blocked host → refuse
      current = next;
    }

    if (!res || !res.ok) {
      // Return 1x1 transparent PNG instead of 502 so the img element doesn't break.
      return new Response(TRANSPARENT_PIXEL, {
        headers: {
          'Content-Type': 'image/png',
          'Access-Control-Allow-Origin': '*',
          'X-Proxy-Status': 'failed',
        },
      });
    }

    const ct = res.headers.get('content-type') || 'image/png';
    if (!ct.startsWith('image/') && !ct.includes('octet-stream')) {
      return new Response(TRANSPARENT_PIXEL, {
        headers: {
          'Content-Type': 'image/png',
          'Access-Control-Allow-Origin': '*',
          'X-Proxy-Status': 'not-image',
        },
      });
    }

    const body = await res.arrayBuffer();
    // Reject tiny responses (likely error pages, 1x1 tracking pixels, or placeholders).
    if (body.byteLength < 500) {
      return new Response(TRANSPARENT_PIXEL, {
        headers: {
          'Content-Type': 'image/png',
          'Access-Control-Allow-Origin': '*',
          'X-Proxy-Status': 'too-small',
        },
      });
    }

    // Read actual dimensions from the binary header to reject sub-4px images.
    const buf = new Uint8Array(body);
    let imgW = 0;
    let imgH = 0;
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf.byteLength >= 24) {
      imgW = (buf[16] << 24) | (buf[17] << 16) | (buf[18] << 8) | buf[19];
      imgH = (buf[20] << 24) | (buf[21] << 16) | (buf[22] << 8) | buf[23];
    }
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf.byteLength >= 10) {
      imgW = buf[6] | (buf[7] << 8);
      imgH = buf[8] | (buf[9] << 8);
    }
    // Reject images smaller than 4x4 (tracking pixels, spacers).
    if (imgW > 0 && imgH > 0 && (imgW < 4 || imgH < 4)) {
      return new Response(TRANSPARENT_PIXEL, {
        headers: {
          'Content-Type': 'image/png',
          'Access-Control-Allow-Origin': '*',
          'X-Proxy-Status': 'too-small-dimensions',
        },
      });
    }

    return new Response(body, {
      headers: {
        'Content-Type': ct,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=86400',
        'X-Proxy-Status': 'ok',
        ...(imgW > 0 ? { 'X-Image-Width': String(imgW), 'X-Image-Height': String(imgH) } : {}),
      },
    });
  } catch {
    return new Response(TRANSPARENT_PIXEL, {
      headers: {
        'Content-Type': 'image/png',
        'Access-Control-Allow-Origin': '*',
        'X-Proxy-Status': 'error',
      },
    });
  }
});

/** Validate that a URL points to a real, loadable image (HEAD check). */
async function isImageReachable(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ProjectSites/1.0)' },
      redirect: 'follow',
    });
    const ct = r.headers.get('content-type') || '';
    return r.ok && (ct.startsWith('image/') || ct.includes('octet-stream'));
  } catch {
    return false;
  }
}

/**
 * Fetch image dimensions by downloading the first bytes and reading the header.
 * Returns { width, height, byteLength } or null if unable to determine.
 */
async function getImageDimensions(
  url: string,
): Promise<{ width: number; height: number; byteLength: number } | null> {
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ProjectSites/1.0)',
        Range: 'bytes=0-65535',
      },
      redirect: 'follow',
    });
    if (!r.ok && r.status !== 206) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    const cl = parseInt(r.headers.get('content-length') || '0') || buf.byteLength;

    // PNG: dimensions at bytes 16-23 (IHDR chunk).
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      if (buf.byteLength >= 24) {
        const w = (buf[16] << 24) | (buf[17] << 16) | (buf[18] << 8) | buf[19];
        const h = (buf[20] << 24) | (buf[21] << 16) | (buf[22] << 8) | buf[23];
        return { width: w, height: h, byteLength: cl };
      }
    }

    // JPEG: scan for SOF0/SOF2 markers.
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i < buf.byteLength - 9) {
        if (buf[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = buf[i + 1];
        // SOF0 (0xC0) or SOF2 (0xC2) — contains dimensions.
        if (marker === 0xc0 || marker === 0xc2) {
          const h = (buf[i + 5] << 8) | buf[i + 6];
          const w = (buf[i + 7] << 8) | buf[i + 8];
          return { width: w, height: h, byteLength: cl };
        }
        const segLen = (buf[i + 2] << 8) | buf[i + 3];
        i += 2 + segLen;
      }
    }

    // GIF: dimensions at bytes 6-9.
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
      if (buf.byteLength >= 10) {
        const w = buf[6] | (buf[7] << 8);
        const h = buf[8] | (buf[9] << 8);
        return { width: w, height: h, byteLength: cl };
      }
    }

    // WebP: RIFF header, VP8 chunk.
    if (
      buf[0] === 0x52 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46 &&
      buf[3] === 0x46 &&
      buf.byteLength >= 30
    ) {
      // VP8 lossy.
      if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x20) {
        const w = (buf[26] | (buf[27] << 8)) & 0x3fff;
        const h = (buf[28] | (buf[29] << 8)) & 0x3fff;
        return { width: w, height: h, byteLength: cl };
      }
    }

    return null;
  } catch {
    return null;
  }
}

/** Image quality assessment result from AI vision inspection. */
interface ImageQualityResult {
  /** 0-100 quality score */
  quality_score: number;
  is_professional: boolean;
  /** No NSFW, no violence, no hate */
  is_safe: boolean;
  description: string;
  recommendation: 'use_as_is' | 'use_as_inspiration' | 'enhance' | 'reject';
  issues: string[];
  /** Excessive white/blank padding on sides */
  has_padding?: boolean;
  /** Appears to be a generic CAD/architectural rendering (not a real photo) */
  is_generic_rendering?: boolean;
  /** Confidence that this image is actually of/about the specified business */
  business_relevance?: number;
}

/**
 * Use GPT-4o vision to assess image quality, professionalism, and safety.
 * Returns null if the vision API is unavailable (no OpenAI key).
 */
async function inspectImageWithVision(
  imageUrl: string,
  context: { businessName: string; imageRole: 'logo' | 'favicon' | 'hero' | 'photo' | 'banner' },
  openaiKey: string,
  env: Env,
): Promise<ImageQualityResult | null> {
  try {
    const { response: res } = await gatewayFetch(env, 'openai', '/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: `You are an image quality inspector for a professional website builder. Assess images for:
1. QUALITY: Resolution clarity, compression artifacts, pixelation (0-100 score)
2. PROFESSIONALISM: Is this suitable for a business website? Consider composition, lighting, branding quality
3. SAFETY: Flag NSFW, violent, hateful, or inappropriate content
4. RELEVANCE: Does this match the business "${context.businessName}" and its intended use as a ${context.imageRole}?
5. PADDING: Does the image have large white/blank areas on the sides? (uncropped, improperly formatted)
6. RENDERING: Is this a generic CAD/architectural rendering rather than a real photograph of an actual business?
7. BUSINESS MATCH: How confident (0.0-1.0) are you this image depicts "${context.businessName}" specifically (not just a similar business)?

Return ONLY valid JSON (no markdown):
{"quality_score":0-100,"is_professional":bool,"is_safe":bool,"description":"what the image shows","recommendation":"use_as_is|use_as_inspiration|enhance|reject","issues":["issue1"],"has_padding":bool,"is_generic_rendering":bool,"business_relevance":0.0-1.0}

Scoring guide:
- 90-100: High-res, professional, clearly related to this specific business, perfect for a modern website
- 70-89: Good quality, minor issues (slightly low-res, imperfect composition)
- 50-69: Usable as inspiration but should be enhanced/replaced for final site
- 30-49: Low quality (blurry, pixelated, amateur, has padding, generic rendering) — use only as inspiration
- 0-29: Reject — too low quality, unsafe, irrelevant, or clearly not this business

REJECT if: has_padding is true AND quality is below 60, OR is_generic_rendering is true AND business_relevance < 0.5`,
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Assess this ${context.imageRole} image for "${context.businessName}":`,
              },
              { type: 'image_url', image_url: { url: imageUrl, detail: 'low' } },
            ],
          },
        ],
        max_tokens: 300,
        temperature: 0.1,
      }),
    });

    if (!res.ok) return null;
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    const content = data.choices?.[0]?.message?.content || '';
    // Strip any markdown code fences before parsing.
    const jsonStr = content
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();
    const result = JSON.parse(jsonStr) as ImageQualityResult;
    result.quality_score = Math.max(0, Math.min(100, result.quality_score));
    result.issues = result.issues || [];
    return result;
  } catch {
    return null;
  }
}

/**
 * Scrape likely content images (not icons/trackers) from a webpage's <img> tags.
 */
function scrapePageImages(html: string, domain: string): string[] {
  const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  const images: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = imgRegex.exec(html)) !== null) {
    let src = match[1];
    if (!src || src.startsWith('data:')) continue;

    // Resolve relative URLs.
    if (src.startsWith('/')) src = `https://${domain}${src}`;
    else if (!src.startsWith('http')) src = `https://${domain}/${src}`;

    // Skip tracking pixels, tiny icons, and common non-content images.
    if (/1x1|spacer|pixel|tracking|analytics|beacon|sprite|icon-\d|badge/i.test(src)) continue;
    if (/gravatar|wp-includes\/images|emoji|smilies/i.test(src)) continue;

    // Skip if width/height attributes are explicitly tiny.
    const fullTag = match[0];
    const widthMatch = fullTag.match(/width=["']?(\d+)/i);
    const heightMatch = fullTag.match(/height=["']?(\d+)/i);
    const w = widthMatch ? parseInt(widthMatch[1]) : 0;
    const h = heightMatch ? parseInt(heightMatch[1]) : 0;
    if ((w > 0 && w < 100) || (h > 0 && h < 100)) continue;

    if (!seen.has(src)) {
      seen.add(src);
      images.push(src);
    }
  }
  return images;
}

/** Extended image metadata returned by discover-images (incl. AI quality). */
interface DiscoveredImage {
  url: string;
  name: string;
  type: 'logo' | 'favicon' | 'image';
  source: 'website-scrape' | 'website-img' | 'google-cse' | 'google-favicon';
  /** Original (non-proxied) URL for internal processing */
  originalUrl?: string;
  /** AI vision quality assessment (null if vision unavailable) */
  quality?: ImageQualityResult | null;
  dimensions?: { width: number; height: number } | null;
}

/**
 * AI image discovery — finds logo, favicon, and images for a business. All URLs
 * are proxied through /api/image-proxy for CORS safety.
 *
 * @remarks
 * Every image returned has been (1) validated for reachability (HTTP HEAD/GET),
 * (2) checked for minimum dimensions (>= 64px icons, >= 400px photos), (3)
 * inspected by GPT-4o vision, and (4) annotated with a quality score + usage rec.
 */
mediaAi.post('/api/ai/discover-images', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    name: string;
    address?: string;
    website?: string;
  };
  if (!body.name) {
    return c.json({ data: { logo: null, favicon: null, images: [], brand_assessment: null } });
  }

  const openaiKey = c.env.OPENAI_API_KEY || '';
  const website = body.website || '';
  let domain = '';
  try {
    if (website)
      domain = new URL(website.startsWith('http') ? website : `https://${website}`).hostname;
  } catch {
    /* ignore */
  }

  const baseProxy = `https://${DOMAINS.SITES_BASE}/api/image-proxy?url=`;
  const proxy = (url: string) => `${baseProxy}${encodeURIComponent(url)}`;

  // ── Step 1: Scrape the business website (single fetch, reuse HTML) ──
  let scrapedHtml = '';
  if (domain) {
    try {
      const siteRes = await fetch(`https://${domain}`, {
        headers: { 'User-Agent': 'ProjectSites/1.0 (https://projectsites.dev)' },
        redirect: 'follow',
      });
      if (siteRes.ok) {
        scrapedHtml = await siteRes.text();
      }
    } catch {
      // Scraping failed — will use fallbacks.
    }
  }

  // ── Step 2: Extract logo from website ──
  let logo: DiscoveredImage | null = null;
  let favicon: DiscoveredImage | null = null;
  if (domain && scrapedHtml) {
    // og:image is usually the highest-quality brand image.
    const ogMatch =
      scrapedHtml.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
      scrapedHtml.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    // apple-touch-icon is usually the logo at 180px+.
    const appleMatch = scrapedHtml.match(
      /<link[^>]+rel=["']apple-touch-icon["'][^>]+href=["']([^"']+)["']/i,
    );
    const iconMatch = scrapedHtml.match(
      /<link[^>]+rel=["']icon["'][^>]+sizes=["'](\d+)x\d+["'][^>]+href=["']([^"']+)["']/i,
    );

    let logoUrl = '';
    if (ogMatch?.[1]) {
      logoUrl = ogMatch[1];
    } else if (appleMatch?.[1]) {
      logoUrl = appleMatch[1];
    } else if (iconMatch && parseInt(iconMatch[1]) >= 96) {
      logoUrl = iconMatch[2];
    }

    if (logoUrl) {
      if (logoUrl.startsWith('/')) logoUrl = `https://${domain}${logoUrl}`;
      else if (!logoUrl.startsWith('http')) logoUrl = `https://${domain}/${logoUrl}`;
      logo = {
        url: proxy(logoUrl),
        originalUrl: logoUrl,
        name: `${domain}-logo.png`,
        type: 'logo',
        source: 'website-scrape',
      };
    }
  }

  // Try Logo.dev API for high-res company logo.
  if (!logo && domain && c.env.LOGODEV_TOKEN) {
    try {
      const logodevUrl = `https://img.logo.dev/${domain}?token=${c.env.LOGODEV_TOKEN}&size=256&format=png&retina=true`;
      const dims = await getImageDimensions(logodevUrl);
      if (dims && dims.width >= 100 && dims.height >= 100) {
        logo = {
          url: proxy(logodevUrl),
          originalUrl: logodevUrl,
          name: `${domain}-logodev.png`,
          type: 'logo',
          source: 'website-scrape',
        };
      }
    } catch {
      /* non-critical */
    }
  }

  // Try Brandfetch API for full brand kit.
  let brandfetchData: {
    logo_url?: string;
    icon_url?: string;
    colors?: string[];
    fonts?: string[];
  } | null = null;
  if (domain && c.env.BRANDFETCH_API_KEY) {
    try {
      const bfRes = await fetch(`https://api.brandfetch.io/v2/brands/${domain}`, {
        headers: { Authorization: `Bearer ${c.env.BRANDFETCH_API_KEY}` },
      });
      if (bfRes.ok) {
        const bfData = (await bfRes.json()) as {
          logos?: { formats?: { src: string; format: string }[]; type?: string }[];
          icons?: { formats?: { src: string }[] }[];
          colors?: { hex: string; type: string }[];
          fonts?: { name: string; type: string }[];
        };
        const bfLogos = bfData.logos || [];
        const primaryLogo = bfLogos.find((l) => l.type === 'logo') || bfLogos[0];
        const logoSrc =
          primaryLogo?.formats?.find((f) => f.format === 'svg')?.src ||
          primaryLogo?.formats?.find((f) => f.format === 'png')?.src;
        if (logoSrc && !logo) {
          logo = {
            url: proxy(logoSrc),
            originalUrl: logoSrc,
            name: `${domain}-brandfetch-logo.png`,
            type: 'logo',
            source: 'website-scrape',
          };
        }
        const bfIcon = bfData.icons?.[0]?.formats?.[0]?.src;
        if (bfIcon) {
          const iconDims = await getImageDimensions(bfIcon);
          if (iconDims && iconDims.width >= 64 && !favicon) {
            favicon = {
              url: proxy(bfIcon),
              originalUrl: bfIcon,
              name: `${domain}-brandfetch-icon.png`,
              type: 'favicon',
              source: 'website-scrape',
              dimensions: { width: iconDims.width, height: iconDims.height },
            };
          }
        }
        brandfetchData = {
          logo_url: logoSrc || undefined,
          icon_url: bfIcon || undefined,
          colors: bfData.colors?.map((c) => c.hex) || [],
          fonts: bfData.fonts?.map((f) => f.name) || [],
        };
      }
    } catch {
      /* non-critical */
    }
  }

  // Fallback: Google's faviconV2 at max resolution.
  if (!logo && domain) {
    const googleFavUrl = `https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://${domain}&size=256`;
    logo = {
      url: proxy(googleFavUrl),
      originalUrl: googleFavUrl,
      name: `${domain}-logo.png`,
      type: 'logo',
      source: 'google-favicon',
    };
  }

  // ── Step 3: Extract favicon with dimension validation ──
  if (domain && scrapedHtml) {
    // Look for large icons: 512px, 384px, 256px, 192px.
    const largeIconMatch = scrapedHtml.match(
      /<link[^>]+rel=["'](?:apple-touch-icon|icon)["'][^>]+sizes=["'](\d+)x\d+["'][^>]+href=["']([^"']+)["']/gi,
    );
    let bestUrl = '';
    let bestSize = 0;
    if (largeIconMatch) {
      for (const tag of largeIconMatch) {
        const sizeM = tag.match(/sizes=["'](\d+)/i);
        const hrefM = tag.match(/href=["']([^"']+)["']/i);
        if (sizeM && hrefM) {
          const s = parseInt(sizeM[1]);
          if (s > bestSize) {
            bestSize = s;
            bestUrl = hrefM[1];
          }
        }
      }
    }
    // apple-touch-icon without sizes is usually 180px.
    if (!bestUrl || bestSize < 180) {
      const appleM = scrapedHtml.match(
        /<link[^>]+rel=["']apple-touch-icon["'][^>]+href=["']([^"']+)["']/i,
      );
      if (appleM?.[1] && bestSize < 180) {
        bestUrl = appleM[1];
        bestSize = 180;
      }
    }

    if (bestUrl) {
      if (bestUrl.startsWith('/')) bestUrl = `https://${domain}${bestUrl}`;
      else if (!bestUrl.startsWith('http')) bestUrl = `https://${domain}/${bestUrl}`;

      // Validate actual dimensions — reject sub-64px favicons.
      const dims = await getImageDimensions(bestUrl);
      if (dims && dims.width >= 64 && dims.height >= 64) {
        favicon = {
          url: proxy(bestUrl),
          originalUrl: bestUrl,
          name: `${domain}-favicon.png`,
          type: 'favicon',
          source: 'website-scrape',
          dimensions: { width: dims.width, height: dims.height },
        };
      } else if (dims) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            service: 'discover-images',
            message: 'Rejected tiny favicon',
            domain,
            width: dims.width,
            height: dims.height,
            url: bestUrl,
          }),
        );
      }
    }

    // If no valid favicon from HTML tags, try the standard favicon paths.
    if (!favicon) {
      for (const path of [
        '/apple-touch-icon.png',
        '/favicon-32x32.png',
        '/favicon.png',
        '/favicon.ico',
      ]) {
        const candidateUrl = `https://${domain}${path}`;
        const dims = await getImageDimensions(candidateUrl);
        if (dims && dims.width >= 64 && dims.height >= 64) {
          favicon = {
            url: proxy(candidateUrl),
            originalUrl: candidateUrl,
            name: `${domain}-favicon.png`,
            type: 'favicon',
            source: 'website-scrape',
            dimensions: { width: dims.width, height: dims.height },
          };
          break;
        }
      }
    }
  }

  // Fallback: Google faviconV2 at 256px (only if we have a domain and no favicon yet).
  if (!favicon && domain) {
    const googleFavUrl = `https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://${domain}&size=256`;
    const dims = await getImageDimensions(googleFavUrl);
    if (dims && dims.width >= 64 && dims.height >= 64) {
      favicon = {
        url: proxy(googleFavUrl),
        originalUrl: googleFavUrl,
        name: `${domain}-favicon.png`,
        type: 'favicon',
        source: 'google-favicon',
        dimensions: { width: dims.width, height: dims.height },
      };
    }
  }

  // ── Step 4: Discover images from multiple sources ──
  const images: DiscoveredImage[] = [];
  const cseKey = c.env.GOOGLE_CSE_KEY;
  const cseCx = c.env.GOOGLE_CSE_CX;
  const bizName = body.name;
  const slug = bizName.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  // 4a: Scrape <img> tags from the business homepage for large content images.
  if (domain && scrapedHtml) {
    const pageImages = scrapePageImages(scrapedHtml, domain);
    const scraped = await Promise.all(
      pageImages.slice(0, 10).map(async (imgUrl) => {
        const dims = await getImageDimensions(imgUrl);
        if (dims && dims.width >= 300 && dims.height >= 200 && dims.byteLength > 15000) {
          return { url: imgUrl, title: '', width: dims.width, height: dims.height };
        }
        return null;
      }),
    );
    const validScraped = scraped.filter((s): s is NonNullable<typeof s> => s !== null);
    // Largest area first — best content images tend to be large.
    validScraped.sort((a, b) => b.width * b.height - a.width * a.height);
    for (let i = 0; i < Math.min(validScraped.length, 5); i++) {
      images.push({
        url: proxy(validScraped[i].url),
        originalUrl: validScraped[i].url,
        name: `${slug}-site-${i + 1}.jpg`,
        type: 'image',
        source: 'website-img',
        dimensions: { width: validScraped[i].width, height: validScraped[i].height },
      });
    }
  }

  // 4b: Google Custom Search for additional images.
  if (cseKey && cseCx) {
    try {
      const blocked =
        /shutterstock|gettyimages|istockphoto|alamy|dreamstime|123rf|depositphotos|stock\.adobe|loopnet|zillow/i;
      const addr = body.address || '';
      const city = addr.split(',').slice(1, 2).join('').trim();
      const locationCtx = city ? ` ${city}` : '';

      const queries = [
        // Prioritize images hosted on the business's own website.
        ...(domain ? [`site:${domain} -icon -logo -badge -sprite`] : []),
        `"${bizName}"${locationCtx} official photo -watermark -stock -getty -shutterstock -hotel`,
        `"${bizName}"${locationCtx} site:wikipedia.org OR site:flickr.com OR site:commons.wikimedia.org`,
        `"${bizName}"${locationCtx} building exterior -editorial -stock -hotel -resort`,
        `"${bizName}"${locationCtx} -stock -editorial -hotel -"for sale"`,
      ];

      const allCandidates: { url: string; title: string }[] = [];
      const seenFromScrape = new Set(images.map((img) => img.originalUrl || ''));

      const searchPromises = queries.map(async (q) => {
        try {
          const cseUrl = `https://www.googleapis.com/customsearch/v1?key=${cseKey}&cx=${cseCx}&q=${encodeURIComponent(q)}&searchType=image&num=4&imgSize=xlarge&imgType=photo&safe=active`;
          const cseRes = await fetch(cseUrl);
          if (cseRes.ok) {
            const cseData = (await cseRes.json()) as {
              items?: {
                link: string;
                title: string;
                displayLink?: string;
                image?: { width?: number; height?: number };
              }[];
            };
            for (const item of cseData.items || []) {
              if (blocked.test(item.displayLink || '') || blocked.test(item.link)) continue;
              if (/watermark|preview|thumb|editorial|icon|logo|badge/i.test(item.link)) continue;
              if (seenFromScrape.has(item.link)) continue;
              const imgW = item.image?.width || 0;
              const imgH = item.image?.height || 0;
              if (imgW > 0 && imgW < 400) continue;
              if (imgH > 0 && imgH < 400) continue;
              allCandidates.push({ url: item.link, title: item.title || '' });
            }
          }
        } catch {
          /* skip */
        }
      });
      await Promise.all(searchPromises);

      // Deduplicate (also against scraped images).
      const seen = new Set<string>(seenFromScrape);
      const unique = allCandidates.filter((item) => {
        if (seen.has(item.url)) return false;
        seen.add(item.url);
        return true;
      });

      const validated: typeof unique = [];
      await Promise.all(
        unique.slice(0, 20).map(async (item) => {
          // SSRF defense-in-depth: these candidate URLs come from image-search
          // providers, not the user — but guard anyway so a compromised/poisoned
          // provider response can't make us HEAD a private/loopback/metadata host.
          if (!isProxyableImageUrl(item.url)) return;
          try {
            const r = await fetch(item.url, {
              method: 'HEAD',
              headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ProjectSites/1.0)' },
              redirect: 'follow',
            });
            const ct = r.headers.get('content-type') || '';
            const cl = parseInt(r.headers.get('content-length') || '0');
            if (r.ok && ct.startsWith('image/') && (cl === 0 || cl > 20000)) validated.push(item);
          } catch {
            /* skip */
          }
        }),
      );

      const maxCse = Math.max(0, 14 - images.length);
      for (let i = 0; i < Math.min(validated.length, maxCse); i++) {
        images.push({
          url: proxy(validated[i].url),
          originalUrl: validated[i].url,
          name: `${slug}-${images.length + 1}.jpg`,
          type: 'image',
          source: 'google-cse',
        });
      }
    } catch (err) {
      console.warn('[discover-images] CSE search failed:', err);
    }
  }

  // 4c: Unsplash — high-quality royalty-free photos.
  const unsplashKey = c.env.UNSPLASH_ACCESS_KEY;
  if (unsplashKey && images.length < 14) {
    try {
      const unsplashQuery =
        `${bizName} ${body.address?.split(',').slice(1, 2).join('').trim() || ''}`.trim();
      const uRes = await fetch(
        `https://api.unsplash.com/search/photos?query=${encodeURIComponent(unsplashQuery)}&per_page=4&orientation=landscape`,
        {
          headers: { Authorization: `Client-ID ${unsplashKey}` },
        },
      );
      if (uRes.ok) {
        const uData = (await uRes.json()) as {
          results?: {
            urls: { regular: string };
            alt_description?: string;
            user: { name: string };
          }[];
        };
        const seenUrls = new Set(images.map((img) => img.originalUrl || ''));
        for (const photo of (uData.results || []).slice(0, 4)) {
          if (!seenUrls.has(photo.urls.regular) && images.length < 14) {
            images.push({
              url: proxy(photo.urls.regular),
              originalUrl: photo.urls.regular,
              name: `${slug}-unsplash-${images.length + 1}.jpg`,
              type: 'image',
              source: 'google-cse', // grouped with discovered images
            });
          }
        }
      }
    } catch {
      /* non-critical */
    }
  }

  // 4d: Foursquare — venue photos.
  const foursquareKey = c.env.FOURSQUARE_API_KEY;
  if (foursquareKey && images.length < 14) {
    try {
      const fsQuery = encodeURIComponent(bizName);
      const fsNear = encodeURIComponent(body.address || '');
      const fsSearchRes = await fetch(
        `https://api.foursquare.com/v3/places/search?query=${fsQuery}&near=${fsNear}&limit=1`,
        {
          headers: { Authorization: foursquareKey, Accept: 'application/json' },
        },
      );
      if (fsSearchRes.ok) {
        const fsSearchData = (await fsSearchRes.json()) as { results?: { fsq_id: string }[] };
        const fsqId = fsSearchData.results?.[0]?.fsq_id;
        if (fsqId) {
          const fsPhotosRes = await fetch(
            `https://api.foursquare.com/v3/places/${fsqId}/photos?limit=4`,
            {
              headers: { Authorization: foursquareKey, Accept: 'application/json' },
            },
          );
          if (fsPhotosRes.ok) {
            const fsPhotos = (await fsPhotosRes.json()) as { prefix: string; suffix: string }[];
            const seenUrls = new Set(images.map((img) => img.originalUrl || ''));
            for (const p of (Array.isArray(fsPhotos) ? fsPhotos : []).slice(0, 3)) {
              const photoUrl = `${p.prefix}original${p.suffix}`;
              if (!seenUrls.has(photoUrl) && images.length < 14) {
                images.push({
                  url: proxy(photoUrl),
                  originalUrl: photoUrl,
                  name: `${slug}-fsq-${images.length + 1}.jpg`,
                  type: 'image',
                  source: 'google-cse',
                });
              }
            }
          }
        }
      }
    } catch {
      /* non-critical */
    }
  }

  // 4e: Yelp — business photos.
  const yelpKey = c.env.YELP_API_KEY;
  if (yelpKey && images.length < 14) {
    try {
      const yelpQuery = encodeURIComponent(bizName);
      const yelpLocation = encodeURIComponent(body.address || '');
      const yRes = await fetch(
        `https://api.yelp.com/v3/businesses/search?term=${yelpQuery}&location=${yelpLocation}&limit=1`,
        {
          headers: { Authorization: `Bearer ${yelpKey}` },
        },
      );
      if (yRes.ok) {
        const yData = (await yRes.json()) as {
          businesses?: { id: string; image_url?: string; photos?: string[] }[];
        };
        const biz = yData.businesses?.[0];
        if (biz) {
          const seenUrls = new Set(images.map((img) => img.originalUrl || ''));
          const yelpPhotos = biz.photos || (biz.image_url ? [biz.image_url] : []);
          for (const photoUrl of yelpPhotos.slice(0, 3)) {
            if (photoUrl && !seenUrls.has(photoUrl) && images.length < 14) {
              images.push({
                url: proxy(photoUrl),
                originalUrl: photoUrl,
                name: `${slug}-yelp-${images.length + 1}.jpg`,
                type: 'image',
                source: 'google-cse',
              });
            }
          }
        }
      }
    } catch {
      /* non-critical */
    }
  }

  // ── Step 5: Validate logo and favicon reachability ──
  if (logo?.originalUrl && !(await isImageReachable(logo.originalUrl))) {
    logo = null;
  }
  if (favicon?.originalUrl && !(await isImageReachable(favicon.originalUrl))) {
    favicon = null;
  }

  // ── Step 6: AI vision quality inspection on ALL images ──
  if (openaiKey) {
    const inspectionTasks: Promise<void>[] = [];

    if (logo) {
      const logoRef = logo;
      inspectionTasks.push(
        inspectImageWithVision(
          logoRef.originalUrl || logoRef.url,
          { businessName: bizName, imageRole: 'logo' },
          openaiKey,
          c.env,
        ).then((result) => {
          logoRef.quality = result;
        }),
      );
    }

    if (favicon) {
      const favRef = favicon;
      inspectionTasks.push(
        inspectImageWithVision(
          favRef.originalUrl || favRef.url,
          { businessName: bizName, imageRole: 'favicon' },
          openaiKey,
          c.env,
        ).then((result) => {
          favRef.quality = result;
        }),
      );
    }

    // Inspect discovered images in batches of 6 to avoid rate limits.
    for (let batch = 0; batch < images.length; batch += 6) {
      const batchImages = images.slice(batch, batch + 6);
      const batchTasks = batchImages.map((img) =>
        inspectImageWithVision(
          img.originalUrl || img.url,
          { businessName: bizName, imageRole: 'photo' },
          openaiKey,
          c.env,
        ).then((result) => {
          img.quality = result;
        }),
      );
      inspectionTasks.push(...batchTasks);
    }

    // Wait for all inspections (15s timeout so we don't block forever). The timer
    // MUST be cleared once allSettled wins the race — otherwise the dangling 15s
    // setTimeout keeps the runtime alive ("worker failed to exit gracefully" in a
    // real test force-exit, + minor prod resource waste per call).
    let inspectionTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(inspectionTasks),
      new Promise((resolve) => {
        inspectionTimer = setTimeout(resolve, 15000);
      }),
    ]);
    clearTimeout(inspectionTimer);

    if (logo?.quality && (!logo.quality.is_safe || logo.quality.recommendation === 'reject')) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          service: 'discover-images',
          message: 'Logo rejected by vision',
          domain,
          issues: logo.quality.issues,
        }),
      );
      logo = null;
    }
    if (
      favicon?.quality &&
      (!favicon.quality.is_safe || favicon.quality.recommendation === 'reject')
    ) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          service: 'discover-images',
          message: 'Favicon rejected by vision',
          domain,
          issues: favicon.quality.issues,
        }),
      );
      favicon = null;
    }

    const filteredImages = images.filter((img) => {
      if (!img.quality) return true; // Vision unavailable — keep
      if (!img.quality.is_safe) return false;
      if (img.quality.recommendation === 'reject') return false;
      // Excessive padding + low quality.
      if (img.quality.has_padding && img.quality.quality_score < 60) return false;
      // Generic CAD rendering with low business relevance.
      if (img.quality.is_generic_rendering && (img.quality.business_relevance ?? 0) < 0.5)
        return false;
      return true;
    });
    images.length = 0;
    images.push(...filteredImages);

    // Highest quality first so the best images appear first in the UI.
    images.sort((a, b) => (b.quality?.quality_score ?? 50) - (a.quality?.quality_score ?? 50));
  }

  // ── Step 7: Brand quality assessment ──
  let brandAssessment: {
    brand_maturity: 'established' | 'developing' | 'minimal';
    website_quality_score: number;
    asset_strategy: string;
    has_professional_logo: boolean;
    has_quality_favicon: boolean;
    recommendation: string;
    brandfetch?: NonNullable<typeof brandfetchData>;
  } | null = null;

  if (openaiKey && domain && scrapedHtml) {
    try {
      const titleMatch = scrapedHtml.match(/<title[^>]*>([^<]+)<\/title>/i);
      const pageTitle = titleMatch?.[1]?.trim() || '';
      const hasOgImage = /<meta[^>]+property=["']og:image/i.test(scrapedHtml);
      const hasAppleTouchIcon = /<link[^>]+rel=["']apple-touch-icon/i.test(scrapedHtml);
      const hasStructuredData = /application\/ld\+json/i.test(scrapedHtml);
      const hasViewport = /<meta[^>]+name=["']viewport/i.test(scrapedHtml);
      const hasSsl = website.startsWith('https');
      const imgCount = (scrapedHtml.match(/<img[^>]+>/gi) || []).length;

      // Heuristic website-quality score (0-100).
      let siteScore = 20; // base
      if (hasOgImage) siteScore += 15;
      if (hasAppleTouchIcon) siteScore += 10;
      if (hasStructuredData) siteScore += 15;
      if (hasViewport) siteScore += 10;
      if (hasSsl) siteScore += 10;
      if (imgCount >= 3) siteScore += 10;
      if (pageTitle && pageTitle.length > 5) siteScore += 10;

      const hasProfessionalLogo = !!(
        logo?.quality &&
        logo.quality.quality_score >= 70 &&
        logo.quality.is_professional
      );
      const hasQualityFavicon = !!(favicon?.dimensions && favicon.dimensions.width >= 256);

      let maturity: 'established' | 'developing' | 'minimal' = 'minimal';
      if (siteScore >= 70 && hasProfessionalLogo) maturity = 'established';
      else if (siteScore >= 40) maturity = 'developing';

      let strategy = '';
      let recommendation = '';
      if (maturity === 'established') {
        strategy = 'Use original brand assets as-is. Honor existing brand identity.';
        recommendation = 'Recreate site faithful to existing brand with modern enhancements.';
      } else if (maturity === 'developing') {
        strategy = 'Use original assets as inspiration. Enhance colors, typography, and imagery.';
        recommendation = 'Build a polished, professional site that elevates the existing brand.';
      } else {
        strategy =
          'Original assets are low quality. Use as inspiration only. Generate professional AI alternatives.';
        recommendation = 'Create a gorgeous, modern site that reimagines the brand professionally.';
      }

      brandAssessment = {
        brand_maturity: maturity,
        website_quality_score: siteScore,
        asset_strategy: strategy,
        has_professional_logo: hasProfessionalLogo,
        has_quality_favicon: hasQualityFavicon,
        recommendation,
      };
    } catch {
      // Brand assessment is non-critical.
    }
  }

  if (brandAssessment && brandfetchData) {
    brandAssessment.brandfetch = brandfetchData;
  }

  // Strip internal fields from the response.
  const cleanImage = (img: DiscoveredImage) => ({
    url: img.url,
    name: img.name,
    type: img.type,
    source: img.source,
    quality: img.quality || null,
    dimensions: img.dimensions || null,
  });

  return c.json({
    data: {
      logo: logo ? cleanImage(logo) : null,
      favicon: favicon ? cleanImage(favicon) : null,
      images: images.map(cleanImage),
      brand_assessment: brandAssessment,
    },
  });
});

/**
 * Video discovery — finds relevant videos for a business from YouTube, Pexels,
 * and Pixabay. All videos include attribution data for the `/attribution` page.
 *
 * @remarks
 * Sources in priority order: (1) YouTube Data API v3 — official channel /
 * location-specific content, (2) Pexels Video API, (3) Pixabay Video API.
 */
mediaAi.post('/api/ai/discover-videos', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    name: string;
    address?: string;
    business_type?: string;
  };
  if (!body.name) {
    return c.json({ data: { videos: [], attribution: [] } });
  }

  const videos: {
    url: string;
    embed_url: string;
    thumbnail: string;
    title: string;
    source: 'youtube' | 'pexels' | 'pixabay';
    duration_seconds: number;
    attribution: { author: string; license: string; source_url: string };
    relevance: 'business_specific' | 'category_generic';
  }[] = [];

  const bizName = body.name;
  const bizType = body.business_type || '';
  const addr = body.address || '';
  const city = addr.split(',').slice(1, 2).join('').trim();

  // 1. YouTube Data API — search for business-specific videos.
  const youtubeKey = c.env.YOUTUBE_API_KEY;
  if (youtubeKey) {
    try {
      const queries = [
        `"${bizName}" ${city}`.trim(),
        ...(bizType ? [`${bizType} ${city} tour`] : []),
      ];
      for (const q of queries) {
        const ytUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&maxResults=3&q=${encodeURIComponent(q)}&key=${youtubeKey}`;
        const ytRes = await fetch(ytUrl);
        if (ytRes.ok) {
          const ytData = (await ytRes.json()) as {
            items?: {
              id: { videoId: string };
              snippet: {
                title: string;
                thumbnails: { high?: { url: string } };
                channelTitle: string;
              };
            }[];
          };
          for (const item of ytData.items || []) {
            const videoId = item.id.videoId;
            videos.push({
              url: `https://www.youtube.com/watch?v=${videoId}`,
              embed_url: `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&loop=1&playlist=${videoId}&controls=0`,
              thumbnail:
                item.snippet.thumbnails?.high?.url ||
                `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
              title: item.snippet.title,
              source: 'youtube',
              duration_seconds: 0,
              attribution: {
                author: item.snippet.channelTitle,
                license: 'YouTube Standard License',
                source_url: `https://www.youtube.com/watch?v=${videoId}`,
              },
              relevance: q.includes(bizName) ? 'business_specific' : 'category_generic',
            });
          }
        }
      }
    } catch (err) {
      console.warn('[discover-videos] YouTube search failed:', err);
    }
  }

  // 2. Pexels Video API — royalty-free stock videos.
  const pexelsKey = c.env.PEXELS_API_KEY;
  if (pexelsKey && videos.length < 5) {
    try {
      const pexelsQuery = bizType || bizName;
      const pxRes = await fetch(
        `https://api.pexels.com/videos/search?query=${encodeURIComponent(pexelsQuery)}&per_page=3&size=large`,
        {
          headers: { Authorization: pexelsKey },
        },
      );
      if (pxRes.ok) {
        const pxData = (await pxRes.json()) as {
          videos?: {
            id: number;
            url: string;
            duration: number;
            image: string;
            user: { name: string; url: string };
            video_files?: { link: string; quality: string; width: number }[];
          }[];
        };
        for (const v of pxData.videos || []) {
          const hdFile = v.video_files?.find((f) => f.quality === 'hd' || f.width >= 1280);
          if (hdFile) {
            videos.push({
              url: v.url,
              embed_url: hdFile.link,
              thumbnail: v.image,
              title: `Stock video from Pexels`,
              source: 'pexels',
              duration_seconds: v.duration,
              attribution: {
                author: v.user.name,
                license: 'Pexels License (free for commercial use)',
                source_url: v.url,
              },
              relevance: 'category_generic',
            });
          }
        }
      }
    } catch (err) {
      console.warn('[discover-videos] Pexels search failed:', err);
    }
  }

  // 3. Pixabay Video API — royalty-free fallback.
  const pixabayKey = c.env.PIXABAY_API_KEY;
  if (pixabayKey && videos.length < 3) {
    try {
      const pbQuery = bizType || bizName;
      const pbRes = await fetch(
        `https://pixabay.com/api/videos/?key=${pixabayKey}&q=${encodeURIComponent(pbQuery)}&per_page=3&safesearch=true`,
      );
      if (pbRes.ok) {
        const pbData = (await pbRes.json()) as {
          hits?: {
            id: number;
            pageURL: string;
            duration: number;
            user: string;
            videos?: { large?: { url: string; thumbnail: string } };
          }[];
        };
        for (const h of pbData.hits || []) {
          if (h.videos?.large?.url) {
            videos.push({
              url: h.pageURL,
              embed_url: h.videos.large.url,
              thumbnail: h.videos.large.thumbnail || '',
              title: `Stock video from Pixabay`,
              source: 'pixabay',
              duration_seconds: h.duration,
              attribution: {
                author: h.user,
                license: 'Pixabay License (free for commercial use)',
                source_url: h.pageURL,
              },
              relevance: 'category_generic',
            });
          }
        }
      }
    } catch (err) {
      console.warn('[discover-videos] Pixabay search failed:', err);
    }
  }

  const seen = new Set<string>();
  const unique = videos.filter((v) => {
    if (seen.has(v.embed_url)) return false;
    seen.add(v.embed_url);
    return true;
  });

  // Business-specific first, then by source priority.
  unique.sort((a, b) => {
    if (a.relevance !== b.relevance) return a.relevance === 'business_specific' ? -1 : 1;
    const srcOrder = { youtube: 0, pexels: 1, pixabay: 2 };
    return srcOrder[a.source] - srcOrder[b.source];
  });

  const attribution = unique.map((v) => v.attribution);

  return c.json({
    data: {
      videos: unique.slice(0, 6),
      attribution,
    },
  });
});

/**
 * AI image edit — generates a new image from a text prompt using OpenAI DALL-E 3.
 * Returns a proxied URL to the generated image.
 */
mediaAi.post('/api/ai/edit-image', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { prompt: string; originalUrl?: string };
  if (!body.prompt?.trim()) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Prompt is required' } }, 400);
  }

  const openaiKey = c.env.OPENAI_API_KEY;
  if (!openaiKey) {
    return c.json(
      { error: { code: 'CONFIG_ERROR', message: 'OpenAI API key not configured' } },
      500,
    );
  }

  try {
    // If an original image URL is provided, describe it with GPT-4o Vision first, then edit.
    let editPrompt = body.prompt;
    if (body.originalUrl) {
      try {
        const { response: descRes } = await gatewayFetch(c.env, 'openai', '/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: 'Describe this image in detail — subject, colors, composition, style, setting. Be specific.',
                  },
                  { type: 'image_url', image_url: { url: body.originalUrl } },
                ],
              },
            ],
            max_tokens: 300,
          }),
        });
        if (descRes.ok) {
          const descData = (await descRes.json()) as {
            choices: { message: { content: string } }[];
          };
          const description = descData.choices?.[0]?.message?.content || '';
          if (description) {
            editPrompt = `Starting from this image: ${description}\n\nNow apply this edit: ${body.prompt}\n\nGenerate the modified version of this same image with the edit applied.`;
          }
        }
      } catch {
        /* fall through to raw prompt */
      }
    }

    const { response: res } = await gatewayFetch(c.env, 'openai', '/v1/images/generations', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt: editPrompt,
        n: 1,
        size: '1024x1024',
        response_format: 'url',
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.warn('[edit-image] DALL-E error:', err);
      return c.json({ error: { code: 'AI_ERROR', message: 'Image generation failed' } }, 502);
    }

    const data = (await res.json()) as { data?: { url: string }[] };
    const imageUrl = data.data?.[0]?.url;
    if (!imageUrl) {
      return c.json({ error: { code: 'AI_ERROR', message: 'No image returned' } }, 502);
    }

    // Proxy the generated image through our endpoint for CORS.
    const baseProxy = `https://${DOMAINS.SITES_BASE}/api/image-proxy?url=`;
    return c.json({
      data: {
        url: `${baseProxy}${encodeURIComponent(imageUrl)}`,
        prompt: body.prompt,
      },
    });
  } catch (err) {
    console.warn('[edit-image] Error:', err);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Image generation failed' } }, 500);
  }
});
