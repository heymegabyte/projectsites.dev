/**
 * @module middleware/error_render
 * @description RFC7807 JSON envelope builder + HTML error page renderer.
 * Centralizes response shape generation to keep middleware thin.
 */

import { escapeHtml } from '@project-sites/shared';

import { HTTP_ERROR_SUGGESTIONS, HTTP_ERROR_TITLES } from './error_taxonomy.js';

/**
 * Build an RFC7807-compliant JSON error response envelope.
 */
export function buildErrorEnvelope(opts: {
  code: string;
  message: string;
  requestId: string;
  /** Structured per-branch payload (e.g. `{ issues: [...] }` for validation). */
  details?: unknown;
}): {
  error: {
    code: string;
    message: string;
    request_id: string;
    details?: unknown;
  };
} {
  const envelope: {
    error: { code: string; message: string; request_id: string; details?: unknown };
  } = {
    error: {
      code: opts.code,
      message: opts.message,
      request_id: opts.requestId,
    },
  };
  if (opts.details !== undefined) {
    envelope.error.details = opts.details;
  }
  return envelope;
}

/**
 * Build a branded HTML error page matching the ProjectSites design system.
 * Uses Fira Code for debug info, animated gradients, and a cyber/terminal aesthetic.
 */
export function brandedErrorPage(opts: {
  status: number;
  code: string;
  message: string;
  requestId: string;
  details?: string;
}): string {
  const title = HTTP_ERROR_TITLES[opts.status] || `Error ${opts.status}`;
  const suggestion = HTTP_ERROR_SUGGESTIONS[opts.status] || 'Try again or <a href="https://projectsites.dev/" class="link">go home</a>.';

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} | ProjectSites</title><link href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@300;400;500&family=Space+Grotesk:wght@400;600;700&display=swap" rel="stylesheet"><style>*{margin:0;padding:0;box-sizing:border-box}body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0f;color:#e0e0e0;font-family:'Space Grotesk',sans-serif;overflow:hidden}@keyframes gradient{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.6}}@keyframes scanline{0%{top:-100%}100%{top:100%}}@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}.bg{position:fixed;inset:0;background:linear-gradient(-45deg,#0a0a0f,#0d1117,#0a1628,#0f0a1e);background-size:400% 400%;animation:gradient 8s ease infinite}.grid{position:fixed;inset:0;background-image:linear-gradient(rgba(0,255,200,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(0,255,200,.03) 1px,transparent 1px);background-size:60px 60px}.scanline{position:fixed;width:100%;height:4px;background:linear-gradient(90deg,transparent,rgba(0,255,200,.08),transparent);animation:scanline 4s linear infinite;z-index:0}.container{text-align:center;max-width:600px;padding:2rem;position:relative;z-index:1}.code{font-size:7rem;font-weight:700;background:linear-gradient(135deg,#00ffc8,#00d4ff,#7c3aed);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;animation:float 3s ease-in-out infinite;line-height:1}.title{font-size:1.8rem;color:#c8d6e5;margin:.5rem 0}.msg{font-size:1.1rem;color:#8892a4;margin:1rem 0 2rem;line-height:1.6}.link{color:#00ffc8;text-decoration:none;border-bottom:1px solid rgba(0,255,200,.3);transition:all .3s}.link:hover{border-color:#00ffc8;text-shadow:0 0 8px rgba(0,255,200,.3)}.actions{display:flex;gap:1rem;justify-content:center;flex-wrap:wrap;margin-bottom:2rem}.btn{display:inline-block;padding:12px 28px;border-radius:50px;text-decoration:none;font-weight:600;font-family:inherit;transition:all .3s}.btn-primary{background:linear-gradient(135deg,#00ffc8,#00d4ff);color:#0a0a0f}.btn-primary:hover{transform:translateY(-3px);box-shadow:0 8px 30px rgba(0,255,200,.3)}.btn-ghost{background:transparent;color:#8892a4;border:1px solid rgba(255,255,255,.1)}.btn-ghost:hover{border-color:#00ffc8;color:#00ffc8}.debug{margin-top:2rem;text-align:left;background:rgba(0,255,200,.03);border:1px solid rgba(0,255,200,.08);border-radius:12px;padding:1.5rem;font-family:'Fira Code',monospace;font-size:.72rem;color:#4a9;line-height:2}.debug-title{color:#00ffc8;font-size:.8rem;margin-bottom:.5rem;font-weight:500;display:flex;align-items:center;gap:6px}.debug-title::after{content:'_';animation:blink 1s infinite}.debug span{color:#556}</style></head><body><div class="bg"></div><div class="grid"></div><div class="scanline"></div><div class="container"><div class="code">${opts.status}</div><h1 class="title">${title}</h1><p class="msg">${suggestion}</p><div class="actions"><a class="btn btn-primary" href="https://projectsites.dev/">Go Home</a><a class="btn btn-ghost" href="https://projectsites.dev/create">Build a Site</a></div><div class="debug"><div class="debug-title">// diagnostics</div><span>status:</span> ${opts.status} ${title}<br><span>code:</span> ${escapeHtml(opts.code)}<br><span>message:</span> ${escapeHtml(opts.message)}<br><span>request_id:</span> ${escapeHtml(opts.requestId)}<br><span>timestamp:</span> ${new Date().toISOString()}${opts.details ? '<br><span>details:</span> ' + escapeHtml(opts.details) : ''}</div></div></body></html>`;
}

/**
 * Determine if the request prefers HTML over JSON (browser vs API client).
 */
export function prefersHtml(accept: string | undefined): boolean {
  if (!accept) return false;
  if (!accept.includes('text/html')) return false;
  const jsonIdx = accept.indexOf('application/json');
  if (jsonIdx === -1) return true;
  return accept.indexOf('text/html') < jsonIdx;
}
