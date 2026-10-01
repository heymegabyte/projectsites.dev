/**
 * @module lib/branded_error_page
 * @description Branded HTML error page builder for non-API responses.
 * Generates styled 4xx/5xx error pages with branding, correlation IDs, and recovery affordances.
 */

/**
 * Branded error page parameters.
 */
export interface ErrorPageParams {
  status: number;
  code: string;
  message: string;
  requestId: string;
  details?: string;
}

/**
 * Build a branded HTML error page.
 * @param params - Error page parameters (status, code, message, requestId, optional details).
 * @returns HTML string ready to serve as response body.
 * @example
 * const html = brandedErrorPage({
 *   status: 500,
 *   code: 'INTERNAL_ERROR',
 *   message: 'Something went wrong',
 *   requestId: 'abc123',
 * });
 */
export function brandedErrorPage(params: ErrorPageParams): string {
  const { status, code, message, requestId, details } = params;
  const isDarkMode = true; // Brand default: dark theme

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${status} — ${code}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: ${isDarkMode ? '#060610' : '#f9f9f9'};
      color: ${isDarkMode ? '#f4f4ff' : '#1a1a1a'};
      line-height: 1.6;
      padding: 2rem;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .container {
      max-width: 600px;
      text-align: center;
      border-radius: 12px;
      padding: 3rem;
      background: ${isDarkMode ? '#0d0d14' : '#fff'};
      border: 1px solid ${isDarkMode ? '#1a1a24' : '#e5e5e5'};
      box-shadow: 0 4px 24px ${isDarkMode ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.1)'};
    }
    .status-code {
      font-size: 4rem;
      font-weight: 900;
      background: linear-gradient(135deg, #00E5FF, #50AAE3);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 0.5rem;
    }
    .code-label {
      font-size: 0.875rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: ${isDarkMode ? '#7C7C8F' : '#999'};
      margin-bottom: 1.5rem;
    }
    .message {
      font-size: 1.5rem;
      font-weight: 600;
      margin-bottom: 1rem;
      color: ${isDarkMode ? '#f4f4ff' : '#1a1a1a'};
    }
    .details {
      font-size: 0.95rem;
      color: ${isDarkMode ? '#a8a8b8' : '#666'};
      margin-bottom: 2rem;
      line-height: 1.8;
    }
    .meta {
      font-size: 0.8rem;
      color: ${isDarkMode ? '#6a6a7a' : '#aaa'};
      padding-top: 1.5rem;
      border-top: 1px solid ${isDarkMode ? '#1a1a24' : '#e5e5e5'};
      margin-top: 1.5rem;
      word-break: break-all;
    }
    .meta-label {
      display: block;
      font-weight: 500;
      text-transform: uppercase;
      font-size: 0.7rem;
      letter-spacing: 0.15em;
      margin-bottom: 0.3rem;
      margin-top: 0.5rem;
      opacity: 0.8;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="status-code">${status}</div>
    <div class="code-label">${code}</div>
    <div class="message">${escapeHtml(message)}</div>
    ${details ? `<div class="details">${escapeHtml(details)}</div>` : ''}
    <div class="meta">
      <div class="meta-label">Request ID</div>
      <div>${escapeHtml(requestId)}</div>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Escape HTML special characters in a string.
 * @internal
 */
function escapeHtml(str: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return str.replace(/[&<>"']/g, (c) => map[c]);
}
