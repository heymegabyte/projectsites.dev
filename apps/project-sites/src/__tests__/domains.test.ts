jest.mock('../services/db.js', () => ({
  dbQuery: jest.fn().mockResolvedValue({ data: [], error: null }),
  dbQueryOne: jest.fn().mockResolvedValue(null),
  dbInsert: jest.fn().mockResolvedValue({ error: null }),
  dbUpdate: jest.fn().mockResolvedValue({ error: null, changes: 1 }),
}));

import { dbQuery, dbQueryOne, dbInsert, dbUpdate } from '../services/db.js';
import {
  createCustomHostname,
  checkHostnameStatus,
  deleteCustomHostname,
  provisionFreeDomain,
  provisionCustomDomain,
  getSiteHostnames,
  getHostnameByDomain,
  verifyPendingHostnames,
  setPrimaryHostname,
  checkCnameTarget,
  getPrimaryHostname,
  parseCfCustomHostname,
} from '../services/domains.js';
import { AppError } from '@project-sites/shared';

const mockQuery = dbQuery as jest.MockedFunction<typeof dbQuery>;
const mockQueryOne = dbQueryOne as jest.MockedFunction<typeof dbQueryOne>;
const mockInsert = dbInsert as jest.MockedFunction<typeof dbInsert>;
const mockUpdate = dbUpdate as jest.MockedFunction<typeof dbUpdate>;

const mockEnv = {
  CF_API_TOKEN: 'test-cf-token',
  CF_ZONE_ID: 'test-zone-id',
} as any;

// D1 mock that captures atomic-batch statements. `prepare(sql).bind(...args)` returns a
// tagged descriptor; `batch([...])` records the descriptors so tests assert the primary
// swap ran in ONE all-or-nothing batch (setSolePrimary). `batch` is a jest.fn so a test
// can make it reject (simulating a mid-swap D1 failure → the op must NOT partial-write).
const mockDb = {
  prepare: (sql: string) => ({
    bind: (...args: unknown[]) => ({ sql, args }),
  }),
  batch: jest.fn(async (stmts: Array<{ sql: string; args: unknown[] }>) =>
    stmts.map(() => ({ success: true, meta: { changes: 1 } })),
  ),
} as unknown as D1Database;
const mockBatch = (mockDb as unknown as { batch: jest.Mock }).batch;

const originalFetch = global.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn();
});

afterEach(() => {
  global.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// createCustomHostname
// ---------------------------------------------------------------------------
describe('createCustomHostname', () => {
  it('returns cf_id, status, and ssl_status on success', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: { id: 'cf-host-123', status: 'pending', ssl: { status: 'pending_validation' } },
      }),
      text: async () => '',
    });

    const result = await createCustomHostname(mockEnv, 'app.example.com');

    expect(result).toEqual({
      cf_id: 'cf-host-123',
      status: 'pending',
      ssl_status: 'pending_validation',
    });
  });

  it('throws badRequest on CF API failure', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      json: async () => ({}),
      text: async () => 'Zone not found',
    });

    const err = await createCustomHostname(mockEnv, 'bad.example.com').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).message).toMatch(/Failed to create custom hostname/);
    expect((err as AppError).statusCode).toBe(400);
  });

  it('sends correct auth header and body', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: { id: 'cf-1', status: 'pending', ssl: { status: 'pending_validation' } },
      }),
      text: async () => '',
    });

    await createCustomHostname(mockEnv, 'test.example.com');

    expect(global.fetch).toHaveBeenCalledWith(
      `https://api.cloudflare.com/client/v4/zones/test-zone-id/custom_hostnames`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-cf-token',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          hostname: 'test.example.com',
          ssl: {
            method: 'http',
            type: 'dv',
            settings: { min_tls_version: '1.2' },
          },
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// checkHostnameStatus
// ---------------------------------------------------------------------------
describe('checkHostnameStatus', () => {
  it('returns status, ssl_status, and empty verification_errors', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: { status: 'active', ssl: { status: 'active' } },
      }),
      text: async () => '',
    });

    const result = await checkHostnameStatus(mockEnv, 'cf-host-123');

    expect(result).toEqual({
      status: 'active',
      ssl_status: 'active',
      verification_errors: [],
    });
  });

  it('returns verification_errors array when present', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: {
          status: 'pending',
          ssl: { status: 'pending_validation' },
          verification_errors: ['CNAME not found', 'DNS timeout'],
        },
      }),
      text: async () => '',
    });

    const result = await checkHostnameStatus(mockEnv, 'cf-host-456');

    expect(result.verification_errors).toEqual(['CNAME not found', 'DNS timeout']);
  });

  it('throws notFound when hostname not found', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => 'Not found',
    });

    const err = await checkHostnameStatus(mockEnv, 'cf-nonexistent').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).message).toMatch(/Custom hostname not found/);
    expect((err as AppError).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// deleteCustomHostname
// ---------------------------------------------------------------------------
describe('deleteCustomHostname', () => {
  it('succeeds with no return value', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: { id: 'cf-host-123' } }),
      text: async () => '',
    });

    const result = await deleteCustomHostname(mockEnv, 'cf-host-123');

    expect(result).toBeUndefined();
    expect(global.fetch).toHaveBeenCalledWith(
      `https://api.cloudflare.com/client/v4/zones/test-zone-id/custom_hostnames/cf-host-123`,
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-cf-token',
        }),
      }),
    );
  });

  it('ignores 404 errors', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => 'Not found',
    });

    await expect(deleteCustomHostname(mockEnv, 'cf-already-gone')).resolves.toBeUndefined();
  });

  it('throws on other errors', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => 'Internal Server Error',
    });

    const err = await deleteCustomHostname(mockEnv, 'cf-host-err').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).message).toMatch(/Failed to delete custom hostname/);
    expect((err as AppError).statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// provisionFreeDomain
// ---------------------------------------------------------------------------
describe('provisionFreeDomain', () => {
  it('returns hostname in format slug.projectsites.dev', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: { id: 'cf-free-1', status: 'pending', ssl: { status: 'pending_validation' } },
      }),
      text: async () => '',
    });

    mockInsert.mockResolvedValueOnce({ error: null });

    const result = await provisionFreeDomain(mockDb, mockEnv, {
      org_id: 'org-1',
      site_id: 'site-1',
      slug: 'my-app',
    });

    expect(result.hostname).toBe('my-app.projectsites.dev');
    expect(result.status).toBe('pending');
  });

  it('returns existing hostname if already exists', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'existing-id', status: 'active' });

    const result = await provisionFreeDomain(mockDb, mockEnv, {
      org_id: 'org-1',
      site_id: 'site-1',
      slug: 'existing-app',
    });

    expect(result).toEqual({
      hostname: 'existing-app.projectsites.dev',
      status: 'active',
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('creates new hostname when none exists', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: { id: 'cf-new-1', status: 'active', ssl: { status: 'active' } },
      }),
      text: async () => '',
    });

    mockInsert.mockResolvedValueOnce({ error: null });

    const result = await provisionFreeDomain(mockDb, mockEnv, {
      org_id: 'org-2',
      site_id: 'site-2',
      slug: 'new-app',
    });

    expect(result).toEqual({
      hostname: 'new-app.projectsites.dev',
      status: 'active',
    });

    // Verify CF API was called
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // Verify DB insert was called
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsert).toHaveBeenCalledWith(
      mockDb,
      'hostnames',
      expect.objectContaining({
        org_id: 'org-2',
        site_id: 'site-2',
        hostname: 'new-app.projectsites.dev',
        type: 'free_subdomain',
        status: 'active',
        cf_custom_hostname_id: 'cf-new-1',
      }),
    );
  });

  it('rolls back the CF hostname + THROWS when the D1 insert drops (no orphan, no lying-success)', async () => {
    mockQueryOne.mockResolvedValueOnce(null); // not already present
    // createCustomHostname → CF create OK (returns a cf_id)
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: { id: 'cf-orphan-1', status: 'pending', ssl: { status: 'pending_validation' } },
      }),
      text: async () => '',
    });
    // D1 tracking insert DROPS ({ error } — dbInsert never throws)
    mockInsert.mockResolvedValueOnce({ error: 'D1_ERROR: database is locked' });
    // compensating deleteCustomHostname → CF DELETE OK
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '',
    });

    await expect(
      provisionFreeDomain(mockDb, mockEnv, {
        org_id: 'org-1',
        site_id: 'site-1',
        slug: 'drop-app',
      }),
    ).rejects.toThrow(/failed to persist hostname/);

    // The CF hostname was created THEN deleted (compensated) — no orphan left behind.
    const calls = (global.fetch as jest.Mock).mock.calls;
    expect(calls.length).toBe(2);
    expect(String(calls[1][0])).toContain('custom_hostnames/cf-orphan-1');
    expect(calls[1][1]?.method).toBe('DELETE');
  });
});

// ---------------------------------------------------------------------------
// provisionCustomDomain
// ---------------------------------------------------------------------------
describe('provisionCustomDomain', () => {
  it('returns hostname, status, and is_primary on success', async () => {
    // Domain limit check
    mockQuery.mockResolvedValueOnce({ data: [], error: null });
    // Existing hostname check
    mockQueryOne.mockResolvedValueOnce(null);
    // Site custom domains check (auto-primary) — none exist
    mockQuery.mockResolvedValueOnce({ data: [], error: null });

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: { id: 'cf-custom-1', status: 'pending', ssl: { status: 'pending_validation' } },
      }),
      text: async () => '',
    });

    // DB insert
    mockInsert.mockResolvedValueOnce({ error: null });
    // Auto-primary: clear + set
    mockUpdate.mockResolvedValueOnce({ error: null, changes: 0 });
    mockUpdate.mockResolvedValueOnce({ error: null, changes: 1 });

    const result = await provisionCustomDomain(mockDb, mockEnv, {
      org_id: 'org-1',
      site_id: 'site-1',
      hostname: 'app.example.com',
    });

    expect(result).toEqual({
      hostname: 'app.example.com',
      status: 'pending',
      is_primary: true,
    });
  });

  it('rolls back the CF hostname, THROWS, and NEVER sets primary when the D1 insert drops', async () => {
    mockQuery.mockResolvedValueOnce({ data: [], error: null }); // domain-limit check
    mockQueryOne.mockResolvedValueOnce(null); // existing-hostname check
    mockQuery.mockResolvedValueOnce({ data: [], error: null }); // site custom domains → first
    // createCustomHostname → CF create OK
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: { id: 'cf-custom-drop', status: 'pending', ssl: { status: 'pending_validation' } },
      }),
      text: async () => '',
    });
    // D1 tracking insert DROPS
    mockInsert.mockResolvedValueOnce({ error: 'D1_ERROR: disk I/O error' });
    // compensating deleteCustomHostname → CF DELETE OK
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '',
    });

    await expect(
      provisionCustomDomain(mockDb, mockEnv, {
        org_id: 'org-1',
        site_id: 'site-1',
        hostname: 'drop.example.com',
      }),
    ).rejects.toThrow(/failed to persist hostname/);

    // setSolePrimary (db.batch) must NEVER run on a dropped insert — else the site is
    // left primary-less (every primary cleared, the new one set on a non-existent row).
    expect(mockBatch).not.toHaveBeenCalled();
    // The CF hostname was compensated (deleted), not orphaned.
    const calls = (global.fetch as jest.Mock).mock.calls;
    expect(calls.length).toBe(2);
    expect(calls[1][1]?.method).toBe('DELETE');
  });

  it('throws conflict when max domains reached', async () => {
    const tenDomains = Array.from({ length: 10 }, (_, i) => ({ id: `dom-${i}` }));
    mockQuery.mockResolvedValueOnce({ data: tenDomains, error: null });

    await expect(
      provisionCustomDomain(mockDb, mockEnv, {
        org_id: 'org-full',
        site_id: 'site-1',
        hostname: 'eleventh.example.com',
      }),
    ).rejects.toThrow(/Maximum custom domains/);
  });

  it('throws conflict when hostname already registered', async () => {
    // Domain limit check: under limit
    mockQuery.mockResolvedValueOnce({ data: [{ id: 'dom-1' }], error: null });
    // Existing hostname check: already taken
    mockQueryOne.mockResolvedValueOnce({ id: 'existing-host' });

    await expect(
      provisionCustomDomain(mockDb, mockEnv, {
        org_id: 'org-1',
        site_id: 'site-1',
        hostname: 'taken.example.com',
      }),
    ).rejects.toThrow(/already registered/);
  });

  it('creates CF hostname and DB record and auto-sets as primary', async () => {
    mockQuery.mockResolvedValueOnce({ data: [], error: null });
    mockQueryOne.mockResolvedValueOnce(null);
    // Site custom domains check — none exist (first custom domain)
    mockQuery.mockResolvedValueOnce({ data: [], error: null });

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: { id: 'cf-custom-2', status: 'active', ssl: { status: 'active' } },
      }),
      text: async () => '',
    });

    mockInsert.mockResolvedValueOnce({ error: null });
    // Auto-primary: clear + set
    mockUpdate.mockResolvedValueOnce({ error: null, changes: 0 });
    mockUpdate.mockResolvedValueOnce({ error: null, changes: 1 });

    const result = await provisionCustomDomain(mockDb, mockEnv, {
      org_id: 'org-3',
      site_id: 'site-3',
      hostname: 'custom.example.com',
    });

    expect(result.is_primary).toBe(true);

    // CF API called with hostname
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('custom_hostnames'),
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('custom.example.com'),
      }),
    );

    // DB insert with correct fields
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsert).toHaveBeenCalledWith(
      mockDb,
      'hostnames',
      expect.objectContaining({
        org_id: 'org-3',
        site_id: 'site-3',
        hostname: 'custom.example.com',
        type: 'custom_cname',
        status: 'active',
        cf_custom_hostname_id: 'cf-custom-2',
        ssl_status: 'active',
      }),
    );

    // Auto-primary runs as ONE atomic batch: clear all (is_primary = 0) then set one.
    expect(mockBatch).toHaveBeenCalledTimes(1);
    const stmts = mockBatch.mock.calls[0][0] as Array<{ sql: string; args: unknown[] }>;
    expect(stmts).toHaveLength(2);
    expect(stmts[0].sql).toContain('is_primary = 0');
    expect(stmts[0].args).toContain('site-3');
    expect(stmts[1].sql).toContain('is_primary = 1');
  });

  it('does NOT auto-set primary when site already has custom domains', async () => {
    mockQuery.mockResolvedValueOnce({ data: [], error: null });
    mockQueryOne.mockResolvedValueOnce(null);
    // Site already has custom domains
    mockQuery.mockResolvedValueOnce({
      data: [{ id: 'h-existing', type: 'custom_cname' }],
      error: null,
    });

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: { id: 'cf-custom-3', status: 'pending', ssl: { status: 'pending_validation' } },
      }),
      text: async () => '',
    });

    mockInsert.mockResolvedValueOnce({ error: null });

    const result = await provisionCustomDomain(mockDb, mockEnv, {
      org_id: 'org-1',
      site_id: 'site-1',
      hostname: 'second.example.com',
    });

    expect(result.is_primary).toBe(false);
    // Should NOT run the primary-swap batch when the site already has custom domains
    expect(mockBatch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getSiteHostnames
// ---------------------------------------------------------------------------
describe('getSiteHostnames', () => {
  it('returns array of hostnames', async () => {
    const hostnames = [
      {
        id: 'h1',
        hostname: 'app.projectsites.dev',
        type: 'free_subdomain',
        status: 'active',
        ssl_status: 'active',
      },
      {
        id: 'h2',
        hostname: 'custom.example.com',
        type: 'custom_cname',
        status: 'pending',
        ssl_status: 'pending_validation',
      },
    ];
    mockQuery.mockResolvedValueOnce({ data: hostnames, error: null });

    const result = await getSiteHostnames(mockDb, 'site-1');

    expect(result).toEqual(hostnames);
    expect(result).toHaveLength(2);
  });

  it('returns empty array when none found', async () => {
    mockQuery.mockResolvedValueOnce({ data: [], error: null });

    const result = await getSiteHostnames(mockDb, 'site-empty');

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getHostnameByDomain
// ---------------------------------------------------------------------------
describe('getHostnameByDomain', () => {
  it('returns hostname record when found', async () => {
    const record = {
      id: 'h1',
      site_id: 'site-1',
      org_id: 'org-1',
      type: 'custom_cname',
      status: 'active',
    };
    mockQueryOne.mockResolvedValueOnce(record);

    const result = await getHostnameByDomain(mockDb, 'custom.example.com');

    expect(result).toEqual(record);
  });

  it('returns null when not found', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    const result = await getHostnameByDomain(mockDb, 'nonexistent.example.com');

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// verifyPendingHostnames
// ---------------------------------------------------------------------------
describe('verifyPendingHostnames', () => {
  it('returns { verified: 1, failed: 0 } when hostname becomes active', async () => {
    mockQuery.mockResolvedValueOnce({
      data: [
        { id: 'h-pending', cf_custom_hostname_id: 'cf-pending-1', hostname: 'pending.example.com' },
      ],
      error: null,
    });

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: { status: 'active', ssl: { status: 'active' } },
      }),
      text: async () => '',
    });

    // PATCH update
    mockUpdate.mockResolvedValueOnce({ error: null, changes: 1 });

    const result = await verifyPendingHostnames(mockDb, mockEnv);

    expect(result).toEqual({ verified: 1, failed: 0 });

    // Verify dbUpdate was called with active status
    expect(mockUpdate).toHaveBeenCalledWith(
      mockDb,
      'hostnames',
      expect.objectContaining({
        status: 'active',
        ssl_status: 'active',
        verification_errors: null,
      }),
      'id = ?',
      ['h-pending'],
    );
  });

  it('returns { verified: 0, failed: 1 } when verification errors', async () => {
    mockQuery.mockResolvedValueOnce({
      data: [
        {
          id: 'h-fail',
          cf_custom_hostname_id: 'cf-fail-1',
          hostname: 'fail.example.com',
          // Old enough that the grace window has elapsed → a persistent error now fails.
          created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        },
      ],
      error: null,
    });

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: {
          status: 'pending',
          ssl: { status: 'pending_validation' },
          verification_errors: ['CNAME record missing'],
        },
      }),
      text: async () => '',
    });

    // PATCH update
    mockUpdate.mockResolvedValueOnce({ error: null, changes: 1 });

    const result = await verifyPendingHostnames(mockDb, mockEnv);

    expect(result).toEqual({ verified: 0, failed: 1 });

    expect(mockUpdate).toHaveBeenCalledWith(
      mockDb,
      'hostnames',
      expect.objectContaining({
        status: 'verification_failed',
        verification_errors: JSON.stringify(['CNAME record missing']),
      }),
      'id = ?',
      ['h-fail'],
    );
  });

  it('KEEPS a YOUNG hostname pending on verification errors (grace period — DNS still propagating)', async () => {
    // A freshly-created hostname returns verification_errors until the owner's DNS
    // (CNAME + DCV) propagates. Failing it immediately would strand it forever —
    // `verification_failed` is excluded from this sweep. Within the grace window it
    // must stay `pending` so the next sweep retries it and it self-heals.
    mockQuery.mockResolvedValueOnce({
      data: [
        {
          id: 'h-young',
          cf_custom_hostname_id: 'cf-young-1',
          hostname: 'young.example.com',
          created_at: new Date().toISOString(), // just created — inside the grace window
        },
      ],
      error: null,
    });
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: {
          status: 'pending',
          ssl: { status: 'pending_validation' },
          verification_errors: ['custom hostname does not CNAME to this zone yet'],
        },
      }),
      text: async () => '',
    });
    mockUpdate.mockResolvedValueOnce({ error: null, changes: 1 });

    const result = await verifyPendingHostnames(mockDb, mockEnv);

    // Not failed — kept pending for the next sweep to retry.
    expect(result).toEqual({ verified: 0, failed: 0 });
    expect(mockUpdate).toHaveBeenCalledWith(
      mockDb,
      'hostnames',
      expect.objectContaining({ status: 'pending' }),
      'id = ?',
      ['h-young'],
    );
  });

  it('returns { verified: 0, failed: 0 } when no pending hostnames', async () => {
    mockQuery.mockResolvedValueOnce({ data: [], error: null });

    const result = await verifyPendingHostnames(mockDb, mockEnv);

    expect(result).toEqual({ verified: 0, failed: 0 });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// setPrimaryHostname
// ---------------------------------------------------------------------------
describe('setPrimaryHostname', () => {
  it('clears all primaries then sets the chosen one in ONE atomic batch', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'h-123' });

    await setPrimaryHostname(mockDb, 'site-1', 'h-123');

    expect(mockQueryOne).toHaveBeenCalledWith(
      mockDb,
      expect.stringContaining('SELECT id FROM hostnames'),
      ['h-123', 'site-1'],
    );

    // The clear-all + set-one swap is a single all-or-nothing batch (no partial write).
    expect(mockBatch).toHaveBeenCalledTimes(1);
    const stmts = mockBatch.mock.calls[0][0] as Array<{ sql: string; args: unknown[] }>;
    expect(stmts).toHaveLength(2);
    expect(stmts[0].sql).toContain('is_primary = 0');
    expect(stmts[0].args).toContain('site-1');
    expect(stmts[1].sql).toContain('is_primary = 1');
    expect(stmts[1].args).toContain('h-123');
  });

  // Regression guard: the primary swap was two separate error-ignoring dbUpdate calls, so a
  // mid-swap D1 failure (clear committed, set failed) could leave the site with ZERO primary
  // hostnames — broken canonical-host resolution — with no error surfaced. The atomic batch
  // rejects (rolls back) so the failure is LOUD and no partial write lands.
  it('propagates a mid-swap failure (atomic — never a silent partial write)', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'h-123' });
    mockBatch.mockRejectedValueOnce(new Error('D1_ERROR: batch failed'));

    await expect(setPrimaryHostname(mockDb, 'site-1', 'h-123')).rejects.toThrow();
  });

  it('throws notFound if hostname does not belong to site', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    const err = await setPrimaryHostname(mockDb, 'site-1', 'h-missing').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(404);
    // notFound short-circuits BEFORE any write.
    expect(mockBatch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// checkCnameTarget
// ---------------------------------------------------------------------------
describe('checkCnameTarget', () => {
  it('returns CNAME target when record exists', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        Answer: [{ type: 5, data: 'projectsites.dev.' }],
      }),
    });

    const result = await checkCnameTarget('www.example.com');

    expect(result).toBe('projectsites.dev');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('cloudflare-dns.com/dns-query'),
      expect.objectContaining({
        headers: { accept: 'application/dns-json' },
      }),
    );
  });

  it('returns null when no CNAME record exists', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ Answer: [] }),
    });

    const result = await checkCnameTarget('www.example.com');

    expect(result).toBeNull();
  });

  it('returns null when DNS query fails', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
    });

    const result = await checkCnameTarget('www.example.com');

    expect(result).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));

    const result = await checkCnameTarget('www.example.com');

    expect(result).toBeNull();
  });

  it('strips trailing dot from CNAME data', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        Answer: [{ type: 5, data: 'target.example.com.' }],
      }),
    });

    const result = await checkCnameTarget('alias.example.com');

    expect(result).toBe('target.example.com');
  });
});

// ---------------------------------------------------------------------------
// getPrimaryHostname
// ---------------------------------------------------------------------------
describe('getPrimaryHostname', () => {
  it('returns primary hostname when one exists', async () => {
    mockQueryOne.mockResolvedValueOnce({ hostname: 'www.custom.com' });

    const result = await getPrimaryHostname(mockDb, 'site-1');

    expect(result).toBe('www.custom.com');
    expect(mockQueryOne).toHaveBeenCalledWith(
      mockDb,
      expect.stringContaining('ORDER BY COALESCE(is_primary, 0) DESC'),
      ['site-1'],
    );
  });

  it('returns null when no hostnames exist', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    const result = await getPrimaryHostname(mockDb, 'site-empty');

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseCfCustomHostname — Zod-validated CF-API boundary (vendor-risk-tiering)
// ---------------------------------------------------------------------------
describe('parseCfCustomHostname', () => {
  it('passes a well-formed CF response through unchanged', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const json = {
      result: {
        id: 'cf-host-abc',
        status: 'active',
        ssl: { status: 'active' },
        verification_errors: ['dns pending'],
      },
    };

    const out = parseCfCustomHostname(json, { fn: 'createCustomHostname', hostname: 'x.com' });

    expect(out.result.id).toBe('cf-host-abc');
    expect(out.result.status).toBe('active');
    expect(out.result.ssl?.status).toBe('active');
    expect(out.result.verification_errors).toEqual(['dns pending']);
    // A valid response must NOT emit a drift warn.
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('parses a minimal response (status only) — id/ssl/errors optional pre-SSL', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const out = parseCfCustomHostname(
      { result: { status: 'pending' } },
      { fn: 'checkHostnameStatus' },
    );

    expect(out.result.status).toBe('pending');
    expect(out.result.id).toBeUndefined();
    expect(out.result.ssl).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('fails SOFT on shape-drift — returns {status:"unknown"} fallback and logs a structured warn', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // result.status renamed/removed = genuine drift of the one required field.
    const drifted = { result: { id: 'cf-1', state: 'active' } };

    const out = parseCfCustomHostname(drifted, {
      fn: 'createCustomHostname',
      hostname: 'drift.com',
    });

    expect(out.result.status).toBe('unknown');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse((warnSpy.mock.calls[0] as unknown[])[0] as string);
    expect(logged.level).toBe('warn');
    expect(logged.service).toBe('domains');
    expect(logged.fn).toBe('createCustomHostname');
    expect(logged.hostname).toBe('drift.com');
    expect(Array.isArray(logged.issues)).toBe(true);
    warnSpy.mockRestore();
  });

  it('fails SOFT on a totally malformed body (no result key)', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const out = parseCfCustomHostname({ errors: ['boom'] }, { fn: 'checkHostnameStatus' });

    expect(out.result.status).toBe('unknown');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('fails SOFT on null / non-object JSON', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(parseCfCustomHostname(null, { fn: 'checkHostnameStatus' }).result.status).toBe(
      'unknown',
    );
    expect(parseCfCustomHostname('nope', { fn: 'checkHostnameStatus' }).result.status).toBe(
      'unknown',
    );
    expect(warnSpy).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });
});
