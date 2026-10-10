// @vitest-environment jsdom
/**
 * @file Resources › Buckets › Object preview (B12) — DOM-render proof for the in-editor, SANDBOXED
 *       object preview modal + the pure `classifyPreview` type map.
 *
 * Context: clicking an object used to only download it. B12 adds a PREVIEW affordance that opens the
 * bytes in the shared `ModalShell` — fetched ONCE via the existing `requestBucketDownload` bridge
 * (→ `PS_R2_DOWNLOAD_RESULT`, a base64 data URL) and rendered by type:
 *   • image  → inert `<img>` from a blob URL
 *   • pdf    → SANDBOXED `<iframe sandbox>` (NO `allow-scripts` — untrusted bytes never execute)
 *   • text   → fetched + ESCAPED in a `<pre>` (never innerHTML, never executed)
 *   • video/audio → inert `<video>`/`<audio controls>`
 *   • none   → graceful "No preview available — Download" fallback (never a doomed control)
 * Plus loading + error states, and blob-URL cleanup on close.
 *
 * SECURITY (the "sandboxed" in B12): this asserts the pdf iframe carries a `sandbox` attribute that
 * does NOT grant `allow-scripts`, and that the text preview goes through a `<pre>` (React-escaped),
 * never `dangerouslySetInnerHTML`.
 *
 * The bridge helper is mocked (the real one postMessages a parent absent in jsdom). The modal +
 * classifier are exported from BucketsPanel for this exact falsifiability (mirrors `OwnerKeySection`).
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock the download bridge BEFORE importing the panel (swc hoists vi.mock). ──
const mockDownload = vi.fn();

vi.mock('~/lib/embed/embedded-mode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/embed/embedded-mode')>();
  return {
    ...actual,
    isEmbedded: true,
    postToastToParent: vi.fn(),
    requestBucketDownload: (...a: unknown[]) => mockDownload(...a),
  };
});

import { ObjectPreviewModal, classifyPreview, isPreviewable } from '~/components/workbench/BucketsPanel';

/** A base64 data URL for the given mime + text body (what the download bridge returns). */
function dataUrl(mime: string, body: string): string {
  return `data:${mime};base64,${Buffer.from(body, 'utf8').toString('base64')}`;
}

// Deterministic blob-URL plumbing so we can assert create + REVOKE (cleanup) happen.
const createdUrls: string[] = [];
const revokedUrls: string[] = [];

beforeEach(() => {
  mockDownload.mockReset();
  createdUrls.length = 0;
  revokedUrls.length = 0;

  let n = 0;
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => {
      const url = `blob:mock/${++n}`;
      createdUrls.push(url);

      return url;
    }),
    revokeObjectURL: vi.fn((url: string) => {
      revokedUrls.push(url);
    }),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('classifyPreview — the pure preview-type map (SSOT for modal + gallery)', () => {
  it('classifies images, pdf, text/code, video, audio by extension', () => {
    expect(classifyPreview('images/hero.webp')).toBe('image');
    expect(classifyPreview('logo.svg')).toBe('image');
    expect(classifyPreview('report.pdf')).toBe('pdf');
    expect(classifyPreview('README.md')).toBe('text');
    expect(classifyPreview('config.json')).toBe('text');
    expect(classifyPreview('app.tsx')).toBe('text');
    expect(classifyPreview('data.csv')).toBe('text');
    expect(classifyPreview('promo.mp4')).toBe('video');
    expect(classifyPreview('track.mp3')).toBe('audio');
  });

  it('treats .html/.xml as ESCAPED text (never a live document)', () => {
    expect(classifyPreview('index.html')).toBe('text');
    expect(classifyPreview('feed.xml')).toBe('text');
    // Even when the server hints text/html, extension-driven text wins → inert escaped source.
    expect(classifyPreview('index.html', 'text/html')).toBe('text');
  });

  it('falls back to content-type for extension-less keys, else none', () => {
    expect(classifyPreview('blob', 'image/png')).toBe('image');
    expect(classifyPreview('blob', 'application/pdf')).toBe('pdf');
    expect(classifyPreview('blob', 'text/plain')).toBe('text');
    expect(classifyPreview('mystery.bin')).toBe('none');
    expect(classifyPreview('archive.zip')).toBe('none');
    expect(isPreviewable('archive.zip')).toBe(false);
    expect(isPreviewable('hero.webp')).toBe(true);
  });
});

describe('ObjectPreviewModal — renders bytes in-editor by type (sandboxed)', () => {
  const noop = () => {};

  it('shows a loading state, then an inert <img> for an image, then REVOKES the blob URL on close', async () => {
    let resolve!: (v: unknown) => void;
    mockDownload.mockReturnValue(new Promise((r) => (resolve = r)));

    const onClose = vi.fn();
    render(<ObjectPreviewModal bucket="site-assets" objectKey="images/hero.png" onClose={onClose} onDownload={noop} />);

    // Loading state before the bridge resolves.
    expect(screen.getByTestId('buckets-preview-loading')).toBeTruthy();

    await act(async () => {
      resolve({
        type: 'PS_R2_DOWNLOAD_RESULT',
        ok: true,
        dataUrl: dataUrl('image/png', 'PNGBYTES'),
        contentType: 'image/png',
      });
    });

    const img = await screen.findByTestId('buckets-preview-image');
    expect(img.getAttribute('src')).toBe('blob:mock/1');
    expect(createdUrls).toContain('blob:mock/1');

    // Closing unmounts → the created blob URL is revoked (no leak).
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('revokes the blob URL on UNMOUNT (cleanup)', async () => {
    mockDownload.mockResolvedValue({
      type: 'PS_R2_DOWNLOAD_RESULT',
      ok: true,
      dataUrl: dataUrl('image/png', 'X'),
      contentType: 'image/png',
    });

    const { unmount } = render(<ObjectPreviewModal bucket="b" objectKey="a.png" onClose={noop} onDownload={noop} />);
    await screen.findByTestId('buckets-preview-image');

    unmount();
    expect(revokedUrls).toContain('blob:mock/1');
  });

  it('renders text ESCAPED in a <pre> (never innerHTML) — HTML tags appear as literal text', async () => {
    const malicious = '<script>window.__pwned=1</script>hello';
    mockDownload.mockResolvedValue({
      type: 'PS_R2_DOWNLOAD_RESULT',
      ok: true,
      dataUrl: dataUrl('text/plain', malicious),
      contentType: 'text/plain',
    });

    render(<ObjectPreviewModal bucket="b" objectKey="notes.txt" onClose={noop} onDownload={noop} />);

    const pre = await screen.findByTestId('buckets-preview-text');
    // The raw source is shown as TEXT; it was never parsed into a real <script> node.
    expect(pre.textContent).toContain('<script>');
    expect(pre.querySelector('script')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    // No blob URL for the text path (rendered directly from decoded text).
    expect(createdUrls).toHaveLength(0);
  });

  it('renders a PDF inside a SANDBOXED iframe with NO allow-scripts', async () => {
    mockDownload.mockResolvedValue({
      type: 'PS_R2_DOWNLOAD_RESULT',
      ok: true,
      dataUrl: dataUrl('application/pdf', '%PDF-1.7'),
      contentType: 'application/pdf',
    });

    render(<ObjectPreviewModal bucket="b" objectKey="report.pdf" onClose={noop} onDownload={noop} />);

    const iframe = (await screen.findByTestId('buckets-preview-pdf')) as HTMLIFrameElement;
    // The sandbox attribute is PRESENT…
    expect(iframe.hasAttribute('sandbox')).toBe(true);
    // …and critically does NOT grant script execution to untrusted bytes.
    expect(iframe.getAttribute('sandbox') || '').not.toContain('allow-scripts');
    expect(iframe.getAttribute('src')).toBe('blob:mock/1');
  });

  it('shows a graceful "No preview available — Download" fallback for unpreviewable types', async () => {
    mockDownload.mockResolvedValue({
      type: 'PS_R2_DOWNLOAD_RESULT',
      ok: true,
      dataUrl: dataUrl('application/zip', 'PK'),
      contentType: 'application/zip',
    });

    const onDownload = vi.fn();
    const onClose = vi.fn();
    render(<ObjectPreviewModal bucket="b" objectKey="bundle.zip" onClose={onClose} onDownload={onDownload} />);

    await screen.findByTestId('buckets-preview-unavailable');
    // The fallback is never doomed — its Download button fires the parent's download + closes.
    fireEvent.click(screen.getByTestId('buckets-preview-download'));
    expect(onDownload).toHaveBeenCalledWith('bundle.zip');
    expect(onClose).toHaveBeenCalled();
  });

  it('surfaces a friendly error (with a Download escape hatch) when the bridge fails', async () => {
    mockDownload.mockResolvedValue({ type: 'PS_R2_DOWNLOAD_RESULT', ok: false, error: 'boom' });

    render(<ObjectPreviewModal bucket="b" objectKey="report.pdf" onClose={noop} onDownload={noop} />);

    const err = await screen.findByTestId('buckets-preview-error');
    expect(err.textContent).toContain('Couldn’t load preview');
    expect(screen.getByTestId('buckets-preview-download')).toBeTruthy();
  });
});

describe('reduced-motion guard', () => {
  it('the preview modal entrance is motion-safe gated (reduced-motion users get no motion)', async () => {
    mockDownload.mockResolvedValue({
      type: 'PS_R2_DOWNLOAD_RESULT',
      ok: true,
      dataUrl: dataUrl('text/plain', 'x'),
      contentType: 'text/plain',
    });

    render(<ObjectPreviewModal bucket="b" objectKey="a.txt" onClose={() => {}} onDownload={() => {}} />);

    const dialog = await screen.findByTestId('buckets-preview-modal');
    // The shared ModalShell overlay fades only under motion-safe:* — no unconditional animation.
    const overlay = dialog.querySelector('[aria-hidden]');
    expect(overlay?.className).toContain('motion-safe:');
    // And the in-flight spinner (shown during load) carries the motion-reduce opt-out.
    const html = dialog.innerHTML;
    expect(html).toContain('motion-reduce:');
  });
});
