/**
 * @file Unit tests for the pure D1 Overview helpers — byte/count formatting (null → "—", never a
 * fabricated 0) and database labelling.
 */
import { describe, it, expect } from 'vitest';

import { classifyExportResponse, dbLabel, formatBytes, formatCount } from './d1-browser-logic';

describe('formatBytes', () => {
  it('scales bytes → B/KB/MB/GB (binary)', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(33_067_008)).toBe('31.5 MB');
    expect(formatBytes(2 * 1024 ** 3)).toBe('2 GB');
  });
  it('renders unavailable (null / undefined / non-finite / negative) as "—"', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(-5)).toBe('—');
  });
});

describe('formatCount', () => {
  it('formats integers with thousands separators; real 0 stays 0', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(42)).toBe('42');
    expect(formatCount(1024)).toBe('1,024');
  });
  it('renders unavailable (null / undefined / non-finite) as "—"', () => {
    expect(formatCount(null)).toBe('—');
    expect(formatCount(undefined)).toBe('—');
    expect(formatCount(Number.NaN)).toBe('—');
  });
});

describe('dbLabel', () => {
  it('shows the name, falling back to the id when blank', () => {
    expect(dbLabel({ id: 'ea3e', name: 'prod-db' })).toBe('prod-db');
    expect(dbLabel({ id: 'ea3e', name: '   ' })).toBe('ea3e');
    expect(dbLabel({ id: 'ea3e', name: '' })).toBe('ea3e');
  });
});

describe('classifyExportResponse (the export poll-loop decision core)', () => {
  it('done — only when complete AND a signedUrl is present', () => {
    const action = classifyExportResponse({
      ok: true,
      data: { status: 'complete', signedUrl: 'https://cf/dump.sql', filename: 'db.sql', note: '' },
    });
    expect(action.kind).toBe('done');
    expect(action.kind === 'done' && action.data.signedUrl).toBe('https://cf/dump.sql');
  });

  it('NEVER done on a complete WITHOUT a signedUrl (no fabricated download)', () => {
    const action = classifyExportResponse({ ok: true, data: { status: 'complete', note: '' } });
    expect(action.kind).toBe('error');
  });

  it('processing — carries the resume bookmark', () => {
    const action = classifyExportResponse({
      ok: true,
      data: { status: 'processing', bookmark: 'bm-1', note: '' },
    });
    expect(action).toEqual({ kind: 'processing', bookmark: 'bm-1' });
  });

  it('error — surfaces the CF reason; unavailable → honest message', () => {
    expect(classifyExportResponse({ ok: true, data: { status: 'error', reason: 'boom', note: '' } })).toEqual({
      kind: 'error',
      message: 'boom',
    });
    expect(classifyExportResponse({ ok: true, data: { status: 'unavailable', note: '' } })).toEqual({
      kind: 'error',
      message: 'D1 not available',
    });
  });

  it('error — a failed/shapeless bridge response (timeout, no status) never masquerades as success', () => {
    expect(classifyExportResponse({ ok: false, error: 'Request timed out' })).toEqual({
      kind: 'error',
      message: 'Request timed out',
    });
    expect(classifyExportResponse({ ok: true, data: { anything: 1 } as never }).kind).toBe('error');
  });
});
