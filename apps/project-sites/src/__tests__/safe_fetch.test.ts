/**
 * Tests for the SSRF-safe fetch wrapper. The headline case is the redirect-bypass: a public URL that
 * 302s to an internal host MUST be blocked AT THE HOP (not followed) — the exact lesson from
 * [[ssrf-redirect-follow-bypasses-host-allowlist-revalidate-every-hop]]. Fetch is injected so the
 * redirect chain is deterministic and no real network is touched.
 */
import { safeFetch, SafeFetchError } from '../services/safe_fetch.js';
import { SsrfError } from '../services/ssrf_guard.js';

/** Minimal response stub the wrapper inspects. */
const mkRes = (status: number, location?: string) => ({
  status,
  headers: { get: (k: string) => (k.toLowerCase() === 'location' ? location ?? null : null) },
});

/** Build an injectable fetch that returns queued responses and records the URLs + init it saw. */
function scriptedFetch(steps: Array<ReturnType<typeof mkRes>>) {
  const calls: Array<{ url: string; redirect: unknown }> = [];
  let i = 0;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, redirect: init?.redirect });
    return steps[Math.min(i++, steps.length - 1)];
  };
  return { fetchImpl, calls };
}

describe('safeFetch: pre-flight validation', () => {
  it('throws SsrfError BEFORE any fetch when the initial URL is private', async () => {
    const { fetchImpl, calls } = scriptedFetch([mkRes(200)]);
    await expect(safeFetch('http://169.254.169.254/latest/meta-data/', { fetchImpl })).rejects.toBeInstanceOf(SsrfError);
    expect(calls).toHaveLength(0); // never touched the network
  });
  it('throws SsrfError for a non-http protocol up front', async () => {
    const { fetchImpl } = scriptedFetch([mkRes(200)]);
    await expect(safeFetch('file:///etc/passwd', { fetchImpl })).rejects.toBeInstanceOf(SsrfError);
  });
});

describe('safeFetch: manual redirect handling', () => {
  it('returns a direct 200 and always fetches with redirect:manual', async () => {
    const { fetchImpl, calls } = scriptedFetch([mkRes(200)]);
    const res = await safeFetch('https://example.com/logo.png', { fetchImpl });
    expect(res.status).toBe(200);
    expect(calls[0].redirect).toBe('manual');
  });
  it('follows a safe redirect to another PUBLIC host', async () => {
    const { fetchImpl, calls } = scriptedFetch([mkRes(302, 'https://cdn.example.com/final.png'), mkRes(200)]);
    const res = await safeFetch('https://example.com/logo', { fetchImpl });
    expect(res.status).toBe(200);
    expect(calls[1].url).toBe('https://cdn.example.com/final.png');
  });
  it('BLOCKS a redirect to an internal host at the hop (the SSRF-bypass fix)', async () => {
    const { fetchImpl, calls } = scriptedFetch([mkRes(302, 'http://169.254.169.254/'), mkRes(200)]);
    await expect(safeFetch('https://example.com/logo', { fetchImpl })).rejects.toBeInstanceOf(SsrfError);
    expect(calls).toHaveLength(1); // fetched hop-0, refused to fetch the internal redirect
  });
  it('resolves a relative Location against the current URL and re-validates it', async () => {
    const { fetchImpl, calls } = scriptedFetch([mkRes(301, '/moved/final.png'), mkRes(200)]);
    const res = await safeFetch('https://example.com/logo', { fetchImpl });
    expect(res.status).toBe(200);
    expect(calls[1].url).toBe('https://example.com/moved/final.png');
  });
  it('throws SafeFetchError when the redirect chain exceeds the cap', async () => {
    const { fetchImpl } = scriptedFetch([mkRes(302, 'https://a.example.com/next')]); // always redirects
    await expect(safeFetch('https://example.com/loop', { fetchImpl, maxRedirects: 3 })).rejects.toBeInstanceOf(SafeFetchError);
  });
  it('hands back a redirect with no Location rather than guessing', async () => {
    const { fetchImpl } = scriptedFetch([mkRes(302, undefined)]);
    const res = await safeFetch('https://example.com/x', { fetchImpl });
    expect(res.status).toBe(302);
  });
});
