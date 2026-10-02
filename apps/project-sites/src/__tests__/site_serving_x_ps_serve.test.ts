/**
 * Unit tests for the `x-ps-serve` observability marker on the R2 serving path
 * (fire-82). Canonical answer #2: WfP is the DEFAULT serve policy, verified by
 * `x-ps-serve: wfp`; R2 is the byte-identical fail-soft. The WfP dispatch branch
 * (`serveSiteViaWfpIfPreferred`) already stamps `x-ps-serve: wfp`
 * (see wfp_serve_preference.test.ts). The gap this closes: the R2 path
 * (`serveSiteFromR2`) emitted NO marker, so a prod-verify of "which path served"
 * was BLIND when the header was absent (e.g. lonemountainglobal.projectsites.dev
 * returned 200 with no `x-ps-serve`).
 *
 * Under test: `serveSiteFromR2` now stamps `x-ps-serve: r2` on EVERY branch it
 * returns — the main HTML 200, the soft-404 SPA shell, static assets, AND the
 * genuine not-found 404 fallback — so every published-site response names the
 * path that served it. R2 is the fail-soft, so a degraded WfP request that falls
 * back here is honestly reported as `r2`.
 *
 * Harness mirrors the `serveSiteFromR2` block in site_serving.test.ts
 * (createMockEnv + baseSite). swc-jest hoists `jest.mock` above imports ONLY when
 * it sees the GLOBAL `jest`; this file needs no module mocks (pure env stub).
 */

import { serveSiteFromR2 } from '../services/site_serving';
import type { Env } from '../types/env';

function createMockEnv(files: Record<string, string> = {}): Env {
  return {
    SITES_BUCKET: {
      get: jest.fn(async (key: string) => {
        const content = files[key];
        if (!content) return null;
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(content));
            controller.close();
          },
        });
        return {
          body: stream,
          text: async () => content,
          key,
          httpMetadata: { contentType: 'text/html' },
          size: content.length,
        };
      }),
    },
    CACHE_KV: {
      get: jest.fn(async () => null),
      put: jest.fn(async () => {}),
      delete: jest.fn(async () => {}),
    },
  } as unknown as Env;
}

const baseSite = {
  site_id: 'test-id',
  slug: 'my-biz',
  current_build_version: 'v1',
  plan: 'free',
};

describe('serveSiteFromR2 — x-ps-serve: r2 marker (fire-82)', () => {
  it('stamps x-ps-serve: r2 on the main HTML 200 response', async () => {
    const env = createMockEnv({
      'sites/my-biz/v1/index.html': '<html><body>Hello</body></html>',
    });

    const response = await serveSiteFromR2(env, baseSite, '/');

    expect(response.status).toBe(200);
    expect(response.headers.get('x-ps-serve')).toBe('r2');
  });

  it('stamps x-ps-serve: r2 on a static asset (CSS) response', async () => {
    const env = createMockEnv({
      'sites/my-biz/v1/style.css': 'body { color: red; }',
    });

    const response = await serveSiteFromR2(env, baseSite, '/style.css');

    expect(response.status).toBe(200);
    expect(response.headers.get('x-ps-serve')).toBe('r2');
  });

  // THE GAP: the not-found fallback branch. Before fire-82 this 404 carried no
  // `x-ps-serve`, so the prod-verify couldn't tell R2 served it (vs the request
  // never reaching the worker). The marker must be present on the fallback too.
  it('stamps x-ps-serve: r2 on the not-found (404) fallback branch', async () => {
    const env = createMockEnv({}); // nothing in R2 → genuine not-found

    const response = await serveSiteFromR2(env, baseSite, '/missing.txt');

    expect(response.status).toBe(404);
    expect(response.headers.get('x-ps-serve')).toBe('r2');
  });

  // Consistency with the WfP marker: both paths now answer the same question.
  // `wfp` is set by serveSiteViaWfpIfPreferred; `r2` is set here. A response that
  // comes through R2 must NEVER claim wfp.
  it('never claims x-ps-serve: wfp on an R2-served response', async () => {
    const env = createMockEnv({
      'sites/my-biz/v1/index.html': '<html><body>Hello</body></html>',
    });

    const response = await serveSiteFromR2(env, baseSite, '/');

    expect(response.headers.get('x-ps-serve')).not.toBe('wfp');
    expect(response.headers.get('x-ps-serve')).toBe('r2');
  });
});
