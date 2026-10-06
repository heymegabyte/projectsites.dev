/**
 * Asset Collector — queries multiple multimedia APIs in parallel,
 * downloads everything to a local assets/ directory, and returns a manifest.
 *
 * Usage:
 *   import { collectAssets } from './asset-collector.mjs';
 *   const manifest = await collectAssets({ slug, businessName, businessType, address, outputDir });
 */

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOTAL_TIMEOUT_MS = 60_000;

function env(key) {
  return process.env[key] || '';
}

function log(source, msg) {
  console.warn(`[assets] ${source}: ${msg}`);
}

/**
 * Download a URL to a local file. Returns the file path on success, null on failure.
 */
async function downloadFile(url, destPath, signal) {
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) {
      log('download', `HTTP ${res.status} for ${url}`);
      return null;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destPath, buffer);
    return destPath;
  } catch (err) {
    log('download', `Failed ${url}: ${err.message}`);
    return null;
  }
}

/**
 * Wrap an async function so it never throws — returns { ok, value } or { ok, error }.
 */
async function safe(label, fn) {
  try {
    const value = await fn();
    return { ok: true, label, value };
  } catch (err) {
    log(label, `Error: ${err.message}`);
    return { ok: false, label, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// 1. Stock Photos — Unsplash, Pexels, Pixabay
// ---------------------------------------------------------------------------

async function searchUnsplash(query, signal) {
  const key = env('UNSPLASH_ACCESS_KEY');
  if (!key) { log('Unsplash', 'No API key, skipping'); return []; }

  const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=10&orientation=landscape`;
  const res = await fetch(url, { headers: { Authorization: `Client-ID ${key}` }, signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const photos = (data.results || []).map((p) => ({
    source: 'unsplash',
    url: p.urls?.regular || p.urls?.full,
    width: p.width,
    height: p.height,
    description: p.alt_description || '',
    credit: p.user?.name || 'Unsplash',
  }));
  log('Unsplash', `${photos.length} photos`);
  return photos;
}

async function searchPexels(query, signal) {
  const key = env('PEXELS_API_KEY');
  if (!key) { log('Pexels', 'No API key, skipping'); return []; }

  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=10&orientation=landscape`;
  const res = await fetch(url, { headers: { Authorization: key }, signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const photos = (data.photos || []).map((p) => ({
    source: 'pexels',
    url: p.src?.large2x || p.src?.large || p.src?.original,
    width: p.width,
    height: p.height,
    description: p.alt || '',
    credit: p.photographer || 'Pexels',
  }));
  log('Pexels', `${photos.length} photos`);
  return photos;
}

async function searchPixabayPhotos(query, signal) {
  const key = env('PIXABAY_API_KEY');
  if (!key) { log('Pixabay', 'No API key, skipping'); return []; }

  const url = `https://pixabay.com/api/?key=${key}&q=${encodeURIComponent(query)}&image_type=photo&per_page=10&orientation=horizontal`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const photos = (data.hits || []).map((p) => ({
    source: 'pixabay',
    url: p.largeImageURL || p.webformatURL,
    width: p.imageWidth,
    height: p.imageHeight,
    description: p.tags || '',
    credit: p.user || 'Pixabay',
  }));
  log('Pixabay Photos', `${photos.length} photos`);
  return photos;
}

/**
 * Build a set of specific, high-quality search queries for stock photo APIs.
 * Uses business context to generate queries more likely to return relevant images.
 *
 * @param {string} businessName - Business name
 * @param {string} businessType - Type/category of business
 * @param {string} [city] - City extracted from address
 * @returns {string[]} Array of search queries (deduplicated)
 */
function buildStockPhotoQueries(businessName, businessType, city) {
  const queries = new Set();

  // Location-specific query
  if (city) {
    queries.add(`${businessName} ${city}`);
  }

  // Professional interior/exterior
  queries.add(`${businessType} professional interior`);
  queries.add(`${businessType} professional exterior storefront`);

  // Business-type-specific queries based on common categories
  const typeLC = businessType.toLowerCase();

  if (typeLC.includes('coffee') || typeLC.includes('cafe') || typeLC.includes('café')) {
    queries.add('coffee shop latte art');
    queries.add('cafe interior modern cozy');
    queries.add('barista preparing coffee');
  } else if (typeLC.includes('restaurant') || typeLC.includes('dining')) {
    queries.add('restaurant elegant table setting');
    queries.add('chef plating food professional');
    queries.add('restaurant interior warm lighting');
  } else if (typeLC.includes('salon') || typeLC.includes('barber') || typeLC.includes('beauty')) {
    queries.add('hair salon modern interior');
    queries.add('barber shop professional grooming');
    queries.add('beauty salon styling station');
  } else if (typeLC.includes('gym') || typeLC.includes('fitness') || typeLC.includes('yoga')) {
    queries.add('modern gym equipment interior');
    queries.add('fitness training professional');
    queries.add('yoga studio peaceful');
  } else if (typeLC.includes('dental') || typeLC.includes('dentist')) {
    queries.add('modern dental office interior');
    queries.add('dental care professional');
    queries.add('dentist office clean');
  } else if (typeLC.includes('law') || typeLC.includes('attorney') || typeLC.includes('legal')) {
    queries.add('law office professional interior');
    queries.add('legal consultation meeting');
    queries.add('modern office executive');
  } else if (typeLC.includes('auto') || typeLC.includes('mechanic') || typeLC.includes('car')) {
    queries.add('auto repair shop professional');
    queries.add('car mechanic working');
    queries.add('automotive service center');
  } else if (typeLC.includes('bakery') || typeLC.includes('pastry')) {
    queries.add('bakery display artisan bread');
    queries.add('pastry shop beautiful cakes');
    queries.add('bakery interior warm');
  } else if (typeLC.includes('flower') || typeLC.includes('florist')) {
    queries.add('flower shop colorful arrangements');
    queries.add('florist arranging bouquet');
    queries.add('floral shop interior');
  } else if (typeLC.includes('hotel') || typeLC.includes('inn') || typeLC.includes('lodge')) {
    queries.add('hotel lobby luxury modern');
    queries.add('hotel room elegant');
    queries.add('boutique hotel interior');
  } else {
    // Generic professional queries for unrecognized business types
    queries.add(`${businessType} workspace professional`);
    queries.add(`${businessType} service quality`);
    queries.add(`${businessType} customer experience`);
  }

  return [...queries];
}

/**
 * Extract city name from an address string.
 * @param {string} [address]
 * @returns {string|undefined}
 */
function extractCity(address) {
  if (!address) return undefined;
  // Try to find city from comma-separated address parts (e.g., "123 Main St, Springfield, IL 62701")
  const parts = address.split(',').map((p) => p.trim());
  if (parts.length >= 2) {
    // The city is typically the second-to-last or second part
    // Remove any zip/state suffix from the candidate
    const candidate = parts.length >= 3 ? parts[parts.length - 2] : parts[1];
    // Strip state abbreviation and zip code
    const cleaned = candidate.replace(/\b[A-Z]{2}\b\s*\d{5}(-\d{4})?/g, '').trim();
    if (cleaned) return cleaned;
  }
  return undefined;
}

/**
 * Collect stock photos from all 3 providers, deduplicate, pick best 8-10.
 */
async function collectStockPhotos({ businessName, businessType, address, assetsDir, signal }) {
  const city = extractCity(address);
  const queries = buildStockPhotoQueries(businessName, businessType, city);

  // Limit to 6 API calls total (2 per provider) to stay within rate limits
  const selectedQueries = queries.slice(0, 3);

  const results = await Promise.allSettled([
    ...selectedQueries.map((q) => searchUnsplash(q, signal)),
    ...selectedQueries.map((q) => searchPexels(q, signal)),
    ...selectedQueries.slice(0, 2).map((q) => searchPixabayPhotos(q, signal)),
  ]);

  // Flatten all successful results
  const allPhotos = results
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => r.value);

  // Deduplicate by URL
  const seen = new Set();
  const unique = allPhotos.filter((p) => {
    if (!p.url || seen.has(p.url)) return false;
    seen.add(p.url);
    return true;
  });

  // Sort by resolution (area) descending, take the best 10
  unique.sort((a, b) => (b.width * b.height) - (a.width * a.height));
  const best = unique.slice(0, 10);

  // Download in parallel
  const downloads = await Promise.allSettled(
    best.map(async (photo, i) => {
      const filename = `stock-${i + 1}.jpg`;
      const dest = path.join(assetsDir, filename);
      const saved = await downloadFile(photo.url, dest, signal);
      return saved ? { ...photo, localPath: filename } : null;
    }),
  );

  const images = downloads
    .filter((r) => r.status === 'fulfilled' && r.value)
    .map((r) => r.value);

  log('Stock Photos', `Downloaded ${images.length} images`);
  return images;
}

// ---------------------------------------------------------------------------
// 2. Stock Videos — Pexels + Pixabay
// ---------------------------------------------------------------------------

async function searchPexelsVideos(query, signal) {
  const key = env('PEXELS_API_KEY');
  if (!key) return [];

  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=3&orientation=landscape`;
  const res = await fetch(url, { headers: { Authorization: key }, signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data.videos || []).map((v) => {
    const medium = v.video_files?.find((f) => f.quality === 'sd') || v.video_files?.[0];
    return {
      source: 'pexels',
      url: medium?.link,
      width: medium?.width || 0,
      height: medium?.height || 0,
      duration: v.duration || 0,
    };
  }).filter((v) => v.url);
}

async function searchPixabayVideos(query, signal) {
  const key = env('PIXABAY_API_KEY');
  if (!key) return [];

  const url = `https://pixabay.com/api/videos/?key=${key}&q=${encodeURIComponent(query)}&per_page=3`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data.hits || []).map((v) => {
    const medium = v.videos?.medium || v.videos?.small;
    return {
      source: 'pixabay',
      url: medium?.url,
      width: medium?.width || 0,
      height: medium?.height || 0,
      duration: v.duration || 0,
    };
  }).filter((v) => v.url);
}

async function collectStockVideos({ businessType, assetsDir, signal }) {
  const results = await Promise.allSettled([
    searchPexelsVideos(businessType, signal),
    searchPixabayVideos(businessType, signal),
  ]);

  const allVideos = results
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => r.value);

  // Sort by shortest duration first (best for hero background), then by resolution
  allVideos.sort((a, b) => a.duration - b.duration || (b.width * b.height) - (a.width * a.height));
  const best = allVideos.slice(0, 2);

  const downloads = await Promise.allSettled(
    best.map(async (video, i) => {
      const filename = i === 0 ? 'hero-video.mp4' : `hero-video-${i + 1}.mp4`;
      const dest = path.join(assetsDir, filename);
      const saved = await downloadFile(video.url, dest, signal);
      return saved ? { ...video, localPath: filename } : null;
    }),
  );

  const videos = downloads
    .filter((r) => r.status === 'fulfilled' && r.value)
    .map((r) => r.value);

  log('Stock Videos', `Downloaded ${videos.length} videos`);
  return videos;
}

// ---------------------------------------------------------------------------
// 3. Google Street View
// ---------------------------------------------------------------------------

async function collectStreetView({ address, assetsDir, signal }) {
  if (!address) { log('StreetView', 'No address, skipping'); return null; }
  const key = env('GOOGLE_MAPS_API_KEY');
  if (!key) { log('StreetView', 'No API key, skipping'); return null; }

  const url = `https://maps.googleapis.com/maps/api/streetview?size=1200x600&location=${encodeURIComponent(address)}&key=${key}`;
  const dest = path.join(assetsDir, 'streetview.jpg');
  const saved = await downloadFile(url, dest, signal);
  if (saved) log('StreetView', 'Downloaded');
  return saved ? { localPath: 'streetview.jpg', source: 'google-streetview' } : null;
}

// ---------------------------------------------------------------------------
// 4. Google Places Photos
// ---------------------------------------------------------------------------

async function collectPlacesPhotos({ businessName, address, assetsDir, signal }) {
  if (!businessName || !address) { log('Places', 'Missing business name or address, skipping'); return { photos: [], rating: null, reviewCount: null }; }
  const key = env('GOOGLE_MAPS_API_KEY');
  if (!key) { log('Places', 'No API key, skipping'); return { photos: [], rating: null, reviewCount: null }; }

  // Find place
  const searchUrl = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(businessName + ' ' + address)}&inputtype=textquery&fields=place_id,photos,rating,user_ratings_total&key=${key}`;
  const searchRes = await fetch(searchUrl, { signal });
  if (!searchRes.ok) throw new Error(`Places search HTTP ${searchRes.status}`);
  const searchData = await searchRes.json();

  const candidate = searchData.candidates?.[0];
  if (!candidate) { log('Places', 'No candidates found'); return { photos: [], rating: null, reviewCount: null }; }

  const rating = candidate.rating || null;
  const reviewCount = candidate.user_ratings_total || null;
  const photoRefs = (candidate.photos || []).slice(0, 5).map((p) => p.photo_reference);

  if (photoRefs.length === 0) {
    log('Places', 'No photos found');
    return { photos: [], rating, reviewCount };
  }

  // Download photos in parallel
  const downloads = await Promise.allSettled(
    photoRefs.map(async (ref, i) => {
      const photoUrl = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=1200&photo_reference=${ref}&key=${key}`;
      const filename = `places-${i + 1}.jpg`;
      const dest = path.join(assetsDir, filename);
      const saved = await downloadFile(photoUrl, dest, signal);
      return saved ? { localPath: filename, source: 'google-places' } : null;
    }),
  );

  const photos = downloads
    .filter((r) => r.status === 'fulfilled' && r.value)
    .map((r) => r.value);

  log('Places', `Downloaded ${photos.length} photos (rating: ${rating}, reviews: ${reviewCount})`);
  return { photos, rating, reviewCount };
}

// ---------------------------------------------------------------------------
// 5. Yelp Photos + Reviews
// ---------------------------------------------------------------------------

async function collectYelp({ businessName, address, assetsDir, signal }) {
  if (!businessName || !address) { log('Yelp', 'Missing business name or address, skipping'); return null; }
  const key = env('YELP_API_KEY');
  if (!key) { log('Yelp', 'No API key, skipping'); return null; }

  // Search for business
  const searchUrl = `https://api.yelp.com/v3/businesses/search?term=${encodeURIComponent(businessName)}&location=${encodeURIComponent(address)}&limit=1`;
  const searchRes = await fetch(searchUrl, { headers: { Authorization: `Bearer ${key}` }, signal });
  if (!searchRes.ok) throw new Error(`Yelp search HTTP ${searchRes.status}`);
  const searchData = await searchRes.json();

  const biz = searchData.businesses?.[0];
  if (!biz) { log('Yelp', 'No business found'); return null; }

  // Fetch reviews in parallel with image download
  const [reviewsResult, imageResult] = await Promise.allSettled([
    (async () => {
      const reviewsUrl = `https://api.yelp.com/v3/businesses/${biz.id}/reviews?limit=3`;
      const reviewsRes = await fetch(reviewsUrl, { headers: { Authorization: `Bearer ${key}` }, signal });
      if (!reviewsRes.ok) return [];
      const reviewsData = await reviewsRes.json();
      return (reviewsData.reviews || []).map((r) => ({
        text: r.text,
        author: r.user?.name || 'Anonymous',
        rating: r.rating,
      }));
    })(),
    (async () => {
      if (!biz.image_url) return null;
      const dest = path.join(assetsDir, 'yelp-main.jpg');
      return downloadFile(biz.image_url, dest, signal);
    })(),
  ]);

  const reviews = reviewsResult.status === 'fulfilled' ? reviewsResult.value : [];
  const imageSaved = imageResult.status === 'fulfilled' && imageResult.value;

  log('Yelp', `Rating: ${biz.rating}, Reviews: ${biz.review_count}, Downloaded image: ${!!imageSaved}`);

  return {
    rating: biz.rating,
    reviewCount: biz.review_count,
    reviews,
    image: imageSaved ? { localPath: 'yelp-main.jpg', source: 'yelp' } : null,
  };
}

// ---------------------------------------------------------------------------
// 6. Mapbox Dark Map (geocode with Google, render with Mapbox)
// ---------------------------------------------------------------------------

async function collectMapImage({ address, assetsDir, signal }) {
  if (!address) { log('Map', 'No address, skipping'); return null; }
  const googleKey = env('GOOGLE_MAPS_API_KEY');
  const mapboxToken = env('MAPBOX_ACCESS_TOKEN');
  if (!googleKey || !mapboxToken) { log('Map', 'Missing Google or Mapbox key, skipping'); return null; }

  // Geocode
  const geocodeUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${googleKey}`;
  const geocodeRes = await fetch(geocodeUrl, { signal });
  if (!geocodeRes.ok) throw new Error(`Geocode HTTP ${geocodeRes.status}`);
  const geocodeData = await geocodeRes.json();

  const location = geocodeData.results?.[0]?.geometry?.location;
  if (!location) { log('Map', 'Geocode returned no results'); return null; }

  const { lat, lng } = location;
  const accentColor = '64ffda'; // matches project theme
  const mapUrl = `https://api.mapbox.com/styles/v1/mapbox/dark-v11/static/pin-l+${accentColor}(${lng},${lat})/${lng},${lat},15,0/1200x600@2x?access_token=${mapboxToken}`;

  const dest = path.join(assetsDir, 'map-dark.png');
  const saved = await downloadFile(mapUrl, dest, signal);
  if (saved) log('Map', `Downloaded dark map (${lat}, ${lng})`);
  return saved ? { localPath: 'map-dark.png', source: 'mapbox', lat, lng } : null;
}

// ---------------------------------------------------------------------------
// 7. AI-Generated Images (Flux Pro via Replicate)
// ---------------------------------------------------------------------------

async function generateReplicateImage(prompt, filename, assetsDir, signal) {
  const token = env('REPLICATE_API_TOKEN');
  if (!token) return null;

  // Create prediction
  const createRes = await fetch('https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro/predictions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input: {
        prompt,
        aspect_ratio: '16:9',
      },
    }),
    signal,
  });
  if (!createRes.ok) throw new Error(`Replicate create HTTP ${createRes.status}`);
  const prediction = await createRes.json();

  // Poll for completion (max ~50s with 2s intervals)
  let result = prediction;
  const pollStart = Date.now();
  while (result.status !== 'succeeded' && result.status !== 'failed') {
    if (Date.now() - pollStart > 50_000) { log('Replicate', `Timeout waiting for ${filename}`); return null; }
    await new Promise((r) => setTimeout(r, 2000));

    const pollRes = await fetch(result.urls?.get || `https://api.replicate.com/v1/predictions/${result.id}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (!pollRes.ok) throw new Error(`Replicate poll HTTP ${pollRes.status}`);
    result = await pollRes.json();
  }

  if (result.status === 'failed') {
    log('Replicate', `Generation failed for ${filename}: ${result.error}`);
    return null;
  }

  // Download the output image
  const outputUrl = Array.isArray(result.output) ? result.output[0] : result.output;
  if (!outputUrl) { log('Replicate', `No output URL for ${filename}`); return null; }

  const dest = path.join(assetsDir, filename);
  const saved = await downloadFile(outputUrl, dest, signal);
  return saved ? { localPath: filename, source: 'replicate-flux', prompt } : null;
}

async function collectAIImages({ businessType, assetsDir, signal }) {
  const token = env('REPLICATE_API_TOKEN');
  if (!token) { log('AI Images', 'No Replicate API token, skipping'); return []; }

  const prompts = [
    {
      filename: 'ai-hero.webp',
      prompt: `Professional cinematic photo of a ${businessType}, modern interior, dramatic lighting, 8k photography`,
    },
    {
      filename: 'ai-about.webp',
      prompt: `Professional portrait-style photo representing ${businessType} excellence, warm lighting`,
    },
    {
      filename: 'ai-feature.webp',
      prompt: `Professional detail shot related to ${businessType}, artistic composition`,
    },
  ];

  const results = await Promise.allSettled(
    prompts.map((p) => generateReplicateImage(p.prompt, p.filename, assetsDir, signal)),
  );

  const images = results
    .filter((r) => r.status === 'fulfilled' && r.value)
    .map((r) => r.value);

  log('AI Images', `Generated ${images.length}/${prompts.length} images`);
  return images;
}

// ---------------------------------------------------------------------------
// 8. Logo Generation (Ideogram)
// ---------------------------------------------------------------------------

async function collectLogo({ businessName, website, assetsDir, signal }) {
  // FIRST: Try to discover the real logo from the business website
  if (website) {
    try {
      const siteUrl = website.startsWith('http') ? website : `https://${website}`;
      const domain = new URL(siteUrl).hostname;

      // Try Google's high-quality favicon service (returns the actual logo/icon)
      const googleFavicon = `https://www.google.com/s2/favicons?domain=${domain}&sz=256`;
      const favDest = path.join(assetsDir, 'logo-discovered.png');
      const favResult = await downloadFile(googleFavicon, favDest, signal);
      if (favResult) {
        // Check if it's a real logo (not a generic icon) — file size > 5KB suggests real logo
        const stats = fs.statSync(favDest);
        if (stats.size > 5000) {
          log('Logo', `Discovered real logo from ${domain} (${Math.round(stats.size/1024)}KB)`);
          return { localPath: 'logo-discovered.png', source: 'website-favicon', domain };
        }
      }

      // Try og:image from the website as fallback logo source
      const pageRes = await fetch(siteUrl, { signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (pageRes.ok) {
        const html = await pageRes.text();
        const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
        if (ogMatch?.[1]) {
          const ogDest = path.join(assetsDir, 'logo-og.png');
          const ogResult = await downloadFile(ogMatch[1], ogDest, signal);
          if (ogResult) {
            log('Logo', `Discovered og:image logo from ${domain}`);
            return { localPath: 'logo-og.png', source: 'website-og-image', domain };
          }
        }
      }
    } catch (err) {
      log('Logo', `Website logo discovery failed: ${err.message}`);
    }
  }

  // FALLBACK: Generate logo with Ideogram (only if no real logo found)
  const key = env('IDEOGRAM_API_KEY');
  if (!key) { log('Logo', 'No Ideogram API key, skipping'); return null; }
  log('Logo', 'No real logo found — generating with Ideogram AI');

  const res = await fetch('https://api.ideogram.ai/generate', {
    method: 'POST',
    headers: {
      'Api-Key': key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      image_request: {
        prompt: `Minimalist professional logo for '${businessName}', clean vector style, single icon, no background`,
        model: 'V_2',
        style_type: 'DESIGN',
        aspect_ratio: 'ASPECT_1_1',
      },
    }),
    signal,
  });

  if (!res.ok) throw new Error(`Ideogram HTTP ${res.status}`);
  const data = await res.json();

  const imageUrl = data.data?.[0]?.url;
  if (!imageUrl) { log('Logo', 'No image URL in response'); return null; }

  const dest = path.join(assetsDir, 'logo-ai.png');
  const saved = await downloadFile(imageUrl, dest, signal);
  if (saved) log('Logo', 'Generated and downloaded');
  return saved ? { localPath: 'logo-ai.png', source: 'ideogram' } : null;
}

// ---------------------------------------------------------------------------
// 9. Cloudinary Optimization URLs
// ---------------------------------------------------------------------------

function getOptimizedUrl(originalUrl) {
  const cloudName = env('CLOUDINARY_CLOUD_NAME');
  if (!cloudName || !originalUrl) return originalUrl;
  return `https://res.cloudinary.com/${cloudName}/image/fetch/w_1200,h_auto,q_auto,f_webp/${encodeURIComponent(originalUrl)}`;
}

function enrichWithOptimizedUrls(images) {
  const cloudName = env('CLOUDINARY_CLOUD_NAME');
  if (!cloudName) return images;
  return images.map((img) => ({
    ...img,
    optimizedUrl: img.url ? getOptimizedUrl(img.url) : undefined,
  }));
}

// ---------------------------------------------------------------------------
// Image Quality Validation (GPT-4o-mini Vision)
// ---------------------------------------------------------------------------

/**
 * Validate a single image using GPT-4o-mini Vision API.
 * Returns a quality assessment including relevance, professionalism, and issue detection.
 *
 * PROVIDER POLICY (category-B PRODUCT, PRESERVED — rules/agent-provider-policy.md
 * § Product-runtime boundary + ADR-0057): GPT-4.1-mini VISION curation of CUSTOMER-site imagery
 * (relevance/quality/watermark gate). Vision has no DeepSeek equivalent, so OpenAI stays — this is
 * the delivery pipeline, not internal dev orchestration. (Workers-AI vision = possible FUTURE
 * enhancement, not a policy fix.)
 *
 * @param {string} imagePath - Absolute path to the image file
 * @param {string} businessName - Business name for context
 * @param {string} businessType - Business type for context
 * @returns {Promise<{relevant: boolean, professional: boolean, has_issues: boolean, score: number, reason: string} | null>}
 */
async function validateImage(imagePath, businessName, businessType) {
  const apiKey = env('OPENAI_API_KEY');
  if (!apiKey) return null;

  try {
    const imageBuffer = fs.readFileSync(imagePath);

    // Skip very small files (likely broken downloads)
    if (imageBuffer.length < 1000) {
      return { relevant: false, professional: false, has_issues: true, score: 0, reason: 'File too small, likely broken download' };
    }

    const base64 = imageBuffer.toString('base64');
    const mimeType = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text: `You are validating images for a ${businessType} called "${businessName}". Rate this image:
1. Is it relevant to this type of business? (yes/no)
2. Is it professional quality? (yes/no)
3. Does it contain watermarks, "DO NOT COPY", stock photo overlays, or inappropriate content? (yes/no)
4. Relevance score 1-10

Respond ONLY as JSON: {"relevant": bool, "professional": bool, "has_issues": bool, "score": number, "reason": "brief reason"}`,
            },
            {
              type: 'image_url',
              image_url: { url: `data:${mimeType};base64,${base64}` },
            },
          ],
        }],
        max_tokens: 150,
      }),
    });

    if (!response.ok) {
      log('Validate', `GPT-4o-mini HTTP ${response.status} for ${path.basename(imagePath)}`);
      return null;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';

    // Extract JSON from the response (handle markdown code blocks)
    const jsonMatch = content.match(/\{[^}]+\}/);
    if (!jsonMatch) {
      log('Validate', `Could not parse JSON from response for ${path.basename(imagePath)}: ${content}`);
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      relevant: !!parsed.relevant,
      professional: !!parsed.professional,
      has_issues: !!parsed.has_issues,
      score: Number(parsed.score) || 0,
      reason: String(parsed.reason || ''),
    };
  } catch (err) {
    log('Validate', `Error validating ${path.basename(imagePath)}: ${err.message}`);
    return null;
  }
}

/**
 * Validate and filter stock photos using GPT-4o-mini Vision.
 * Removes images that are irrelevant, have watermarks/issues, or score below threshold.
 * Only validates stock photos (files matching stock-*.jpg).
 *
 * @param {string} assetsDir - Path to the assets directory
 * @param {string} businessName - Business name for context
 * @param {string} businessType - Business type for context
 * @param {object[]} stockImages - Array of stock image objects with localPath
 * @param {AbortSignal} signal - Abort signal for cancellation
 * @returns {Promise<object[]>} Filtered array of valid stock images
 */
async function validateAndFilterImages(assetsDir, businessName, businessType, stockImages, signal) {
  const apiKey = env('OPENAI_API_KEY');
  if (!apiKey) {
    log('Validate', 'No OPENAI_API_KEY, skipping image validation');
    return stockImages;
  }

  if (!stockImages || stockImages.length === 0) {
    return stockImages;
  }

  log('Validate', `Validating ${stockImages.length} stock photos with GPT-4o-mini Vision...`);

  // Validate all stock images in parallel (concurrency limited to 5 at a time)
  const CONCURRENCY = 5;
  const results = [];

  for (let i = 0; i < stockImages.length; i += CONCURRENCY) {
    if (signal?.aborted) break;

    const batch = stockImages.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map(async (img) => {
        const imagePath = path.join(assetsDir, img.localPath);
        const validation = await validateImage(imagePath, businessName, businessType);
        return { img, validation };
      }),
    );
    results.push(...batchResults);
  }

  const kept = [];
  const removed = [];

  for (const result of results) {
    if (result.status !== 'fulfilled') {
      // If validation failed, keep the image (benefit of the doubt)
      kept.push(result.reason?.img || null);
      continue;
    }

    const { img, validation } = result.value;

    if (!validation) {
      // API unavailable or parse error — keep the image
      kept.push(img);
      continue;
    }

    const shouldRemove =
      validation.has_issues ||
      !validation.relevant ||
      validation.score < 5;

    if (shouldRemove) {
      removed.push({ img, validation });
      // Delete the rejected image file from disk
      try {
        const filePath = path.join(assetsDir, img.localPath);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (err) {
        log('Validate', `Could not delete rejected file ${img.localPath}: ${err.message}`);
      }
    } else {
      kept.push(img);
    }
  }

  if (removed.length > 0) {
    log('Validate', `Removed ${removed.length} images:`);
    for (const { img, validation } of removed) {
      log('Validate', `  - ${img.localPath}: score=${validation.score}, reason="${validation.reason}"`);
    }
  }

  log('Validate', `Kept ${kept.filter(Boolean).length}/${stockImages.length} stock photos after validation`);
  return kept.filter(Boolean);
}

/**
 * Attempt to download replacement images for slots that were filtered out.
 * Uses more specific search queries to find better alternatives.
 *
 * @param {number} needed - Number of replacement images needed
 * @param {string} businessName - Business name
 * @param {string} businessType - Business type
 * @param {string} [address] - Business address
 * @param {string} assetsDir - Assets directory
 * @param {number} startIndex - Starting index for filenames (stock-N.jpg)
 * @param {AbortSignal} signal - Abort signal
 * @returns {Promise<object[]>} Array of replacement image objects
 */
async function fetchReplacementImages(needed, businessName, businessType, address, assetsDir, startIndex, signal) {
  if (needed <= 0) return [];

  log('Validate', `Fetching ${needed} replacement images with refined queries...`);

  const city = extractCity(address);
  const typeLC = businessType.toLowerCase();

  // Build very specific replacement queries
  const replacementQueries = [];
  if (city) {
    replacementQueries.push(`${businessType} ${city} professional`);
  }
  replacementQueries.push(`${businessType} high quality professional photography`);
  replacementQueries.push(`${businessType} interior design modern`);

  // Add type-specific replacement queries
  if (typeLC.includes('coffee') || typeLC.includes('cafe')) {
    replacementQueries.push('specialty coffee pour over closeup');
  } else if (typeLC.includes('restaurant')) {
    replacementQueries.push('fine dining restaurant ambiance');
  } else if (typeLC.includes('salon') || typeLC.includes('barber')) {
    replacementQueries.push('modern salon chair mirror professional');
  } else {
    replacementQueries.push(`${businessType} service professional team`);
  }

  // Search with replacement queries (use first 2 queries across providers)
  const searchQueries = replacementQueries.slice(0, 2);
  const searchResults = await Promise.allSettled([
    ...searchQueries.map((q) => searchUnsplash(q, signal)),
    ...searchQueries.map((q) => searchPexels(q, signal)),
  ]);

  const allPhotos = searchResults
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => r.value);

  // Deduplicate
  const seen = new Set();
  const unique = allPhotos.filter((p) => {
    if (!p.url || seen.has(p.url)) return false;
    seen.add(p.url);
    return true;
  });

  // Sort by resolution, take what we need
  unique.sort((a, b) => (b.width * b.height) - (a.width * a.height));
  const candidates = unique.slice(0, needed);

  // Download replacements
  const downloads = await Promise.allSettled(
    candidates.map(async (photo, i) => {
      const filename = `stock-${startIndex + i}.jpg`;
      const dest = path.join(assetsDir, filename);
      const saved = await downloadFile(photo.url, dest, signal);
      return saved ? { ...photo, localPath: filename } : null;
    }),
  );

  const replacements = downloads
    .filter((r) => r.status === 'fulfilled' && r.value)
    .map((r) => r.value);

  log('Validate', `Downloaded ${replacements.length}/${needed} replacement images`);
  return replacements;
}

// ---------------------------------------------------------------------------
// Main: collectAssets
// ---------------------------------------------------------------------------

/**
 * Collect all multimedia assets for a business website build.
 *
 * @param {object} params
 * @param {string} params.slug - Site slug
 * @param {string} params.businessName - Business name
 * @param {string} params.businessType - Type/category of business
 * @param {string} [params.address] - Physical address
 * @param {string} [params.phone] - Phone number
 * @param {string} [params.website] - Existing website URL
 * @param {string} params.outputDir - Directory to write assets into (an assets/ subdirectory is created)
 * @returns {Promise<object>} Manifest of collected assets and metadata
 */
export async function collectAssets(params) {
  const { slug, businessName, businessType, address, outputDir } = params;

  log('Collector', `Collecting from 14 sources for "${businessName}" (${businessType})...`);

  // Ensure assets directory exists
  const assetsDir = path.join(outputDir, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });

  // Global timeout via AbortController
  const controller = new AbortController();
  const { signal } = controller;
  const timeout = setTimeout(() => {
    log('Collector', 'Global 60s timeout reached, aborting remaining requests');
    controller.abort();
  }, TOTAL_TIMEOUT_MS);

  const ctx = { businessName, businessType, address, assetsDir, signal };

  try {
    // Run all collectors in parallel
    const [
      stockPhotos,
      stockVideos,
      streetView,
      placesData,
      yelpData,
      mapImage,
      aiImages,
      logo,
    ] = await Promise.allSettled([
      safe('Stock Photos', () => collectStockPhotos(ctx)),
      safe('Stock Videos', () => collectStockVideos(ctx)),
      safe('Street View', () => collectStreetView(ctx)),
      safe('Places', () => collectPlacesPhotos(ctx)),
      safe('Yelp', () => collectYelp(ctx)),
      safe('Map', () => collectMapImage(ctx)),
      safe('AI Images', () => collectAIImages(ctx)),
      safe('Logo', () => collectLogo(ctx)),
    ]);

    // Extract values (safe() already handles errors, but Promise.allSettled adds another layer)
    const extract = (result) => {
      if (result.status === 'fulfilled' && result.value?.ok) return result.value.value;
      return null;
    };

    let stockImgs = extract(stockPhotos) || [];
    const videos = extract(stockVideos) || [];
    const streetViewResult = extract(streetView);
    const places = extract(placesData) || { photos: [], rating: null, reviewCount: null };
    const yelp = extract(yelpData);
    const map = extract(mapImage);
    const aiImgs = extract(aiImages) || [];
    const logoResult = extract(logo);

    // Validate and filter stock photos (skip Google Places, Yelp, and AI-generated images)
    const originalCount = stockImgs.length;
    stockImgs = await validateAndFilterImages(assetsDir, businessName, businessType, stockImgs, signal);

    // If images were removed, try to fetch replacements
    const removedCount = originalCount - stockImgs.length;
    if (removedCount > 0 && !signal.aborted) {
      const startIndex = stockImgs.length + 1;
      const replacements = await fetchReplacementImages(
        removedCount, businessName, businessType, address, assetsDir, startIndex, signal,
      );

      if (replacements.length > 0) {
        // Validate replacements too (quick second pass)
        const validReplacements = await validateAndFilterImages(
          assetsDir, businessName, businessType, replacements, signal,
        );
        stockImgs = [...stockImgs, ...validReplacements];
        log('Collector', `Added ${validReplacements.length} validated replacement images`);
      }
    }

    const images = enrichWithOptimizedUrls(stockImgs);

    // Build manifest
    const manifest = {
      slug,
      businessName,
      businessType,
      collectedAt: new Date().toISOString(),
      images,
      videos,
      streetView: streetViewResult,
      placesPhotos: enrichWithOptimizedUrls(places.photos),
      placesRating: places.rating,
      placesReviewCount: places.reviewCount,
      yelpRating: yelp?.rating || null,
      yelpReviewCount: yelp?.reviewCount || null,
      yelpReviews: yelp?.reviews || [],
      yelpImage: yelp?.image || null,
      mapImage: map,
      aiImages: aiImgs,
      logo: logoResult,
      reviews: yelp?.reviews || [],
    };

    // Write manifest to disk
    const manifestPath = path.join(assetsDir, '_manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const totalAssets =
      images.length +
      videos.length +
      (streetViewResult ? 1 : 0) +
      places.photos.length +
      (yelp?.image ? 1 : 0) +
      (map ? 1 : 0) +
      aiImgs.length +
      (logoResult ? 1 : 0);

    log('Collector', `Done. ${totalAssets} assets collected, manifest written to ${manifestPath}`);

    return manifest;
  } finally {
    clearTimeout(timeout);
  }
}
