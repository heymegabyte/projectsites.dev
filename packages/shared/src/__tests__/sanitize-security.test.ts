/**
 * sanitizeHtml — XSS regression suite.
 *
 * Guards the fix for a real bypass: the original event-handler regex required
 * quotes (`on\w+\s*=\s*["']…["']`), so UNQUOTED handlers (`<svg onload=alert(1)>`,
 * `<img src=x onerror=alert(1)>`) survived. `sanitizeHtml` is applied to
 * user-supplied `additional_context` in the worker (`routes/search.ts`), so the
 * gap was reachable. These cases assert the dangerous constructs are gone while
 * benign markup + benign `on…`-looking text is preserved.
 */
import { sanitizeHtml, escapeHtml, safeRelativePath, pickSafeRedirect } from '../utils/sanitize.js';

describe('safeRelativePath — open-redirect defense', () => {
  const fb = '/admin';
  it('keeps a genuine same-origin relative path', () => {
    expect(safeRelativePath('/admin/mcp', fb)).toBe('/admin/mcp');
    expect(safeRelativePath('/ok?x=1&y=2', fb)).toBe('/ok?x=1&y=2');
  });
  it('rejects the userinfo bypass (@evil.com → host evil.com when composed)', () => {
    expect(safeRelativePath('@evil.com', fb)).toBe(fb);
    expect(safeRelativePath('https://evil.com', fb)).toBe(fb);
  });
  it('rejects protocol-relative + backslash + whitespace tricks', () => {
    expect(safeRelativePath('//evil.com', fb)).toBe(fb);
    expect(safeRelativePath('/\\evil.com', fb)).toBe(fb);
    expect(safeRelativePath('/a b', fb)).toBe(fb);
  });
  it('falls back on undefined/empty', () => {
    expect(safeRelativePath(undefined, fb)).toBe(fb);
    expect(safeRelativePath('', fb)).toBe(fb);
  });
});

describe('pickSafeRedirect — absolute-URL open-redirect defense', () => {
  const allowed = new Set(['nsk.projectsites.dev', 'projectsites.dev', 'donate.nsk.org']);
  const fb = 'https://nsk.projectsites.dev/ok';

  it('keeps a URL whose host is on the allowlist', () => {
    expect(pickSafeRedirect('https://nsk.projectsites.dev/thanks', fb, allowed)).toBe(
      'https://nsk.projectsites.dev/thanks',
    );
    expect(pickSafeRedirect('https://donate.nsk.org/done', fb, allowed)).toBe('https://donate.nsk.org/done');
  });

  it('falls back for a cross-host (phishing) URL', () => {
    expect(pickSafeRedirect('https://evil.com/steal', fb, allowed)).toBe(fb);
    // userinfo bypass: host is evil.com, not the allowlisted prefix
    expect(pickSafeRedirect('https://nsk.projectsites.dev@evil.com/x', fb, allowed)).toBe(fb);
  });

  it('falls back when undefined or unparseable', () => {
    expect(pickSafeRedirect(undefined, fb, allowed)).toBe(fb);
    expect(pickSafeRedirect('::::not a url', fb, allowed)).toBe(fb);
  });

  it('matches host case-insensitively', () => {
    expect(pickSafeRedirect('https://NSK.ProjectSites.dev/x', fb, allowed)).toBe('https://NSK.ProjectSites.dev/x');
  });
});

describe('escapeHtml — entity encoding', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });

  it('escapes & first so existing entities are not double-mangled into tags', () => {
    // & must be escaped BEFORE < / > or "&lt;" could be re-processed.
    expect(escapeHtml('5 < 10 & 3 > 1')).toBe('5 &lt; 10 &amp; 3 &gt; 1');
  });

  it('renders injected markup inert (no live tag survives)', () => {
    const out = escapeHtml('<script>alert(1)</script>');
    expect(out).not.toContain('<script>');
    expect(out).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('is a no-op on text with no special characters', () => {
    expect(escapeHtml('Hello world 123')).toBe('Hello world 123');
  });
});

describe('sanitizeHtml — XSS vectors', () => {
  const dangerous: Array<[string, string]> = [
    ['unquoted onload', '<svg onload=alert(1)>'],
    ['unquoted onclick', '<div onclick=alert(1)>hi</div>'],
    ['unquoted onerror img', '<img src=x onerror=alert(1)>'],
    ['unquoted onmouseover', '<a onmouseover=alert(1)>x</a>'],
    ['double-quoted handler', `<div onclick="steal()">Hi</div>`],
    ['single-quoted handler', `<div onclick='steal()'>Hi</div>`],
    ['mixed-case handler', '<svg OnLoad=alert(1)>'],
    ['script block', '<script>alert(1)</script>'],
    ['nested split script', '<scr<script>ipt>alert(1)</script>'],
    ['iframe', '<iframe src="evil"></iframe>'],
    ['object', '<object data="evil"></object>'],
    ['embed', '<embed src="evil">'],
    ['javascript uri', '<a href="javascript:alert(1)">x</a>'],
    ['vbscript uri', '<a href="vbscript:msgbox(1)">x</a>'],
    ['data uri', '<a href="data:text/html,<script>alert(1)</script>">x</a>'],
    // Unterminated openers — browsers auto-close a <script>/<iframe> at EOF, so the
    // balanced-pair regexes (which require a literal closing tag) must NOT be the only
    // defence. These pass through the shell UNLESS the unterminated-opener strip fires. (AL-780)
    ['unterminated script (no closing tag)', '<script>alert(document.cookie)'],
    ['unterminated script (truncated at EOF)', 'prefix<script'],
    ['unterminated iframe (no closing tag)', '<iframe src="evil"'],
  ];

  for (const [name, payload] of dangerous) {
    it(`neutralizes: ${name}`, () => {
      const out = sanitizeHtml(payload);
      // No event handlers survive (quoted or unquoted).
      expect(out).not.toMatch(/\son\w+\s*=/i);
      // No executable script/embed shells survive.
      expect(out.toLowerCase()).not.toContain('<script');
      expect(out.toLowerCase()).not.toContain('<iframe');
      expect(out.toLowerCase()).not.toContain('<object');
      expect(out.toLowerCase()).not.toContain('<embed');
      // No dangerous URI schemes survive.
      expect(out.toLowerCase()).not.toContain('javascript:');
      expect(out.toLowerCase()).not.toContain('vbscript:');
      expect(out.toLowerCase()).not.toContain('data:');
    });
  }

  it('strips SLASH-separated event handlers (HTML5 treats / as an attr separator)', () => {
    // The shared loop above asserts /\son\w+=/ (space boundary) — it CANNOT see the
    // slash-separated form, so this vector needs its own assertion. (AL-780)
    expect(sanitizeHtml('<svg/onload=alert(1)>').toLowerCase()).not.toContain('onload');
    expect(sanitizeHtml('<img src=x/onerror=alert(1)>').toLowerCase()).not.toContain('onerror');
    expect(sanitizeHtml('<div/onclick=steal()>hi</div>').toLowerCase()).not.toContain('onclick');
  });

  it('preserves benign markup', () => {
    expect(sanitizeHtml('<p>Hello <strong>world</strong></p>')).toBe('<p>Hello <strong>world</strong></p>');
    expect(sanitizeHtml('<a href="https://example.com">link</a>')).toBe('<a href="https://example.com">link</a>');
    // Over-strip guard for the broadened [\s/] boundary: a benign closing tag and
    // self-closing slash must survive — only `on\w+=` after the boundary strips. (AL-780)
    expect(sanitizeHtml('<p>line one</p>')).toBe('<p>line one</p>');
    expect(sanitizeHtml('<br/>')).toBe('<br/>');
    expect(sanitizeHtml('<img src="a.jpg"/>')).toBe('<img src="a.jpg"/>');
  });

  it('does not corrupt text that merely contains "on" or attribute-like words', () => {
    // No leading-space + on\w+= boundary, so these are untouched.
    expect(sanitizeHtml('<p>Once upon a time</p>')).toBe('<p>Once upon a time</p>');
    expect(sanitizeHtml('<button name="on">On</button>')).toBe('<button name="on">On</button>');
  });

  it('is idempotent (re-sanitizing changes nothing)', () => {
    const once = sanitizeHtml('<div onclick=alert(1)><scr<script>ipt>x</script>ok</div>');
    expect(sanitizeHtml(once)).toBe(once);
  });
});
