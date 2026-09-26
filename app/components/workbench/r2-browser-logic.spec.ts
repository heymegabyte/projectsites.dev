/**
 * @file Unit tests for the pure R2 Browser helpers — byte formatting, relative upload time, and the
 * previewable-content-type predicate. Pure logic; no DOM / module mocking.
 */
import { describe, it, expect } from 'vitest';

import {
  formatBytes,
  formatUploaded,
  isPreviewableContentType,
  r2ParentPrefix,
  r2PrefixLabel,
} from './r2-browser-logic';

describe('formatBytes', () => {
  it('renders 0 / negative / non-finite as "0 B"', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B');
  });
  it('renders bytes as whole numbers', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });
  it('scales to KB/MB/GB/TB with one decimal', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5_242_880)).toBe('5.0 MB');
    expect(formatBytes(1_181_116_006)).toBe('1.1 GB');
    expect(formatBytes(2_529_403_698_115)).toBe('2.3 TB');
  });
});

describe('formatUploaded', () => {
  const now = Date.parse('2023-11-14T22:00:00Z');
  it('returns "—" for null or unparseable input', () => {
    expect(formatUploaded(null, now)).toBe('—');
    expect(formatUploaded('not-a-date', now)).toBe('—');
  });
  it('buckets recent times', () => {
    expect(formatUploaded('2023-11-14T21:59:30Z', now)).toBe('just now'); // 30s
    expect(formatUploaded('2023-11-14T21:55:00Z', now)).toBe('5m ago');
    expect(formatUploaded('2023-11-14T19:00:00Z', now)).toBe('3h ago');
    expect(formatUploaded('2023-11-12T22:00:00Z', now)).toBe('2d ago');
  });
  it('treats a future timestamp as just now (no negative age)', () => {
    expect(formatUploaded('2023-11-14T22:05:00Z', now)).toBe('just now');
  });
});

describe('isPreviewableContentType', () => {
  it('is true for image, text, and application/json', () => {
    expect(isPreviewableContentType('image/png')).toBe(true);
    expect(isPreviewableContentType('text/html; charset=utf-8')).toBe(true);
    expect(isPreviewableContentType('application/json')).toBe(true);
    expect(isPreviewableContentType('IMAGE/JPEG')).toBe(true); // case-insensitive
  });
  it('is false for other types + null', () => {
    expect(isPreviewableContentType('application/pdf')).toBe(false);
    expect(isPreviewableContentType('application/octet-stream')).toBe(false);
    expect(isPreviewableContentType(null)).toBe(false);
  });
});

describe('r2ParentPrefix (folder "up" navigation)', () => {
  it('drops the last delimited segment', () => {
    expect(r2ParentPrefix('logs/2026/01/')).toBe('logs/2026/');
    expect(r2ParentPrefix('logs/2026/')).toBe('logs/');
  });

  it('a top-level prefix goes to the root ("")', () => {
    expect(r2ParentPrefix('logs/')).toBe('');
    expect(r2ParentPrefix('')).toBe('');
  });

  it('handles a prefix without a trailing delimiter', () => {
    expect(r2ParentPrefix('logs/2026')).toBe('logs/');
    expect(r2ParentPrefix('logs')).toBe('');
  });
});

describe('r2PrefixLabel (folder display name relative to the current prefix)', () => {
  it('shows only the segment after the current prefix', () => {
    expect(r2PrefixLabel('logs/2026/', 'logs/')).toBe('2026/');
    expect(r2PrefixLabel('images/', '')).toBe('images/');
  });

  it('falls back to the full prefix when it does not start with the current one', () => {
    expect(r2PrefixLabel('other/', 'logs/')).toBe('other/');
  });
});
