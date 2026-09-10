/**
 * @file Pure derivation logic for the Functions tab — kept separate from the React
 * component so it is unit-testable without importing the (webcontainer-heavy)
 * workbench store. Maps the project's real `functions/` file map → route table +
 * bindings (Cloudflare Pages Functions convention). No mocks, no side effects.
 */
import { WORK_DIR } from '~/utils/constants';
import type { FileMap } from '~/lib/stores/files';

export interface RouteEntry {
  path: string;
  methods: string[];
  handlerFile: string;
  usesResources: string[];
}

export interface BindingEntry {
  name: string;
  type: string;
  target: string;
}

export const FUNCTIONS_DIR = `${WORK_DIR}/functions`;
export const CODE_EXT = /\.(ts|tsx|js|jsx|mjs)$/;

const METHODS = ['Get', 'Post', 'Put', 'Patch', 'Delete'] as const;

/** Map a functions/ file path (relative, leading slash) to its served route. */
export function fileToRoute(relFromFunctions: string): string {
  const noExt = relFromFunctions.replace(CODE_EXT, '');
  const routed = noExt
    .replace(/\/index$/, '') // functions/api/index.ts → /api
    .replace(/\[\[[^\]]+\]\]/g, '*') // [[catchall]] → *
    .replace(/\[([^\]]+)\]/g, ':$1');

  // [id] → :id
  return routed === '' ? '/' : routed;
}

/** True if the project has any code file under functions/. */
export function hasFunctionsFolder(files: FileMap): boolean {
  return Object.keys(files).some((p) => p.startsWith(FUNCTIONS_DIR + '/') && CODE_EXT.test(p));
}

/** Derive the live route table from the project's functions/ folder. */
export function deriveRoutes(files: FileMap, resourceNames: Set<string>): RouteEntry[] {
  const routes: RouteEntry[] = [];

  for (const [path, dirent] of Object.entries(files)) {
    if (!dirent || dirent.type !== 'file') {
      continue;
    }

    if (!path.startsWith(FUNCTIONS_DIR + '/') || !CODE_EXT.test(path)) {
      continue;
    }

    const rel = path.slice(FUNCTIONS_DIR.length); // /api/contact.ts
    const base = rel.replace(/^\//, '');
    const isMiddleware = /(^|\/)_middleware\.[a-z]+$/.test(base);
    const content = dirent.content || '';
    const methods = METHODS.filter((m) => content.includes(`onRequest${m}`)).map((m) => m.toUpperCase());

    // A bare `onRequest` (not suffixed by a method) handles ALL verbs.
    if (/\bonRequest(?![A-Za-z])/.test(content)) {
      methods.unshift('ALL');
    }

    if (!methods.length) {
      methods.push(isMiddleware ? 'MW' : 'ALL');
    }

    const uses = [...resourceNames].filter((n) => n && new RegExp(`\\benv\\.${n}\\b`).test(content));
    routes.push({
      path: isMiddleware ? fileToRoute(rel).replace(/\/_middleware$/, '/*') : fileToRoute(rel),
      methods,
      handlerFile: `functions${rel}`,
      usesResources: uses,
    });
  }

  return routes.sort((a, b) => a.path.localeCompare(b.path));
}

/** Result of scaffolding a new Pages Function from a user-typed route name. */
export type ScaffoldResult = { path: string; route: string; content: string } | { error: string };

/** The starter-handler flavours the "New function" gallery can generate. */
export type FunctionTemplate = 'blank' | 'contact' | 'webhook' | 'cron' | 'json-api' | 'proxy';

export interface TemplateMeta {
  kind: FunctionTemplate;
  label: string;

  /** HTTP verb the generated handler serves — for the gallery chip. */
  method: string;

  /** One-line description of what the template does. */
  blurb: string;

  /** Phosphor icon class for the gallery chip. */
  icon: string;
}

/**
 * Ordered gallery of the templates {@link scaffoldFunction} can generate — the
 * single source of truth for the "New function" template picker chips. Every
 * entry's `kind` is a valid {@link FunctionTemplate}.
 *
 * @example
 * FUNCTION_TEMPLATES[0].kind; // 'blank'
 * FUNCTION_TEMPLATES.find((t) => t.kind === 'contact')?.method; // 'POST'
 */
export const FUNCTION_TEMPLATES: readonly TemplateMeta[] = [
  {
    kind: 'blank',
    label: 'Blank',
    method: 'GET',
    blurb: 'Minimal GET handler returning JSON.',
    icon: 'i-ph:file-dashed',
  },
  {
    kind: 'contact',
    label: 'Contact form',
    method: 'POST',
    blurb: 'Parse a JSON body, validate, respond.',
    icon: 'i-ph:envelope',
  },
  {
    kind: 'webhook',
    label: 'Webhook',
    method: 'POST',
    blurb: 'Signed-webhook receiver skeleton.',
    icon: 'i-ph:webhooks-logo',
  },
  {
    kind: 'cron',
    label: 'Scheduled',
    method: 'GET',
    blurb: 'Cron-trigger handler + wrangler note.',
    icon: 'i-ph:clock-countdown',
  },
  {
    kind: 'json-api',
    label: 'JSON API',
    method: 'GET',
    blurb: 'Typed JSON resource endpoint.',
    icon: 'i-ph:brackets-curly',
  },
  {
    kind: 'proxy',
    label: 'Proxy',
    method: 'GET',
    blurb: 'Fetch an upstream and forward it.',
    icon: 'i-ph:arrows-left-right',
  },
] as const;

/**
 * Render the file body for a given template + route. Pure. CRITICAL: prose
 * comments here must NEVER contain the literal token `onRequest` — {@link deriveRoutes}
 * scans the WHOLE file text for `onRequest{Method}`, so a mention in a comment would
 * fabricate phantom methods (a bare `onRequest<` would flag it as an ALL-verb route).
 * Each body therefore carries exactly the `onRequest{Verb}` export(s) it means to serve.
 *
 * @param template - Which starter flavour to generate.
 * @param route - The served route path, embedded in the body.
 * @returns The TypeScript source for the new handler file.
 * @example
 * templateBody('contact', '/api/contact').includes('onRequestPost'); // true
 * templateBody('contact', '/api/contact').includes('onRequest' + 'Get'); // false
 */
export function templateBody(template: FunctionTemplate, route: string): string {
  const r = JSON.stringify(route);

  switch (template) {
    case 'contact':
      return `/**
 * ${route} — Pages Function: accepts a contact-form submission (JSON body) and
 * echoes a typed result. Wire a D1 insert or an email send where marked.
 */
interface ContactBody {
  name?: string;
  email?: string;
  message?: string;
}

export async function onRequestPost(ctx: { request: Request }) {
  let body: ContactBody;

  try {
    body = (await ctx.request.json()) as ContactBody;
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  if (!body.email || !body.message) {
    return Response.json({ ok: false, error: 'email and message are required' }, { status: 422 });
  }

  // Persist / notify here (e.g. ctx.env.DB.prepare(...), an email send, a queue push).
  return Response.json({ ok: true, route: ${r}, received: body });
}
`;

    case 'webhook':
      return `/**
 * ${route} — Pages Function: signed-webhook receiver. Verify the provider
 * signature against a shared secret BEFORE trusting the payload, then dispatch.
 */
export async function onRequestPost(ctx: { request: Request; env: Record<string, string> }) {
  const signature = ctx.request.headers.get('x-signature') ?? '';
  const raw = await ctx.request.text();

  const secret = ctx.env.WEBHOOK_SECRET;

  if (!secret) {
    return Response.json({ ok: false, error: 'webhook secret not configured' }, { status: 500 });
  }

  const expected = await hmacSha256Hex(secret, raw);

  if (!timingSafeEqual(signature, expected)) {
    return Response.json({ ok: false, error: 'bad signature' }, { status: 401 });
  }

  const event = JSON.parse(raw) as { type?: string };

  // Dispatch on event.type here (idempotently — key on the provider event id).
  return Response.json({ ok: true, route: ${r}, type: event.type ?? null });
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));

  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;

  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return diff === 0;
}
`;

    case 'cron':
      return `/**
 * ${route} — Pages Function invoked on a schedule. Add a cron trigger in
 * wrangler.jsonc so the platform calls this route (there is no native Pages
 * cron; a Worker Cron Trigger hitting this URL is the convention):
 *   "triggers": { "crons": ["0 * * * *"] }
 * Guard it with a shared secret so only the scheduler can invoke it.
 */
export async function onRequestGet(ctx: { request: Request; env: Record<string, string> }) {
  const token = new URL(ctx.request.url).searchParams.get('token');

  if (ctx.env.CRON_SECRET && token !== ctx.env.CRON_SECRET) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const ranAt = new Date().toISOString();

  // Do the scheduled work here (refresh a cache, send a digest, prune rows…).
  return Response.json({ ok: true, route: ${r}, ranAt });
}
`;

    case 'json-api':
      return `/**
 * ${route} — Pages Function: typed JSON resource. Shape the payload with an
 * interface so callers get a stable contract; swap the sample for real data.
 */
interface Payload {
  route: string;
  generatedAt: string;
  items: Array<{ id: string; label: string }>;
}

export async function onRequestGet(): Promise<Response> {
  const payload: Payload = {
    route: ${r},
    generatedAt: new Date().toISOString(),
    items: [{ id: '1', label: 'sample' }],
  };

  return Response.json(payload, { headers: { 'cache-control': 'public, max-age=60' } });
}
`;

    case 'proxy':
      return `/**
 * ${route} — Pages Function: fetch an upstream resource and forward the body.
 * Set UPSTREAM_URL as a binding/var, or read it from a query param you trust.
 */
export async function onRequestGet(ctx: { request: Request; env: Record<string, string> }) {
  const upstream = ctx.env.UPSTREAM_URL ?? new URL(ctx.request.url).searchParams.get('url');

  if (!upstream) {
    return Response.json({ ok: false, route: ${r}, error: 'no upstream configured' }, { status: 400 });
  }

  const res = await fetch(upstream, { headers: { accept: 'application/json' } });
  const contentType = res.headers.get('content-type') ?? 'application/json';

  return new Response(res.body, { status: res.status, headers: { 'content-type': contentType } });
}
`;

    case 'blank':
    default:
      return `/**
 * ${route} — Cloudflare Pages Function (scaffolded). Each exported handler
 * becomes a live route on deploy; duplicate it for other HTTP verbs.
 */
export async function onRequestGet() {
  return Response.json({ ok: true, route: ${r} });
}
`;
  }
}

/**
 * Turn a user-typed route name (e.g. `"contact"`, `"api/booking"`) into a new Pages
 * Function file under `functions/` + a starter handler chosen from the template
 * gallery. Pure — the caller writes it via `workbenchStore.createFile(path, content)`,
 * after which {@link deriveRoutes} surfaces it live. Bare names default under `api/`
 * (the convention every existing route follows: `contact` → `functions/api/contact.ts`
 * → `/api/contact`). Rejects empty, unsafe, or already-existing names.
 *
 * @param rawName - The user's typed route name.
 * @param existing - The current file map, to reject a collision.
 * @param template - Which starter flavour to generate (default `'blank'`, so existing
 *   callers/tests that pass only two args keep the original `onRequestGet` behaviour).
 * @returns `{ path, route, content }` to create, or `{ error }` to show inline.
 * @example
 * scaffoldFunction('contact', {}, 'contact'); // → { path, route: '/api/contact', content: '…onRequestPost…' }
 */
export function scaffoldFunction(
  rawName: string,
  existing: FileMap = {},
  template: FunctionTemplate = 'blank',
): ScaffoldResult {
  let name = (rawName || '').trim().toLowerCase();
  name = name.replace(/^\/+|\/+$/g, ''); // strip leading/trailing slashes FIRST
  name = name.replace(CODE_EXT, ''); // then a typed extension (now truly at the end)

  if (!name) {
    return { error: 'Enter a route name, e.g. "contact" or "api/webhook".' };
  }

  if (!/^[a-z0-9][a-z0-9/_-]*$/.test(name) || name.includes('..') || name.includes('//')) {
    return { error: 'Letters, digits, "-", "_", "/" only (e.g. "api/contact").' };
  }

  // Bare name (no folder) → under api/, matching the existing route convention.
  const rel = name.includes('/') ? name : `api/${name}`;
  const path = `${FUNCTIONS_DIR}/${rel}.ts`;

  if (existing[path]) {
    return { error: `functions/${rel}.ts already exists.` };
  }

  const route = fileToRoute(`/${rel}.ts`);

  return { path, route, content: templateBody(template, route) };
}

/**
 * Read the text of a file-map entry, tolerating both the object dirent
 * (`{ content }`) and a bare string value some callers store. Returns `''` when
 * absent so the view can show an honest empty preview.
 *
 * @param entry - A `FileMap` value (dirent, raw string, or undefined).
 * @returns The file's text, or `''`.
 * @example
 * fileContent({ type: 'file', content: 'x', isBinary: false }); // 'x'
 * fileContent('raw'); // 'raw'
 * fileContent(undefined); // ''
 */
export function fileContent(entry: FileMap[string] | string | undefined): string {
  if (typeof entry === 'string') {
    return entry;
  }

  if (entry && typeof entry === 'object' && 'content' in entry && typeof entry.content === 'string') {
    return entry.content;
  }

  return '';
}

/**
 * First `n` lines of a source string — for the route-detail code preview.
 *
 * @param source - The full file text.
 * @param n - Max lines to keep (default 16).
 * @returns The leading `n` lines joined by `\n`.
 * @example
 * previewLines('a\nb\nc', 2); // 'a\nb'
 */
export function previewLines(source: string, n = 16): string {
  return source.split('\n').slice(0, n).join('\n');
}

/**
 * Count how many of `routes` reference each declared binding name (`env.NAME`),
 * for the bindings-list usage badge. Keyed by binding name.
 *
 * @param routes - The derived route table.
 * @param bindingNames - Declared binding names from wrangler.
 * @returns A record of `name → number of routes using it`.
 * @example
 * bindingUsageCounts([{ path: '/a', methods: [], handlerFile: 'functions/a.ts', usesResources: ['DB'] }], ['DB', 'KV']);
 * // → { DB: 1, KV: 0 }
 */
export function bindingUsageCounts(routes: RouteEntry[], bindingNames: string[]): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const name of bindingNames) {
    counts[name] = routes.filter((r) => r.usesResources.includes(name)).length;
  }

  return counts;
}

/** Strip // and block comments so a wrangler.jsonc parses as JSON (URLs preserved). */
export function stripJsonComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Best-effort binding + script parse from wrangler.jsonc / wrangler.toml (never throws). */
export function deriveWrangler(files: FileMap): {
  bindings: BindingEntry[];
  script: string | null;
  compatDate: string | null;
} {
  const bindings: BindingEntry[] = [];
  let script: string | null = null;
  let compatDate: string | null = null;
  const jsonc =
    (files[`${WORK_DIR}/wrangler.jsonc`] as { content?: string } | undefined)?.content ??
    (files[`${WORK_DIR}/wrangler.json`] as { content?: string } | undefined)?.content;
  const toml = (files[`${WORK_DIR}/wrangler.toml`] as { content?: string } | undefined)?.content;

  if (jsonc) {
    try {
      const w = JSON.parse(stripJsonComments(jsonc)) as Record<string, unknown>;
      script = typeof w.name === 'string' ? w.name : null;
      compatDate = typeof w.compatibility_date === 'string' ? w.compatibility_date : null;

      for (const d of (w.d1_databases as { binding: string; database_name?: string }[]) ?? []) {
        bindings.push({ name: d.binding, type: 'd1', target: d.database_name ?? 'd1' });
      }

      for (const r of (w.r2_buckets as { binding: string; bucket_name?: string }[]) ?? []) {
        bindings.push({ name: r.binding, type: 'r2', target: r.bucket_name ?? 'r2' });
      }

      for (const k of (w.kv_namespaces as { binding: string }[]) ?? []) {
        bindings.push({ name: k.binding, type: 'kv', target: 'kv namespace' });
      }

      for (const s of (w.services as { binding: string; service?: string }[]) ?? []) {
        bindings.push({ name: s.binding, type: 'service', target: s.service ?? 'service' });
      }

      for (const key of Object.keys((w.vars as Record<string, unknown>) ?? {})) {
        bindings.push({ name: key, type: 'env', target: 'var' });
      }
    } catch {
      /* malformed wrangler — fall through to empty */
    }
  } else if (toml) {
    const nameM = toml.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
    script = nameM ? nameM[1] : null;

    const cdM = toml.match(/^\s*compatibility_date\s*=\s*["']([^"']+)["']/m);
    compatDate = cdM ? cdM[1] : null;

    for (const m of toml.matchAll(
      /\[\[(d1_databases|r2_buckets|kv_namespaces|services)\]\][\s\S]*?binding\s*=\s*["']([^"']+)["']/g,
    )) {
      const kind =
        m[1] === 'd1_databases' ? 'd1' : m[1] === 'r2_buckets' ? 'r2' : m[1] === 'kv_namespaces' ? 'kv' : 'service';
      bindings.push({ name: m[2], type: kind, target: kind });
    }
  }

  return { bindings, script, compatDate };
}
