/**
 * @module lib/error_pages
 * @description Branded error page HTML builder extracted from middleware for reuse.
 * Renders domain-branded 4xx/5xx error pages with optional details.
 *
 * @example
 * ```ts
 * const html = brandedErrorPage({
 *   status: 404,
 *   code: 'NOT_FOUND',
 *   message: 'Page not found',
 *   requestId: 'req-123',
 * });
 * ```
 */

interface ErrorPageOptions {
  status: number;
  code: string;
  message: string;
  requestId: string;
  details?: string;
}

/**
 * Renders a branded HTML error page for non-API requests.
 *
 * @param opts - Error page options (status, code, message, requestId, optional details)
 * @returns Complete HTML document string (doctype + shell + styled error layout)
 *
 * @remarks
 * - Status-specific messaging (404 = "not found", 503 = "be back soon", etc.)
 * - Styled with inline CSS (no external deps, works when CSS loading fails)
 * - Includes request ID for support reference
 * - Dark theme matching platform default (`#060610` background)
 * - Details field rendered if provided (validation errors, diagnostics)
 *
 * @throws Never — always returns a valid HTML string
 */
export function brandedErrorPage(opts: ErrorPageOptions): string {
  const { status, code, message, requestId, details } = opts;

  // Status-specific messaging
  const friendlyMessage = (() => {
    if (status === 404) return '404 — Page not found';
    if (status === 403) return '403 — Access denied';
    if (status === 400) return '400 — Invalid request';
    if (status === 503) return 'Be back soon';
    if (status >= 500) return 'Something went wrong';
    return `${status} error`;
  })();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${status} — ProjectSites</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; }
    body {
      background: #060610;
      color: #f4f4ff;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      max-width: 600px;
      text-align: center;
    }
    .status-code {
      font-size: 72px;
      font-weight: 700;
      color: #00e5ff;
      margin-bottom: 16px;
      line-height: 1;
    }
    .message {
      font-size: 20px;
      margin-bottom: 32px;
      opacity: 0.9;
    }
    .details {
      background: rgba(0, 229, 255, 0.05);
      border: 1px solid rgba(0, 229, 255, 0.2);
      border-radius: 8px;
      padding: 16px;
      margin: 32px 0;
      font-family: 'Monaco', 'Menlo', monospace;
      font-size: 12px;
      text-align: left;
      color: #00e5ff;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .request-id {
      font-size: 12px;
      color: #999;
      margin-top: 32px;
    }
    .home-link {
      display: inline-block;
      margin-top: 24px;
      padding: 12px 24px;
      background: rgba(0, 229, 255, 0.1);
      border: 1px solid #00e5ff;
      border-radius: 4px;
      color: #00e5ff;
      text-decoration: none;
      font-size: 14px;
      font-weight: 500;
      transition: all 0.2s ease;
    }
    .home-link:hover {
      background: rgba(0, 229, 255, 0.2);
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="status-code">${status}</div>
    <div class="message">${friendlyMessage}</div>
    ${message ? `<p style="font-size: 16px; margin-bottom: 24px;">${escapeHtml(message)}</p>` : ''}
    ${details ? `<div class="details">${escapeHtml(details)}</div>` : ''}
    <div class="request-id">Request ID: ${escapeHtml(requestId)}</div>
    <a href="/" class="home-link">Back to home</a>
  </div>
</body>
</html>`;
}

/**
 * Escapes HTML special characters to prevent XSS in error pages.
 *
 * @param str - String to escape
 * @returns Escaped string safe for inline HTML
 *
 * @internal
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
