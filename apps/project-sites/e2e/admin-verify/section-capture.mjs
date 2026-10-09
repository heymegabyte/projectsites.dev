/** Runs inside the browser; keep this function self-contained for page.evaluate. */
export function captureSection({ shell, contentSelector }) {
  // An explicitly scoped overlay must never fall back to the dashboard behind it.
  const root = contentSelector
    ? document.querySelector(contentSelector)
    : document.querySelector('main') || document.body;
  const text = root?.innerText || '';
  return {
    path: location.pathname,
    mainLen: text.trim().length,
    text: text.slice(0, 4000),
    h1: (root?.querySelector('h1')?.innerText || '').slice(0, 80),
    rows: root?.querySelectorAll('table tbody tr, [role="row"]').length || 0,
    shellPresent: shell ? !!document.querySelector(`[data-testid="${shell}"]`) : null,
  };
}
