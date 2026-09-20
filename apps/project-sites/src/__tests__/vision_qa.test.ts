import { rubricToFindings, assertPublicHttpsUrl, type VisionScore } from '../routes/vision_qa';

const base: VisionScore = {
  layout: 8,
  typography: 8,
  color: 8,
  imagery: 8,
  whitespace: 8,
  distinctiveness: 8,
  overall: 8,
  notes: '',
  model: 'x',
};

describe('rubricToFindings', () => {
  it('returns no findings when every axis is 7+', () => {
    expect(rubricToFindings(base)).toEqual([]);
  });

  it('flags only axes scoring below 7, with a suggestion', () => {
    const r = rubricToFindings({ ...base, color: 4, whitespace: 6 });
    expect(r.map((f) => f.axis)).toEqual(['color', 'whitespace']); // worst-first
    expect(r[0].value).toBe(4);
    expect(r[0].suggestion.length).toBeGreaterThan(0);
  });

  it('orders findings worst-first', () => {
    const r = rubricToFindings({ ...base, layout: 5, color: 2, typography: 6 });
    expect(r.map((f) => f.value)).toEqual([2, 5, 6]);
  });

  it('ignores null axes (no real score)', () => {
    const r = rubricToFindings({ ...base, layout: null, color: null });
    expect(r).toEqual([]);
  });
});

describe('assertPublicHttpsUrl — vision-qa SSRF guard (AL-843)', () => {
  it('accepts a public https url (normalized)', () => {
    const r = assertPublicHttpsUrl('https://example.com/path');
    expect(r.ok).toBe(true);
    expect(r.url).toBe('https://example.com/path');
  });

  it('BLOCKS cloud-metadata + private/loopback/link-local hosts (the SSRF surface)', () => {
    for (const bad of [
      'https://169.254.169.254/latest/meta-data/', // AWS/GCP metadata
      'https://metadata.google.internal/', // GCP metadata name
      'https://127.0.0.1/admin', // loopback
      'https://localhost:8787/', // named loopback
      'https://10.0.0.5/', // RFC1918
      'https://192.168.1.1/', // RFC1918
      'https://172.16.4.4/', // RFC1918
      'https://[::1]/', // IPv6 loopback
    ]) {
      const r = assertPublicHttpsUrl(bad);
      expect(r.ok).toBe(false);
      expect(r.url).toBeNull();
    }
  });

  it('rejects non-https schemes (http / javascript / data) — vision-qa is https-only', () => {
    expect(assertPublicHttpsUrl('http://example.com').ok).toBe(false);
    expect(assertPublicHttpsUrl('javascript:alert(1)').ok).toBe(false);
    expect(assertPublicHttpsUrl('data:text/html,x').ok).toBe(false);
  });

  it('rejects empty / malformed input', () => {
    expect(assertPublicHttpsUrl('').ok).toBe(false);
    expect(assertPublicHttpsUrl('   ').ok).toBe(false);
    expect(assertPublicHttpsUrl('not a url').ok).toBe(false);
  });
});
