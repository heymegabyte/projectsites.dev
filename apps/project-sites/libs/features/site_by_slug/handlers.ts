/**
 * @module libs/features/site_by_slug/handlers
 *
 * @description
 * Public-by-slug read surface for a site's editor payloads — the endpoints the
 * bolt.diy editor hits to bootstrap a workbench from a published site's R2
 * artifacts. Access is gated by slug + R2 obscurity (build-context / chat /
 * files carry no PII); `research.json` is additionally org-scoped unless
 * `RESEARCH_JSON_PUBLIC === 'true'`. Every handler reads directly from
 * `c.env.SITES_BUCKET` (R2) and `c.env.DB` (D1) — the `_manifest.json` at the
 * site root (or the D1 `current_build_version` fallback) points at the current
 * build version.
 *
 * | Method | Path                                          | Auth       | Purpose                                              |
 * | ------ | --------------------------------------------- | ---------- | ---------------------------------------------------- |
 * | GET    | /api/sites/by-slug/:slug/build-context        | public     | Raw AI build-context JSON for editor bootstrap        |
 * | GET    | /api/sites/by-slug/:slug/chat                 | public     | Synthetic bolt.diy chat export (source files → artifact) |
 * | GET    | /api/sites/by-slug/:slug/files                | public     | File-tree metadata (no bodies) for the editor sidebar |
 * | GET    | /api/sites/by-slug/:slug/research.json        | conditional| Cached research blob (org-scoped unless public)       |
 *
 * Extracted VERBATIM from the `api.ts` monolith (route-decomposition installment
 * 13) — only the route-registration receiver changed (`api.` → `siteBySlug.`);
 * the handler bodies are byte-for-byte unchanged. The private
 * `emptyBoltChatResponse` helper moved alongside its only caller (the `/chat`
 * handler). Known AppErrors (`unauthorized`/`notFound`) propagate to the
 * app-level error handler.
 *
 * @packageDocumentation
 */

import { Hono } from 'hono';
import { notFound, unauthorized } from '@project-sites/shared';
import type { Env, Variables } from '../../../src/types/env.js';
import { dbQueryOne } from '../../../src/services/db.js';

type AppContext = { Bindings: Env; Variables: Variables };

export const siteBySlug = new Hono<AppContext>();

/**
 * Retrieve the AI build-context JSON for a published site slug. Used by
 * bolt.diy to bootstrap a chat session preloaded with research data so
 * the editor can iteratively improve the generated site.
 *
 * @route GET /api/sites/by-slug/:slug/build-context
 * @auth NONE — slug + R2 obscurity serve as the access token; no PII
 *   stored in build-context (research-only data).
 * @param slug — site slug (path param)
 * @returns 200 OK `application/json` — raw build-context document
 *   (research summary + brand kit + content blocks consumed by bolt.diy).
 * @throws {AppError} `NOT_FOUND` — no `_build-context.json` at that path
 *   (site never went through the AI workflow, or context wasn't persisted).
 *
 * @remarks
 * Reads `sites/{slug}/assets/_build-context.json` directly from R2 —
 * NOT version-pinned. The build-context is the orchestrator's input,
 * not the site output, so it lives at the site root rather than under
 * a version directory.
 *
 * Sets `Access-Control-Allow-Origin: *` so the bolt.diy editor (hosted
 * on a different origin) can read it client-side. `Cache-Control: no-cache`
 * so a re-publish picks up updated research without manual purge.
 *
 * @see {@link buildContextService}
 */
siteBySlug.get('/api/sites/by-slug/:slug/build-context', async (c) => {
  const slug = c.req.param('slug');

  const contextObj = await c.env.SITES_BUCKET.get(`sites/${slug}/assets/_build-context.json`);

  if (!contextObj) {
    throw notFound('No build context found for this site');
  }

  const contextData = await contextObj.text();

  return new Response(contextData, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    },
  });
});

/**
 * A valid-but-empty bolt.diy chat payload (HTTP 200). Returned by the
 * `/chat` endpoint instead of a 404 when a site has no R2 manifest /
 * version / source files yet. The editor auto-imports `/chat` via
 * `importChatFrom`; a 404 there logs an un-suppressable
 * "Failed to load resource: 404" on our origin for every admin route.
 * An empty `messages` array makes bolt boot a fresh workbench silently.
 *
 * @param slug - site slug (used only to derive a human description)
 * @returns 200 `application/json` `{ messages: [], description, exportDate }`
 */
function emptyBoltChatResponse(slug: string): Response {
  const businessName = slug.replace(/-/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
  const now = new Date().toISOString();
  const chatJson = {
    messages: [] as unknown[],
    description: `${businessName} Website`,
    exportDate: now,
  };
  return new Response(JSON.stringify(chatJson), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/**
 * Reconstruct a bolt.diy-compatible chat export for a published site so
 * the editor can "open" the site as if it were the original chat
 * session. Reads `_manifest.json` to find the current version, lists
 * source files from R2, reads each text file, and wraps them in a
 * synthetic `<boltArtifact>` payload with `<boltAction type="file">`
 * blocks per source file.
 *
 * @route GET /api/sites/by-slug/:slug/chat
 * @auth NONE — slug serves as access token; binary files filtered
 *   server-side so this endpoint can't be used to exfiltrate non-text
 *   assets.
 * @param slug — site slug (path param)
 * @returns 200 OK `application/json` — bolt.diy chat schema:
 *   `{ messages: [user, assistant], description, exportDate }`.
 *   Assistant message body is a `<boltArtifact>` block listing every
 *   source file. For Vite projects, includes shell actions
 *   (`npm install` + `npm run dev`) so opening the chat auto-boots the
 *   dev server.
 *   When the manifest / version / source files are absent, returns 200 with
 *   an empty bolt chat (`{ messages: [] }`) instead of 404 — see the
 *   "Graceful empty-state" note below.
 *
 * @remarks
 * Vite-vs-static branching: `is_vite_project=true` reads from
 * `sites/{slug}/{version}/_src/` (source code for editor) and appends
 * install + start shell actions. Static sites read from
 * `sites/{slug}/{version}/` directly (compiled output, no shell actions).
 *
 * Binary file filter: only files with text extensions (HTML, CSS, JS,
 * TS, JSON, XML, SVG, MD, YAML, TOML, etc.) or no extension (LICENSE,
 * Makefile) pass through. Reading binaries as `.text()` corrupts
 * content — silently dropping them prevents broken bolt.diy state.
 *
 * `package.json` sorts FIRST in the artifact so bolt.diy detects the
 * Vite project and auto-runs `npm install` before other file writes.
 *
 * Business name lookup: tries D1 `sites.business_name` first, falls
 * back to slug-derived title-case ("vitos-mens-salon" →
 * "Vitos Mens Salon") if the row is missing or soft-deleted.
 *
 * Excluded prefixes: `_meta/` (chat exports, internal manifests) and
 * `research.json` (raw research data) are filtered out — they aren't
 * source files.
 *
 * Graceful empty-state (NOT 404): when a site has no R2 manifest /
 * version / source files yet — e.g. a row that is `published` in D1 but
 * whose build artifacts never landed in R2 — this returns 200 with an
 * empty bolt chat instead of a hard 404. The editor iframe auto-imports
 * this via `importChatFrom`, so a 404 would surface an un-suppressable
 * "Failed to load resource: 404" in the browser console on EVERY admin
 * route (the iframe is persistently mounted). An empty chat lets bolt
 * boot a fresh workbench with zero console noise.
 *
 * @see {@link generateSlugFromChat} for inverse direction (chat → slug).
 * @see {@link emptyBoltChatResponse} for the graceful empty-state payload.
 */
siteBySlug.get('/api/sites/by-slug/:slug/chat', async (c) => {
  const slug = c.req.param('slug');

  // Manifest resolution order (journey 2026-08-19 — the editor was
  // permanently EMPTY for workflow-built sites):
  //   1. Site-root `sites/{slug}/_manifest.json` — the legacy bolt-publish
  //      artifact. An OLD upload path also wrote a root copy with
  //      `files: []` for workflow builds — a root manifest that EXISTS but
  //      lists nothing. A root manifest is only usable when it actually
  //      lists files.
  //   2. D1 `sites.current_build_version` → `sites/{slug}/{version}/_manifest.json`
  //      — the REAL workflow write path. D1 is the authoritative pointer;
  //      used whenever the root copy is missing OR file-less.
  type ManifestShape = {
    current_version: string;
    // v1 shape: string[] of paths. v2 shape (container manifest writer):
    // { name, size, type }[]. Normalized below.
    files?: Array<string | { name?: string; size?: number; type?: string }>;
    source_files?: Array<string | { name?: string; size?: number; type?: string }>;
    is_vite_project?: boolean;
  };
  const listFiles = (d: ManifestShape | null | undefined): boolean =>
    Array.isArray(d?.files) && (d?.files?.length ?? 0) > 0;

  let manifestData: ManifestShape | null = null;
  const rootManifest = await c.env.SITES_BUCKET.get(`sites/${slug}/_manifest.json`);
  if (rootManifest) {
    manifestData = (await rootManifest.json()) as ManifestShape;
  }
  if (!manifestData || !listFiles(manifestData)) {
    const versionRow = await c.env.DB.prepare(
      'SELECT current_build_version FROM sites WHERE slug = ? AND deleted_at IS NULL',
    )
      .bind(slug)
      .first<{ current_build_version: string | null }>()
      .catch(() => null);
    const fallbackVersion = versionRow?.current_build_version;
    if (fallbackVersion) {
      const pinned = await c.env.SITES_BUCKET.get(
        `sites/${slug}/${fallbackVersion}/_manifest.json`,
      );
      if (pinned) manifestData = (await pinned.json()) as ManifestShape;
    }
  }

  if (!manifestData?.current_version) {
    return emptyBoltChatResponse(slug);
  }

  const version = manifestData.current_version;
  const isVite = manifestData.is_vite_project === true;

  // For Vite projects, serve source files from _src/ so the editor can run the dev server
  const prefix = isVite ? `sites/${slug}/${version}/_src/` : `sites/${slug}/${version}/`;

  // Extensions safe to read as text and embed in boltArtifact
  const TEXT_EXTENSIONS = new Set([
    '.html',
    '.htm',
    '.css',
    '.js',
    '.mjs',
    '.cjs',
    '.ts',
    '.tsx',
    '.jsx',
    '.json',
    '.xml',
    '.txt',
    '.svg',
    '.md',
    '.mdx',
    '.yaml',
    '.yml',
    '.toml',
    '.env',
    '.gitignore',
    '.npmrc',
    '.prettierrc',
    '.eslintrc',
    '.map',
    '.webmanifest',
    '.csv',
    '.tsv',
    '.graphql',
    '.gql',
  ]);

  const isTextFile = (filePath: string): boolean => {
    // Files without extensions (LICENSE, Makefile, etc.) are treated as text
    const lastDot = filePath.lastIndexOf('.');
    if (lastDot === -1 || lastDot < filePath.lastIndexOf('/')) return true;
    return TEXT_EXTENSIONS.has(filePath.slice(lastDot).toLowerCase());
  };

  // For Vite projects, prefer source_files (editor needs source, not built output)
  // Normalize v1 (string[]) + v2 ({name,size,type}[]) manifest shapes —
  // the container manifest writer emits objects, the legacy writers strings.
  const normalizeManifestPaths = (
    entries?: Array<string | { name?: string; size?: number; type?: string }>,
  ): string[] =>
    (entries ?? []).map((e) => (typeof e === 'string' ? e : (e.name ?? ''))).filter(Boolean);

  let filePaths: string[] = normalizeManifestPaths(
    isVite ? manifestData.source_files : manifestData.files,
  );

  if (filePaths.length === 0) {
    const listed = await c.env.SITES_BUCKET.list({ prefix, limit: 100 });
    filePaths = listed.objects
      .map((obj) => obj.key.replace(prefix, ''))
      .filter((p) => !p.startsWith('_meta/') && p !== 'research.json');
  } else {
    filePaths = filePaths.filter((p) => !p.startsWith('_meta/') && p !== 'research.json');
  }

  // Filter out binary files — reading them as .text() corrupts the content
  filePaths = filePaths.filter(isTextFile);

  const fileReads = filePaths.map(async (filePath) => {
    const obj = await c.env.SITES_BUCKET.get(`${prefix}${filePath}`);
    if (!obj) return null;
    const content = await obj.text();
    return { path: filePath, content };
  });

  // Vite `_src` fallback — the workflow's container builds do not ship a
  // `_src/` directory (the manifest says `is_vite_project: true` with only
  // compiled `files`). A pure `_src` read then returns zero files → another
  // lying-empty editor. Fall back to the compiled `files` entries at the
  // version root so the editor always opens with the real site content.
  const readFiles = (await Promise.all(fileReads)).filter(
    (f): f is { path: string; content: string } => f !== null,
  );
  let files = readFiles;
  if (files.length === 0 && isVite) {
    const compiledFilePaths = normalizeManifestPaths(manifestData.files)
      .filter((p) => !p.startsWith('_meta/') && p !== 'research.json')
      .filter(isTextFile);
    const compiledPrefix = `sites/${slug}/${version}/`;
    const compiledReads = await Promise.all(
      compiledFilePaths.map(async (filePath) => {
        const obj = await c.env.SITES_BUCKET.get(`${compiledPrefix}${filePath}`);
        if (!obj) return null;
        const content = await obj.text();
        return { path: filePath, content };
      }),
    );
    files = compiledReads.filter((f): f is { path: string; content: string } => f !== null);
  }

  if (files.length === 0) {
    return emptyBoltChatResponse(slug);
  }

  // Guarantee a package.json so bolt.diy's WebContainer can boot the project. Container
  // builds ship compiled output (index.html + assets/*, NO package.json), so without this
  // the editor imports the files but "cannot open package.json" and never loads (Randy's
  // Donuts, 2026-09). A minimal Vite + React + Tailwind manifest matches the template stack.
  if (!files.some((f) => f.path === 'package.json')) {
    const pkgName = slug.replace(/[^a-z0-9-]/g, '') || 'site';
    files.push({
      path: 'package.json',
      content: JSON.stringify(
        {
          name: pkgName,
          private: true,
          version: '1.0.0',
          type: 'module',
          scripts: { dev: 'vite', build: 'tsc -b && vite build', preview: 'vite preview' },
          dependencies: {
            react: '^19.0.0',
            'react-dom': '^19.0.0',
            'react-router-dom': '^6.26.0',
            clsx: '^2.1.1',
            'tailwind-merge': '^2.4.0',
            'class-variance-authority': '^0.7.0',
            'lucide-react': '^0.400.0',
            zod: '^3.23.8',
          },
          devDependencies: {
            '@types/react': '^19.0.0',
            '@types/react-dom': '^19.0.0',
            '@vitejs/plugin-react': '^4.3.1',
            autoprefixer: '^10.4.19',
            postcss: '^8.4.39',
            tailwindcss: '^3.4.6',
            typescript: '^5.5.3',
            vite: '^5.3.4',
          },
        },
        null,
        2,
      ),
    });
  }

  let businessName = slug.replace(/-/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
  try {
    const site = await c.env.DB.prepare(
      'SELECT business_name FROM sites WHERE slug = ? AND deleted_at IS NULL',
    )
      .bind(slug)
      .first<{ business_name: string }>();
    if (site?.business_name) businessName = site.business_name;
  } catch {
    // Use slug-derived name as fallback
  }

  // Sort files: package.json first (triggers auto-install in bolt.diy)
  const sortedFiles = [...files].sort((a, b) => {
    if (a.path === 'package.json') return -1;
    if (b.path === 'package.json') return 1;
    return a.path.localeCompare(b.path);
  });

  const fileActions = sortedFiles.map(
    (f) => `<boltAction type="file" filePath="${f.path}">\n${f.content}\n</boltAction>`,
  );

  // For Vite projects, add install + start actions so the dev server starts
  // Shell actions ONLY when a package.json actually exists in the imported
  // set. The container builds are compiled output (index.html + assets/*.js,
  // NO package.json) yet the manifest flags `is_vite_project: true` — the old
  // unconditional shell actions made bolt run `npm install` in a project with
  // no package.json on EVERY open (ENOENT spam + "Start Application" failure,
  // journey 2026-08-19). A build with a real package.json (source-published
  // bolt sites) still gets the install + dev-server boot.
  const hasPackageJson = files.some((f) => f.path === 'package.json');
  const postFileActions =
    isVite && hasPackageJson
      ? [
          '<boltAction type="shell">npm install --legacy-peer-deps</boltAction>',
          '<boltAction type="start">npm run dev</boltAction>',
        ]
      : [];

  const assistantContent = [
    `I've built a professional website for ${businessName} with ${files.length} files. The project files are:\n${sortedFiles.map((f) => `- ${f.path}`).join('\n')}\n`,
    `<boltArtifact id="site-${slug}" title="${businessName} Website">`,
    ...fileActions,
    ...postFileActions,
    '</boltArtifact>',
  ].join('\n');

  const now = new Date().toISOString();

  const chatJson = {
    messages: [
      {
        id: `msg-user-${slug}`,
        role: 'user',
        content: `Build a professional website for ${businessName}`,
        createdAt: now,
      },
      {
        id: `msg-asst-${slug}`,
        role: 'assistant',
        content: assistantContent,
        createdAt: now,
      },
    ],
    description: `${businessName} Website`,
    exportDate: now,
  };

  return new Response(JSON.stringify(chatJson), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*',
    },
  });
});

/**
 * List file metadata for a published site without returning file
 * content. Used by the bolt.diy editor sidebar to render the file tree
 * before fetching individual files on demand.
 *
 * @route GET /api/sites/by-slug/:slug/files
 * @auth NONE — slug serves as access token; only metadata exposed,
 *   never content.
 * @param slug — site slug (path param)
 * @returns 200 OK `{ slug, version, fileCount, files: Array<{ path, size,
 *   etag, httpMetadata, extension }>, is_vite_project }`.
 *   `httpMetadata` includes `contentType` for client-side rendering hints.
 * @throws {AppError} `NOT_FOUND` — manifest missing or `current_version`
 *   not set on the manifest.
 *
 * @remarks
 * Same Vite-vs-static prefix branching as `/chat`: Vite reads
 * `_src/`, static reads version root. Lists up to 500 R2 objects per
 * call — sufficient for any reasonable site, but caller should be
 * aware that very large generated sites will be truncated silently.
 *
 * Filtered out: `_meta/`, `research.json`, `_manifest.json` — internal
 * artifacts the editor doesn't need to surface.
 *
 * No content fetched: each file is a single R2 list-objects field, not
 * a body read. Editor must call `/api/sites/by-slug/:slug/chat` (full
 * read) or a separate per-file endpoint to get bodies.
 */
siteBySlug.get('/api/sites/by-slug/:slug/files', async (c) => {
  const slug = c.req.param('slug');

  const manifest = await c.env.SITES_BUCKET.get(`sites/${slug}/_manifest.json`);
  if (!manifest) {
    throw notFound('Site not found or no version published');
  }

  const manifestData = (await manifest.json()) as {
    current_version: string;
    files?: string[];
    source_files?: string[];
    is_vite_project?: boolean;
  };

  if (!manifestData.current_version) {
    throw notFound('No published version found');
  }

  const version = manifestData.current_version;
  const isVite = manifestData.is_vite_project === true;

  // For Vite projects, list source files from _src/ prefix (for the editor)
  // For legacy static sites, list the serving files directly
  const prefix = isVite ? `sites/${slug}/${version}/_src/` : `sites/${slug}/${version}/`;

  const listed = await c.env.SITES_BUCKET.list({ prefix, limit: 500 });
  const files = listed.objects
    .filter((obj) => {
      const rel = obj.key.replace(prefix, '');
      return !rel.startsWith('_meta/') && rel !== 'research.json' && rel !== '_manifest.json';
    })
    .map((obj) => {
      const path = obj.key.replace(prefix, '');
      const ext = path.includes('.') ? path.slice(path.lastIndexOf('.')) : '';
      return {
        path,
        size: obj.size,
        etag: obj.etag,
        httpMetadata: obj.httpMetadata,
        extension: ext,
      };
    });

  return c.json({
    slug,
    version,
    fileCount: files.length,
    files,
    is_vite_project: isVite,
  });
});

/**
 * Retrieve the AI-generated research JSON for a published site slug.
 * Access is gated by the `RESEARCH_JSON_PUBLIC` env var: when set to
 * `"true"`, no auth required; otherwise the caller MUST be authenticated
 * AND the site MUST belong to the caller's org.
 *
 * @route GET /api/sites/by-slug/:slug/research.json
 * @auth Conditional — Bearer required UNLESS `env.RESEARCH_JSON_PUBLIC === 'true'`.
 * @param slug — site slug (path param)
 * @returns 200 OK `application/json` — raw research blob (business
 *   profile, brand kit, social discovery, USPs, image strategies, etc.).
 * @throws {AppError} `UNAUTHORIZED` — research is private AND session
 *   missing orgId.
 * @throws {AppError} `NOT_FOUND` — site missing/cross-org, manifest
 *   missing, or `research.json` not present at either versioned or root
 *   path.
 *
 * @remarks
 * Lookup chain: versioned path
 * `sites/{slug}/{current_version}/research.json` → root path
 * `sites/{slug}/research.json`. Versioned wins; root is the legacy
 * fallback for sites generated before the versioning convention shipped.
 *
 * Cross-org guard: when private, runs `WHERE slug = ? AND org_id = ?
 * AND deleted_at IS NULL` BEFORE the R2 read. Soft-deleted sites are
 * not surfaced regardless of org match.
 *
 * 5-minute browser cache (`public, max-age=300`) when served — research
 * data rarely changes post-publish. Set `RESEARCH_JSON_PUBLIC=true` for
 * portfolio sites where research transparency is a feature.
 */
siteBySlug.get('/api/sites/by-slug/:slug/research.json', async (c) => {
  const slug = c.req.param('slug');
  const isPublic = c.env.RESEARCH_JSON_PUBLIC === 'true';

  if (!isPublic) {
    const orgId = c.get('orgId');
    if (!orgId)
      throw unauthorized(
        'Research data requires authentication (or set RESEARCH_JSON_PUBLIC=true)',
      );

    // Verify the site belongs to the user's org
    const site = await dbQueryOne<{ id: string }>(
      c.env.DB,
      'SELECT id FROM sites WHERE slug = ? AND org_id = ? AND deleted_at IS NULL',
      [slug, orgId],
    );
    if (!site) throw notFound('Site not found');
  }

  const manifest = await c.env.SITES_BUCKET.get(`sites/${slug}/_manifest.json`);
  if (!manifest) throw notFound('Site not found or no version published');

  const manifestData = (await manifest.json()) as { current_version: string };
  if (!manifestData.current_version) throw notFound('No published version found');

  let researchObj = await c.env.SITES_BUCKET.get(
    `sites/${slug}/${manifestData.current_version}/research.json`,
  );

  if (!researchObj) {
    researchObj = await c.env.SITES_BUCKET.get(`sites/${slug}/research.json`);
  }

  if (!researchObj) throw notFound('No research data found for this site');

  const researchData = await researchObj.text();

  return new Response(researchData, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    },
  });
});
