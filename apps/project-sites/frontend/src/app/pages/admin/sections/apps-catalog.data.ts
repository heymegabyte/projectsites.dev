/**
 * @module data/apps-catalog
 *
 * @description
 * Curated catalog of self-hostable open-source applications that ship with a
 * production-ready Dockerfile or docker-compose.yml. Every entry can be
 * one-click deployed onto Cloudflare Workers Containers (CFC), with auxiliary
 * services (Postgres → Neon, Redis → Upstash, S3 → R2) auto-provisioned
 * during the deploy wizard in `/admin/apps`.
 *
 * ## Picking apps
 *
 * Inclusion criteria, all must hold:
 *  - Active OSS project (commit in last 90 days)
 *  - Either a single official Dockerfile OR a 1-2-service docker-compose
 *  - All required infra is one of: Postgres / Redis / S3 / SQLite / volume
 *    (anything needing ElasticSearch / ClickHouse / Influx / custom message
 *    brokers is excluded — those don't fit the CFC + Neon + Upstash stack)
 *  - Container starts in <30s on cold boot
 *  - Memory ceiling ≤ 1 GiB at p95 (CFC instance class fits)
 *
 * ## Per-entry shape
 * {@link CatalogApp} carries everything the `/admin/apps` UI needs to render
 * the card + the worker needs to provision infra + the container DO needs
 * to start the image.
 */

/** Aux-infra dependencies the deploy wizard must provision before container start. */
export type InfraDep = 'postgres' | 'redis' | 's3' | 'sqlite' | 'volume' | 'mailrelay' | 'hyperdrive';

/**
 * Effective infra for an app — auto-includes **Hyperdrive whenever Postgres is
 * present**. Every Postgres connection routes through Cloudflare Hyperdrive for
 * connection pooling + edge acceleration (so e.g. 50 tenants on one app share a
 * pooled Postgres rather than each opening raw connections). Derived here so the
 * rule lives in ONE place instead of being hand-duplicated across ~30 catalog
 * entries — append 'hyperdrive' to any app's declared `infra` at read time.
 */
export function withHyperdrive(infra: readonly InfraDep[]): InfraDep[] {
  const out = [...infra];
  if (out.includes('postgres') && !out.includes('hyperdrive')) out.push('hyperdrive');
  return out;
}

/** Top-level taxonomy used by the catalog filter chips. */
export type AppCategory =
  | 'analytics'
  | 'knowledge'
  | 'productivity'
  | 'communication'
  | 'developer'
  | 'privacy'
  | 'marketing'
  | 'monitoring'
  | 'ai'
  | 'backend'
  | 'media'
  | 'vector-db'
  | 'media-ai'
  | 'voice-ai'
  | 'agent-platform'
  | 'ai-ops'
  | 'ai-search'
  | 'ai-marketing';

export interface CatalogApp {
  /** URL-safe slug, primary key inside `app_instances.app_slug`. */
  readonly id: string;
  /** Display name. */
  readonly name: string;
  /** One-line value-proposition shown on the catalog card. */
  readonly tagline: string;
  /** Full description rendered on the detail page. */
  readonly description: string;
  /** Headline capabilities — rendered as a checklist on the detail page's About
   *  card. Optional: only populated apps show the checklist. */
  readonly features?: readonly string[];
  /** Filter taxonomy. */
  readonly category: AppCategory;
  /** Container image reference (`registry/name:tag`). */
  readonly image: string;
  /** Optional custom Dockerfile when the upstream image is unsuitable. */
  readonly dockerfile?: string;
  /** Optional compose file path inside the upstream repo (for reference only — CFC runs one container). */
  readonly composeRef?: string;
  /** Required aux infra — provisioned during deploy wizard. */
  readonly infra: InfraDep[];
  /** Default container port to proxy `fetch` to. */
  readonly port: number;
  /** Default env-var shape — `description` shown in the deploy wizard form. */
  readonly env: ReadonlyArray<{
    readonly key: string;
    readonly description: string;
    readonly required: boolean;
    /** Auto-resolved from provisioned infra (e.g. `DATABASE_URL` from Neon). */
    readonly auto?: 'postgres_url' | 'redis_url' | 's3_url' | 'secret' | 'public_url';
    readonly default?: string;
  }>;
  /** Persistent storage hint — bytes the container's `/data` volume needs. */
  readonly volumeMB?: number;
  /** RAM ceiling in MiB — drives CFC instance-class pick. */
  readonly memoryMB: number;
  /** Estimated monthly cost USD at small-to-medium usage. */
  readonly estCostMonthly: number;
  /** Upstream homepage. */
  readonly homepage: string;
  /** Upstream repo. */
  readonly repo: string;
  /** Inline SVG glyph or emoji marker for the catalog card. */
  readonly glyph: string;
  /** License — surfaced in the detail page for compliance. */
  readonly license: string;
  /** Tags surfaced as small chips below the tagline. */
  readonly tags: ReadonlyArray<string>;
  /**
   * `true` once the per-image AppRuntime DO subclass + matching wrangler
   * `[[containers]]` block is wired — instance creation will actually boot
   * the upstream image. `false`/undefined renders a "Coming soon" pill and
   * disables the deploy button.
   */
  readonly supported?: boolean;
}

/**
 * Live/Soon classification — ONE source of truth: the per-app `supported`
 * flag on each catalog entry (a slug is "Live" only when its upstream
 * container is wired to boot today). A duplicate slugs-array here drifted
 * from the flags (9-Live vs 4-Live) and re-badged every catalog card Live
 * while the deploy backend couldn't keep the promise (journey 2026-08-19).
 * Keep the FLAG in lockstep with the worker's deployed per-image bindings
 * in wrangler.toml `[[env.production.containers]]` blocks.
 */
export function isAppSupported(id: string): boolean {
  return APPS_CATALOG.some((a) => a.id === id && a.supported === true);
}

export const APPS_CATALOG: ReadonlyArray<CatalogApp> = [
  // ── Analytics ───────────────────────────────────────────────
  {
    id: 'umami',
    supported: true,
    name: 'Umami',
    tagline: 'Privacy-respecting web analytics',
    description:
      'Cookieless, GDPR-compliant analytics. ~30KB script, real-time dashboard, event tracking. The clean alternative to Google Analytics.',
    features: [
      'Cookieless tracking — GDPR, CCPA & PECR compliant',
      'Real-time dashboard with live visitor view',
      'Unlimited websites & custom event tracking',
      'Lightweight ~30KB tracker script',
      'Team accounts & sharable report URLs',
    ],
    category: 'analytics',
    image: 'ghcr.io/umami-software/umami:postgresql-latest',
    composeRef: 'https://github.com/umami-software/umami/blob/master/docker-compose.yml',
    infra: ['postgres'],
    port: 3000,
    env: [
      { key: 'DATABASE_URL', description: 'Postgres connection string', required: true, auto: 'postgres_url' },
      { key: 'APP_SECRET', description: 'Random 32-byte secret for signing tokens', required: true, auto: 'secret' },
      { key: 'HASH_SALT', description: 'Random salt for hashed IPs', required: true, auto: 'secret' },
    ],
    memoryMB: 256,
    volumeMB: 0,
    estCostMonthly: 6,
    homepage: 'https://umami.is',
    repo: 'https://github.com/umami-software/umami',
    glyph: '📊',
    license: 'MIT',
    tags: ['analytics', 'gdpr', 'cookieless'],
  },

  // ── Knowledge ───────────────────────────────────────────────

  // ── Productivity ────────────────────────────────────────────

  // ── Communication ───────────────────────────────────────────

  // ── Developer ───────────────────────────────────────────────

  // ── Privacy ─────────────────────────────────────────────────

  // ── Marketing ───────────────────────────────────────────────
  {
    id: 'listmonk',
    supported: true,
    name: 'Listmonk',
    tagline: 'Self-hosted email + campaign manager',
    description: 'Newsletter blasts, transactional email, segmentation. Go-fast, sends 5M+ emails/hour.',
    features: [
      'Subscriber & list management with segmentation',
      'High-throughput sending (millions/hour)',
      'Rich + plain-text templating',
      'Campaign analytics — opens, clicks, bounces',
      'Double opt-in, import/export & multi-list',
    ],
    category: 'marketing',
    image: 'listmonk/listmonk:latest',
    infra: ['postgres', 'mailrelay'],
    port: 9000,
    env: [
      { key: 'LISTMONK_db__host', description: 'Postgres host', required: true, auto: 'postgres_url' },
      { key: 'LISTMONK_db__user', description: 'Postgres user', required: true, auto: 'postgres_url' },
      { key: 'LISTMONK_db__password', description: 'Postgres password', required: true, auto: 'postgres_url' },
      { key: 'LISTMONK_db__database', description: 'DB name', required: true, auto: 'postgres_url' },
      { key: 'LISTMONK_app__address', description: '0.0.0.0:9000', required: true, default: '0.0.0.0:9000' },
    ],
    memoryMB: 256,
    volumeMB: 0,
    estCostMonthly: 7,
    homepage: 'https://listmonk.app',
    repo: 'https://github.com/knadh/listmonk',
    glyph: '📧',
    license: 'AGPL-3.0',
    tags: ['email', 'newsletter', 'mautic-alt'],
  },

  // ── Monitoring ──────────────────────────────────────────────

  // ── AI ──────────────────────────────────────────────────────
  {
    id: 'open-webui',
    supported: true,
    name: 'Open WebUI',
    tagline: 'Beautiful UI for Ollama + OpenAI + Anthropic',
    description: 'ChatGPT-like UI for your local LLMs. RAG, multi-model, voice. The polished AI playground.',
    features: [
      'ChatGPT-style chat for Ollama + OpenAI-compatible APIs',
      'RAG — chat with your own documents',
      'Multi-model switching mid-conversation',
      'Markdown, code & LaTeX rendering',
      'Voice input & multi-user with roles',
    ],
    category: 'ai',
    image: 'ghcr.io/open-webui/open-webui:main',
    infra: ['sqlite', 'volume'],
    port: 8080,
    env: [
      { key: 'WEBUI_SECRET_KEY', description: 'Session signing key', required: true, auto: 'secret' },
      { key: 'OLLAMA_BASE_URL', description: 'Optional Ollama endpoint', required: false },
      { key: 'OPENAI_API_KEY', description: 'OpenAI-compatible API key (or set OLLAMA_BASE_URL)', required: true },
    ],
    memoryMB: 512,
    volumeMB: 256,
    estCostMonthly: 12,
    homepage: 'https://openwebui.com',
    repo: 'https://github.com/open-webui/open-webui',
    glyph: '🤖',
    license: 'MIT',
    tags: ['llm', 'ollama', 'chat'],
  },

  // ── Backend ─────────────────────────────────────────────────

  // ── Media ───────────────────────────────────────────────────

  // ── AI (catalog v2 expansion 2026-05-24 — full rationale in src/data/AI-APPS-RESEARCH.md) ──
  {
    id: 'lobe-chat',
    name: 'Lobe Chat',
    supported: false,
    tagline: 'Polished ChatGPT-style UI for 30+ providers',
    description:
      'Cinematic chat interface for OpenAI, Anthropic, Gemini, Ollama, and local models. Plugins, vision, RAG, agent marketplace. Lighthouse 95+, PWA-ready.',
    features: [
      'Modern chat UI for 40+ LLM providers',
      'Plugins + function calling',
      'Multi-modal: vision, TTS + STT',
      'Local-first conversation storage',
      'Installable PWA, mobile-friendly',
    ],
    category: 'ai',
    image: 'lobehub/lobe-chat-database:latest',
    infra: ['postgres'],
    port: 3210,
    env: [
      { key: 'DATABASE_URL', description: 'Postgres connection string', required: true, auto: 'postgres_url' },
      { key: 'KEY_VAULTS_SECRET', description: '32-byte secret to encrypt user API keys', required: true, auto: 'secret' },
      { key: 'NEXT_AUTH_SECRET', description: 'NextAuth session secret', required: true, auto: 'secret' },
      { key: 'APP_URL', description: 'Public canonical URL', required: true, auto: 'public_url' },
      { key: 'OPENAI_API_KEY', description: 'Optional default OpenAI key', required: false },
    ],
    memoryMB: 768,
    estCostMonthly: 18,
    homepage: 'https://lobehub.com',
    repo: 'https://github.com/lobehub/lobe-chat',
    glyph: '💬',
    license: 'Apache-2.0',
    tags: ['llm', 'chat', 'pwa'],
  },
  {
    id: 'langflow',
    name: 'Langflow',
    supported: false,
    tagline: 'Visual builder for LangChain + LangGraph agents',
    description:
      'Drag-drop graph editor for RAG pipelines, agents, MCP servers. Exports Python. Backed by DataStax. The polished alternative to writing LangChain by hand.',
    features: [
      'Visual drag-and-drop flow builder',
      'Rich LangChain component library',
      'Export flows as API or embed',
      'Multi-agent orchestration',
      'Live playground for testing',
    ],
    category: 'agent-platform',
    image: 'langflowai/langflow:latest',
    infra: ['postgres', 'volume'],
    port: 7860,
    env: [
      { key: 'LANGFLOW_DATABASE_URL', description: 'Postgres connection URL', required: true, auto: 'postgres_url' },
      { key: 'LANGFLOW_AUTO_LOGIN', description: 'Auto-login flag', required: true, default: 'false' },
      { key: 'LANGFLOW_SUPERUSER', description: 'Initial admin email', required: true, default: 'admin@example.com' },
      { key: 'LANGFLOW_SUPERUSER_PASSWORD', description: 'Initial admin password', required: true, auto: 'secret' },
      { key: 'LANGFLOW_SECRET_KEY', description: '32-byte encryption secret', required: true, auto: 'secret' },
    ],
    memoryMB: 1024,
    volumeMB: 512,
    estCostMonthly: 24,
    homepage: 'https://langflow.org',
    repo: 'https://github.com/langflow-ai/langflow',
    glyph: '🕸️',
    license: 'MIT',
    tags: ['agents', 'no-code', 'rag'],
  },
  {
    id: 'litellm',
    name: 'LiteLLM',
    supported: false,
    tagline: 'OpenAI-compatible proxy for 100+ providers',
    description:
      'Unified API gateway across Anthropic, OpenAI, Bedrock, Vertex, Ollama, and 95 more. Virtual keys, spend tracking, rate limits, observability hooks.',
    features: [
      'One OpenAI-compatible API for 100+ providers',
      'Virtual keys + spend tracking',
      'Per-key rate limits + budgets',
      'Automatic fallbacks + load balancing',
      'Logging + observability hooks',
    ],
    category: 'ai-ops',
    image: 'ghcr.io/berriai/litellm-database:main-stable',
    infra: ['postgres'],
    port: 4000,
    env: [
      { key: 'DATABASE_URL', description: 'Postgres connection string', required: true, auto: 'postgres_url' },
      { key: 'LITELLM_MASTER_KEY', description: 'Master admin key (sk-...)', required: true, auto: 'secret' },
      { key: 'LITELLM_SALT_KEY', description: '32-byte salt for key encryption', required: true, auto: 'secret' },
      { key: 'STORE_MODEL_IN_DB', description: 'Persist model config in DB', required: false, default: 'True' },
    ],
    memoryMB: 768,
    estCostMonthly: 18,
    homepage: 'https://litellm.ai',
    repo: 'https://github.com/BerriAI/litellm',
    glyph: '🔀',
    license: 'MIT',
    tags: ['gateway', 'proxy', 'multi-model'],
  },
  {
    id: 'phoenix',
    supported: false,
    name: 'Arize Phoenix',
    tagline: 'OSS LLM tracing + evals',
    description:
      'OpenInference-based tracing for LangChain, LlamaIndex, DSPy, Haystack. Built-in eval datasets, prompt experimentation, side-by-side comparison.',
    features: [
      'LLM tracing + span inspection',
      'Eval + experiment tracking',
      'Embedding + retrieval analysis',
      'Prompt + dataset management',
      'OpenTelemetry-native',
    ],
    category: 'ai-ops',
    image: 'arizephoenix/phoenix:latest',
    infra: ['volume'],
    port: 6006,
    env: [
      { key: 'PHOENIX_WORKING_DIR', description: 'Data directory', required: true, default: '/mnt/data' },
      { key: 'PHOENIX_ENABLE_AUTH', description: 'Require login (true/false)', required: false, default: 'true' },
      { key: 'PHOENIX_SECRET', description: '32-byte session secret', required: false, auto: 'secret' },
    ],
    memoryMB: 768,
    volumeMB: 1024,
    estCostMonthly: 17,
    homepage: 'https://phoenix.arize.com',
    repo: 'https://github.com/Arize-ai/phoenix',
    glyph: '🔭',
    license: 'Elastic-2.0',
    tags: ['observability', 'tracing', 'opentelemetry'],
  },
  {
    id: 'stirling-pdf',
    supported: false,
    name: 'Stirling PDF',
    tagline: '60+ PDF tools — the OSS Acrobat',
    description:
      'Merge, split, sign, redact, OCR, convert, compress. 60+ REST endpoints. Files held in memory only — never written to disk.',
    features: [
      '60+ PDF tools in one app',
      'Merge, split, rotate, reorder',
      'OCR + searchable-text extraction',
      'Convert to/from Office + images',
      'Sign, redact, watermark, compress',
      'Files processed in memory — never written to disk',
    ],
    category: 'productivity',
    image: 'docker.stirlingpdf.com/stirlingtools/stirling-pdf:latest',
    infra: [],
    port: 8080,
    env: [
      { key: 'DOCKER_ENABLE_SECURITY', description: 'Enable login (true/false)', required: false, default: 'true' },
      { key: 'SECURITY_INITIALLOGIN_USERNAME', description: 'Initial admin user', required: false, default: 'admin' },
      { key: 'SECURITY_INITIALLOGIN_PASSWORD', description: 'Initial admin password', required: false, auto: 'secret' },
    ],
    memoryMB: 512,
    estCostMonthly: 11,
    homepage: 'https://stirlingpdf.com',
    repo: 'https://github.com/Stirling-Tools/Stirling-PDF',
    glyph: '📄',
    license: 'MIT',
    tags: ['pdf', 'ocr', 'acrobat-alt'],
  },
  {
    id: 'payload',
    name: 'Payload CMS',
    tagline: 'CF-native headless CMS — D1 · R2 · Worker',
    description:
      'TypeScript-native headless CMS with a React admin UI, REST + GraphQL APIs, auth, access control, and media uploads — launched CF-native on its own D1 database, R2 bucket, and Worker (no container). Delete removes all three. Up to 3 per site.',
    features: [
      'Own D1 database + R2 bucket + Worker per instance',
      'Auto-generated REST + GraphQL APIs',
      'React admin UI with live preview',
      'Auth + field-level access control',
      'Delete cascades — no dangling D1 / R2 / Worker',
    ],
    category: 'knowledge',
    image: 'cf-native:payload-d1',
    infra: [],
    port: 3000,
    env: [
      {
        key: 'PAYLOAD_SECRET',
        description: '32-byte secret for auth + field encryption (auto-generated per instance)',
        required: true,
        auto: 'secret',
      },
    ],
    memoryMB: 128,
    estCostMonthly: 5,
    homepage: 'https://payloadcms.com',
    repo: 'https://github.com/payloadcms/payload',
    glyph: '🗂️',
    license: 'MIT',
    tags: ['cms', 'headless', 'typescript', 'd1', 'r2', 'cf-worker'],
    supported: true,
  },
];

export const APP_CATEGORIES: ReadonlyArray<{ id: AppCategory; label: string; glyph: string }> = [
  { id: 'analytics', label: 'Analytics', glyph: '📊' },
  { id: 'knowledge', label: 'Knowledge', glyph: '📚' },
  { id: 'productivity', label: 'Productivity', glyph: '✅' },
  { id: 'marketing', label: 'Marketing', glyph: '📧' },
  { id: 'ai', label: 'AI', glyph: '🤖' },
  { id: 'agent-platform', label: 'Agents', glyph: '🪢' },
  { id: 'ai-ops', label: 'AI ops', glyph: '🔬' },
];

/** Lookup an app by id — throws if missing so callers fail loud. */
export function findApp(id: string): CatalogApp {
  const app = APPS_CATALOG.find((a) => a.id === id);
  if (!app) throw new Error(`Unknown app id: ${id}`);
  return app;
}
