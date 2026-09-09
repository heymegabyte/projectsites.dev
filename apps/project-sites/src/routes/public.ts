/**
 * @module routes/public
 *
 * @description
 * Distribution flywheel surfaces — public, unauthenticated endpoints that feed
 * the `/changelog`, `/roadmap`, and `/integrations` marketing pages plus a
 * public RSS feed that lets users (and AI search crawlers) subscribe to ship
 * notes without polling the SPA.
 *
 * ## Endpoints
 *
 * | Method | Path | Purpose |
 * | ------ | ---- | ------- |
 * | `GET`  | `/changelog.json` | Parsed CHANGELOG.md entries (falls back to a curated hardcoded list when the file is missing) |
 * | `GET`  | `/feed.xml` | RSS 2.0 of the same entries, `application/rss+xml` content-type |
 * | `GET`  | `/api/public/integrations` | Catalog of every third-party service the platform speaks to |
 * | `GET`  | `/api/public/roadmap` | Roadmap items grouped by quarter |
 *
 * @remarks
 * Mounted from `src/index.ts` BEFORE the `*` catch-all so the marketing
 * worker never tries to resolve a site for these paths. Every response sets
 * `Cache-Control` so the edge cache can serve them at zero D1/AI cost.
 *
 * @packageDocumentation
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';

const publicRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * Parsed changelog entry — shape shared by `/changelog.json` and the RSS feed.
 *
 * @remarks
 * `date` is an ISO-8601 date string so clients can sort + render with `Intl.DateTimeFormat`.
 * `tags[]` is a free-form classification array used by the SPA filter chips and
 * the RSS feed's `<category>` elements.
 */
export interface ChangelogEntry {
  readonly date: string;
  readonly version: string;
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
}

/**
 * Curated fallback used when `CHANGELOG.md` is not bundled with the worker.
 *
 * @remarks
 * Newest entry FIRST. Keep tags concise + lower-case so SPA chip filters
 * match without normalization. Update at each release.
 */
const FALLBACK_ENTRIES: readonly ChangelogEntry[] = [
  {
    date: '2026-06-19',
    version: 'v1.8.0',
    title: 'Trust Center + installable PWA',
    body: 'New /trust page lays out our security posture honestly — generated sites are scanned so server-only keys never reach the browser, every build earns an A–F readiness grade, and connected credentials are encrypted at rest. Project Sites is now installable to your home screen on Android, desktop Chrome, and iOS Safari.',
    tags: ['feature', 'security', 'trust', 'pwa'],
  },
  {
    date: '2026-05-25',
    version: 'v1.7.0',
    title: 'Distribution flywheel — changelog, roadmap, integrations, RSS',
    body: 'Public RSS feed at /feed.xml. New /roadmap page with Trello-style columns. New /integrations catalog covering every third-party service. Changelog gains search + tag filters.',
    tags: ['feature', 'marketing', 'rss'],
  },
  {
    date: '2026-05-24',
    version: 'v1.6.0',
    title: 'Cinematic landing + voice agent',
    body: 'New OKLCH-meshed homepage with persona-aligned voice. AI Voice + SMS Agent ships with Twilio media-stream bridge, vanity number generator, and per-site MCP attachments.',
    tags: ['feature', 'voice', 'design'],
  },
  {
    date: '2026-05-22',
    version: 'v1.5.0',
    title: 'Apps store, Pulse Inbox, Pulse Social',
    body: 'Self-hostable apps deployable to Cloudflare Workers Containers. Unified inbox across email, Slack, Discord, Telegram, and website widget. Composer + scheduler for 11 social networks.',
    tags: ['feature', 'apps', 'social', 'inbox'],
  },
  {
    date: '2026-04-19',
    version: 'v1.4.0',
    title: 'Multimedia pipeline',
    body: 'Seven parallel image sources, DALL-E 3 generation, and AVIF/WebP optimization. Every site now ships with 10+ unique images curated from a 100-candidate pool.',
    tags: ['feature', 'media'],
  },
  {
    date: '2026-04-14',
    version: 'v1.3.0',
    title: 'Admin dashboard — all eleven sections polished',
    body: 'Editor, analytics, email, social, forms, integrations, billing, audit, settings, voice, and apps all received a design pass with dialog-shell primitive and brand tokens.',
    tags: ['feature', 'design', 'admin'],
  },
  {
    date: '2026-04-10',
    version: 'v1.2.0',
    title: 'Playwright E2E coverage',
    body: '41 Playwright tests across three user journeys — golden path, admin flows, and site serving. Tests run against the production URL after every deploy.',
    tags: ['quality', 'testing'],
  },
  {
    date: '2026-04-09',
    version: 'v1.1.0',
    title: 'Google Sheets, PostHog, Sentry',
    body: 'Server-side event capture with PostHog. Structured error tracking with Sentry. Google Sheets export for form submissions.',
    tags: ['integration', 'observability'],
  },
  {
    date: '2026-03-25',
    version: 'v1.0.0',
    title: 'Production launch',
    body: 'Initial public launch — AI site generation, magic-link auth, Stripe billing, custom domains, and Cloudflare Workers delivery.',
    tags: ['launch'],
  },
];

/**
 * Roadmap item shown on `/roadmap`. Status drives the column placement.
 */
export interface RoadmapItem {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: 'shipped' | 'in_progress' | 'planned';
  readonly quarter: string;
}

/**
 * Quarter-grouped roadmap shape returned by `GET /api/public/roadmap`.
 */
export interface RoadmapResponse {
  readonly quarters: readonly {
    readonly quarter: string;
    readonly items: readonly RoadmapItem[];
  }[];
}

/**
 * Curated roadmap. Source of truth lives here; future migrations can read
 * from D1 if community voting becomes a thing.
 */
const ROADMAP: readonly RoadmapItem[] = [
  {
    id: 'voice-agent',
    title: 'AI Voice + SMS Agent',
    description: 'Twilio media-stream bridge with per-site agent prompts and MCP tool attachments.',
    status: 'shipped',
    quarter: 'Q2 2026',
  },
  {
    id: 'apps-store',
    title: 'Self-hostable Apps Store',
    description:
      'One-click deploys for Umami, Outline, n8n, Vaultwarden, Listmonk on Workers Containers.',
    status: 'shipped',
    quarter: 'Q2 2026',
  },
  {
    id: 'pulse-inbox',
    title: 'Pulse Inbox',
    description:
      'Unified conversation hub across email, Slack, Discord, Telegram, and website widget.',
    status: 'shipped',
    quarter: 'Q2 2026',
  },
  {
    id: 'pulse-social',
    title: 'Pulse Social composer',
    description:
      'Composer + scheduler for eleven social networks with per-account analytics rollups.',
    status: 'shipped',
    quarter: 'Q2 2026',
  },
  {
    id: 'rss-distribution',
    title: 'Public RSS + roadmap + integrations',
    description:
      'Distribution flywheel pages so users (and AI crawlers) can subscribe to ship notes and discover every supported tool.',
    status: 'shipped',
    quarter: 'Q2 2026',
  },
  {
    id: 'memory-primitives',
    title: 'Anthropic Memory + Files + Skills',
    description:
      'Native Anthropic memory primitives so each site retains operator context across sessions.',
    status: 'in_progress',
    quarter: 'Q2 2026',
  },
  {
    id: 'citations-api',
    title: 'Citations API for AI chats',
    description:
      'Every AI response cites the exact source document so users can verify the answer.',
    status: 'in_progress',
    quarter: 'Q2 2026',
  },
  {
    id: 'agency-white-label',
    title: 'White-label agency mode',
    description:
      'Sub-orgs with brand overrides + Stripe Connect payouts for agencies reselling project sites.',
    status: 'in_progress',
    quarter: 'Q2 2026',
  },
  {
    id: 'predictive-prerender',
    title: 'Predictive prerender + Thompson A/B',
    description:
      'Per-site experiments with multi-armed bandit allocation and Speculation Rules prerender.',
    status: 'planned',
    quarter: 'Q3 2026',
  },
  {
    id: 'mobile-shell',
    title: 'Mobile Capacitor shell',
    description: 'iOS + Android native shells around the admin SPA with push notifications.',
    status: 'planned',
    quarter: 'Q3 2026',
  },
  {
    id: 'multi-region-d1',
    title: 'Multi-region D1 with read replicas',
    description: 'Sessions API across EU + APAC for sub-30ms reads worldwide.',
    status: 'planned',
    quarter: 'Q3 2026',
  },
  {
    id: 'marketplace-templates',
    title: 'Public template marketplace',
    description: 'Community-submitted templates with revenue share for the original designer.',
    status: 'planned',
    quarter: 'Q4 2026',
  },
  {
    id: 'desktop-electron',
    title: 'Desktop Electron app',
    description:
      'Offline-first desktop client with local site preview and bolt.diy editor bundled.',
    status: 'planned',
    quarter: 'Q4 2026',
  },
];

/**
 * Catalog of every third-party service the platform speaks to. Surfaced on
 * `/integrations` so prospects can verify the platform plugs into the tools
 * they already use before signing up.
 *
 * @remarks
 * `status` reflects platform support, not the third party's own status.
 * `mcp_supported = true` means a Model Context Protocol server (either
 * native or proxied) is available for AI tool calls.
 */
export interface Integration {
  readonly slug: string;
  readonly name: string;
  readonly category:
    | 'Communication'
    | 'Payments'
    | 'Analytics'
    | 'AI'
    | 'Email'
    | 'CRM'
    | 'Calendar'
    | 'Maps'
    | 'Media'
    | 'Infrastructure'
    | 'Developer';
  readonly status: 'live' | 'beta' | 'planned';
  readonly description: string;
  readonly logo_url: string;
  readonly docs_url: string;
  readonly mcp_supported: boolean;
}

/**
 * Integration catalog — keep alphabetized within each category so the SPA
 * grid renders in a predictable order without client-side sorting.
 */
const INTEGRATIONS: readonly Integration[] = [
  // Payments
  {
    slug: 'stripe',
    name: 'Stripe',
    category: 'Payments',
    status: 'live',
    description:
      'Subscription billing, Connect Express payouts, embedded checkout, and webhook idempotency.',
    logo_url: 'https://logo.clearbit.com/stripe.com',
    docs_url: 'https://stripe.com/docs',
    mcp_supported: true,
  },
  {
    slug: 'square',
    name: 'Square',
    category: 'Payments',
    status: 'live',
    description:
      'Web Payments SDK for donations, point of sale, and recurring giving with a single ledger.',
    logo_url: 'https://logo.clearbit.com/squareup.com',
    docs_url: 'https://developer.squareup.com/docs',
    mcp_supported: false,
  },
  // Communication
  {
    slug: 'twilio',
    name: 'Twilio',
    category: 'Communication',
    status: 'live',
    description:
      'Voice + SMS for the AI Voice Agent. Phone-number provisioning, vanity search, media streams.',
    logo_url: 'https://logo.clearbit.com/twilio.com',
    docs_url: 'https://www.twilio.com/docs',
    mcp_supported: false,
  },
  {
    slug: 'slack',
    name: 'Slack',
    category: 'Communication',
    status: 'live',
    description:
      'Pulse Inbox channel, alerts on form submissions and billing events, slash-command posting.',
    logo_url: 'https://logo.clearbit.com/slack.com',
    docs_url: 'https://api.slack.com',
    mcp_supported: true,
  },
  {
    slug: 'discord',
    name: 'Discord',
    category: 'Communication',
    status: 'live',
    description: 'Pulse Inbox webhook + Discord bot for community sites and team alerts.',
    logo_url: 'https://logo.clearbit.com/discord.com',
    docs_url: 'https://discord.com/developers/docs',
    mcp_supported: false,
  },
  // AI
  {
    slug: 'openai',
    name: 'OpenAI',
    category: 'AI',
    status: 'live',
    description:
      'GPT-4o, GPT Image 1.5, Whisper, and Sora. Routed through the AI Gateway for caching and fallback.',
    logo_url: 'https://logo.clearbit.com/openai.com',
    docs_url: 'https://platform.openai.com/docs',
    mcp_supported: true,
  },
  {
    slug: 'anthropic',
    name: 'Anthropic',
    category: 'AI',
    status: 'live',
    description:
      'Claude Opus 4.7 + Sonnet 4.6 with prompt caching, Citations API, and Memory primitives.',
    logo_url: 'https://logo.clearbit.com/anthropic.com',
    docs_url: 'https://docs.anthropic.com',
    mcp_supported: true,
  },
  {
    slug: 'elevenlabs',
    name: 'ElevenLabs',
    category: 'AI',
    status: 'live',
    description: 'Voice synthesis for podcast studio and AI Voice Agent outbound calls.',
    logo_url: 'https://logo.clearbit.com/elevenlabs.io',
    docs_url: 'https://elevenlabs.io/docs',
    mcp_supported: false,
  },
  {
    slug: 'deepgram',
    name: 'Deepgram',
    category: 'AI',
    status: 'live',
    description:
      'Streaming speech-to-text for live voice transcription during Twilio media-stream calls.',
    logo_url: 'https://logo.clearbit.com/deepgram.com',
    docs_url: 'https://developers.deepgram.com',
    mcp_supported: false,
  },
  {
    slug: 'stability',
    name: 'Stability AI',
    category: 'AI',
    status: 'live',
    description: 'Stable Diffusion fallback for image generation when DALL-E quota is exhausted.',
    logo_url: 'https://logo.clearbit.com/stability.ai',
    docs_url: 'https://platform.stability.ai/docs',
    mcp_supported: false,
  },
  {
    slug: 'ideogram',
    name: 'Ideogram',
    category: 'AI',
    status: 'live',
    description: 'Typographic logo generation with reliable in-image text rendering.',
    logo_url: 'https://logo.clearbit.com/ideogram.ai',
    docs_url: 'https://developer.ideogram.ai',
    mcp_supported: false,
  },
  {
    slug: 'replicate',
    name: 'Replicate',
    category: 'AI',
    status: 'live',
    description: 'Image upscaling, background removal, and access to community models.',
    logo_url: 'https://logo.clearbit.com/replicate.com',
    docs_url: 'https://replicate.com/docs',
    mcp_supported: false,
  },
  {
    slug: 'removebg',
    name: 'Remove.bg',
    category: 'AI',
    status: 'live',
    description: 'One-click background removal for logos and product photos.',
    logo_url: 'https://logo.clearbit.com/remove.bg',
    docs_url: 'https://www.remove.bg/api',
    mcp_supported: false,
  },
  // Email
  {
    slug: 'resend',
    name: 'Resend',
    category: 'Email',
    status: 'live',
    description: 'Primary transactional email provider — magic links, receipts, weekly digests.',
    logo_url: 'https://logo.clearbit.com/resend.com',
    docs_url: 'https://resend.com/docs',
    mcp_supported: true,
  },
  {
    slug: 'sendgrid',
    name: 'SendGrid',
    category: 'Email',
    status: 'live',
    description:
      'Break-glass fallback email provider with automatic failover when Amazon SES is unreachable.',
    logo_url: 'https://logo.clearbit.com/sendgrid.com',
    docs_url: 'https://docs.sendgrid.com',
    mcp_supported: false,
  },
  {
    slug: 'mailchimp',
    name: 'Mailchimp',
    category: 'Email',
    status: 'live',
    description:
      'Newsletter list sync via OAuth — every form submission can push to a Mailchimp audience.',
    logo_url: 'https://logo.clearbit.com/mailchimp.com',
    docs_url: 'https://mailchimp.com/developer',
    mcp_supported: true,
  },
  // Analytics
  {
    slug: 'posthog',
    name: 'PostHog',
    category: 'Analytics',
    status: 'live',
    description:
      'Product analytics, session replay, feature flags, and LLM observability in one platform.',
    logo_url: 'https://logo.clearbit.com/posthog.com',
    docs_url: 'https://posthog.com/docs',
    mcp_supported: true,
  },
  {
    slug: 'ga4',
    name: 'Google Analytics 4',
    category: 'Analytics',
    status: 'live',
    description:
      'Per-site GA4 measurement ID injection with Consent Mode v2 and Tag Manager support.',
    logo_url: 'https://logo.clearbit.com/google.com',
    docs_url: 'https://developers.google.com/analytics',
    mcp_supported: false,
  },
  {
    slug: 'sentry',
    name: 'Sentry',
    category: 'Analytics',
    status: 'live',
    description: 'Error tracking, release health, and performance traces for every published site.',
    logo_url: 'https://logo.clearbit.com/sentry.io',
    docs_url: 'https://docs.sentry.io',
    mcp_supported: true,
  },
  // CRM
  {
    slug: 'hubspot',
    name: 'HubSpot',
    category: 'CRM',
    status: 'live',
    description: 'Form submissions sync to HubSpot contacts with custom property mapping.',
    logo_url: 'https://logo.clearbit.com/hubspot.com',
    docs_url: 'https://developers.hubspot.com',
    mcp_supported: true,
  },
  {
    slug: 'notion',
    name: 'Notion',
    category: 'CRM',
    status: 'live',
    description: 'Push form submissions and inbox messages into a Notion database for triage.',
    logo_url: 'https://logo.clearbit.com/notion.so',
    docs_url: 'https://developers.notion.com',
    mcp_supported: true,
  },
  {
    slug: 'linear',
    name: 'Linear',
    category: 'CRM',
    status: 'live',
    description:
      'Convert inbox conversations into Linear issues with full message context attached.',
    logo_url: 'https://logo.clearbit.com/linear.app',
    docs_url: 'https://developers.linear.app',
    mcp_supported: true,
  },
  // Calendar
  {
    slug: 'google-calendar',
    name: 'Google Calendar',
    category: 'Calendar',
    status: 'live',
    description: 'Two-way sync for booking forms and the AI dashboard agenda widget.',
    logo_url: 'https://logo.clearbit.com/google.com',
    docs_url: 'https://developers.google.com/calendar',
    mcp_supported: true,
  },
  {
    slug: 'calendly',
    name: 'Calendly',
    category: 'Calendar',
    status: 'live',
    description:
      'Embed a Calendly scheduler on any site and capture booking events as form submissions.',
    logo_url: 'https://logo.clearbit.com/calendly.com',
    docs_url: 'https://developer.calendly.com',
    mcp_supported: false,
  },
  // Maps
  {
    slug: 'google-places',
    name: 'Google Places',
    category: 'Maps',
    status: 'live',
    description:
      'Business search, geocoding, photos, and hours used during the create-from-search flow.',
    logo_url: 'https://logo.clearbit.com/google.com',
    docs_url: 'https://developers.google.com/maps/documentation/places/web-service',
    mcp_supported: false,
  },
  {
    slug: 'foursquare',
    name: 'Foursquare',
    category: 'Maps',
    status: 'live',
    description:
      'Secondary venue search source and tip aggregation for hospitality and retail sites.',
    logo_url: 'https://logo.clearbit.com/foursquare.com',
    docs_url: 'https://docs.foursquare.com',
    mcp_supported: false,
  },
  {
    slug: 'yelp',
    name: 'Yelp',
    category: 'Maps',
    status: 'live',
    description:
      'Pulls venue photos and review snippets to enrich generated sites with social proof.',
    logo_url: 'https://logo.clearbit.com/yelp.com',
    docs_url: 'https://docs.developer.yelp.com',
    mcp_supported: false,
  },
  {
    slug: 'mapbox',
    name: 'Mapbox',
    category: 'Maps',
    status: 'live',
    description:
      'Custom-styled map embeds when a site needs more design control than Google Maps offers.',
    logo_url: 'https://logo.clearbit.com/mapbox.com',
    docs_url: 'https://docs.mapbox.com',
    mcp_supported: false,
  },
  // Media
  {
    slug: 'unsplash',
    name: 'Unsplash',
    category: 'Media',
    status: 'live',
    description: 'Editorial-quality stock photography sourced during the image-discovery phase.',
    logo_url: 'https://logo.clearbit.com/unsplash.com',
    docs_url: 'https://unsplash.com/documentation',
    mcp_supported: false,
  },
  {
    slug: 'pexels',
    name: 'Pexels',
    category: 'Media',
    status: 'live',
    description: 'Stock photos + 4K video clips for hero backgrounds and section reveals.',
    logo_url: 'https://logo.clearbit.com/pexels.com',
    docs_url: 'https://www.pexels.com/api',
    mcp_supported: false,
  },
  {
    slug: 'pixabay',
    name: 'Pixabay',
    category: 'Media',
    status: 'live',
    description:
      'Illustrations, vectors, and supplementary photos beyond the Unsplash + Pexels catalog.',
    logo_url: 'https://logo.clearbit.com/pixabay.com',
    docs_url: 'https://pixabay.com/api/docs',
    mcp_supported: false,
  },
  {
    slug: 'cloudinary',
    name: 'Cloudinary',
    category: 'Media',
    status: 'live',
    description:
      'Image optimization CDN — auto WebP/AVIF, responsive sizing, on-the-fly transforms.',
    logo_url: 'https://logo.clearbit.com/cloudinary.com',
    docs_url: 'https://cloudinary.com/documentation',
    mcp_supported: false,
  },
  {
    slug: 'brandfetch',
    name: 'Brandfetch',
    category: 'Media',
    status: 'live',
    description: 'Pulls every public brand asset for a domain — logos, colors, fonts, favicons.',
    logo_url: 'https://logo.clearbit.com/brandfetch.com',
    docs_url: 'https://docs.brandfetch.com',
    mcp_supported: false,
  },
  {
    slug: 'logo-dev',
    name: 'Logo.dev',
    category: 'Media',
    status: 'live',
    description:
      'Logo lookup-by-domain used during brand research before falling back to AI generation.',
    logo_url: 'https://logo.clearbit.com/logo.dev',
    docs_url: 'https://www.logo.dev/docs',
    mcp_supported: false,
  },
  // Infrastructure
  {
    slug: 'cloudflare',
    name: 'Cloudflare',
    category: 'Infrastructure',
    status: 'live',
    description:
      'Workers, D1, KV, R2, Workflows, Containers, AI Gateway, and Vectorize — the entire platform.',
    logo_url: 'https://logo.clearbit.com/cloudflare.com',
    docs_url: 'https://developers.cloudflare.com',
    mcp_supported: true,
  },
  // Developer
  {
    slug: 'github',
    name: 'GitHub',
    category: 'Developer',
    status: 'live',
    description:
      'OAuth sign-in, source-of-truth for templates, and per-site repository sync on Pro plan.',
    logo_url: 'https://logo.clearbit.com/github.com',
    docs_url: 'https://docs.github.com',
    mcp_supported: true,
  },
];

/**
 * Parse a CHANGELOG.md file in conventional-commits format. Each release
 * block starts with a level-2 header `## vX.Y.Z - YYYY-MM-DD`. Bulleted
 * lines beneath are aggregated into a single body paragraph.
 *
 * @param markdown raw file content
 * @returns parsed entries, newest first
 *
 * @example
 * ```md
 * ## v1.6.0 - 2026-05-24
 * Cinematic landing + voice agent
 *
 * - OKLCH-meshed homepage
 * - Twilio media-stream bridge
 * ```
 */
function parseChangelogMarkdown(markdown: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  const blocks = markdown.split(/^##\s+/m).slice(1);
  for (const block of blocks) {
    const headerMatch = block.match(/^(v?[\d.]+)\s*[-–]\s*(\d{4}-\d{2}-\d{2})\s*\n([\s\S]*)/);
    if (!headerMatch) continue;
    const [, version, date, rest] = headerMatch;
    const lines = rest
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const titleLine = lines.find((l) => !l.startsWith('-') && !l.startsWith('*')) ?? '';
    const bullets = lines
      .filter((l) => l.startsWith('-') || l.startsWith('*'))
      .map((l) => l.replace(/^[-*]\s*/, ''));
    const tagSet = new Set<string>();
    for (const bullet of bullets) {
      const tagMatch = bullet.match(/^\(([a-z-]+)\)/);
      if (tagMatch) tagSet.add(tagMatch[1]);
    }
    entries.push({
      date,
      version: version.startsWith('v') ? version : `v${version}`,
      title: titleLine || `Release ${version}`,
      body: bullets.length > 0 ? bullets.join(' • ') : titleLine,
      tags: tagSet.size > 0 ? [...tagSet] : ['release'],
    });
  }
  return entries.sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Load entries from the bundled `CHANGELOG.md` if present, otherwise return
 * the curated fallback. Reading happens at request time so an updated
 * changelog ships without a deploy when the file is mounted via R2.
 */
export async function loadChangelogEntries(env: Env): Promise<readonly ChangelogEntry[]> {
  try {
    if (env.SITES_BUCKET) {
      const obj = await env.SITES_BUCKET.get('marketing/CHANGELOG.md');
      if (obj) {
        const text = await obj.text();
        const parsed = parseChangelogMarkdown(text);
        if (parsed.length > 0) return parsed;
      }
    }
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'public-routes',
        message: 'changelog_r2_read_failed',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  return FALLBACK_ENTRIES;
}

/**
 * XML-escape a string for safe inclusion in RSS `<title>`, `<description>`,
 * and `<category>` elements.
 */
function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Convert an ISO-8601 date to RFC-822 (required by the RSS 2.0 spec).
 *
 * @example `"2026-05-25"` → `"Mon, 25 May 2026 00:00:00 GMT"`
 */
function toRfc822(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toUTCString();
}

/**
 * `GET /changelog.json` — Parsed changelog entries.
 *
 * @remarks
 * Edge-cached for five minutes. Consumers: the SPA `/changelog` page, AI
 * search crawlers, and the public RSS endpoint.
 */
publicRoutes.get('/changelog.json', async (c) => {
  const entries = await loadChangelogEntries(c.env);
  return c.json(
    { entries, count: entries.length, source: entries === FALLBACK_ENTRIES ? 'inline' : 'r2' },
    200,
    {
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    },
  );
});

/**
 * `GET /feed.xml` — RSS 2.0 feed of every changelog entry.
 *
 * @remarks
 * Content-type is `application/rss+xml` so feed readers auto-detect.
 * Items use the entry's date as both `pubDate` and the GUID seed so the
 * same release never appears twice in a subscriber's inbox.
 */
publicRoutes.get('/feed.xml', async (c) => {
  const entries = await loadChangelogEntries(c.env);
  const buildDate = new Date().toUTCString();
  const items = entries
    .map((e) => {
      const guid = `https://projectsites.dev/changelog#${e.version}`;
      const categories = e.tags.map((t) => `      <category>${escapeXml(t)}</category>`).join('\n');
      return `    <item>
      <title>${escapeXml(`${e.version} — ${e.title}`)}</title>
      <link>${guid}</link>
      <guid isPermaLink="false">${guid}</guid>
      <pubDate>${toRfc822(e.date)}</pubDate>
      <description>${escapeXml(e.body)}</description>
${categories}
    </item>`;
    })
    .join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Project Sites — Changelog</title>
    <link>https://projectsites.dev/changelog</link>
    <atom:link href="https://projectsites.dev/feed.xml" rel="self" type="application/rss+xml" />
    <description>Ship notes for the Project Sites platform. New features, fixes, and improvements.</description>
    <language>en-us</language>
    <lastBuildDate>${buildDate}</lastBuildDate>
    <generator>Project Sites Worker</generator>
${items}
  </channel>
</rss>`;
  return new Response(xml, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    },
  });
});

/**
 * `GET /api/public/integrations` — Catalog of every third-party service.
 *
 * @remarks
 * Edge-cached for one hour because the catalog is static between deploys.
 * Grouped by category client-side so a single round-trip serves any layout.
 */
publicRoutes.get('/api/public/integrations', (c) => {
  const byCategory = INTEGRATIONS.reduce<Record<string, Integration[]>>((acc, integration) => {
    const bucket = acc[integration.category] ?? [];
    bucket.push(integration);
    acc[integration.category] = bucket;
    return acc;
  }, {});
  return c.json(
    {
      integrations: INTEGRATIONS,
      by_category: byCategory,
      count: INTEGRATIONS.length,
      mcp_supported_count: INTEGRATIONS.filter((i) => i.mcp_supported).length,
    },
    200,
    {
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
    },
  );
});

/**
 * `GET /api/public/roadmap` — Roadmap grouped by quarter.
 *
 * @remarks
 * Quarters are returned in the order they appear in the source array so
 * the SPA can render them left-to-right without resorting.
 */
publicRoutes.get('/api/public/roadmap', (c) => {
  const quarters: { quarter: string; items: RoadmapItem[] }[] = [];
  for (const item of ROADMAP) {
    let bucket = quarters.find((q) => q.quarter === item.quarter);
    if (!bucket) {
      bucket = { quarter: item.quarter, items: [] };
      quarters.push(bucket);
    }
    bucket.items.push(item);
  }
  const response: RoadmapResponse = { quarters };
  return c.json(
    {
      ...response,
      count: ROADMAP.length,
      shipped_count: ROADMAP.filter((r) => r.status === 'shipped').length,
      in_progress_count: ROADMAP.filter((r) => r.status === 'in_progress').length,
      planned_count: ROADMAP.filter((r) => r.status === 'planned').length,
    },
    200,
    {
      'Cache-Control': 'public, max-age=600, s-maxage=600',
    },
  );
});

export { publicRoutes };
