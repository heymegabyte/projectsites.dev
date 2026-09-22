/**
 * create-intents.ts — the typed core of the workbench "Create" menu.
 *
 * A project on ProjectSites.dev is an R2-backed git repo (GitHub-connectable), so
 * "add a cron / function / API endpoint / workflow" == "write the right starter
 * FILE(S) into the project". This module is the pure, testable seam that:
 *   1. classifies a natural-language request into a typed {@link CreateIntent}
 *      (classification is kept SEPARATE from execution), and
 *   2. scaffolds that intent into concrete files ({@link scaffoldForIntent}).
 *
 * Starter contents match the canonical Functions convention (the SSOT
 * `scaffold/functions/api/hello.ts`): Cloudflare-Pages-style file routing under
 * `functions/api/*` → `/api/*` via `onRequest*` handlers receiving one
 * `ctx = { request, params, env, waitUntil }`; scheduled work lives in
 * `functions/_scheduled.ts` with `export const cron`. Bindings on `ctx.env`:
 * `AI` / `DATA` / `KV` / `R2` / `SECRETS`. No I/O here — the component executes.
 */
import { z } from 'zod';

export const CREATE_KINDS = ['function', 'endpoint', 'cron', 'workflow', 'template'] as const;
export type CreateKind = (typeof CREATE_KINDS)[number];

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Discriminated union of every creation intent the menu supports. */
export const createIntentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('function'), name: z.string().min(1).max(64), prompt: z.string().optional() }),
  z.object({
    kind: z.literal('endpoint'),
    name: z.string().min(1).max(64),
    method: z.enum(HTTP_METHODS).default('POST'),
    prompt: z.string().optional(),
  }),
  z.object({
    kind: z.literal('cron'),
    name: z.string().min(1).max(64),
    schedule: z.string().min(1).max(64),
    prompt: z.string().optional(),
  }),
  z.object({ kind: z.literal('workflow'), name: z.string().min(1).max(64), prompt: z.string().optional() }),
  z.object({ kind: z.literal('template'), name: z.string().min(1).max(64), templateId: z.string().min(1) }),
]);
export type CreateIntent = z.infer<typeof createIntentSchema>;

/** Files a scaffold writes, which to open after, and a one-line human preview. */
export interface ScaffoldFile {
  path: string;
  content: string;
}
export interface ScaffoldResult {
  intent: CreateIntent;
  files: ScaffoldFile[];
  openPath: string;

  /** Whether executing this needs a confirm gate (deploy / secrets / public exposure). */
  sensitive: boolean;
  summary: string;
}

/** kebab-case a free-text name into a safe file slug. */
export function slugify(input: string, fallback = 'new'): string {
  const s = (input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || fallback;
}

/**
 * Best-effort cron from natural language. Deterministic (no AI) — covers the
 * common owner phrasings; defaults to nightly 02:00 UTC when only "nightly/daily".
 */
export function cronFromText(text: string): string {
  const t = (text || '').toLowerCase();

  const everyN = t.match(/every\s+(\d{1,3})\s*(minute|min|hour)/);

  if (everyN) {
    const n = Math.max(1, Math.min(parseInt(everyN[1], 10), everyN[2].startsWith('hour') ? 23 : 59));
    return everyN[2].startsWith('hour') ? `0 */${n} * * *` : `*/${n} * * * *`;
  }

  if (/every\s+hour|hourly/.test(t)) {
    return '0 * * * *';
  }

  if (/every\s+minute/.test(t)) {
    return '* * * * *';
  }

  // "at 2 am" / "at 2:30 pm" / "2am"
  const at = t.match(/(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);

  if (at && (/\bat\b/.test(t) || /\b(am|pm)\b/.test(t))) {
    let hour = parseInt(at[1], 10);
    const min = at[2] ? parseInt(at[2], 10) : 0;
    const mer = at[3];

    if (mer === 'pm' && hour < 12) {
      hour += 12;
    }

    if (mer === 'am' && hour === 12) {
      hour = 0;
    }

    if (hour >= 0 && hour <= 23 && min >= 0 && min <= 59) {
      return `${min} ${hour} * * *`;
    }
  }

  if (/weekly/.test(t)) {
    return '0 2 * * 1';
  } // Monday 02:00

  if (/monthly/.test(t)) {
    return '0 2 1 * *';
  } // 1st 02:00

  return '0 2 * * *'; // nightly 02:00 default
}

/** Pull a human name out of a request ("called X", "named X", quoted, or leading nouns). */
export function nameFromText(text: string, kind: CreateKind): string {
  const t = (text || '').trim();
  const explicit = t.match(/(?:called|named)\s+["']?([a-z0-9 _-]{2,40})["']?/i);

  if (explicit) {
    return slugify(explicit[1], `${kind}`);
  }

  const quoted = t.match(/["']([a-z0-9 _-]{2,40})["']/i);

  if (quoted) {
    return slugify(quoted[1], `${kind}`);
  }

  // Domain-y keyword → concise slug.
  const kw = t.match(
    /\b(contact|sitemap|newsletter|webhook|order|booking|invoice|cache|publish|subscribe|lead|payment|review|feedback|search|upload|export|sync)\b/i,
  );

  if (kw) {
    const suffix = kind === 'endpoint' ? '' : kind === 'cron' ? '-job' : kind === 'workflow' ? '-flow' : '';
    return slugify(kw[1] + suffix, `${kind}`);
  }

  return kind === 'endpoint'
    ? 'my-endpoint'
    : kind === 'cron'
      ? 'nightly-job'
      : kind === 'workflow'
        ? 'my-workflow'
        : 'my-function';
}

/**
 * Classify a natural-language request into a typed intent. Pure + deterministic —
 * the (optional) AI-Gateway upgrade (EPIC B) can later replace THIS function
 * without touching {@link scaffoldForIntent} (classification ⟂ execution).
 */
export function classifyIntent(text: string): CreateIntent {
  const t = (text || '').toLowerCase();
  const prompt = text?.trim() || undefined;

  // Scheduled/cron — time cadence phrasing.
  if (/\b(every|nightly|daily|weekly|monthly|hourly|cron|schedule|each night|each day|at \d)\b/.test(t)) {
    return { kind: 'cron', name: nameFromText(text, 'cron'), schedule: cronFromText(text), prompt };
  }

  // Workflow — multi-step / orchestration phrasing.
  if (/\b(workflow|pipeline|orchestrat|then\b.*\b(purge|publish|deploy|notify)|multi-step|steps?)\b/.test(t)) {
    return { kind: 'workflow', name: nameFromText(text, 'workflow'), prompt };
  }

  // Endpoint — API/route/form/webhook phrasing.
  if (/\b(endpoint|api|route|webhook|form|post|get|receive|submit)\b/.test(t)) {
    const method: HttpMethod = /\bget\b|read|fetch|list/.test(t) ? 'GET' : 'POST';
    return { kind: 'endpoint', name: nameFromText(text, 'endpoint'), method, prompt };
  }

  // Default — a generic function.
  return { kind: 'function', name: nameFromText(text, 'function'), prompt };
}

// ── Starter file bodies (match the canonical scaffold SSOT) ──────────────────

const HEADER = (title: string) =>
  `/**\n * ${title}\n *\n * File-routed like Cloudflare Pages: functions/api/<name>.ts → /api/<name>.\n * Handlers: onRequestGet / onRequestPost / … receive one ctx = { request, params, env, waitUntil }.\n * Bindings on ctx.env: AI · DATA · KV · R2 · SECRETS. Reserved: /api/contact-form, /api/_ps/*.\n * Publish bundles functions/ for you — no local build step. See functions/api/hello.ts for full docs.\n */\n`;

function endpointBody(slug: string, method: HttpMethod, note?: string): string {
  const handler = `onRequest${method.charAt(0) + method.slice(1).toLowerCase()}`;

  if (method === 'GET') {
    return (
      HEADER(`functions/api/${slug}.ts — GET /api/${slug}${note ? ` (${note})` : ''}`) +
      `\nexport const ${handler} = async ({ request, env }: { request: Request; env: any }): Promise<Response> => {\n` +
      `  const url = new URL(request.url);\n` +
      `  // Read your data via env.DATA / env.KV / env.R2; call AI via env.AI.\n` +
      `  return Response.json({ ok: true, endpoint: '/api/${slug}', query: Object.fromEntries(url.searchParams) });\n};\n`
    );
  }

  return (
    HEADER(`functions/api/${slug}.ts — ${method} /api/${slug}${note ? ` (${note})` : ''}`) +
    `\nexport const ${handler} = async ({ request, env }: { request: Request; env: any }): Promise<Response> => {\n` +
    `  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;\n\n` +
    `  // Validate input before you trust it (reject early, be specific).\n` +
    `  const errors: Record<string, string> = {};\n` +
    `  // e.g. if (!body.email) errors.email = 'required';\n` +
    `  if (Object.keys(errors).length) return Response.json({ ok: false, errors }, { status: 400 });\n\n` +
    `  // Do the work: env.DATA (forms/site), env.KV, env.R2, env.AI, env.SECRETS.<KEY>.\n` +
    `  return Response.json({ ok: true, endpoint: '/api/${slug}', received: body });\n};\n`
  );
}

function functionBody(slug: string): string {
  return (
    HEADER(`functions/api/${slug}.ts — /api/${slug} (GET + POST)`) +
    `\nexport const onRequestGet = ({ request }: { request: Request }): Response => {\n` +
    `  const name = new URL(request.url).searchParams.get('name') ?? 'world';\n` +
    `  return Response.json({ ok: true, message: \`Hello, \${name}!\`, from: 'functions/api/${slug}.ts' });\n};\n\n` +
    `export const onRequestPost = async ({ request }: { request: Request }): Promise<Response> => {\n` +
    `  const youSent = await request.json().catch(() => ({}));\n` +
    `  return Response.json({ ok: true, youSent });\n};\n`
  );
}

function workflowBody(slug: string, note?: string): string {
  return (
    HEADER(`functions/api/${slug}.ts — a multi-step workflow${note ? ` (${note})` : ''}`) +
    `\n// A "workflow" here is an endpoint that runs ordered steps. Trigger it on a\n` +
    `// schedule by adding functions/_scheduled.ts, or call it from another Function.\n` +
    `export const onRequestPost = async ({ request, env, waitUntil }: { request: Request; env: any; waitUntil: (p: Promise<unknown>) => void }): Promise<Response> => {\n` +
    `  const ran: string[] = [];\n` +
    `  try {\n` +
    `    // Step 1 — gather / validate.\n` +
    `    ran.push('step-1');\n` +
    `    // Step 2 — do the main work (env.DATA / env.KV / env.R2 / env.AI).\n` +
    `    ran.push('step-2');\n` +
    `    // Step 3 — finalize; defer slow follow-ups with waitUntil so the response is fast.\n` +
    `    waitUntil(Promise.resolve());\n` +
    `    ran.push('step-3');\n` +
    `    return Response.json({ ok: true, workflow: '${slug}', steps: ran });\n` +
    `  } catch (err) {\n` +
    `    return Response.json({ ok: false, workflow: '${slug}', failedAfter: ran, error: String(err) }, { status: 500 });\n` +
    `  }\n};\n`
  );
}

function scheduledBody(slug: string, schedule: string, note?: string): string {
  return (
    HEADER(`functions/_scheduled.ts — a scheduled job${note ? ` (${note})` : ''}`) +
    `\n// The platform runs this on the cron below. ONE _scheduled.ts per site —\n` +
    `// if you already have one, merge this handler into it.\n` +
    `export const cron = '${schedule}';\n\n` +
    `export const scheduled = async ({ env }: { env: any }): Promise<void> => {\n` +
    `  // '${slug}' runs on: ${schedule} (min hour dom mon dow, UTC).\n` +
    `  // Do the scheduled work: refresh caches, sync data, send digests, etc.\n` +
    `  // env.DATA / env.KV / env.R2 / env.AI / env.SECRETS are all available.\n` +
    `};\n`
  );
}

/** Curated multi-purpose templates (the "Browse Templates" set + AI examples). */
export interface CreateTemplate {
  id: string;
  label: string;
  description: string;
  intent: CreateIntent;
}
export const CREATE_TEMPLATES: readonly CreateTemplate[] = [
  {
    id: 'contact-endpoint',
    label: 'Contact form endpoint',
    description: 'POST /api/contact — validates input, ready to send an email.',
    intent: {
      kind: 'endpoint',
      name: 'contact',
      method: 'POST',
      prompt: 'contact form endpoint that validates input and sends an email',
    },
  },
  {
    id: 'sitemap-cron',
    label: 'Nightly sitemap refresh',
    description: 'A scheduled job that runs every night at 2 AM.',
    intent: {
      kind: 'cron',
      name: 'sitemap-refresh',
      schedule: '0 2 * * *',
      prompt: 'refresh the sitemap every night at 2 AM',
    },
  },
  {
    id: 'publish-workflow',
    label: 'Publish + purge workflow',
    description: 'A workflow that publishes approved pages and purges the cache.',
    intent: { kind: 'workflow', name: 'publish-and-purge', prompt: 'publish approved pages and purge the cache' },
  },
] as const;

/**
 * Turn a validated intent into the concrete file(s) to create. Pure — the caller
 * writes them via workbenchStore.createFile. Draft file creation is NOT sensitive
 * (it writes to the project tree, not prod); deploy/secrets happen elsewhere.
 */
export function scaffoldForIntent(rawIntent: CreateIntent): ScaffoldResult {
  const intent = createIntentSchema.parse(rawIntent);

  if (intent.kind === 'template') {
    const tpl = CREATE_TEMPLATES.find((t) => t.id === intent.templateId);

    if (!tpl) {
      throw new Error(`Unknown template: ${intent.templateId}`);
    }

    return scaffoldForIntent(tpl.intent);
  }

  const note = intent.prompt && intent.prompt.length <= 80 ? intent.prompt : undefined;

  switch (intent.kind) {
    case 'function': {
      const slug = slugify(intent.name, 'my-function');
      const path = `functions/api/${slug}.ts`;

      return {
        intent,
        files: [{ path, content: functionBody(slug) }],
        openPath: path,
        sensitive: false,
        summary: `Function → ${path} (GET+POST at /api/${slug})`,
      };
    }
    case 'endpoint': {
      const slug = slugify(intent.name, 'my-endpoint');
      const path = `functions/api/${slug}.ts`;

      return {
        intent,
        files: [{ path, content: endpointBody(slug, intent.method, note) }],
        openPath: path,
        sensitive: false,
        summary: `API endpoint → ${intent.method} /api/${slug} (${path})`,
      };
    }
    case 'cron': {
      const slug = slugify(intent.name, 'nightly-job');
      const path = `functions/_scheduled.ts`;

      return {
        intent,
        files: [{ path, content: scheduledBody(slug, intent.schedule, note) }],
        openPath: path,
        sensitive: false,
        summary: `Scheduled job → ${path} (cron '${intent.schedule}')`,
      };
    }
    case 'workflow': {
      const slug = slugify(intent.name, 'my-workflow');
      const path = `functions/api/${slug}.ts`;

      return {
        intent,
        files: [{ path, content: workflowBody(slug, note) }],
        openPath: path,
        sensitive: false,
        summary: `Workflow → ${path} (multi-step, POST /api/${slug})`,
      };
    }
  }

  throw new Error(`Unhandled intent kind: ${JSON.stringify(intent)}`);
}
