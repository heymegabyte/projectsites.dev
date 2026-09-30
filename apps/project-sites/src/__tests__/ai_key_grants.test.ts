/**
 * ai_key_grants — durable GrantRecord storage attached to `api_tokens` rows
 * (campaign lane-3, CAMPAIGN-cf-native-ai §5: grants reference CONCRETE ids).
 *
 * The service persists an immutable mint-time SNAPSHOT (sites / connections /
 * actions / models / limits / approval policy / expiry) as Zod-validated
 * `grant_json` in `ai_api_key_grants` (migration 0649), one row per token
 * (`token_id` UNIQUE). Shapes come from `@project-sites/shared` ai-policy
 * (`GrantRecordSchema`) — NEVER redefined here.
 *
 * Contract locked by this suite:
 *   1. put (create) — constructs the full GrantRecord server-side: UUIDv7 id,
 *      `api_key` principal with refId = token id, revision 1; the stored
 *      grant_json round-trips `GrantRecordSchema` exactly.
 *   2. put (update) — revision bumps (authoritative-revision guarantee for
 *      `effectiveAllow`'s live_state leg), org-scoped UPDATE, deleted_at
 *      cleared; grant_json revision matches the column.
 *   3. validation — invalid input / unknown keys / wildcard ids throw
 *      (ZodError) BEFORE any DB write; cross-org update throws 403 AppError.
 *   4. get — parse+validate on read; absent → null; corrupt or
 *      schema-drifted stored JSON → null (fail CLOSED, never a mangled grant).
 *   5. revoke — sets revokedAt + bumps revision (org-scoped); an unparseable
 *      row is soft-deleted (fail closed) rather than left authorizing.
 *   6. list — org-scoped, skips invalid rows instead of failing the surface.
 *
 * ts-jest/@swc-jest: GLOBAL `jest`; D1 prepare→bind→(run|first|all) chain
 * mocked (same harness as api_tokens.test.ts) — no real DB, real Zod.
 */
import { GrantRecordSchema, AppError } from '@project-sites/shared';

import {
  putGrantForToken,
  getGrantForToken,
  revokeGrant,
  listGrantsForOrg,
  summarizeGrant,
  GrantInputSchema,
  type GrantInput,
} from '../services/ai_key_grants.js';

// ─── D1 prepare→bind→(run|first|all) chain mock ──────────────────

interface PreparedCall {
  sql: string;
  args: unknown[];
}

let preparedCalls: PreparedCall[];
let runResults: unknown[];
let firstResults: unknown[];
let allResults: unknown[];

function makeDb(): D1Database {
  const prepare = jest.fn((sql: string) => {
    const bind = jest.fn((...args: unknown[]) => {
      preparedCalls.push({ sql, args });
      return {
        run: jest.fn(async () => {
          const r = runResults.shift();
          if (r instanceof Error) throw r;
          return r ?? { meta: { changes: 1 } };
        }),
        first: jest.fn(async () => {
          const r = firstResults.shift();
          if (r instanceof Error) throw r;
          return r ?? null;
        }),
        all: jest.fn(async () => {
          const r = allResults.shift();
          if (r instanceof Error) throw r;
          return r ?? { results: [] };
        }),
      };
    });
    return { bind };
  });
  return { prepare } as unknown as D1Database;
}

beforeEach(() => {
  preparedCalls = [];
  runResults = [];
  firstResults = [];
  allResults = [];
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** A valid mint-time grant input — CONCRETE ids only, per campaign §5. */
function validInput(): GrantInput {
  return GrantInputSchema.parse({
    siteIds: ['site-aaa', 'site-bbb'],
    connectionIds: ['conn-notion-1'],
    actionIds: ['workers_ai.text.generate', 'projectsites.site.read'],
    modelIds: ['@cf/meta/llama-3.3-70b-instruct-fp8-fast'],
    limits: { spendCents: 5000, rpm: 60 },
    approvalPolicy: 'follow_capability',
    expiresAt: '2027-01-01T00:00:00Z',
  });
}

/** A full stored GrantRecord as the service would persist it. */
function storedRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '01920000-0000-7000-8000-000000000001',
    principal: { kind: 'api_key', refId: 'tok-1' },
    orgId: 'org-1',
    siteIds: ['site-aaa'],
    connectionIds: [],
    actionIds: ['workers_ai.text.generate'],
    modelIds: [],
    limits: {},
    approvalPolicy: 'follow_capability',
    revision: 1,
    expiresAt: '2027-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('putGrantForToken — create', () => {
  it('inserts a revision-1 grant whose grant_json round-trips GrantRecordSchema', async () => {
    const db = makeDb();
    firstResults.push(null); // no existing row for this token

    const record = await putGrantForToken(db, 'tok-1', 'org-1', validInput());

    const insert = preparedCalls.find((c) => c.sql.includes('INSERT INTO ai_api_key_grants'));
    expect(insert).toBeDefined();
    // Bound order: id, token_id, org_id, grant_json, revision, created_at, updated_at
    expect(insert!.args[1]).toBe('tok-1');
    expect(insert!.args[2]).toBe('org-1');
    const stored = GrantRecordSchema.parse(JSON.parse(String(insert!.args[3])));
    expect(stored).toEqual(record);
    expect(stored.revision).toBe(1);
    expect(insert!.args[4]).toBe(1); // revision column mirrors the json
    expect(stored.principal).toEqual({ kind: 'api_key', refId: 'tok-1' });
    expect(stored.orgId).toBe('org-1');
    expect(stored.siteIds).toEqual(['site-aaa', 'site-bbb']);
  });

  it('mints a UUIDv7 id (version nibble 7) for the grant record', async () => {
    const db = makeDb();
    firstResults.push(null);
    const record = await putGrantForToken(db, 'tok-1', 'org-1', validInput());
    expect(record.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('applies schema defaults when limits/approvalPolicy are omitted', async () => {
    const db = makeDb();
    firstResults.push(null);
    const record = await putGrantForToken(
      db,
      'tok-1',
      'org-1',
      GrantInputSchema.parse({
        siteIds: [],
        connectionIds: [],
        actionIds: ['projectsites.site.read'],
        modelIds: [],
        expiresAt: '2027-06-01T00:00:00Z',
      }),
    );
    expect(record.limits).toEqual({});
    expect(record.approvalPolicy).toBe('follow_capability');
  });
});

describe('putGrantForToken — update', () => {
  it('bumps the revision (authoritative-revision guarantee) and clears deleted_at', async () => {
    const db = makeDb();
    firstResults.push({ id: 'grant-existing', org_id: 'org-1', revision: 3 });

    const record = await putGrantForToken(db, 'tok-1', 'org-1', validInput());

    expect(record.revision).toBe(4);
    expect(record.id).toBe('grant-existing'); // stable grant id across edits
    const update = preparedCalls.find((c) => c.sql.includes('UPDATE ai_api_key_grants'));
    expect(update).toBeDefined();
    expect(update!.sql).toContain('deleted_at = NULL');
    expect(update!.sql).toContain('org_id = ?');
    const stored = GrantRecordSchema.parse(JSON.parse(String(update!.args[0])));
    expect(stored.revision).toBe(4);
    expect(update!.args[1]).toBe(4); // revision column stays in lockstep
  });

  it('throws 403 (never writes) when the token belongs to another org', async () => {
    const db = makeDb();
    firstResults.push({ id: 'grant-existing', org_id: 'org-OTHER', revision: 1 });

    await expect(putGrantForToken(db, 'tok-1', 'org-1', validInput())).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(preparedCalls.some((c) => c.sql.includes('UPDATE ai_api_key_grants'))).toBe(false);
    expect(preparedCalls.some((c) => c.sql.includes('INSERT INTO ai_api_key_grants'))).toBe(false);
  });
});

describe('putGrantForToken — validation (fail closed BEFORE any write)', () => {
  it('rejects a structurally invalid grant input', async () => {
    const db = makeDb();
    await expect(
      putGrantForToken(db, 'tok-1', 'org-1', {
        siteIds: 'not-an-array',
      } as unknown as GrantInput),
    ).rejects.toThrow();
    expect(preparedCalls).toHaveLength(0);
  });

  it('rejects unknown keys (.strict() — no smuggled fields)', () => {
    const parsed = GrantInputSchema.safeParse({ ...validInput(), sneaky: true });
    expect(parsed.success).toBe(false);
  });

  it('rejects wildcard ids (grants hold CONCRETE ids only)', () => {
    const parsed = GrantInputSchema.safeParse({ ...validInput(), siteIds: ['*'] });
    expect(parsed.success).toBe(false);
  });

  it('rejects a malformed capability action id', () => {
    const parsed = GrantInputSchema.safeParse({ ...validInput(), actionIds: ['not-dotted'] });
    expect(parsed.success).toBe(false);
  });

  it('requires an expiry (no perpetual credentials)', () => {
    const { expiresAt: _drop, ...rest } = validInput();
    const parsed = GrantInputSchema.safeParse(rest);
    expect(parsed.success).toBe(false);
  });
});

describe('getGrantForToken — parse+validate on read', () => {
  it('returns null when no grant row exists', async () => {
    const db = makeDb();
    firstResults.push(null);
    expect(await getGrantForToken(db, 'tok-1')).toBeNull();
  });

  it('returns the parsed GrantRecord for a valid row', async () => {
    const db = makeDb();
    firstResults.push({ grant_json: JSON.stringify(storedRecord()) });
    const grant = await getGrantForToken(db, 'tok-1');
    expect(grant).not.toBeNull();
    expect(grant!.principal.refId).toBe('tok-1');
    expect(GrantRecordSchema.parse(grant)).toEqual(grant);
  });

  it('fails CLOSED (null) on corrupt stored JSON', async () => {
    const db = makeDb();
    firstResults.push({ grant_json: '{not json' });
    expect(await getGrantForToken(db, 'tok-1')).toBeNull();
  });

  it('fails CLOSED (null) on schema-drifted stored JSON', async () => {
    const db = makeDb();
    firstResults.push({ grant_json: JSON.stringify({ hello: 'world' }) });
    expect(await getGrantForToken(db, 'tok-1')).toBeNull();
  });
});

describe('revokeGrant', () => {
  it('returns false when the org has no grant for the token', async () => {
    const db = makeDb();
    firstResults.push(null);
    expect(await revokeGrant(db, 'org-1', 'tok-1')).toBe(false);
  });

  it('sets revokedAt + bumps the revision on the stored record', async () => {
    const db = makeDb();
    firstResults.push({
      id: 'grant-1',
      grant_json: JSON.stringify(storedRecord({ revision: 2 })),
      revision: 2,
    });

    expect(await revokeGrant(db, 'org-1', 'tok-1')).toBe(true);

    const update = preparedCalls.find((c) => c.sql.includes('UPDATE ai_api_key_grants'));
    expect(update).toBeDefined();
    const stored = GrantRecordSchema.parse(JSON.parse(String(update!.args[0])));
    expect(stored.revokedAt).toBeDefined();
    expect(stored.revision).toBe(3);
  });

  it('soft-deletes an unparseable row (fail closed) and reports true', async () => {
    const db = makeDb();
    firstResults.push({ id: 'grant-1', grant_json: '{broken', revision: 1 });

    expect(await revokeGrant(db, 'org-1', 'tok-1')).toBe(true);

    const update = preparedCalls.find((c) => c.sql.includes('UPDATE ai_api_key_grants'));
    expect(update).toBeDefined();
    expect(update!.sql).toContain('deleted_at');
  });
});

describe('listGrantsForOrg', () => {
  it('maps valid rows and skips invalid ones instead of failing the surface', async () => {
    const db = makeDb();
    allResults.push({
      results: [
        { token_id: 'tok-1', grant_json: JSON.stringify(storedRecord()) },
        { token_id: 'tok-bad', grant_json: '{corrupt' },
        {
          token_id: 'tok-2',
          grant_json: JSON.stringify(
            storedRecord({ principal: { kind: 'api_key', refId: 'tok-2' }, revision: 5 }),
          ),
        },
      ],
    });

    const grants = await listGrantsForOrg(db, 'org-1');
    expect(grants.map((g) => g.tokenId)).toEqual(['tok-1', 'tok-2']);
    expect(grants[1].grant.revision).toBe(5);
    const list = preparedCalls.find((c) => c.sql.includes('FROM ai_api_key_grants'));
    expect(list!.sql).toContain('org_id = ?');
    expect(list!.sql).toContain('deleted_at IS NULL');
  });
});

describe('summarizeGrant — counts, never the full snapshot', () => {
  it('reports counts + lifecycle fields without leaking the id arrays', () => {
    const grant = GrantRecordSchema.parse(
      storedRecord({
        siteIds: ['s1', 's2', 's3'],
        connectionIds: ['c1'],
        actionIds: ['a.b.c', 'd.e.f'],
        modelIds: ['m1'],
        revision: 7,
        revokedAt: '2026-10-01T00:00:00Z',
      }),
    );
    const summary = summarizeGrant(grant);
    expect(summary).toEqual({
      siteCount: 3,
      connectionCount: 1,
      actionCount: 2,
      modelCount: 1,
      approvalPolicy: 'follow_capability',
      revision: 7,
      expiresAt: '2027-01-01T00:00:00Z',
      revokedAt: '2026-10-01T00:00:00Z',
    });
    expect(JSON.stringify(summary)).not.toContain('s1');
  });
});

describe('shared-layer integrity', () => {
  it('AppError from @project-sites/shared is what cross-org put throws (403 envelope)', async () => {
    const db = makeDb();
    firstResults.push({ id: 'g', org_id: 'org-2', revision: 1 });
    const err = await putGrantForToken(db, 'tok-1', 'org-1', validInput()).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
  });
});
