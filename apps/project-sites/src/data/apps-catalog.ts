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
export type InfraDep = 'postgres' | 'redis' | 's3' | 'sqlite' | 'volume' | 'mailrelay';

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
  /**
   * Opt in to Neon's POOLED connection for this app's Postgres URL. Default
   * (unset/false) → the DIRECT connection (always safe). Set true ONLY for apps
   * verified to tolerate transaction-mode pooling (no LISTEN/NOTIFY, advisory
   * locks, or cross-tx prepared statements) — see
   * `docs/architecture/scale-to-zero-apps-routing.md` § Phase 3.
   */
  readonly poolerSafe?: boolean;
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
   * `true` once a per-image AppRuntime DO subclass + matching wrangler
   * `[[containers]]` block is wired — the app can actually boot. `false`
   * (or undefined) means the catalog card is decorative only and the
   * `POST /api/apps/instances` preflight returns `424 app_not_supported`.
   * Source of truth lives in
   * `src/durable_objects/app_runtime_subclasses.ts → SUPPORTED_APP_SLUGS`.
   */
  readonly supported?: boolean;
}

export const APPS_CATALOG: ReadonlyArray<CatalogApp> = [
  // ── Analytics ───────────────────────────────────────────────
  {
    id: 'umami',
    name: 'Umami',
    tagline: 'Privacy-respecting web analytics',
    description:
      'Cookieless, GDPR-compliant analytics. ~30KB script, real-time dashboard, event tracking. The clean alternative to Google Analytics.',
    category: 'analytics',
    image: 'ghcr.io/umami-software/umami:postgresql-latest',
    composeRef: 'https://github.com/umami-software/umami/blob/master/docker-compose.yml',
    infra: ['postgres'],
    port: 3000,
    env: [
      {
        key: 'DATABASE_URL',
        description: 'Postgres connection string',
        required: true,
        auto: 'postgres_url',
      },
      {
        key: 'APP_SECRET',
        description: 'Random 32-byte secret for signing tokens',
        required: true,
        auto: 'secret',
      },
      {
        key: 'HASH_SALT',
        description: 'Random salt for hashed IPs',
        required: true,
        auto: 'secret',
      },
    ],
    memoryMB: 256,
    volumeMB: 0,
    estCostMonthly: 6,
    homepage: 'https://umami.is',
    repo: 'https://github.com/umami-software/umami',
    glyph: '📊',
    license: 'MIT',
    tags: ['analytics', 'gdpr', 'cookieless'],
    supported: true,
  },

  // ── Knowledge ───────────────────────────────────────────────

  // ── Productivity ────────────────────────────────────────────

  // ── Communication ───────────────────────────────────────────

  // ── Developer ───────────────────────────────────────────────

  // ── Privacy ─────────────────────────────────────────────────

  // ── Marketing ───────────────────────────────────────────────
  {
    id: 'listmonk',
    name: 'Listmonk',
    tagline: 'Self-hosted email + campaign manager',
    description:
      'Newsletter blasts, transactional email, segmentation. Go-fast, sends 5M+ emails/hour.',
    category: 'marketing',
    image: 'listmonk/listmonk:latest',
    infra: ['postgres', 'mailrelay'],
    port: 9000,
    env: [
      {
        key: 'LISTMONK_db__host',
        description: 'Postgres host',
        required: true,
        auto: 'postgres_url',
      },
      {
        key: 'LISTMONK_db__user',
        description: 'Postgres user',
        required: true,
        auto: 'postgres_url',
      },
      {
        key: 'LISTMONK_db__password',
        description: 'Postgres password',
        required: true,
        auto: 'postgres_url',
      },
      {
        key: 'LISTMONK_db__database',
        description: 'DB name',
        required: true,
        auto: 'postgres_url',
      },
      {
        key: 'LISTMONK_app__address',
        description: '0.0.0.0:9000',
        required: true,
        default: '0.0.0.0:9000',
      },
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
    name: 'Open WebUI',
    tagline: 'Beautiful UI for Ollama + OpenAI + Anthropic',
    description:
      'ChatGPT-like UI for your local LLMs. RAG, multi-model, voice. The polished AI playground.',
    category: 'ai',
    image: 'ghcr.io/open-webui/open-webui:main',
    infra: ['sqlite', 'volume'],
    port: 8080,
    env: [
      {
        key: 'WEBUI_SECRET_KEY',
        description: 'Session signing key',
        required: true,
        auto: 'secret',
      },
      { key: 'OLLAMA_BASE_URL', description: 'Optional Ollama endpoint', required: false },
      {
        key: 'OPENAI_API_KEY',
        description: 'OpenAI-compatible API key (or set OLLAMA_BASE_URL)',
        required: true,
      },
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

  // ── AI (catalog v2 expansion 2026-05-24) ───────────────────────
  /**
   * Lobe Chat — 50k+ star polished ChatGPT-style web app with plugins,
   * vision, RAG, and built-in agents. Postgres single-container deploy fits
   * Neon perfectly; React 18 + Next.js shell keeps cold boot well under 30s.
   */
  {
    id: 'lobe-chat',
    name: 'Lobe Chat',
    tagline: 'Polished ChatGPT-style UI for 30+ providers',
    description:
      'Cinematic chat interface for OpenAI, Anthropic, Gemini, Ollama, and local models. Plugins, vision, RAG, agent marketplace. Lighthouse 95+, PWA-ready.',
    category: 'ai',
    image: 'lobehub/lobe-chat-database:latest',
    infra: ['postgres'],
    port: 3210,
    env: [
      {
        key: 'DATABASE_URL',
        description: 'Postgres connection string',
        required: true,
        auto: 'postgres_url',
      },
      {
        key: 'KEY_VAULTS_SECRET',
        description: '32-byte secret to encrypt user API keys',
        required: true,
        auto: 'secret',
      },
      {
        key: 'NEXT_AUTH_SECRET',
        description: 'NextAuth session secret',
        required: true,
        auto: 'secret',
      },
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
  /**
   * AnythingLLM — the most popular self-hosted "chat-your-docs" platform.
   * Bundles its own SQLite + Lance vector DB inside the container — needs
   * only a /app/server/storage volume. Port 3001, instant boot.
   */
  /**
   * NextChat — stateless ChatGPT clone with zero infra. Browser-local
   * storage, no DB. Best fit for tenants who just want a private prompt
   * playground without any persistence overhead.
   */
  /**
   * Khoj — "AI second brain" that indexes Markdown / PDF / Notion notes and
   * answers questions with RAG. Single Postgres + pgvector dependency,
   * official ghcr image, port 42110.
   */
  /**
   * SillyTavern — power-user LLM frontend with character cards, group chats,
   * worldbooks, and presets. Stateless container with mounted /config and
   * /data volumes; no DB needed.
   */

  // ── Agent Platform ─────────────────────────────────────────────
  /**
   * Langflow — DataStax-backed visual agent/RAG builder. Drag-drop nodes
   * compile to Python LangChain code; Postgres single container; port 7860.
   * Most actively-maintained no-code agent platform of 2026.
   */
  {
    id: 'langflow',
    name: 'Langflow',
    tagline: 'Visual builder for LangChain + LangGraph agents',
    description:
      'Drag-drop graph editor for RAG pipelines, agents, MCP servers. Exports Python. Backed by DataStax. The polished alternative to writing LangChain by hand.',
    category: 'agent-platform',
    image: 'langflowai/langflow:latest',
    infra: ['postgres', 'volume'],
    port: 7860,
    env: [
      {
        key: 'LANGFLOW_DATABASE_URL',
        description: 'Postgres connection URL',
        required: true,
        auto: 'postgres_url',
      },
      {
        key: 'LANGFLOW_AUTO_LOGIN',
        description: 'Auto-login flag',
        required: true,
        default: 'false',
      },
      {
        key: 'LANGFLOW_SUPERUSER',
        description: 'Initial admin email',
        required: true,
        default: 'admin@example.com',
      },
      {
        key: 'LANGFLOW_SUPERUSER_PASSWORD',
        description: 'Initial admin password',
        required: true,
        auto: 'secret',
      },
      {
        key: 'LANGFLOW_SECRET_KEY',
        description: '32-byte encryption secret',
        required: true,
        auto: 'secret',
      },
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

  // ── Vector DB ──────────────────────────────────────────────────
  /**
   * Qdrant — Rust-written vector DB, single-container, only needs a volume.
   * 2300 QPS on c5.xlarge, web dashboard at /dashboard. The default pick for
   * any RAG side-deploy.
   */
  /**
   * ChromaDB — Python-first OSS vector DB. Single-container, volume only.
   * Bring-your-own embedding model. The "started with LangChain" default.
   */
  /**
   * Weaviate — vector DB with first-class hybrid search and 24+ embedding
   * modules. semitechnologies/weaviate single container, volume only,
   * AWS-grade durability with replication.
   */

  // ── Media AI (image gen) ───────────────────────────────────────
  /**
   * ComfyUI — node-based image generation, the de-facto Stable Diffusion
   * graph editor. yanwk/comfyui-boot CPU image runs on CFC; GPU upgrade
   * via Containers GPU class when available.
   */
  /**
   * Stable Diffusion WebUI (AUTOMATIC1111) — the legacy default UI for SD.
   * AI-Dock image bundles auth + xformers + persistent volumes. The most
   * extension-rich SD frontend in existence.
   */
  /**
   * Fooocus — plug-and-play SDXL UI, "image gen like Midjourney". 4GB VRAM
   * floor, ships a single container. Most welcoming SD onboarding.
   */
  /**
   * InvokeAI — professional-grade SD UI for studios. Canvas with layers,
   * unified inpainting, model manager. Official ghcr image, port 9090.
   */

  // ── Voice AI ───────────────────────────────────────────────────
  /**
   * Whisper ASR Webservice — OpenAI Whisper / faster-whisper / WhisperX
   * wrapped in a FastAPI server with Swagger UI. Cache models on a volume.
   */
  /**
   * Whishper — full transcription suite (UI + queue + translate). Single
   * pluja/whishper image bundles Mongo + LibreTranslate optional. Port 8082.
   */
  /**
   * Coqui TTS — open-source text-to-speech with voice cloning (XTTS) in 17
   * languages. ghcr.io/coqui-ai/tts ships a single FastAPI container.
   */

  // ── AI Search ──────────────────────────────────────────────────
  /**
   * SearXNG — privacy metasearch over 230+ engines. Backbone for every
   * self-hosted AI answer engine. Single-container, volume only.
   */
  /**
   * Perplexica — generative AI search bundling SearXNG inside one container.
   * Standard image at port 3000, no external search key needed.
   */
  /**
   * Morphic — generative-UI answer engine that renders charts, code, cards
   * inline with the answer. Next.js single container + Postgres.
   */
  /**
   * Farfalle — minimal Perplexity clone with local-or-cloud LLM support.
   * Single image, Postgres optional.
   */

  // ── AI Ops ─────────────────────────────────────────────────────
  /**
   * LiteLLM — OpenAI-compatible proxy for 100+ providers. Centralized key
   * vault, spend tracking, rate limits. ghcr.io/berriai/litellm-database
   * single container + Postgres.
   */
  {
    id: 'litellm',
    name: 'LiteLLM',
    tagline: 'OpenAI-compatible proxy for 100+ providers',
    description:
      'Unified API gateway across Anthropic, OpenAI, Bedrock, Vertex, Ollama, and 95 more. Virtual keys, spend tracking, rate limits, observability hooks.',
    category: 'ai-ops',
    image: 'ghcr.io/berriai/litellm-database:main-stable',
    infra: ['postgres'],
    port: 4000,
    env: [
      {
        key: 'DATABASE_URL',
        description: 'Postgres connection string',
        required: true,
        auto: 'postgres_url',
      },
      {
        key: 'LITELLM_MASTER_KEY',
        description: 'Master admin key (sk-...)',
        required: true,
        auto: 'secret',
      },
      {
        key: 'LITELLM_SALT_KEY',
        description: '32-byte salt for key encryption',
        required: true,
        auto: 'secret',
      },
      {
        key: 'STORE_MODEL_IN_DB',
        description: 'Persist model config in DB',
        required: false,
        default: 'True',
      },
    ],
    memoryMB: 768,
    estCostMonthly: 18,
    homepage: 'https://litellm.ai',
    repo: 'https://github.com/BerriAI/litellm',
    glyph: '🔀',
    license: 'MIT',
    tags: ['gateway', 'proxy', 'multi-model'],
  },
  /**
   * Langfuse — LLM observability + eval + experiment (web container only).
   * Skip ClickHouse for v2-style basic mode; pair with Postgres for traces.
   */
  /**
   * Arize Phoenix — OSS LLM tracing + evaluation in a single container.
   * Port 6006 web UI + 4317 OTLP. SQLite by default, Postgres optional.
   */
  {
    id: 'phoenix',
    name: 'Arize Phoenix',
    tagline: 'OSS LLM tracing + evals',
    description:
      'OpenInference-based tracing for LangChain, LlamaIndex, DSPy, Haystack. Built-in eval datasets, prompt experimentation, side-by-side comparison.',
    category: 'ai-ops',
    image: 'arizephoenix/phoenix:latest',
    infra: ['volume'],
    port: 6006,
    env: [
      {
        key: 'PHOENIX_WORKING_DIR',
        description: 'Data directory',
        required: true,
        default: '/mnt/data',
      },
      {
        key: 'PHOENIX_ENABLE_AUTH',
        description: 'Require login (true/false)',
        required: false,
        default: 'true',
      },
      {
        key: 'PHOENIX_SECRET',
        description: '32-byte session secret',
        required: false,
        auto: 'secret',
      },
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

  // ── Developer (AI coding) ──────────────────────────────────────
  /**
   * Tabby — self-hosted GitHub Copilot alternative. tabbyml/tabby single
   * container, OpenAPI inside. CUDA recommended; CPU fallback available.
   */

  // ── Knowledge (AI bookmarks + RSS) ─────────────────────────────
  /**
   * Karakeep (ex-Hoarder) — AI-tagged bookmark manager. Postgres + volume,
   * single ghcr.io image. iOS/Android/Chrome/Firefox apps included.
   */
  /**
   * Miniflux — Go-written RSS reader, minimalist UX. Single container +
   * Postgres, ~20 MiB RAM idle. The fastest self-hosted feed reader.
   */
  /**
   * FreshRSS — PHP RSS aggregator with extensions, themes, multi-user.
   * SQLite default keeps it single-container.
   */

  // ── Productivity (AI doc tools) ────────────────────────────────
  /**
   * Stirling PDF — 60+ PDF tools, OCR, splitting, signing. Single container
   * port 8080, no DB. The OSS Adobe Acrobat alternative.
   */
  {
    id: 'stirling-pdf',
    name: 'Stirling PDF',
    tagline: '60+ PDF tools — the OSS Acrobat',
    description:
      'Merge, split, sign, redact, OCR, convert, compress. 60+ REST endpoints. Files held in memory only — never written to disk.',
    category: 'productivity',
    image: 'docker.stirlingpdf.com/stirlingtools/stirling-pdf:latest',
    infra: [],
    port: 8080,
    env: [
      {
        key: 'DOCKER_ENABLE_SECURITY',
        description: 'Enable login (true/false)',
        required: false,
        default: 'true',
      },
      {
        key: 'SECURITY_INITIALLOGIN_USERNAME',
        description: 'Initial admin user',
        required: false,
        default: 'admin',
      },
      {
        key: 'SECURITY_INITIALLOGIN_PASSWORD',
        description: 'Initial admin password',
        required: false,
        auto: 'secret',
      },
    ],
    memoryMB: 512,
    estCostMonthly: 11,
    homepage: 'https://stirlingpdf.com',
    repo: 'https://github.com/Stirling-Tools/Stirling-PDF',
    glyph: '📄',
    license: 'MIT',
    tags: ['pdf', 'ocr', 'acrobat-alt'],
  },

  // ── AI Marketing ───────────────────────────────────────────────
  // Postiz REMOVED (2026-08-20) — native social stack replaced it (ADR-0034).

  // ── Media (AI photo management) ────────────────────────────────
  /**
   * Immich — AI-powered self-hosted photo + video manager (90k+ stars).
   * Monolithic image from imagegenius keeps it single-container.
   */
  {
    id: 'payload',
    name: 'Payload CMS',
    tagline: 'CF-native headless CMS — D1 · R2 · Worker',
    description:
      'TypeScript-native headless CMS with a React admin UI, REST + GraphQL APIs, auth, access control, and media uploads — launched CF-native on its own D1 database, R2 bucket, and Worker (no container). Delete removes all three. Up to 3 per site.',
    category: 'knowledge',
    // CF-native launch path (cloudflare_provisioner) — NOT a container image / Neon Postgres.
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
