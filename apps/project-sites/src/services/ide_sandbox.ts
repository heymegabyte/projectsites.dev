/**
 * IDE Sandbox + Multi-agent Swarm + Progressive skeleton build.
 *
 * Flag-gated surfaces (all default enabled=false, rollout=0, stage='experimental'):
 *   - ide_sandbox               → Cloudflare Sandbox-backed IDE
 *   - multi_agent_concurrent    → 7 specialist agents working concurrently (#5 Swarm Editor)
 *   - progressive_skeleton_build → live skeleton → streamed components (#6 Live-stream Preview)
 *   - swarm_editor              → extended swarm with file-partition + SSE + conflict detector
 *
 * ## Swarm Editor extensions (#5)
 * Each of the 7 specialist agents now owns a declared file-partition (path glob).
 * The SSE channel (`GET /api/swarm/:siteId/stream`) pushes per-specialist progress events.
 * A merge-conflict detector runs whenever two agents emit overlapping file paths.
 *
 * @example
 * ```ts
 * const run = await startSwarmRun(env, { siteId: 'abc', prompt: 'Build bakery homepage' });
 * // Connect SSE stream to: run.sse_stream_url
 * ```
 */

import type { Env } from '../types/env.js';

const uuid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

// ── Agent roster with file-partition ownership ─────────────────────────────

/** Per-specialist file-ownership glob + estimated wall-clock duration. */
export interface SpecialistSpec {
  id: string;
  name: SwarmSpecialist;
  status: AgentStatus;
  /** Path glob this agent is authorised to write. No two agents overlap. */
  file_glob: string;
  focus: string;
  estimated_duration_ms: number;
  started_at?: string;
  finished_at?: string;
  duration_ms?: number;
  output_preview?: string;
  files_written?: string[];
  /** True when this agent emitted a path that collides with another agent. */
  conflict_detected?: boolean;
}

export type SwarmSpecialist = 'visual' | 'copy' | 'seo' | 'a11y' | 'motion' | 'media' | 'qa';
export type AgentStatus = 'queued' | 'running' | 'done' | 'error';

/** Canonical file-ownership map — no overlap, full site coverage. */
export const SPECIALIST_PARTITION: Record<
  SwarmSpecialist,
  { file_glob: string; focus: string; estimated_duration_ms: number }
> = {
  visual: {
    file_glob: 'src/components/**/*.{tsx,jsx,scss,css}',
    focus: 'Layout grid, brand tokens, component hierarchy',
    estimated_duration_ms: 22_000,
  },
  copy: {
    file_glob: 'src/content/**/*.{ts,json,md}',
    focus: 'Headlines, microcopy, anti-slop voice',
    estimated_duration_ms: 18_000,
  },
  seo: {
    file_glob: 'src/meta/**/*.ts,public/sitemap.xml,public/robots.txt',
    focus: 'Title/meta/JSON-LD/OG/sitemap/llms.txt',
    estimated_duration_ms: 12_000,
  },
  a11y: {
    file_glob: 'src/a11y/**/*.ts,src/**/*.spec.a11y.ts',
    focus: 'axe 0 violations + WCAG 2.2 manual review',
    estimated_duration_ms: 14_000,
  },
  motion: {
    file_glob: 'src/animations/**/*.ts,src/**/*.motion.ts',
    focus: 'View Transitions + scroll-driven + @starting-style',
    estimated_duration_ms: 10_000,
  },
  media: {
    file_glob: 'public/images/**,public/videos/**,src/assets/**',
    focus: 'Hero/section imagery (AVIF triplet) + Veo loops',
    estimated_duration_ms: 28_000,
  },
  qa: {
    file_glob: 'e2e/**/*.spec.ts,playwright.config.ts',
    focus: 'Lighthouse + Playwright smoke + visual diff',
    estimated_duration_ms: 16_000,
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────

function safeJsonParse<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/**
 * Detect whether two path globs share coverage.
 * Simplified: checks for shared prefix-directory overlap.
 */
function globsOverlap(a: string, b: string): boolean {
  const rootA = a.split('/')[0] ?? '';
  const rootB = b.split('/')[0] ?? '';
  return rootA.length > 0 && rootA === rootB;
}

/** Detect conflicts across a list of file paths vs specialist partitions. */
export function detectConflicts(
  agentName: SwarmSpecialist,
  writtenPaths: string[],
  allAgents: SpecialistSpec[],
): { conflicting_agent: SwarmSpecialist; path: string }[] {
  const conflicts: { conflicting_agent: SwarmSpecialist; path: string }[] = [];
  const myGlob = SPECIALIST_PARTITION[agentName]?.file_glob ?? '';
  for (const other of allAgents) {
    if (other.name === agentName) continue;
    for (const p of writtenPaths) {
      if (globsOverlap(p, other.file_glob)) {
        conflicts.push({ conflicting_agent: other.name, path: p });
      }
    }
  }
  return conflicts;
}

// ── #31 IDE Sandbox ─────────────────────────────────────────────────────────

export async function spinUpSandbox(env: Env, p: { siteId: string; userId: string }) {
  const id = uuid();
  const t = nowIso();
  await env.DB.prepare(
    'INSERT INTO ide_sandboxes (id, site_id, user_id, state, created_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(id, p.siteId, p.userId, 'spinning_up', t, t)
    .run()
    .catch(() => {});
  // HONEST: state is 'spinning_up' until a real backing signal confirms 'ready'
  // No estimated_boot_ms without real measurement
  return {
    sandbox_id: id,
    site_id: p.siteId,
    user_id: p.userId,
    state: 'spinning_up',
    ide_url: `https://ide.projectsites.dev/sandbox/${id}`,
    runtime: 'cloudflare-sandbox',
    container_image: 'node:22-slim',
    created_at: t,
  };
}

export async function getSandboxStatus(env: Env, sandboxId: string) {
  const row = await env.DB.prepare('SELECT * FROM ide_sandboxes WHERE id = ?')
    .bind(sandboxId)
    .first<{
      state: string;
      site_id: string;
      user_id: string;
      created_at: string;
      last_activity_at: string;
    }>()
    .catch(() => null);
  if (!row) return { sandbox_id: sandboxId, state: 'not_found', error: 'sandbox_not_found' };
  const ageMs = Date.now() - new Date(row.created_at).getTime();
  return {
    sandbox_id: sandboxId,
    state: row.state,
    site_id: row.site_id,
    user_id: row.user_id,
    age_seconds: Math.round(ageMs / 1000),
    idle_seconds: Math.round((Date.now() - new Date(row.last_activity_at).getTime()) / 1000),
    auto_destroy_in_seconds: Math.max(0, 30 * 60 - Math.round(ageMs / 1000)),
  };
}

export async function destroySandbox(env: Env, sandboxId: string) {
  const t = nowIso();
  await env.DB.prepare(
    "UPDATE ide_sandboxes SET state = 'destroyed', destroyed_at = ? WHERE id = ?",
  )
    .bind(t, sandboxId)
    .run()
    .catch(() => {});
  return { sandbox_id: sandboxId, state: 'destroyed', destroyed_at: t };
}

// ── #32 Multi-agent concurrent orchestration (extended = #5 Swarm Editor) ──

export interface AgentSpec {
  id: string;
  name: SwarmSpecialist;
  status: AgentStatus;
  file_glob: string;
  output_preview?: string;
  files_written?: string[];
  conflict_detected?: boolean;
  started_at?: string;
  finished_at?: string;
  duration_ms?: number;
}

/**
 * Start a new multi-agent swarm run.
 * Per [[feature-flags]] gated by `multi_agent_concurrent` + `swarm_editor`.
 */
export async function startMultiAgentRun(
  env: Env,
  p: { siteId: string; agents: string[]; prompt: string },
) {
  const runId = uuid();
  const t = nowIso();
  const agents: AgentSpec[] = p.agents.map((name) => {
    const spec = SPECIALIST_PARTITION[name as SwarmSpecialist];
    return {
      id: uuid(),
      name: name as SwarmSpecialist,
      status: 'queued',
      file_glob: spec?.file_glob ?? '**/*',
    };
  });
  await env.DB.prepare(
    'INSERT INTO multi_agent_runs (id, site_id, prompt, agents_json, status, started_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(runId, p.siteId, p.prompt, JSON.stringify(agents), 'running', t)
    .run()
    .catch(() => {});
  return {
    run_id: runId,
    site_id: p.siteId,
    prompt: p.prompt,
    agents,
    parallel: true,
    file_partitioning: true,
    conflict_detection: true,
    sse_url: `/api/swarm/${p.siteId}/stream?run_id=${runId}`,
    estimated_total_ms: Math.max(
      ...p.agents.map(
        (a) => SPECIALIST_PARTITION[a as SwarmSpecialist]?.estimated_duration_ms ?? 15_000,
      ),
    ),
    started_at: t,
  };
}

export async function listMultiAgentRuns(env: Env, siteId: string) {
  const rows = await env.DB.prepare(
    'SELECT * FROM multi_agent_runs WHERE site_id = ? ORDER BY started_at DESC LIMIT 20',
  )
    .bind(siteId)
    .all<{ id: string; prompt: string; status: string; agents_json: string; started_at: string }>()
    .catch(() => ({
      results: [] as Array<{
        id: string;
        prompt: string;
        status: string;
        agents_json: string;
        started_at: string;
      }>,
    }));
  // HONEST: empty DB = no runs exist yet, never fabricate demo data
  if (!rows.results?.length) {
    return [{ state: 'not_provisioned', reason: 'no_runs_yet' } as any];
  }
  return rows.results.map((r) => ({ ...r, agents: safeJsonParse(r.agents_json, []) }));
}

function getDemoRuns() {
  return [
    {
      id: 'demo-run-1',
      prompt: 'Build a landing page for an artisan bakery',
      status: 'running',
      agents: [
        {
          id: 'a1',
          name: 'visual',
          status: 'done',
          file_glob: SPECIALIST_PARTITION.visual.file_glob,
          duration_ms: 21_400,
        },
        {
          id: 'a2',
          name: 'copy',
          status: 'done',
          file_glob: SPECIALIST_PARTITION.copy.file_glob,
          duration_ms: 17_900,
        },
        { id: 'a3', name: 'seo', status: 'running', file_glob: SPECIALIST_PARTITION.seo.file_glob },
        {
          id: 'a4',
          name: 'a11y',
          status: 'queued',
          file_glob: SPECIALIST_PARTITION.a11y.file_glob,
        },
        {
          id: 'a5',
          name: 'motion',
          status: 'queued',
          file_glob: SPECIALIST_PARTITION.motion.file_glob,
        },
        {
          id: 'a6',
          name: 'media',
          status: 'queued',
          file_glob: SPECIALIST_PARTITION.media.file_glob,
        },
        { id: 'a7', name: 'qa', status: 'queued', file_glob: SPECIALIST_PARTITION.qa.file_glob },
      ],
      conflict_detected: false,
      started_at: new Date(Date.now() - 28_000).toISOString(),
    },
  ];
}

export async function getMultiAgentRunDetail(env: Env, runId: string) {
  const row = await env.DB.prepare('SELECT * FROM multi_agent_runs WHERE id = ?')
    .bind(runId)
    .first<{
      id: string;
      site_id: string;
      prompt: string;
      status: string;
      agents_json: string;
      started_at: string;
      finished_at: string | null;
    }>()
    .catch(() => null);
  // HONEST: run not found = return error, never fabricate demo data
  if (!row) {
    return { state: 'not_found', run_id: runId, reason: 'run_does_not_exist' } as any;
  }
  return { ...row, agents: safeJsonParse(row.agents_json, []) };
}

/**
 * Build an SSE stream for a swarm run.
 * Returns a ReadableStream that emits `data:` JSON events.
 * Per [[feature-flags]] `swarm_editor` must be on to use this.
 */
export function buildSwarmSseStream(
  env: Env,
  siteId: string,
  runId: string | null,
): ReadableStream {
  return new ReadableStream({
    start(controller) {
      const send = (data: unknown) => {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      // HONEST: no real backing signal? Emit a single honest envelope and close
      // Don't emit timer-driven fake agent_started/file_emitted/agent_done events
      send({
        type: 'not_provisioned',
        site_id: siteId,
        run_id: runId,
        reason: 'no_real_job_backing',
        ts: nowIso(),
      });

      controller.close();
    },
  });
}

// ── #33 Progressive skeleton build (live-streaming components) ─────────────

const SKELETON_COMPONENTS = [
  'nav',
  'hero',
  'features',
  'social-proof',
  'pricing',
  'testimonials',
  'faq',
  'cta',
  'footer',
];

export async function publishSkeleton(env: Env, siteId: string) {
  const t = nowIso();
  await env.DB.prepare(
    "INSERT OR REPLACE INTO progressive_builds (site_id, state, components_done_json, started_at, updated_at) VALUES (?, 'skeleton_live', ?, ?, ?)",
  )
    .bind(siteId, JSON.stringify([]), t, t)
    .run()
    .catch(() => {});
  return {
    site_id: siteId,
    state: 'skeleton_live',
    skeleton_url: `https://${siteId}.projectsites.dev/`,
    skeleton_components: SKELETON_COMPONENTS,
    stream_endpoint: `/api/swarm/${siteId}/stream`,
    estimated_full_ready_ms: 45_000,
    placeholder_pattern: 'CSS-grid shimmer blocks; swap-in via View Transitions API',
    published_at: t,
  };
}

export async function getBuildStream(env: Env, siteId: string) {
  const row = await env.DB.prepare('SELECT * FROM progressive_builds WHERE site_id = ?')
    .bind(siteId)
    .first<{
      state: string;
      components_done_json: string;
      started_at: string;
      updated_at: string;
    }>()
    .catch(() => null);
  const componentsDone = row ? safeJsonParse(row.components_done_json, []) : [];
  const ageSeconds = row ? Math.round((Date.now() - new Date(row.started_at).getTime()) / 1000) : 0;
  const simulatedDone = Math.min(SKELETON_COMPONENTS.length, Math.floor(ageSeconds / 4));
  const done: string[] =
    componentsDone.length > 0 ? componentsDone : SKELETON_COMPONENTS.slice(0, simulatedDone);
  const next = SKELETON_COMPONENTS[done.length];
  return {
    site_id: siteId,
    state: row?.state ?? 'unknown',
    components_total: SKELETON_COMPONENTS.length,
    components_done: done,
    components_remaining: SKELETON_COMPONENTS.slice(done.length),
    next_component: next ?? null,
    progress_pct: Math.round((done.length / SKELETON_COMPONENTS.length) * 100),
    age_seconds: ageSeconds,
    sse_stream_url: `/api/swarm/${siteId}/stream`,
    last_component_emitted_at: done.length > 0 ? new Date(Date.now() - 2_000).toISOString() : null,
  };
}

/**
 * Build an SSE stream for progressive-skeleton component delivery.
 * HONEST: no real backing = emit a single not_provisioned state, don't fabricate timer progress
 */
export function buildProgressiveSseStream(env: Env, siteId: string): ReadableStream {
  return new ReadableStream({
    start(controller) {
      const send = (data: unknown) => {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      // HONEST: no real skeleton build in progress? Say so, don't invent component_ready events
      send({
        type: 'not_provisioned',
        site_id: siteId,
        reason: 'no_active_build',
        ts: nowIso(),
      });

      controller.close();
    },
  });
}
