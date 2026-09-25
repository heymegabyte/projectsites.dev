/**
 * @file Contract tests for the CF-native per-instance provisioner (Payload stack).
 *
 * Proves the two guarantees the admin lifecycle depends on:
 *  1. provisionPayloadStack creates D1 → R2 → Worker (+ enables the workers.dev
 *     subdomain) and ROLLS BACK everything on any failure — never a partial stack.
 *  2. deprovisionPayloadStack deletes Worker → D1 → R2, RE-READS each, and only
 *     reports `clean:true` when all three are confirmed gone.
 *
 * `fetch` is mocked so these run offline + deterministically in CI — the live
 * launch→200→delete→zero-dangling cycle is separately proven against real CF by
 * `e2e/admin-verify/verify-payload-launcher.mjs`.
 */
import {
  CfProvisionError,
  deprovisionPayloadStack,
  provisionPayloadStack,
} from '../services/cloudflare_provisioner.js';
import type { Env } from '../types/env.js';

const ENV = {
  CF_ACCOUNT_ID: 'acct-test',
  CLOUDFLARE_API_KEY: 'k',
  CLOUDFLARE_EMAIL: 'e@x.com',
} as unknown as Env;

/** Route a mocked CF API call by method + path → {success, result}. */
type Handler = (method: string, url: string) => { status?: number; body: unknown };

function mockFetch(handler: Handler): void {
  (globalThis as unknown as { fetch: unknown }).fetch = ((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const { status = 200, body } = handler(method, url);
    return Promise.resolve({
      ok: status < 400,
      status,
      json: () => Promise.resolve(body),
    } as Response);
  }) as typeof fetch;
}

const okD1 = { success: true, result: { uuid: 'd1-123' } };
const okGeneric = { success: true, result: {} };
const okSubdomain = { success: true, result: { subdomain: 'manhattan' } };
const notFound = { success: false, errors: [{ code: 10000 }] };

describe('provisionPayloadStack', () => {
  it('creates D1 + R2 + Worker and returns the reachable workers.dev URL', async () => {
    mockFetch((method, url) => {
      if (url.includes('/d1/database') && method === 'POST') return { body: okD1 };
      if (url.includes('/r2/buckets') && method === 'POST') return { body: okGeneric };
      if (url.includes('/workers/scripts/') && method === 'PUT') return { body: okGeneric };
      if (url.endsWith('/workers/subdomain')) return { body: okSubdomain };
      if (url.includes('/subdomain') && method === 'POST') return { body: okGeneric };
      return { body: okGeneric };
    });
    const stack = await provisionPayloadStack(ENV, {
      instanceId: 'abcdef12-0000-0000-0000-000000000000',
      slug: 'acme',
      payloadSecret: 's',
    });
    expect(stack.d1DatabaseId).toBe('d1-123');
    expect(stack.workerName).toMatch(/^payload-acme-abcdef12$/);
    expect(stack.r2BucketName).toBe(stack.workerName);
    // Reachable URL uses the account subdomain we resolved.
    expect(stack.subdomain).toBe(`${stack.workerName}.manhattan.workers.dev`);
  });

  it('rolls back the D1 + R2 when the Worker deploy fails (no partial stack)', async () => {
    const deleted: string[] = [];
    mockFetch((method, url) => {
      if (url.includes('/d1/database') && method === 'POST') return { body: okD1 };
      if (url.includes('/r2/buckets') && method === 'POST') return { body: okGeneric };
      if (url.includes('/workers/scripts/') && method === 'PUT')
        return { status: 500, body: { success: false } };
      // teardown re-reads → 404 (confirmed gone)
      if (method === 'DELETE') {
        deleted.push(url);
        return { body: okGeneric };
      }
      if (url.includes('/d1/database/') || url.includes('/r2/buckets/')) return { body: notFound };
      return { body: okGeneric };
    });
    await expect(
      provisionPayloadStack(ENV, {
        instanceId: 'abcdef12-0000-0000-0000-000000000000',
        slug: 'acme',
        payloadSecret: 's',
      }),
    ).rejects.toBeInstanceOf(CfProvisionError);
    // Both the D1 and the R2 that were created got a DELETE during rollback.
    expect(deleted.some((u) => u.includes('/d1/database/'))).toBe(true);
    expect(deleted.some((u) => u.includes('/r2/buckets/'))).toBe(true);
  });

  it('throws NO_CREDENTIALS when neither token nor global key is set', async () => {
    mockFetch(() => ({ body: okGeneric }));
    await expect(
      provisionPayloadStack({ CF_ACCOUNT_ID: 'a' } as unknown as Env, {
        instanceId: 'x',
        slug: 'y',
        payloadSecret: 's',
      }),
    ).rejects.toMatchObject({ code: 'NO_CREDENTIALS' });
  });
});

describe('deprovisionPayloadStack', () => {
  it('reports clean:true only when Worker + D1 + R2 all re-read as gone', async () => {
    mockFetch((method, url) => {
      if (method === 'DELETE') return { body: okGeneric };
      // every GET re-read → 404 (gone)
      return { body: notFound };
    });
    const report = await deprovisionPayloadStack(ENV, {
      workerName: 'payload-acme-abcdef12',
      d1DatabaseId: 'd1-123',
      r2BucketName: 'payload-acme-abcdef12',
    });
    expect(report).toEqual({ worker: 'deleted', d1: 'deleted', r2: 'deleted', clean: true });
  });

  it('reports clean:false when a resource still exists after delete (straggler)', async () => {
    mockFetch((method, url) => {
      if (method === 'DELETE') return { body: { success: false } };
      // R2 re-read still SUCCEEDS (bucket remains); D1/worker gone.
      if (url.includes('/r2/buckets/')) return { body: { success: true, result: { name: 'x' } } };
      return { body: notFound };
    });
    const report = await deprovisionPayloadStack(ENV, {
      workerName: 'w',
      d1DatabaseId: 'd',
      r2BucketName: 'b',
    });
    expect(report.r2).toBe('error');
    expect(report.clean).toBe(false);
  });

  it('treats null ids as not_found (nothing to delete) and stays clean', async () => {
    mockFetch(() => ({ body: notFound }));
    const report = await deprovisionPayloadStack(ENV, {
      workerName: null,
      d1DatabaseId: null,
      r2BucketName: null,
    });
    expect(report).toEqual({ worker: 'not_found', d1: 'not_found', r2: 'not_found', clean: true });
  });
});
