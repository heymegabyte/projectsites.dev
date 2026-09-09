/**
 * Unit coverage for the single-prompt form router (convergence r15).
 *
 * Covers: parseRouterAction (fence stripping, invalid JSON, missing tool),
 * buildPrompt (template resolution, tool-list injection, fallback copy,
 * context snippets), improveRouterPrompt (seed vs improved vs error fallback),
 * and executeRouterAction (noop, send_email SES rail, MCP tool dispatch,
 * error envelopes, edge inputs). D1/KV/fetch/AI/MCP are all mocked — no real APIs.
 *
 * Resend was removed 2026-09-09 (Brian directive) — the send_email built-in
 * fallback now rides the central SES rail (`getEmailProvider(env).sendTransactional`
 * → SigV4 POST to email.{region}.amazonaws.com/v2/email/outbound-emails). When SES
 * creds are absent, send_email falls through to the MCP `executeTool` path.
 */
import {
  parseRouterAction,
  buildPrompt,
  improveRouterPrompt,
  executeRouterAction,
  DEFAULT_ROUTER_PROMPT,
  SAMPLE_ROUTER_PROMPT,
  DEFAULT_CHAT_SYSTEM_PROMPT,
  type RouterAction,
} from '../services/form_router.js';
import { executeTool } from '../services/mcp_client.js';

// Mock the MCP client so executeRouterAction's tool dispatch is deterministic.
jest.mock('../services/mcp_client.js', () => ({
  executeTool: jest.fn(),
  loadAvailableTools: jest.fn(),
}));

const mockExecuteTool = executeTool as unknown as jest.Mock;

const originalFetch = global.fetch;
const mockFetch = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = mockFetch.mockResolvedValue(
    new Response(JSON.stringify({ id: 'msg-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
});

afterEach(() => {
  global.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// parseRouterAction
// ---------------------------------------------------------------------------
describe('parseRouterAction', () => {
  it('parses a plain JSON object', () => {
    const action = parseRouterAction('{"tool":"send_email","reason":"contact"}');
    expect(action).toEqual({ tool: 'send_email', reason: 'contact' });
  });

  it('strips ```json fences before parsing', () => {
    const action = parseRouterAction('```json\n{"tool":"noop"}\n```');
    expect(action?.tool).toBe('noop');
  });

  it('strips bare ``` fences before parsing', () => {
    const action = parseRouterAction(
      '```\n{"tool":"add_to_mailchimp","args":{"email":"a@b.co"}}\n```',
    );
    expect(action?.tool).toBe('add_to_mailchimp');
    expect(action?.args).toEqual({ email: 'a@b.co' });
  });

  it('returns null for invalid JSON', () => {
    expect(parseRouterAction('not json at all')).toBeNull();
  });

  it('returns null when the tool field is missing', () => {
    expect(parseRouterAction('{"reason":"no tool here"}')).toBeNull();
  });

  it('returns null when the tool field is empty string (falsy)', () => {
    expect(parseRouterAction('{"tool":""}')).toBeNull();
  });

  it('tolerates surrounding whitespace', () => {
    const action = parseRouterAction('   \n  {"tool":"noop"}  \n ');
    expect(action?.tool).toBe('noop');
  });

  it('returns null for empty input', () => {
    expect(parseRouterAction('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildPrompt
// ---------------------------------------------------------------------------
describe('buildPrompt', () => {
  it('uses DEFAULT_ROUTER_PROMPT when no custom prompt is given', () => {
    const out = buildPrompt({ businessName: 'Acme', availableTools: [] });
    expect(out).toContain('AI form-router');
    expect(out).toContain('BUSINESS: Acme');
  });

  it('resolves {{business}} and template-context tokens in a custom prompt', () => {
    const out = buildPrompt({
      customPrompt: 'Hi {{business}} — {{form.email}} via {{query.utm_source}}',
      businessName: 'Acme',
      availableTools: [],
      templateContext: {
        form: { email: 'a@b.co', form_name: 'contact', fields: {} },
        query: { utm_source: 'twitter' },
      },
    });
    expect(out).toContain('Hi Acme — a@b.co via twitter');
  });

  it('renders unknown template tokens as empty strings', () => {
    const out = buildPrompt({
      customPrompt: 'X{{form.missing}}Y',
      businessName: 'Acme',
      availableTools: [],
    });
    expect(out).toContain('XY');
  });

  it('injects the connected-tools JSON block when tools are present', () => {
    const tools = [{ name: 'send_email', description: 'Send mail', parameters: {} }];
    const out = buildPrompt({ businessName: 'Acme', availableTools: tools });
    expect(out).toContain('CONNECTED TOOLS (pick ONLY from these)');
    expect(out).toContain('send_email');
  });

  it('uses the no-tools fallback copy when the tool list is empty', () => {
    const out = buildPrompt({ businessName: 'Acme', availableTools: [] });
    expect(out).toContain('CONNECTED TOOLS: (none)');
    expect(out).toContain('server fallback');
  });

  it('appends business reference material when contextSnippets are supplied', () => {
    const out = buildPrompt({
      businessName: 'Acme',
      availableTools: [],
      contextSnippets: ['snippet one', 'snippet two'],
    });
    expect(out).toContain('BUSINESS REFERENCE MATERIAL');
    expect(out).toContain('snippet one');
    expect(out).toContain('snippet two');
  });

  it('caps reference material at 5 snippets', () => {
    const snippets = Array.from({ length: 8 }, (_, i) => `snip-${i}`);
    const out = buildPrompt({
      businessName: 'Acme',
      availableTools: [],
      contextSnippets: snippets,
    });
    expect(out).toContain('snip-4');
    expect(out).not.toContain('snip-5');
  });

  it('omits reference block when contextSnippets is empty', () => {
    const out = buildPrompt({ businessName: 'Acme', availableTools: [], contextSnippets: [] });
    expect(out).not.toContain('BUSINESS REFERENCE MATERIAL');
  });

  it('falls back to default prompt when customPrompt is whitespace-only', () => {
    const out = buildPrompt({ customPrompt: '   \n  ', businessName: 'Acme', availableTools: [] });
    expect(out).toContain('AI form-router');
  });
});

// ---------------------------------------------------------------------------
// improveRouterPrompt
// ---------------------------------------------------------------------------
describe('improveRouterPrompt', () => {
  const makeEnv = (run: jest.Mock) => ({ AI: { run } }) as any;

  it('returns the seed prompt verbatim when value is empty', async () => {
    const run = jest.fn();
    const r = await improveRouterPrompt(makeEnv(run), '');
    expect(r.mode).toBe('seed');
    expect(r.text).toBe(SAMPLE_ROUTER_PROMPT);
    expect(run).not.toHaveBeenCalled();
  });

  it('returns the seed prompt when value is null/undefined', async () => {
    const run = jest.fn();
    const r1 = await improveRouterPrompt(makeEnv(run), null);
    const r2 = await improveRouterPrompt(makeEnv(run), undefined);
    expect(r1.mode).toBe('seed');
    expect(r2.mode).toBe('seed');
    expect(run).not.toHaveBeenCalled();
  });

  it('returns the seed prompt when value is whitespace-only', async () => {
    const run = jest.fn();
    const r = await improveRouterPrompt(makeEnv(run), '    \n  ');
    expect(r.mode).toBe('seed');
    expect(run).not.toHaveBeenCalled();
  });

  it('returns improved text when the AI produces a sufficiently long result', async () => {
    const improved = 'X'.repeat(50);
    const run = jest.fn().mockResolvedValue({ response: improved });
    const r = await improveRouterPrompt(makeEnv(run), 'route newsletters to mailchimp');
    expect(r.mode).toBe('improved');
    expect(r.text).toBe(improved);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('strips surrounding quotes from the AI response', async () => {
    const run = jest.fn().mockResolvedValue({ response: `"${'Y'.repeat(60)}"` });
    const r = await improveRouterPrompt(makeEnv(run), 'tighten this');
    expect(r.text.startsWith('Y')).toBe(true);
    expect(r.text).not.toMatch(/^"/);
  });

  it('falls back to seed when the AI result is too short (< 40 chars)', async () => {
    const run = jest.fn().mockResolvedValue({ response: 'too short' });
    const r = await improveRouterPrompt(makeEnv(run), 'some input here');
    expect(r.mode).toBe('seed');
    expect(r.text).toBe(SAMPLE_ROUTER_PROMPT);
  });

  it('falls back to seed when AI returns no response field', async () => {
    const run = jest.fn().mockResolvedValue({});
    const r = await improveRouterPrompt(makeEnv(run), 'some input');
    expect(r.mode).toBe('seed');
  });

  it('falls back to seed when the AI call throws', async () => {
    const run = jest.fn().mockRejectedValue(new Error('AI down'));
    const r = await improveRouterPrompt(makeEnv(run), 'route to mailchimp please');
    expect(r.mode).toBe('seed');
    expect(r.text).toBe(SAMPLE_ROUTER_PROMPT);
  });
});

// ---------------------------------------------------------------------------
// executeRouterAction
// ---------------------------------------------------------------------------
describe('executeRouterAction', () => {
  // No email rail configured — send_email falls through to the MCP executeTool path.
  const baseEnv = {} as any;
  // SES-configured env — the built-in send_email fallback rides the SES rail.
  const sesEnv = {
    AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
    AWS_SECRET_ACCESS_KEY: 'secret-key',
    AWS_DEFAULT_REGION: 'us-east-1',
    SES_FROM_EMAIL: 'noreply@projectsites.dev',
  } as any;

  it('short-circuits on noop without touching fetch or MCP', async () => {
    const action: RouterAction = { tool: 'noop', reason: 'spam: empty email' };
    const res = await executeRouterAction(baseEnv, 'site-1', action, {
      replyEmail: 'owner@acme.co',
    });
    expect(res).toEqual({
      tool: 'noop',
      status: 'ok',
      detail: { reason: 'spam: empty email' },
    });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockExecuteTool).not.toHaveBeenCalled();
  });

  it('noop with no reason reports a default reason', async () => {
    const res = await executeRouterAction(
      baseEnv,
      'site-1',
      { tool: 'noop' },
      { replyEmail: 'o@acme.co' },
    );
    expect(res.detail).toEqual({ reason: 'no action' });
  });

  it('sends email via the SES rail when reply email + SES creds are present', async () => {
    mockFetch.mockResolvedValue(new Response('{"MessageId":"ses-1"}', { status: 200 }));
    const action: RouterAction = {
      tool: 'send_email',
      args: { subject: '[contact] hello', body: 'Name: Jane', reply_to: 'jane@x.co' },
    };
    const res = await executeRouterAction(sesEnv, 'site-1', action, {
      replyEmail: 'owner@acme.co',
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0][0])).toContain('amazonaws.com');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    // SES rail: recipient in Destination, reply-to honored, html body carries the
    // plaintext wrapped in an escaped <pre>. Never api.resend.com.
    expect(body.Destination.ToAddresses).toEqual(['owner@acme.co']);
    expect(body.ReplyToAddresses).toEqual(['jane@x.co']);
    expect(body.Content.Simple.Subject.Data).toBe('[contact] hello');
    expect(body.Content.Simple.Body.Html.Data).toBe('<pre>Name: Jane</pre>');
    expect(body.FromEmailAddress).toBe('noreply@projectsites.dev');
    expect(res).toEqual({ tool: 'send_email', status: 'ok', detail: { to: 'owner@acme.co' } });
    expect(mockExecuteTool).not.toHaveBeenCalled();
  });

  it('routes send_email through Amazon SES, not Resend, when SES is configured (ADR-0019)', async () => {
    // Resend removed 2026-09-09 — RESEND_API_KEY no longer exists on Env. This test
    // guards that the send NEVER hits api.resend.com regardless (see url assertion below).
    const sesEnv = {
      AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      AWS_SECRET_ACCESS_KEY: 'secret-key',
      AWS_DEFAULT_REGION: 'us-east-1',
      SES_FROM_EMAIL: 'noreply@projectsites.dev',
    } as any;
    mockFetch.mockResolvedValue(new Response('{"MessageId":"ses-1"}', { status: 200 }));
    const action: RouterAction = {
      tool: 'send_email',
      args: { subject: '[contact] hello', body: 'Name: Jane', reply_to: 'jane@x.co' },
    };
    const res = await executeRouterAction(sesEnv, 'site-1', action, {
      replyEmail: 'owner@acme.co',
    });

    const urls = mockFetch.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(urls.some((u) => u.includes('amazonaws.com'))).toBe(true);
    expect(urls.some((u) => u.includes('api.resend.com'))).toBe(false);
    const sesBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(sesBody.ReplyToAddresses).toEqual(['jane@x.co']);
    expect(res).toEqual({ tool: 'send_email', status: 'ok', detail: { to: 'owner@acme.co' } });
  });

  it('defaults subject and body when send_email args are missing', async () => {
    mockFetch.mockResolvedValue(new Response('{"MessageId":"ses-1"}', { status: 200 }));
    const res = await executeRouterAction(
      sesEnv,
      'site-1',
      { tool: 'send_email' },
      { replyEmail: 'o@acme.co' },
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.Content.Simple.Subject.Data).toBe('New form submission');
    // body falls back to a JSON dump of the (empty) args, escaped inside a <pre>
    expect(typeof body.Content.Simple.Body.Html.Data).toBe('string');
    expect(res.status).toBe('ok');
  });

  it('returns an error envelope when the SES send fails', async () => {
    mockFetch.mockResolvedValueOnce(new Response('boom', { status: 502 }));
    const res = await executeRouterAction(
      sesEnv,
      'site-1',
      { tool: 'send_email', args: { subject: 's', body: 'b' } },
      { replyEmail: 'owner@acme.co' },
    );
    expect(res).toEqual({
      tool: 'send_email',
      status: 'error',
      detail: {},
      error: 'ses SES send failed (502): boom',
    });
  });

  it('routes send_email through MCP when no reply email is configured', async () => {
    mockExecuteTool.mockResolvedValue({ ok: true, data: { sent: true } });
    const res = await executeRouterAction(
      baseEnv,
      'site-1',
      { tool: 'send_email', args: { subject: 's' } },
      { replyEmail: null },
    );
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockExecuteTool).toHaveBeenCalledWith(baseEnv, 'site-1', {
      name: 'send_email',
      arguments: { subject: 's' },
    });
    expect(res).toEqual({ tool: 'send_email', status: 'ok', detail: { sent: true } });
  });

  it('routes send_email through MCP when no email rail is configured', async () => {
    mockExecuteTool.mockResolvedValue({ ok: true, data: {} });
    const noRailEnv = {} as any;
    await executeRouterAction(
      noRailEnv,
      'site-1',
      { tool: 'send_email', args: {} },
      { replyEmail: 'o@acme.co' },
    );
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockExecuteTool).toHaveBeenCalledTimes(1);
  });

  it('dispatches an arbitrary MCP tool with its args', async () => {
    mockExecuteTool.mockResolvedValue({ ok: true, data: { id: 'mc-1' } });
    const action: RouterAction = { tool: 'add_to_mailchimp', args: { email: 'a@b.co' } };
    const res = await executeRouterAction(baseEnv, 'site-9', action, { replyEmail: null });
    expect(mockExecuteTool).toHaveBeenCalledWith(baseEnv, 'site-9', {
      name: 'add_to_mailchimp',
      arguments: { email: 'a@b.co' },
    });
    expect(res).toEqual({ tool: 'add_to_mailchimp', status: 'ok', detail: { id: 'mc-1' } });
  });

  it('defaults arguments to an empty object when action.args is undefined', async () => {
    mockExecuteTool.mockResolvedValue({ ok: true, data: {} });
    await executeRouterAction(
      baseEnv,
      'site-1',
      { tool: 'open_github_issue' },
      { replyEmail: null },
    );
    expect(mockExecuteTool).toHaveBeenCalledWith(baseEnv, 'site-1', {
      name: 'open_github_issue',
      arguments: {},
    });
  });

  it('propagates an MCP error into the result envelope', async () => {
    mockExecuteTool.mockResolvedValue({ ok: false, error: 'no connected provider for tool "x"' });
    const res = await executeRouterAction(baseEnv, 'site-1', { tool: 'x' }, { replyEmail: null });
    expect(res).toEqual({
      tool: 'x',
      status: 'error',
      detail: {},
      error: 'no connected provider for tool "x"',
    });
  });

  it('defaults detail to {} when the MCP tool returns no data', async () => {
    mockExecuteTool.mockResolvedValue({ ok: true });
    const res = await executeRouterAction(
      baseEnv,
      'site-1',
      { tool: 'create_linear_issue' },
      { replyEmail: null },
    );
    expect(res.detail).toEqual({});
    expect(res.status).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// Exported constants (contract guards)
// ---------------------------------------------------------------------------
describe('exported prompt constants', () => {
  it('DEFAULT_ROUTER_PROMPT contains the strict-JSON output contract', () => {
    expect(DEFAULT_ROUTER_PROMPT).toContain('one valid JSON object');
    expect(DEFAULT_ROUTER_PROMPT).toContain('{{business}}');
  });

  it('SAMPLE_ROUTER_PROMPT is a non-trivial seed prompt', () => {
    expect(SAMPLE_ROUTER_PROMPT.length).toBeGreaterThan(200);
    expect(SAMPLE_ROUTER_PROMPT).toContain('ROUTING');
  });

  it('DEFAULT_CHAT_SYSTEM_PROMPT is conversational, not a dispatcher', () => {
    expect(DEFAULT_CHAT_SYSTEM_PROMPT).toContain('concierge');
    expect(DEFAULT_CHAT_SYSTEM_PROMPT).toContain('{{business}}');
  });
});
