/**
 * Tests for the SSRF outbound-URL guard. Every case pins a real SSRF class: cloud-metadata, private
 * ranges, loopback (v4 + v6 + IPv4-mapped), link-local/ULA, non-http protocols, odd ports, internal
 * hostnames — plus the allow/deny-list behavior the per-hop re-validation relies on.
 */
import {
  assertPublicHttpUrl,
  isPublicHttpUrl,
  isPrivateOrReservedHost,
  SsrfError,
} from '../services/ssrf_guard.js';

const reason = (raw: string, policy = {}) => {
  try {
    assertPublicHttpUrl(raw, policy);
    return 'ALLOWED';
  } catch (e) {
    return e instanceof SsrfError ? e.code : 'OTHER';
  }
};

describe('isPrivateOrReservedHost', () => {
  it('blocks cloud metadata + private/loopback/link-local IPv4', () => {
    for (const h of [
      '169.254.169.254',
      '10.0.0.5',
      '127.0.0.1',
      '192.168.1.1',
      '172.16.0.1',
      '172.31.255.255',
      '0.0.0.0',
      '100.64.0.1',
    ]) {
      expect(isPrivateOrReservedHost(h)).toBe(true);
    }
  });
  it('allows public IPv4 and hosts just outside private ranges', () => {
    for (const h of [
      '8.8.8.8',
      '1.1.1.1',
      '172.15.0.1',
      '172.32.0.1',
      'example.com',
      'cdn.shopify.com',
    ]) {
      expect(isPrivateOrReservedHost(h)).toBe(false);
    }
  });
  it('blocks IPv6 loopback / link-local / ULA / IPv4-mapped-private', () => {
    for (const h of [
      '::1',
      '::',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isPrivateOrReservedHost(h)).toBe(true);
    }
  });
  it('blocks internal hostnames', () => {
    for (const h of [
      'localhost',
      'foo.localhost',
      'db.internal',
      'printer.local',
      'metadata.google.internal',
      'host.lan',
    ]) {
      expect(isPrivateOrReservedHost(h)).toBe(true);
    }
  });
});

describe('assertPublicHttpUrl: blocks the SSRF classes', () => {
  it('cloud metadata + private hosts → private_host', () => {
    expect(reason('http://169.254.169.254/latest/meta-data/')).toBe('private_host');
    expect(reason('http://10.0.0.5:6379')).toBe('private_host'); // private host wins before port
    expect(reason('https://localhost/admin')).toBe('private_host');
    expect(reason('http://[::1]/')).toBe('private_host');
  });
  it('non-http protocols → protocol_blocked', () => {
    for (const u of [
      'file:///etc/passwd',
      'ftp://example.com',
      'gopher://example.com',
      'data:text/html,x',
    ]) {
      expect(reason(u)).toBe('protocol_blocked');
    }
  });
  it('odd ports on a public host → port_blocked', () => {
    expect(reason('http://example.com:22')).toBe('port_blocked');
    expect(reason('http://example.com:6379')).toBe('port_blocked');
  });
  it('unparseable → invalid_url', () => {
    expect(reason('not a url')).toBe('invalid_url');
    expect(reason('')).toBe('invalid_url');
  });
});

describe('assertPublicHttpUrl: allows legitimate public fetches', () => {
  it('permits public http(s) on default ports', () => {
    expect(reason('https://example.com/logo.png')).toBe('ALLOWED');
    expect(reason('http://example.com')).toBe('ALLOWED');
    expect(reason('https://cdn.example.com:443/a.svg')).toBe('ALLOWED');
    expect(reason('https://8.8.8.8/')).toBe('ALLOWED');
  });
});

describe('assertPublicHttpUrl: allow/deny lists + escape hatch', () => {
  it('allowlist rejects non-listed hosts, accepts listed + subdomains', () => {
    const p = { hostAllowlist: ['example.com', 'shopify.com'] };
    expect(reason('https://evil.com', p)).toBe('host_not_allowlisted');
    expect(reason('https://example.com', p)).toBe('ALLOWED');
    expect(reason('https://cdn.example.com', p)).toBe('ALLOWED');
  });
  it('denylist blocks a host + its subdomains', () => {
    expect(reason('https://tracker.ads.com', { hostDenylist: ['ads.com'] })).toBe('host_denied');
  });
  it('allowPrivateHosts escape hatch permits loopback (tests/dev only)', () => {
    expect(
      reason('http://127.0.0.1:8787/health', {
        allowPrivateHosts: true,
        allowedPorts: ['', '80', '443', '8787'],
      }),
    ).toBe('ALLOWED');
  });
});

describe('isPublicHttpUrl wrapper', () => {
  it('mirrors assert as a boolean', () => {
    expect(isPublicHttpUrl('https://example.com')).toBe(true);
    expect(isPublicHttpUrl('http://169.254.169.254')).toBe(false);
    expect(isPublicHttpUrl('file:///x')).toBe(false);
  });
});
