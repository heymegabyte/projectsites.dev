import {
  buildManifest,
  estimateZipSize,
  manifestToJsonl,
  type ExportAsset,
  type ExportManifest,
} from '../services/site_export.js';

/** Helper: a single file entry for buildManifest. */
function file(name: string, content: string): { name: string; content: string } {
  return { name, content };
}

/** Helper: build a manifest with known content for deterministic tests. */
function sampleManifest(over: Partial<ExportManifest> = {}): ExportManifest {
  const base = buildManifest('s1', 'my-site', [
    file('index.html', '<h1>Hello</h1>'),
    file('style.css', 'body { color: red; }'),
  ]);
  return { ...base, ...over };
}

/** Helper: UTF-8 byte length of a string. */
function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

describe('site_export', () => {
  // -------------------------------------------------------------------------
  // buildManifest
  // -------------------------------------------------------------------------
  describe('buildManifest', () => {
    it('builds a manifest from file entries', () => {
      const m = buildManifest('s1', 'my-site', [file('index.html', '<h1>Hello</h1>')]);

      expect(m.siteId).toBe('s1');
      expect(m.slug).toBe('my-site');
      expect(m.files).toHaveLength(1);
    });

    it('prepends / to path when missing', () => {
      const m = buildManifest('s1', 'my-site', [file('index.html', 'x')]);
      expect(m.files[0].path).toBe('/index.html');
    });

    it('preserves existing leading / on path', () => {
      const m = buildManifest('s1', 'my-site', [file('/index.html', 'x')]);
      expect(m.files[0].path).toBe('/index.html');
    });

    it('computes correct sizeBytes from UTF-8 content', () => {
      const content = '<h1>Hello</h1>';
      const m = buildManifest('s1', 'my-site', [file('page.html', content)]);
      expect(m.files[0].sizeBytes).toBe(utf8Bytes(content));
    });

    it('computes UTF-8 multi-byte characters correctly', () => {
      // emoji = 4 bytes in UTF-8
      const content = '\u{1F680}';
      const m = buildManifest('s1', 'my-site', [file('page.html', content)]);
      expect(m.files[0].sizeBytes).toBe(4);
    });

    it('correctly computes totalSize across multiple files', () => {
      const m = buildManifest('s1', 'my-site', [file('a.html', 'aaa'), file('b.html', 'bbbbb')]);
      expect(m.totalSize).toBe(3 + 5);
    });

    it('correctly computes fileCount', () => {
      const m = buildManifest('s1', 'my-site', [
        file('a.html', ''),
        file('b.html', ''),
        file('c.html', ''),
      ]);
      expect(m.fileCount).toBe(3);
    });

    it('handles empty files array', () => {
      const m = buildManifest('s1', 'my-site', []);
      expect(m.files).toEqual([]);
      expect(m.totalSize).toBe(0);
      expect(m.fileCount).toBe(0);
    });

    it('handles empty content string', () => {
      const m = buildManifest('s1', 'my-site', [file('empty.txt', '')]);
      expect(m.files[0].sizeBytes).toBe(0);
      expect(m.totalSize).toBe(0);
    });

    it('generates an ISO timestamp', () => {
      const m = buildManifest('s1', 'my-site', []);
      expect(m.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(() => new Date(m.exportedAt)).not.toThrow();
    });

    it('each call gets a fresh timestamp', () => {
      jest.useFakeTimers({ now: 1_717_000_000_000 });

      const m1 = buildManifest('s1', 'my-site', []);

      jest.setSystemTime(1_717_000_001_000); // 1 second later

      const m2 = buildManifest('s1', 'my-site', []);

      expect(m1.exportedAt).not.toBe(m2.exportedAt);
      expect(m2.exportedAt > m1.exportedAt).toBe(true);

      jest.useRealTimers();
    });

    it('each call returns a distinct object', () => {
      // Freeze time so both manifests stamp the SAME `exportedAt` — otherwise the two calls can straddle
      // a millisecond boundary on a slow CI runner and `toEqual` flakes on the differing timestamp.
      jest.useFakeTimers({ now: 1_717_000_000_000 });
      const m1 = buildManifest('s1', 'my-site', [file('a.txt', 'x')]);
      const m2 = buildManifest('s1', 'my-site', [file('a.txt', 'x')]);
      expect(m1).toEqual(m2);
      expect(m1).not.toBe(m2);
      jest.useRealTimers();
    });

    it('any file entry produces a valid ExportAsset', () => {
      const m = buildManifest('s1', 'my-site', [file('style.css', 'body{margin:0}')]);
      const asset = m.files[0];
      expect(asset.path).toBe('/style.css');
      expect(asset.content).toBe('body{margin:0}');
      expect(asset.sizeBytes).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // manifestToJsonl
  // -------------------------------------------------------------------------
  describe('manifestToJsonl', () => {
    it('first line is a header with _meta field', () => {
      const m = sampleManifest();
      const jsonl = manifestToJsonl(m);
      const first = JSON.parse(jsonl.split('\n')[0]);
      expect(first._meta).toBe('site-export-v1');
      expect(first.siteId).toBe('s1');
      expect(first.slug).toBe('my-site');
      expect(first.fileCount).toBe(2);
    });

    it('has one body line per file', () => {
      const m = sampleManifest();
      // 2 files → header + 2 body lines (trailing newline → split gives 4 entries)
      const lines = manifestToJsonl(m).trim().split('\n');
      // First line is header, remaining 2 are file entries
      expect(lines).toHaveLength(3);
    });

    it('each body line is a parseable JSON object with path, content, sizeBytes', () => {
      const m = sampleManifest();
      const lines = manifestToJsonl(m).trim().split('\n');

      for (let i = 1; i < lines.length; i++) {
        const entry = JSON.parse(lines[i]);
        expect(entry).toHaveProperty('path');
        expect(entry).toHaveProperty('content');
        expect(entry).toHaveProperty('sizeBytes');
      }
    });

    it('file order in JSONL matches manifest.files order', () => {
      const m = buildManifest('s1', 'my-site', [
        file('first.html', 'a'),
        file('second.html', 'bb'),
        file('third.html', 'ccc'),
      ]);
      const lines = manifestToJsonl(m).trim().split('\n');
      expect(JSON.parse(lines[1]).path).toBe('/first.html');
      expect(JSON.parse(lines[2]).path).toBe('/second.html');
      expect(JSON.parse(lines[3]).path).toBe('/third.html');
    });

    it('ends with a trailing newline', () => {
      const m = sampleManifest();
      const jsonl = manifestToJsonl(m);
      expect(jsonl.endsWith('\n')).toBe(true);
    });

    it('handles empty files array — header only', () => {
      const m = buildManifest('s1', 'my-site', []);
      const jsonl = manifestToJsonl(m);
      const lines = jsonl.trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]).fileCount).toBe(0);
    });

    it('body line content matches the source file content', () => {
      const m = buildManifest('s1', 'my-site', [file('hello.txt', 'world')]);
      const body = JSON.parse(manifestToJsonl(m).trim().split('\n')[1]);
      expect(body.content).toBe('world');
    });

    it('body line sizeBytes matches the source size', () => {
      const content = 'abc123';
      const m = buildManifest('s1', 'my-site', [file('data.txt', content)]);
      const body = JSON.parse(manifestToJsonl(m).trim().split('\n')[1]);
      expect(body.sizeBytes).toBe(utf8Bytes(content));
    });
  });

  // -------------------------------------------------------------------------
  // estimateZipSize
  // -------------------------------------------------------------------------
  describe('estimateZipSize', () => {
    it('returns 0 for an empty manifest', () => {
      const m = buildManifest('s1', 'my-site', []);
      expect(estimateZipSize(m)).toBe(0);
    });

    it('applies 0.33 compression ratio', () => {
      // 300 bytes → 300 * 0.33 = 99
      const m = buildManifest('s1', 'my-site', [file('a.txt', 'x'.repeat(300))]);
      expect(estimateZipSize(m)).toBe(99);
    });

    it('rounds to nearest integer', () => {
      // 10 bytes → 10 * 0.33 = 3.3 → 3
      const m = buildManifest('s1', 'my-site', [file('a.txt', '0123456789')]);
      expect(estimateZipSize(m)).toBe(3);
    });

    it('rounds up when fractional part >= 0.5', () => {
      // 100 bytes → 100 * 0.33 = 33.0 → 33 (exact)
      // 1 byte → 1 * 0.33 = 0.33 → 0 (rounds down)
      // 2 bytes → 2 * 0.33 = 0.66 → 1 (rounds up)
      const m = buildManifest('s1', 'my-site', [
        file('a.txt', 'ab'), // 2 bytes → 0.66
        file('b.txt', 'x'), // 1 byte → 0.33
      ]);
      // total = 3 * 0.33 = 0.99 → 1
      expect(estimateZipSize(m)).toBe(1);
    });

    it('scales linearly with content size', () => {
      const small = buildManifest('s1', 'my-site', [file('a.txt', 'x'.repeat(100))]);
      const large = buildManifest('s1', 'my-site', [file('a.txt', 'x'.repeat(1000))]);
      // 100 * 0.33 ≈ 33, 1000 * 0.33 ≈ 330
      expect(estimateZipSize(large)).toBe(estimateZipSize(small) * 10);
    });
  });

  // -------------------------------------------------------------------------
  // Cross-function: manifest consistency
  // -------------------------------------------------------------------------
  describe('manifest consistency', () => {
    it('manifestToJsonl header matches buildManifest fields', () => {
      const m = buildManifest('site_x', 'demo', [file('a.html', 'hello'), file('b.html', 'world')]);
      const header = JSON.parse(manifestToJsonl(m).split('\n')[0]);

      expect(header.siteId).toBe(m.siteId);
      expect(header.slug).toBe(m.slug);
      expect(header.exportedAt).toBe(m.exportedAt);
      expect(header.totalSize).toBe(m.totalSize);
      expect(header.fileCount).toBe(m.fileCount);
    });

    it('estimateZipSize uses buildManifest totalSize', () => {
      const m = buildManifest('s1', 'my-site', [
        file('a.txt', 'x'.repeat(100)),
        file('b.txt', 'y'.repeat(200)),
      ]);
      // totalSize = 300
      expect(m.totalSize).toBe(300);
      expect(estimateZipSize(m)).toBe(Math.round(300 * 0.33));
    });

    it('file count in JSONL header matches actual body lines', () => {
      const m = buildManifest('s1', 'my-site', [
        file('1.txt', 'a'),
        file('2.txt', 'b'),
        file('3.txt', 'c'),
      ]);
      const lines = manifestToJsonl(m).trim().split('\n');
      const header = JSON.parse(lines[0]);
      expect(header.fileCount).toBe(lines.length - 1);
    });
  });
});
