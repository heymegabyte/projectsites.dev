/**
 * IDE Sandbox + Multi-agent Swarm + Progressive skeleton — unit coverage (convergence r53).
 *
 * Covers every exported member of `services/ide_sandbox.ts`:
 *   - SPECIALIST_PARTITION  — 7-agent roster shape, no-overlap invariant
 *   - detectConflicts       — glob-overlap conflict detection across agents
 *   - spinUpSandbox (#31)   — D1 insert, ready envelope, URL fabrication, DB-throw resilience
 *   - getSandboxStatus      — found vs not_found, age/idle/auto-destroy math
 *   - destroySandbox        — state transition + timestamp
 *   - startMultiAgentRun    — agent mapping, file-glob assignment, SSE url, estimated_total_ms
 *   - listMultiAgentRuns    — D1 rows → parsed agents vs demo fallback
 *   - getMultiAgentRunDetail— row detail vs demo fallback
 *   - buildSwarmSseStream    — connected event + ticked agent_started/file_emitted/agent_done + complete
 *   - publishSkeleton (#33) — D1 upsert + skeleton envelope
 *   - getBuildStream        — components-done math, demo simulation, unknown state
 *   - buildProgressiveSseStream — skeleton_live + component_ready cadence + all_components_ready
 *
 * D1 (`env.DB.prepare`) is jest-mocked; fake timers drive the SSE intervals.
 * No real Sandbox SDK / Durable Object / container is touched.
 */

import {
  SPECIALIST_PARTITION,
  detectConflicts,
  spinUpSandbox,
  getSandboxStatus,
  destroySandbox,
  startMultiAgentRun,
  listMultiAgentRuns,
  getMultiAgentRunDetail,
  buildSwarmSseStream,
  publishSkeleton,
  getBuildStream,
  buildProgressiveSseStream,
  type SpecialistSpec,
  type SwarmSpecialist,
} from '../services/ide_sandbox.js';
import type { Env } from '../types/env.js';

// ─── D1 stub builder ─────────────────────────────────────────────────────────

interface DbOpts {
  /** Return value for `.first()` (getSandboxStatus / getMultiAgentRunDetail / getBuildStream). */
  first?: Record<string, unknown> | null;
  /** Return value for `.all()` (.results). */
  all?: unknown[];
  /** Make `.run()` reject (exercises the `.catch(() => {})` resilience path). */
  runThrows?: boolean;
  /** Make `.first()` reject (exercises `.catch(() => null)`). */
  firstThrows?: boolean;
  /** Make `.all()` reject (exercises `.catch(() => ({ results: [] }))`). */
  allThrows?: boolean;
}

function makeEnv(opts: DbOpts = {}): {
  env: Env;
  prepare: jest.Mock;
  run: jest.Mock;
  bind: jest.Mock;
} {
  const run = jest.fn(async () => {
    if (opts.runThrows) throw new Error('D1 write failed');
    return { success: true };
  });
  const first = jest.fn(async () => {
    if (opts.firstThrows) throw new Error('D1 read failed');
    return 'first' in opts ? opts.first : null;
  });
  const all = jest.fn(async () => {
    if (opts.allThrows) throw new Error('D1 list failed');
    return { results: opts.all ?? [] };
  });
  const bind = jest.fn(() => ({ run, first, all }));
  const prepare = jest.fn(() => ({ bind }));
  const env = { DB: { prepare } } as unknown as Env;
  return { env, prepare, run, bind };
}

function makeSpec(name: SwarmSpecialist, over: Partial<SpecialistSpec> = {}): SpecialistSpec {
  const p = SPECIALIST_PARTITION[name];
  return {
    id: `id-${name}`,
    name,
    status: 'queued',
    file_glob: p.file_glob,
    focus: p.focus,
    estimated_duration_ms: p.estimated_duration_ms,
    ...over,
  };
}

// ─── SPECIALIST_PARTITION roster ──────────────────────────────────────────────

describe('SPECIALIST_PARTITION', () => {
  const names: SwarmSpecialist[] = ['visual', 'copy', 'seo', 'a11y', 'motion', 'media', 'qa'];

  it('declares all 7 specialists with the required fields', () => {
    expect(Object.keys(SPECIALIST_PARTITION)).toHaveLength(7);
    for (const n of names) {
      const spec = SPECIALIST_PARTITION[n];
      expect(typeof spec.file_glob).toBe('string');
      expect(spec.file_glob.length).toBeGreaterThan(0);
      expect(typeof spec.focus).toBe('string');
      expect(spec.estimated_duration_ms).toBeGreaterThan(0);
    }
  });

  it('gives every specialist a distinct file_glob', () => {
    const globs = names.map((n) => SPECIALIST_PARTITION[n].file_glob);
    expect(new Set(globs).size).toBe(globs.length);
  });
});

// ─── detectConflicts ──────────────────────────────────────────────────────────

describe('detectConflicts', () => {
  it('flags a written path that overlaps another agent partition root', () => {
    // copy writes into src/... which shares root "src" with the visual agent.
    const agents = [makeSpec('visual'), makeSpec('copy')];
    const conflicts = detectConflicts('copy', ['src/content/home.ts'], agents);
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts.some((c) => c.conflicting_agent === 'visual')).toBe(true);
    expect(conflicts[0].path).toBe('src/content/home.ts');
  });

  it('never reports a conflict against the same agent', () => {
    const agents = [makeSpec('copy')];
    const conflicts = detectConflicts('copy', ['src/content/home.ts'], agents);
    // copy is the only agent and is skipped → no conflicts
    expect(conflicts).toEqual([]);
  });

  it('returns empty when the written path root does not overlap any partition', () => {
    const agents = [makeSpec('media')]; // media root = "public"
    const conflicts = detectConflicts('media', ['e2e/home.spec.ts'], agents);
    expect(conflicts).toEqual([]);
  });

  it('handles an unknown agent name (no partition) gracefully', () => {
    const agents = [makeSpec('visual')];
    const conflicts = detectConflicts('ghost' as SwarmSpecialist, ['src/x.ts'], agents);
    // ghost has no own glob but still compares written paths against others
    expect(conflicts.some((c) => c.conflicting_agent === 'visual')).toBe(true);
  });

  it('detects multiple overlapping paths across multiple agents', () => {
    const agents = [makeSpec('visual'), makeSpec('a11y'), makeSpec('motion')];
    const conflicts = detectConflicts('visual', ['src/components/Hero.tsx', 'src/a.ts'], agents);
    // both paths share "src" root with a11y + motion
    expect(conflicts.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── #31 spinUpSandbox ────────────────────────────────────────────────────────

describe('spinUpSandbox', () => {
  it('inserts a sandbox row and returns a ready envelope with fabricated URLs', async () => {
    const { env, prepare, bind, run } = makeEnv();
    const out = await spinUpSandbox(env, { siteId: 'site-1', userId: 'u-1' });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0][0]).toContain('INSERT INTO ide_sandboxes');
    expect(bind).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(out.state).toBe('ready');
    expect(out.runtime).toBe('cloudflare-sandbox');
    expect(out.container_image).toBe('node:22-slim');
    expect(out.site_id).toBe('site-1');
    expect(out.user_id).toBe('u-1');
    expect(out.ide_url).toBe(`https://ide.projectsites.dev/sandbox/${out.sandbox_id}`);
    expect(out.monaco_url).toContain('/monaco');
    expect(out.terminal_url).toContain('/term');
    expect(out.file_tree_url).toContain('/files');
    expect(out.preview_url).toContain('/preview');
    expect(out.auto_destroy_idle_minutes).toBe(30);
    expect(out.cpu_limit_ms).toBe(50);
    expect(out.memory_mb).toBe(256);
  });

  it('still returns a ready envelope when the D1 insert throws', async () => {
    const { env } = makeEnv({ runThrows: true });
    const out = await spinUpSandbox(env, { siteId: 's2', userId: 'u2' });
    expect(out.state).toBe('ready');
    expect(out.sandbox_id).toMatch(/[0-9a-f-]{36}/);
  });

  it('mints a unique sandbox_id per call', async () => {
    const { env } = makeEnv();
    const a = await spinUpSandbox(env, { siteId: 's', userId: 'u' });
    const b = await spinUpSandbox(env, { siteId: 's', userId: 'u' });
    expect(a.sandbox_id).not.toBe(b.sandbox_id);
  });
});

// ─── getSandboxStatus ─────────────────────────────────────────────────────────

describe('getSandboxStatus', () => {
  it('returns not_found when no row exists', async () => {
    const { env } = makeEnv({ first: null });
    const out = await getSandboxStatus(env, 'missing');
    expect(out.state).toBe('not_found');
    expect(out.error).toBe('sandbox_not_found');
    expect(out.sandbox_id).toBe('missing');
  });

  it('returns not_found when the D1 read throws', async () => {
    const { env } = makeEnv({ firstThrows: true });
    const out = await getSandboxStatus(env, 'boom');
    expect(out.state).toBe('not_found');
  });

  it('computes age / idle / auto-destroy seconds for an existing row', async () => {
    const created = new Date(Date.now() - 120_000).toISOString(); // 2 min ago
    const last = new Date(Date.now() - 30_000).toISOString(); // 30s ago
    const { env } = makeEnv({
      first: {
        state: 'ready',
        site_id: 'site-9',
        user_id: 'u-9',
        created_at: created,
        last_activity_at: last,
      },
    });
    const out = await getSandboxStatus(env, 'sb-9');
    expect(out.state).toBe('ready');
    expect(out.site_id).toBe('site-9');
    expect(out.age_seconds).toBeGreaterThanOrEqual(119);
    expect(out.idle_seconds).toBeGreaterThanOrEqual(29);
    expect(out.auto_destroy_in_seconds).toBeGreaterThan(0);
    expect(out.auto_destroy_in_seconds).toBeLessThanOrEqual(30 * 60);
  });

  it('clamps auto_destroy_in_seconds at 0 for a stale sandbox', async () => {
    const created = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    const { env } = makeEnv({
      first: {
        state: 'ready',
        site_id: 's',
        user_id: 'u',
        created_at: created,
        last_activity_at: created,
      },
    });
    const out = await getSandboxStatus(env, 'old');
    expect(out.auto_destroy_in_seconds).toBe(0);
  });
});

// ─── destroySandbox ───────────────────────────────────────────────────────────

describe('destroySandbox', () => {
  it('updates state to destroyed and returns a timestamp', async () => {
    const { env, prepare, run } = makeEnv();
    const out = await destroySandbox(env, 'sb-x');
    expect(prepare.mock.calls[0][0]).toContain("state = 'destroyed'");
    expect(run).toHaveBeenCalledTimes(1);
    expect(out.sandbox_id).toBe('sb-x');
    expect(out.state).toBe('destroyed');
    expect(typeof out.destroyed_at).toBe('string');
  });

  it('tolerates a D1 write failure', async () => {
    const { env } = makeEnv({ runThrows: true });
    const out = await destroySandbox(env, 'sb-y');
    expect(out.state).toBe('destroyed');
  });
});

// ─── #32/#5 startMultiAgentRun ────────────────────────────────────────────────

describe('startMultiAgentRun', () => {
  it('maps requested agents to specs and assigns canonical file globs', async () => {
    const { env, prepare, run } = makeEnv();
    const out = await startMultiAgentRun(env, {
      siteId: 'site-7',
      agents: ['visual', 'qa'],
      prompt: 'Build bakery',
    });
    expect(out.agents).toHaveLength(2);
    expect(out.agents[0].name).toBe('visual');
    expect(out.agents[0].status).toBe('queued');
    expect(out.agents[0].file_glob).toBe(SPECIALIST_PARTITION.visual.file_glob);
    expect(out.parallel).toBe(true);
    expect(out.file_partitioning).toBe(true);
    expect(out.conflict_detection).toBe(true);
    expect(out.sse_url).toContain('/api/swarm/site-7/stream?run_id=');
    expect(out.sse_url).toContain(out.run_id);
    expect(prepare.mock.calls[0][0]).toContain('INSERT INTO multi_agent_runs');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('uses the max estimated duration across requested agents', async () => {
    const { env } = makeEnv();
    const out = await startMultiAgentRun(env, {
      siteId: 's',
      agents: ['motion', 'media'],
      prompt: 'p',
    });
    // media = 28_000 > motion = 10_000
    expect(out.estimated_total_ms).toBe(SPECIALIST_PARTITION.media.estimated_duration_ms);
  });

  it('falls back to ** glob for an unknown agent name', async () => {
    const { env } = makeEnv();
    const out = await startMultiAgentRun(env, { siteId: 's', agents: ['mystery'], prompt: 'p' });
    expect(out.agents[0].file_glob).toBe('**/*');
    expect(out.estimated_total_ms).toBe(15_000); // fallback duration
  });

  it('tolerates a D1 insert failure', async () => {
    const { env } = makeEnv({ runThrows: true });
    const out = await startMultiAgentRun(env, { siteId: 's', agents: ['copy'], prompt: 'p' });
    expect(out.agents).toHaveLength(1);
  });
});

// ─── listMultiAgentRuns ───────────────────────────────────────────────────────

describe('listMultiAgentRuns', () => {
  it('returns demo runs when D1 has no rows', async () => {
    const { env } = makeEnv({ all: [] });
    const out = await listMultiAgentRuns(env, 'site-1');
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('demo-run-1');
    expect(out[0].agents).toHaveLength(7);
  });

  it('returns demo runs when the D1 list throws', async () => {
    const { env } = makeEnv({ allThrows: true });
    const out = await listMultiAgentRuns(env, 'site-1');
    expect(out[0].id).toBe('demo-run-1');
  });

  it('maps D1 rows and parses agents_json', async () => {
    const agents = [{ id: 'a1', name: 'visual', status: 'done', file_glob: 'src/**' }];
    const { env, prepare, bind } = makeEnv({
      all: [
        {
          id: 'r1',
          prompt: 'Real run',
          status: 'running',
          agents_json: JSON.stringify(agents),
          started_at: '2026-06-01T00:00:00Z',
        },
      ],
    });
    const out = await listMultiAgentRuns(env, 'site-2');
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('r1');
    expect(out[0].agents).toEqual(agents);
    expect(prepare.mock.calls[0][0]).toContain('FROM multi_agent_runs');
    expect(bind).toHaveBeenCalledWith('site-2');
  });

  it('falls back to [] agents when agents_json is malformed', async () => {
    const { env } = makeEnv({
      all: [{ id: 'r2', prompt: 'p', status: 'running', agents_json: 'not-json', started_at: 't' }],
    });
    const out = await listMultiAgentRuns(env, 's');
    expect(out[0].agents).toEqual([]);
  });
});

// ─── getMultiAgentRunDetail ───────────────────────────────────────────────────

describe('getMultiAgentRunDetail', () => {
  it('returns demo detail when the run is not found', async () => {
    const { env } = makeEnv({ first: null });
    const out = (await getMultiAgentRunDetail(env, 'run-x')) as Record<string, unknown>;
    expect(out.run_id).toBe('run-x');
    expect(out.file_partitioning).toBe(true);
    expect(Array.isArray(out.agents)).toBe(true);
    expect((out.agents as unknown[]).length).toBe(7);
    expect(Array.isArray(out.live_stream_events)).toBe(true);
  });

  it('returns demo detail when the D1 read throws', async () => {
    const { env } = makeEnv({ firstThrows: true });
    const out = (await getMultiAgentRunDetail(env, 'run-z')) as Record<string, unknown>;
    expect(out.run_id).toBe('run-z');
  });

  it('maps a real row and parses agents_json', async () => {
    const agents = [{ id: 'a1', name: 'seo', status: 'queued', file_glob: 'src/meta/**' }];
    const { env } = makeEnv({
      first: {
        id: 'r9',
        site_id: 's9',
        prompt: 'p',
        status: 'done',
        agents_json: JSON.stringify(agents),
        started_at: 't',
        finished_at: 't2',
      },
    });
    const out = (await getMultiAgentRunDetail(env, 'r9')) as Record<string, unknown>;
    expect(out.id).toBe('r9');
    expect(out.agents).toEqual(agents);
  });
});

// ─── buildSwarmSseStream ──────────────────────────────────────────────────────

describe('buildSwarmSseStream', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  async function drain(stream: ReadableStream, maxAdvanceMs: number): Promise<string[]> {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    const chunks: string[] = [];
    let elapsed = 0;
    const step = 1500;
    // first read is the synchronous "connected" event
    let result = await reader.read();
    if (!result.done && result.value) chunks.push(dec.decode(result.value));
    while (elapsed < maxAdvanceMs) {
      jest.advanceTimersByTime(step);
      elapsed += step;
      result = await reader.read();
      if (result.done) break;
      if (result.value) chunks.push(dec.decode(result.value));
    }
    // Cancel before returning: an abandoned `getReader()` never fires the
    // stream's `cancel()` hook, so the producer's `setInterval` keeps the Jest
    // worker's event loop alive ("failed to exit gracefully").
    await reader.cancel();
    return chunks;
  }

  it('emits a connected event immediately with site + run ids', async () => {
    const { env } = makeEnv();
    const stream = buildSwarmSseStream(env, 'site-5', 'run-5');
    const reader = stream.getReader();
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    expect(text).toContain('data: ');
    const payload = JSON.parse(text.replace('data: ', '').trim());
    expect(payload.type).toBe('connected');
    expect(payload.site_id).toBe('site-5');
    expect(payload.run_id).toBe('run-5');
    await reader.cancel();
  });

  it('streams agent_started / file_emitted / agent_done across ticks then completes', async () => {
    const { env } = makeEnv();
    const stream = buildSwarmSseStream(env, 'site-6', null);
    const chunks = await drain(stream, 1500 * 7 * 3 + 1500);
    const joined = chunks.join('');
    expect(joined).toContain('"type":"agent_started"');
    expect(joined).toContain('"type":"file_emitted"');
    expect(joined).toContain('"type":"agent_done"');
    expect(joined).toContain('"type":"swarm_complete"');
  });

  it('clears its interval when the consumer cancels', async () => {
    const clearSpy = jest.spyOn(global, 'clearInterval');
    const { env } = makeEnv();
    const stream = buildSwarmSseStream(env, 'site-7', 'r');
    const reader = stream.getReader();
    await reader.read(); // connected
    jest.advanceTimersByTime(1500); // create the interval
    await reader.cancel();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});

// ─── #33 publishSkeleton ──────────────────────────────────────────────────────

describe('publishSkeleton', () => {
  it('upserts a progressive build and returns the skeleton envelope', async () => {
    const { env, prepare, run } = makeEnv();
    const out = await publishSkeleton(env, 'site-sk');
    expect(prepare.mock.calls[0][0]).toContain('INSERT OR REPLACE INTO progressive_builds');
    expect(run).toHaveBeenCalledTimes(1);
    expect(out.state).toBe('skeleton_live');
    expect(out.skeleton_url).toBe('https://site-sk.projectsites.dev/');
    expect(out.skeleton_components.length).toBe(9);
    expect(out.stream_endpoint).toBe('/api/swarm/site-sk/stream');
    expect(out.estimated_full_ready_ms).toBe(45_000);
  });

  it('tolerates a D1 write failure', async () => {
    const { env } = makeEnv({ runThrows: true });
    const out = await publishSkeleton(env, 's');
    expect(out.state).toBe('skeleton_live');
  });
});

// ─── getBuildStream ───────────────────────────────────────────────────────────

describe('getBuildStream', () => {
  it('returns unknown state with zero progress when no row exists', async () => {
    const { env } = makeEnv({ first: null });
    const out = await getBuildStream(env, 'site-n');
    expect(out.state).toBe('unknown');
    expect(out.components_done).toEqual([]);
    expect(out.progress_pct).toBe(0);
    expect(out.next_component).toBe('nav');
    expect(out.components_total).toBe(9);
    expect(out.last_component_emitted_at).toBeNull();
  });

  it('uses persisted components_done when present', async () => {
    const done = ['nav', 'hero', 'features'];
    const { env } = makeEnv({
      first: {
        state: 'building',
        components_done_json: JSON.stringify(done),
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    });
    const out = await getBuildStream(env, 'site-b');
    expect(out.state).toBe('building');
    expect(out.components_done).toEqual(done);
    expect(out.progress_pct).toBe(Math.round((3 / 9) * 100));
    expect(out.next_component).toBe('social-proof');
    expect(out.last_component_emitted_at).not.toBeNull();
  });

  it('simulates done-count from age when no persisted components', async () => {
    const started = new Date(Date.now() - 16_000).toISOString(); // 16s → floor(16/4)=4 done
    const { env } = makeEnv({
      first: {
        state: 'skeleton_live',
        components_done_json: JSON.stringify([]),
        started_at: started,
        updated_at: started,
      },
    });
    const out = await getBuildStream(env, 'site-s');
    expect(out.components_done.length).toBe(4);
    expect(out.components_remaining.length).toBe(5);
  });

  it('returns unknown state when the D1 read throws', async () => {
    const { env } = makeEnv({ firstThrows: true });
    const out = await getBuildStream(env, 'site-e');
    expect(out.state).toBe('unknown');
  });
});

// ─── buildProgressiveSseStream ────────────────────────────────────────────────

describe('buildProgressiveSseStream', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('emits skeleton_live immediately listing all components', async () => {
    const { env } = makeEnv();
    const stream = buildProgressiveSseStream(env, 'site-p');
    const reader = stream.getReader();
    const first = await reader.read();
    const payload = JSON.parse(new TextDecoder().decode(first.value).replace('data: ', '').trim());
    expect(payload.type).toBe('skeleton_live');
    expect(payload.site_id).toBe('site-p');
    expect(payload.components.length).toBe(9);
    await reader.cancel();
  });

  it('emits component_ready per tick then all_components_ready', async () => {
    const { env } = makeEnv();
    const stream = buildProgressiveSseStream(env, 'site-q');
    const reader = stream.getReader();
    const dec = new TextDecoder();
    const chunks: string[] = [];
    let r = await reader.read(); // skeleton_live
    if (r.value) chunks.push(dec.decode(r.value));
    for (let i = 0; i < 10; i++) {
      jest.advanceTimersByTime(4_000);
      r = await reader.read();
      if (r.done) break;
      if (r.value) chunks.push(dec.decode(r.value));
    }
    const joined = chunks.join('');
    expect(joined).toContain('"type":"component_ready"');
    expect(joined).toContain('"component":"nav"');
    expect(joined).toContain('"type":"all_components_ready"');
    // Cancel before returning: an abandoned `getReader()` never fires the stream's
    // `cancel()` hook, so the producer's `setInterval` keeps the Jest worker's event
    // loop alive — Jest then prints "a worker process has failed to exit gracefully".
    await reader.cancel();
  });

  it('clears its interval on cancel', async () => {
    const clearSpy = jest.spyOn(global, 'clearInterval');
    const { env } = makeEnv();
    const stream = buildProgressiveSseStream(env, 'site-r');
    const reader = stream.getReader();
    await reader.read();
    jest.advanceTimersByTime(4_000);
    await reader.cancel();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
