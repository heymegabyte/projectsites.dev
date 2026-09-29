/**
 * Per-route SEO payload for the marketing SPA — the CLIENT half of the meta SSOT.
 *
 * This is a PURE data module (no Angular deps) so it can be imported by
 * `meta.service.ts` (runtime, client-side enhancement) AND parsed by the build-time
 * SSOT gate (`src/__tests__/marketing_routes.test.ts` § "server/client meta SSOT"),
 * which cross-checks every shared route against the Worker's `MARKETING_META`
 * (`src/marketing_routes.ts`) — the crawler-facing source of truth injected by
 * HTMLRewriter. The gate fails the build if a title/description drifts between the
 * two, so the "keep in sync" comments can never silently rot.
 *
 * Keys match `app.routes.ts` leaf paths (NO leading slash; '' = home). The
 * Worker map keys those same routes with a leading slash ('/', '/create', …);
 * the gate normalizes both sides before comparing.
 */

/** Per-route SEO payload — `url` is computed at apply-time from `BASE_URL`. */
export interface PageMeta {
  title: string;
  description: string;
  url?: string;
}

/** Path → title/description map. Keys match `app.routes.ts` leaf paths. */
export const PAGE_META: Record<string, PageMeta> = {
  '': {
    // 52 chars (50-60 SEO sweet spot) + leads with the primary keyphrase
    // "AI Website Builder" (was 45 chars, brand-only, missing the keyphrase).
    title: 'ProjectSites — AI Website Builder, Live in 4 Minutes',
    description: 'AI-native website builder for real businesses. One prompt, four minutes, a gorgeous live URL with SSL, sitemap, OG cards, and JSON-LD baked in.',
  },
  'create': {
    title: 'Create Your AI Website in Minutes — No Code | ProjectSites',
    description: 'Tell us about your business and our AI builds a professional, SEO-ready website in minutes — hosted, SSL secured, and live. No coding required.',
  },
  'signin': {
    // Mirrors server MARKETING_META['/auth/sign-in'] (the /signin route is the app's
    // 401-redirect target; /auth/sign-in redirects here).
    title: 'Sign In — Manage Your AI Website | ProjectSites',
    description: 'Sign in to manage your AI-generated website — edit content, connect a custom domain, view analytics, and handle billing. Magic link, no password.',
  },
  'waiting': {
    title: 'Building Your AI Website — Live Progress | ProjectSites',
    description: 'Your AI-generated website is being built right now — watch each step (research, design, content, deploy) complete live in real time.',
  },
  'admin': {
    title: 'Dashboard - ProjectSites',
    description: 'Manage your websites, domains, files, and billing from one dashboard.',
  },
  'privacy': {
    // Mirrors server MARKETING_META['/privacy'].
    title: 'Privacy Policy — Your Data & Rights | ProjectSites',
    description: 'How ProjectSites collects, uses, stores, and protects your personal data — plus your rights to access, export, and delete it at any time.',
  },
  'terms': {
    // Mirrors server MARKETING_META['/terms'].
    title: 'Terms of Service — Usage & Billing | ProjectSites',
    description: 'The terms for using ProjectSites: account rules, acceptable use, billing, intellectual property, and service commitments for your AI-built site.',
  },
  'content': {
    title: 'Content Policy — Acceptable Use Guidelines | ProjectSites',
    description: 'Acceptable-use and content guidelines for websites built on ProjectSites — what you can publish, prohibited content, and how we enforce it.',
  },
  'blog': {
    title: 'AI Website Building Blog — Tips & Updates | ProjectSites',
    description: 'Practical guides on AI-powered website building for small businesses — SEO, design, conversion, and launch tips from the ProjectSites team.',
  },
  'changelog': {
    title: 'Changelog — Latest Features, Fixes & Updates | ProjectSites',
    description:
      'See what\'s new in ProjectSites — the latest feature releases, product improvements, and bug fixes, shipped continuously. Subscribe via RSS.',
  },
  'roadmap': {
    title: 'Product Roadmap — Shipped, In Progress & Next | ProjectSites',
    description: 'See what we are building next for ProjectSites. Trello-style public roadmap with shipped, in-progress, and planned features.',
  },
  'integrations': {
    title: 'Integrations — Stripe, Square, OpenAI & 30+ | ProjectSites',
    description: 'Connect ProjectSites with Stripe, Square, Twilio, OpenAI, Anthropic, Slack, HubSpot, and 30 more services across nine categories.',
  },
  'press': {
    title: 'Press Kit — Brand Assets & Media Contacts | ProjectSites',
    description: 'Brand assets, founder bio, fact sheet, 8-slide cinematic picture walkthrough, press releases, and media contacts for ProjectSites by Megabyte Labs.',
  },
  'developers': {
    title: 'Developer Platform — MCP Server, API & CLI | ProjectSites',
    description:
      'Build on ProjectSites with our MCP server, REST API, and CLI. Programmatic site generation, deploys, and management for developers and AI agents.',
  },
  'status': {
    title: 'System Status - ProjectSites',
    description: 'Real-time status of ProjectSites infrastructure, API, and build services.',
  },
  'search': {
    // Mirrors the server MARKETING_META['/search'] (marketing_routes.ts) so the
    // hydrated tab title matches what crawlers/social unfurlers already read.
    title: 'Find Your Business — Start an AI Website | ProjectSites',
    description: 'Search for your business and get a professional, SEO-ready website built by AI in minutes — hosted, SSL secured, and live. No coding required.',
  },
  'pricing': {
    // Was MISSING → client nav to /pricing fell back to the homepage title on the
    // hydrated tab (crawlers were fine — the server injects this). Mirrors
    // MARKETING_META['/pricing'].
    title: 'Pricing — Pay Exact Cost Plus $50/mo | ProjectSites',
    description: 'Transparent pricing: pay the exact metered Cloudflare cost of your site (Worker, D1, R2, AI, voice) plus a flat $50/mo per site. No markup, no membership fees.',
  },
  'auth/sign-up': {
    // Was MISSING → /auth/sign-up client nav showed the homepage title. Mirrors
    // MARKETING_META['/auth/sign-up'].
    title: 'Sign Up — Build Your AI Website Free | ProjectSites',
    description: 'Create your free ProjectSites account and build a professional, SEO-ready website with AI in minutes — hosted, SSL secured, and live in four minutes.',
  },
  // NOTE: no 'classic' entry — /classic is `redirectTo: ''` in app.routes.ts, so
  // the router bounces it to home before MetaService resolves it; a PAGE_META
  // ['classic'] entry would be dead. The gate instead asserts the WORKER's
  // MARKETING_META['/classic'] equals home (the redirect target) — see
  // src/__tests__/marketing_routes.test.ts (meta SSOT: redirect alias === home).
};
