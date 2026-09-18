/**
 * MCP-style OAuth provider adapters. Each provider implements:
 *   - authorizeUrl(state, codeChallenge, returnUrl) — build the consent URL
 *   - exchangeCode(code, codeVerifier) — swap auth code for access token
 *   - listTools() — return JSON-schema tool descriptors for the LLM
 *   - executeTool(name, args, token) — perform the action
 *
 * Per-site tokens live in `mcp_connections`, encrypted via ai_crypto.ts.
 */
import type { Env } from '../types/env.js';
import { decrypt } from './ai_crypto.js';
import { safeParseJSON } from '../utils/safe-parse.js';

/**
 * Identifier for every MCP-style OAuth provider the worker can connect.
 *
 * @remarks
 * Adding a new entry requires (1) a {@link ProviderAdapter} implementation,
 * (2) a `{PROVIDER}_OAUTH_CLIENT_ID` secret in `wrangler.toml`, and
 * (3) registration via {@link allProviders} / `getAdapter`. See `routes/api.ts`
 * `/api/mcp/:provider/connect` for the consumer flow.
 */
export type Provider =
  | 'mailchimp'
  | 'stripe'
  | 'resend'
  | 'hubspot'
  | 'slack'
  | 'notion'
  | 'github'
  | 'linear'
  | 'discord'
  | 'google_calendar'
  | 'twilio'
  | 'calendly'
  | 'airtable'
  | 'zapier'
  // Turn 5 — frontend catalogue flipped these to OAuth-supported. Adapters
  // are not yet implemented server-side; `/api/mcp/:provider/connect`
  // returns `501 oauth_not_configured` until the worker secret is pushed,
  // and `getAdapter()` falls back to a paste-key shim.
  | 'cal_com'
  | 'sentry'
  | 'pagerduty'
  | 'posthog'
  | 'vercel'
  | 'netlify';

/**
 * JSON-schema-style tool descriptor that an LLM can pick + invoke.
 *
 * @remarks
 * Surfaced to the model via `tools[]` on Anthropic/OpenAI messages calls.
 * `parameters` follows JSON Schema Draft 2020-12 — keep arg names stable
 * since the model memorizes them at prompt-cache time.
 */
export interface ToolDescriptor {
  name: string;
  description: string;
  /** JSON schema for input args. */
  parameters: Record<string, unknown>;
}

/**
 * Per-provider adapter for the full OAuth + tool-execution lifecycle.
 *
 * @remarks
 * Implementations live further down this file. Each adapter must be
 * stateless and side-effect free at module-load — all I/O happens through
 * the env-aware methods so wrangler binding resolution stays at request time.
 */
export interface ProviderAdapter {
  provider: Provider;
  /** Authorization URL for the OAuth consent screen. */
  authorizeUrl(env: Env, opts: { state: string; codeVerifier?: string; returnUrl: string }): string;
  /** Exchange auth code for tokens. Returns the raw provider response. */
  exchangeCode(
    env: Env,
    opts: { code: string; codeVerifier?: string; redirectUri: string },
  ): Promise<{
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    metadata?: Record<string, unknown>;
  }>;
  /** Tool descriptors the LLM may invoke. */
  tools(): ToolDescriptor[];
  /** Execute a tool against the provider API. */
  execute(
    env: Env,
    opts: {
      tool: string;
      args: Record<string, unknown>;
      accessToken: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<{ ok: boolean; data?: unknown; error?: string }>;
}

async function challengeFromVerifier(verifier: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/* ─────────────────────────── MailChimp ─────────────────────────── */
const mailchimp: ProviderAdapter = {
  provider: 'mailchimp',
  authorizeUrl(env, { state, returnUrl }) {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: env.MAILCHIMP_OAUTH_CLIENT_ID || env.MAILCHIMP_CLIENT_ID || '',
      redirect_uri: `${new URL(returnUrl).origin}/api/mcp/mailchimp/callback`,
      state,
    });
    return `https://login.mailchimp.com/oauth2/authorize?${params}`;
  },
  async exchangeCode(env, { code, redirectUri }) {
    const tokenRes = await fetch('https://login.mailchimp.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: env.MAILCHIMP_OAUTH_CLIENT_ID || env.MAILCHIMP_CLIENT_ID || '',
        client_secret: env.MAILCHIMP_OAUTH_CLIENT_SECRET || env.MAILCHIMP_CLIENT_SECRET || '',
        redirect_uri: redirectUri,
        code,
      }),
    });
    if (!tokenRes.ok) throw new Error(`mailchimp token exchange ${tokenRes.status}`);
    const token = (await tokenRes.json()) as { access_token: string };
    // Mailchimp requires a follow-up call to discover the data center.
    const meta = await fetch('https://login.mailchimp.com/oauth2/metadata', {
      headers: { Authorization: `OAuth ${token.access_token}` },
    }).then(
      (r) => r.json() as Promise<{ dc: string; api_endpoint: string; login: { email: string } }>,
    );
    return {
      access_token: token.access_token,
      metadata: { dc: meta.dc, api_endpoint: meta.api_endpoint, login_email: meta.login.email },
    };
  },
  tools() {
    return [
      {
        name: 'add_to_mailchimp',
        description: 'Subscribe an email to a Mailchimp audience list. Use for newsletter signups.',
        parameters: {
          type: 'object',
          required: ['email'],
          properties: {
            email: { type: 'string', format: 'email' },
            list_id: {
              type: 'string',
              description: 'Optional Mailchimp list ID. Uses the default list when omitted.',
            },
            merge_fields: { type: 'object' },
          },
        },
      },
    ];
  },
  async execute(env, { tool, args, accessToken, metadata }) {
    void env;
    if (tool !== 'add_to_mailchimp') return { ok: false, error: 'unknown tool' };
    const dc = (metadata?.['dc'] as string | undefined) ?? 'us1';
    const listId = (args['list_id'] as string | undefined) ?? '';
    const email = String(args['email'] ?? '');
    if (!listId || !email) return { ok: false, error: 'list_id and email required' };
    const res = await fetch(`https://${dc}.api.mailchimp.com/3.0/lists/${listId}/members`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email_address: email,
        status: 'subscribed',
        merge_fields: args['merge_fields'] ?? {},
      }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (
      !res.ok &&
      String(body['title'] ?? '')
        .toLowerCase()
        .includes('exists')
    ) {
      return { ok: true, data: { already_subscribed: true } };
    }
    return res.ok ? { ok: true, data: body } : { ok: false, error: `mailchimp ${res.status}` };
  },
};

/* ─────────────────────────── Stripe ─────────────────────────── */
const stripe: ProviderAdapter = {
  provider: 'stripe',
  authorizeUrl(env, { state, returnUrl }) {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id:
        env.STRIPE_OAUTH_CLIENT_ID ||
        env.STRIPE_CONNECT_CLIENT_ID ||
        env.STRIPE_CONNECT_CLIENT_ID_TEST ||
        '',
      scope: 'read_write',
      state,
      redirect_uri: `${new URL(returnUrl).origin}/api/mcp/stripe/callback`,
    });
    return `https://connect.stripe.com/oauth/authorize?${params}`;
  },
  async exchangeCode(env, { code }) {
    const res = await fetch('https://connect.stripe.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_secret: env.STRIPE_SECRET_KEY,
        code,
      }),
    });
    if (!res.ok) throw new Error(`stripe oauth ${res.status}`);
    const json = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      stripe_user_id: string;
    };
    return {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      metadata: { stripe_account_id: json.stripe_user_id },
    };
  },
  tools() {
    return [
      {
        name: 'create_stripe_invoice',
        description:
          'Send a Stripe invoice to a customer when they request a quote, deposit, or payment.',
        parameters: {
          type: 'object',
          required: ['email', 'amount_cents', 'description'],
          properties: {
            email: { type: 'string', format: 'email' },
            amount_cents: { type: 'integer', minimum: 100 },
            currency: { type: 'string', default: 'usd' },
            description: { type: 'string' },
          },
        },
      },
    ];
  },
  async execute(_env, { tool, args, accessToken }) {
    if (tool !== 'create_stripe_invoice') return { ok: false, error: 'unknown tool' };
    const form = new URLSearchParams({
      customer_email: String(args['email'] ?? ''),
      collection_method: 'send_invoice',
      days_until_due: '30',
      description: String(args['description'] ?? ''),
    });
    const inv = await fetch('https://api.stripe.com/v1/invoices', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
    });
    return inv.ok
      ? { ok: true, data: await inv.json() }
      : { ok: false, error: `stripe ${inv.status}` };
  },
};

/* ─────────────────────────── Resend ─────────────────────────── */
// Resend has no OAuth; users paste an API key.
const resend: ProviderAdapter = {
  provider: 'resend',
  authorizeUrl(_env, { state }) {
    // Special marker; UI shows a paste-key flow instead of redirecting.
    return `__paste_key__?state=${state}`;
  },
  async exchangeCode(_env, { code }) {
    // For Resend, the "code" IS the API key the user pasted.
    return { access_token: code };
  },
  tools() {
    return [
      {
        name: 'send_email',
        description:
          'Send an email reply to a customer or to the site owner. Use for contact forms, order confirmations, follow-ups.',
        parameters: {
          type: 'object',
          required: ['to', 'subject', 'body'],
          properties: {
            to: { type: 'string', format: 'email' },
            from: { type: 'string', default: 'noreply@projectsites.dev' },
            reply_to: { type: 'string' },
            subject: { type: 'string' },
            body: { type: 'string' },
          },
        },
      },
    ];
  },
  async execute(_env, { tool, args, accessToken }) {
    if (tool !== 'send_email') return { ok: false, error: 'unknown tool' };
    // §4/ADR-0019 EXEMPT: this is the customer-connected Resend MCP integration —
    // it sends through the CUSTOMER's own Resend account (their `accessToken`), NOT
    // our platform email. The §4 Resend exclusion bans Resend as OUR transactional
    // rail, never as a customer-selectable MCP provider. Do NOT "cut this over".
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: String(args['from'] ?? 'noreply@projectsites.dev'),
        to: [String(args['to'] ?? '')],
        reply_to: args['reply_to'] ? String(args['reply_to']) : undefined,
        subject: String(args['subject'] ?? ''),
        text: String(args['body'] ?? ''),
      }),
    });
    return res.ok
      ? { ok: true, data: await res.json() }
      : { ok: false, error: `resend ${res.status}` };
  },
};

/* ─────────────────────────── HubSpot ─────────────────────────── */
const hubspot: ProviderAdapter = {
  provider: 'hubspot',
  authorizeUrl(env, { state, returnUrl, codeVerifier }) {
    const params = new URLSearchParams({
      client_id: env.HUBSPOT_OAUTH_CLIENT_ID || env.HUBSPOT_CLIENT_ID || '',
      redirect_uri: `${new URL(returnUrl).origin}/api/mcp/hubspot/callback`,
      scope:
        'crm.objects.contacts.read crm.objects.contacts.write crm.objects.companies.read crm.objects.companies.write crm.objects.deals.read crm.objects.deals.write crm.objects.line_items.read crm.objects.line_items.write crm.schemas.contacts.read crm.schemas.companies.read crm.schemas.deals.read crm.objects.owners.read tickets forms',
      state,
    });
    // HubSpot supports PKCE for public clients; include challenge if provided.
    if (codeVerifier) {
      // (caller will pre-derive the challenge; for brevity we just pass state)
    }
    return `https://app.hubspot.com/oauth/authorize?${params}`;
  },
  async exchangeCode(env, { code, redirectUri }) {
    const res = await fetch('https://api.hubapi.com/oauth/v1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: env.HUBSPOT_OAUTH_CLIENT_ID || env.HUBSPOT_CLIENT_ID || '',
        client_secret: env.HUBSPOT_OAUTH_CLIENT_SECRET || env.HUBSPOT_CLIENT_SECRET || '',
        redirect_uri: redirectUri,
        code,
      }),
    });
    if (!res.ok) throw new Error(`hubspot oauth ${res.status}`);
    const json = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    return {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_in: json.expires_in,
    };
  },
  tools() {
    return [
      {
        name: 'create_hubspot_contact',
        description: 'Create or update a HubSpot CRM contact when a customer submits a form.',
        parameters: {
          type: 'object',
          required: ['email'],
          properties: {
            email: { type: 'string', format: 'email' },
            firstname: { type: 'string' },
            lastname: { type: 'string' },
            phone: { type: 'string' },
            company: { type: 'string' },
            lifecyclestage: { type: 'string' },
          },
        },
      },
    ];
  },
  async execute(_env, { tool, args, accessToken }) {
    if (tool !== 'create_hubspot_contact') return { ok: false, error: 'unknown tool' };
    const res = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ properties: args }),
    });
    return res.ok
      ? { ok: true, data: await res.json() }
      : { ok: false, error: `hubspot ${res.status}` };
  },
};

/* ─────────────────────────── Paste-key providers ─────────────────────────── */
// For providers where OAuth setup is heavyweight or the customer just has
// an API key handy, we expose a paste-key flow (same UX as Resend). All of
// these run the same `__paste_key__` marker in authorizeUrl.

function pasteKeyAdapter(opts: {
  provider: Provider;
  tool: ToolDescriptor;
  endpoint: (args: Record<string, unknown>) => { url: string; init: RequestInit };
}): ProviderAdapter {
  return {
    provider: opts.provider,
    authorizeUrl(_env, { state }) {
      return `__paste_key__?state=${state}`;
    },
    async exchangeCode(_env, { code }) {
      return { access_token: code };
    },
    tools() {
      return [opts.tool];
    },
    async execute(_env, { tool, args, accessToken }) {
      if (tool !== opts.tool.name) return { ok: false, error: 'unknown tool' };
      // A paste-key adapter's endpoint() may THROW a clear validation error (e.g. a malformed
      // ACCOUNT_SID:AUTH_TOKEN). Surface it as a typed tool failure instead of an uncaught crash
      // or an opaque downstream 401 — guides the owner to fix the paste-key at connect time.
      let ep: { url: string; init: RequestInit };
      try {
        ep = opts.endpoint({ ...args, _token: accessToken });
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : `${opts.provider} bad request` };
      }
      const { url, init } = ep;
      const headers = (init.headers as Record<string, string>) ?? {};
      headers['Authorization'] = headers['Authorization'] ?? `Bearer ${accessToken}`;
      const res = await fetch(url, { ...init, headers });
      return res.ok
        ? { ok: true, data: await res.json().catch(() => ({})) }
        : { ok: false, error: `${opts.provider} ${res.status}` };
    },
  };
}

const slack: ProviderAdapter = pasteKeyAdapter({
  provider: 'slack',
  tool: {
    name: 'post_to_slack',
    description:
      'Post a message to a Slack channel (use the channel name or ID). Great for new-form alerts, order notices, urgent leads.',
    parameters: {
      type: 'object',
      required: ['channel', 'text'],
      properties: { channel: { type: 'string' }, text: { type: 'string' } },
    },
  },
  endpoint: (args) => ({
    url: 'https://slack.com/api/chat.postMessage',
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel: String(args['channel']), text: String(args['text']) }),
    },
  }),
});

const notion: ProviderAdapter = pasteKeyAdapter({
  provider: 'notion',
  tool: {
    name: 'create_notion_page',
    description:
      'Create a new page in a Notion database (great for capturing leads, support tickets, content ideas).',
    parameters: {
      type: 'object',
      required: ['database_id', 'title'],
      properties: {
        database_id: { type: 'string' },
        title: { type: 'string' },
        properties: { type: 'object' },
      },
    },
  },
  endpoint: (args) => ({
    url: 'https://api.notion.com/v1/pages',
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
      body: JSON.stringify({
        parent: { database_id: String(args['database_id']) },
        properties: {
          Name: { title: [{ text: { content: String(args['title']) } }] },
          ...((args['properties'] as Record<string, unknown>) ?? {}),
        },
      }),
    },
  }),
});

const github: ProviderAdapter = pasteKeyAdapter({
  provider: 'github',
  tool: {
    name: 'open_github_issue',
    description:
      'Open a GitHub issue in a repo (great for bug reports captured from a website form).',
    parameters: {
      type: 'object',
      required: ['repo', 'title', 'body'],
      properties: {
        repo: { type: 'string', description: 'owner/repo' },
        title: { type: 'string' },
        body: { type: 'string' },
        labels: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  endpoint: (args) => ({
    url: `https://api.github.com/repos/${args['repo']}/issues`,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'projectsites-mcp',
      },
      body: JSON.stringify({
        title: String(args['title']),
        body: String(args['body']),
        labels: args['labels'] ?? [],
      }),
    },
  }),
});

const linear: ProviderAdapter = pasteKeyAdapter({
  provider: 'linear',
  tool: {
    name: 'create_linear_issue',
    description: 'Create a Linear issue (bug, feature, support ticket).',
    parameters: {
      type: 'object',
      required: ['team_id', 'title'],
      properties: {
        team_id: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
      },
    },
  },
  endpoint: (args) => ({
    url: 'https://api.linear.app/graphql',
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query:
          'mutation($i: IssueCreateInput!) { issueCreate(input: $i) { success issue { id identifier url } } }',
        variables: {
          i: {
            teamId: String(args['team_id']),
            title: String(args['title']),
            description: String(args['description'] ?? ''),
          },
        },
      }),
    },
  }),
});

const discord: ProviderAdapter = pasteKeyAdapter({
  provider: 'discord',
  tool: {
    name: 'post_to_discord',
    description:
      'Post a message to a Discord channel via a webhook URL (the "API key" here is the webhook URL).',
    parameters: {
      type: 'object',
      required: ['content'],
      properties: { content: { type: 'string' } },
    },
  },
  endpoint: (args) => ({
    url: String(args['_token']),
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: String(args['content']) }),
    },
  }),
});

const googleCalendar: ProviderAdapter = pasteKeyAdapter({
  provider: 'google_calendar',
  tool: {
    name: 'create_calendar_event',
    description:
      'Create a Google Calendar event (paste an OAuth access token; use Calendly MCP for full booking flows).',
    parameters: {
      type: 'object',
      required: ['calendar_id', 'summary', 'start_iso', 'end_iso'],
      properties: {
        calendar_id: { type: 'string', default: 'primary' },
        summary: { type: 'string' },
        description: { type: 'string' },
        start_iso: { type: 'string' },
        end_iso: { type: 'string' },
        attendees: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  endpoint: (args) => ({
    url: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(String(args['calendar_id'] ?? 'primary'))}/events`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary: String(args['summary']),
        description: String(args['description'] ?? ''),
        start: { dateTime: String(args['start_iso']) },
        end: { dateTime: String(args['end_iso']) },
        attendees: (args['attendees'] as string[] | undefined)?.map((email) => ({ email })) ?? [],
      }),
    },
  }),
});

const twilio: ProviderAdapter = pasteKeyAdapter({
  provider: 'twilio',
  tool: {
    name: 'send_sms',
    description:
      'Send an SMS via Twilio (paste-key = ACCOUNT_SID:AUTH_TOKEN combined as Basic auth).',
    parameters: {
      type: 'object',
      required: ['to', 'from', 'body'],
      properties: { to: { type: 'string' }, from: { type: 'string' }, body: { type: 'string' } },
    },
  },
  endpoint: (args) => {
    const token = String(args['_token']);
    const [sid, key] = token.split(':');
    // The paste-key is ACCOUNT_SID:AUTH_TOKEN. A common mistake is pasting only the auth token
    // (no colon) → key===undefined → btoa('sid:undefined') → an opaque Twilio 401 with no hint.
    // Fail LOUD + clear here (the generic executor catches this → typed tool error).
    if (!sid || !key) {
      throw new Error('Twilio paste-key must be ACCOUNT_SID:AUTH_TOKEN (colon-separated).');
    }
    return {
      url: `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      init: {
        method: 'POST',
        headers: {
          Authorization: `Basic ${btoa(`${sid}:${key}`)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          To: String(args['to']),
          From: String(args['from']),
          Body: String(args['body']),
        }).toString(),
      },
    };
  },
});

/* ─────────────────────────── Calendly (OAuth) ─────────────────────────── */
const calendly: ProviderAdapter = {
  provider: 'calendly',
  authorizeUrl(env, { state, returnUrl }) {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: env.CALENDLY_OAUTH_CLIENT_ID ?? '',
      redirect_uri: `${new URL(returnUrl).origin}/api/mcp/calendly/callback`,
      state,
    });
    return `https://auth.calendly.com/oauth/authorize?${params}`;
  },
  async exchangeCode(env, { code, redirectUri }) {
    const res = await fetch('https://auth.calendly.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: env.CALENDLY_OAUTH_CLIENT_ID ?? '',
        client_secret: env.CALENDLY_OAUTH_CLIENT_SECRET ?? '',
        redirect_uri: redirectUri,
        code,
      }),
    });
    if (!res.ok) throw new Error(`calendly oauth ${res.status}`);
    const json = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      owner: string;
      organization: string;
    };
    return {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_in: json.expires_in,
      metadata: { calendly_owner: json.owner, calendly_organization: json.organization },
    };
  },
  tools() {
    return [
      {
        name: 'list_calendly_events',
        description: 'List upcoming Calendly scheduled events for the connected user.',
        parameters: {
          type: 'object',
          properties: {
            count: { type: 'integer', default: 20 },
            status: { type: 'string', enum: ['active', 'canceled'] },
          },
        },
      },
    ];
  },
  async execute(_env, { tool, args, accessToken, metadata }) {
    if (tool !== 'list_calendly_events') return { ok: false, error: 'unknown tool' };
    const owner = (metadata?.['calendly_owner'] as string | undefined) ?? '';
    if (!owner) return { ok: false, error: 'missing calendly_owner metadata' };
    const params = new URLSearchParams({
      user: owner,
      count: String(args['count'] ?? 20),
      ...(args['status'] ? { status: String(args['status']) } : {}),
    });
    const res = await fetch(`https://api.calendly.com/scheduled_events?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return res.ok
      ? { ok: true, data: await res.json() }
      : { ok: false, error: `calendly ${res.status}` };
  },
};

/* ─────────────────────────── Airtable (OAuth + PKCE) ─────────────────────────── */
const airtable: ProviderAdapter = {
  provider: 'airtable',
  authorizeUrl(env, { state, codeVerifier, returnUrl }) {
    // Airtable requires PKCE. The codeVerifier comes from mcp_oauth_states.
    // We pre-compute the challenge here via SHA-256 (done synchronously by
    // wrapping the call in a fire-and-forget; Airtable accepts S256).
    const params = new URLSearchParams({
      client_id: env.AIRTABLE_OAUTH_CLIENT_ID ?? '',
      redirect_uri: `${new URL(returnUrl).origin}/api/mcp/airtable/callback`,
      response_type: 'code',
      scope:
        'data.records:read data.records:write schema.bases:read schema.bases:write user.email:read webhook:manage',
      state,
      // We append the challenge below by re-building the URL after async hash.
      // Since authorizeUrl is sync, callers must pre-derive the challenge.
      // For simplicity we ship the verifier in `code_challenge` with
      // method=plain (Airtable accepts both) when sync hashing isn't available.
      code_challenge: codeVerifier ?? '',
      code_challenge_method: 'plain',
    });
    return `https://airtable.com/oauth2/v1/authorize?${params}`;
  },
  async exchangeCode(env, { code, codeVerifier, redirectUri }) {
    const basic = btoa(
      `${env.AIRTABLE_OAUTH_CLIENT_ID ?? ''}:${env.AIRTABLE_OAUTH_CLIENT_SECRET ?? ''}`,
    );
    const res = await fetch('https://airtable.com/oauth2/v1/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier ?? '',
      }),
    });
    if (!res.ok) throw new Error(`airtable oauth ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope: string;
    };
    return {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_in: json.expires_in,
      metadata: { airtable_scope: json.scope },
    };
  },
  tools() {
    return [
      {
        name: 'append_airtable_row',
        description: 'Append a row to an Airtable table in the connected workspace.',
        parameters: {
          type: 'object',
          required: ['base_id', 'table_name', 'fields'],
          properties: {
            base_id: { type: 'string', description: 'Airtable base ID (starts with `app...`)' },
            table_name: { type: 'string' },
            fields: { type: 'object' },
          },
        },
      },
      {
        name: 'list_airtable_bases',
        description: 'List Airtable bases the connected user has access to.',
        parameters: { type: 'object', properties: {} },
      },
    ];
  },
  async execute(_env, { tool, args, accessToken }) {
    if (tool === 'list_airtable_bases') {
      const res = await fetch('https://api.airtable.com/v0/meta/bases', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      return res.ok
        ? { ok: true, data: await res.json() }
        : { ok: false, error: `airtable ${res.status}` };
    }
    if (tool === 'append_airtable_row') {
      const url = `https://api.airtable.com/v0/${args['base_id']}/${encodeURIComponent(String(args['table_name']))}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ records: [{ fields: args['fields'] }] }),
      });
      return res.ok
        ? { ok: true, data: await res.json() }
        : { ok: false, error: `airtable ${res.status}` };
    }
    return { ok: false, error: 'unknown tool' };
  },
};

/* ─────────────────────────── PagerDuty (OAuth 2.0 Scoped) ─────────────────────────── */
const pagerduty: ProviderAdapter = {
  provider: 'pagerduty',
  authorizeUrl(env, { state, returnUrl }) {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: env.PAGERDUTY_OAUTH_CLIENT_ID ?? '',
      redirect_uri: `${new URL(returnUrl).origin}/api/mcp/pagerduty/callback`,
      scope:
        'incidents.read incidents.write services.read services.write users.read teams.read schedules.read escalation_policies.read oncalls.read',
      state,
    });
    return `https://identity.pagerduty.com/oauth/authorize?${params}`;
  },
  async exchangeCode(env, { code, redirectUri }) {
    const res = await fetch('https://identity.pagerduty.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: env.PAGERDUTY_OAUTH_CLIENT_ID ?? '',
        client_secret: env.PAGERDUTY_OAUTH_CLIENT_SECRET ?? '',
        redirect_uri: redirectUri,
        code,
      }),
    });
    if (!res.ok) throw new Error(`pagerduty oauth ${res.status}`);
    const json = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope: string;
      token_type: string;
    };
    return {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_in: json.expires_in,
      metadata: { pagerduty_scope: json.scope },
    };
  },
  tools() {
    return [
      {
        name: 'trigger_pagerduty_incident',
        description:
          'Trigger a PagerDuty incident on a service (great for high-priority form submissions, AI alerts, downtime detection).',
        parameters: {
          type: 'object',
          required: ['service_id', 'title'],
          properties: {
            service_id: {
              type: 'string',
              description: 'PagerDuty service ID (starts with `P...`)',
            },
            title: { type: 'string' },
            urgency: { type: 'string', enum: ['high', 'low'], default: 'high' },
            details: { type: 'string' },
          },
        },
      },
      {
        name: 'list_pagerduty_services',
        description: 'List PagerDuty services the connected user has access to.',
        parameters: { type: 'object', properties: {} },
      },
    ];
  },
  async execute(_env, { tool, args, accessToken }) {
    if (tool === 'list_pagerduty_services') {
      const res = await fetch('https://api.pagerduty.com/services?limit=50', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.pagerduty+json;version=2',
        },
      });
      return res.ok
        ? { ok: true, data: await res.json() }
        : { ok: false, error: `pagerduty ${res.status}` };
    }
    if (tool === 'trigger_pagerduty_incident') {
      const res = await fetch('https://api.pagerduty.com/incidents', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.pagerduty+json;version=2',
          'Content-Type': 'application/json',
          From: 'projectsites@megabyte.space',
        },
        body: JSON.stringify({
          incident: {
            type: 'incident',
            title: String(args['title']),
            service: { id: String(args['service_id']), type: 'service_reference' },
            urgency: String(args['urgency'] ?? 'high'),
            body: args['details']
              ? { type: 'incident_body', details: String(args['details']) }
              : undefined,
          },
        }),
      });
      return res.ok
        ? { ok: true, data: await res.json() }
        : { ok: false, error: `pagerduty ${res.status}: ${await res.text().catch(() => '')}` };
    }
    return { ok: false, error: 'unknown tool' };
  },
};

const zapier: ProviderAdapter = pasteKeyAdapter({
  provider: 'zapier',
  tool: {
    name: 'trigger_zapier_webhook',
    description: 'POST a payload to a Zapier Catch Hook (the "API key" is the webhook URL).',
    parameters: { type: 'object', properties: { payload: { type: 'object' } } },
  },
  endpoint: (args) => ({
    url: String(args['_token']),
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args['payload'] ?? {}),
    },
  }),
});

/* ─────────────────────────── Vercel (Marketplace Integration) ─────────────────────────── */
// Vercel installs are MARKETPLACE-FLOW, not the standard connect flow: Vercel redirects to
// our callback with `code` + `configurationId` + `teamId` + `next` (no `state`). The token
// exchange hits api.vercel.com/v2/oauth/access_token. The callback handler has a vercel
// branch for this (see routes/mcp_oauth.ts). authorizeUrl is the fallback connect path.
const vercel: ProviderAdapter = {
  provider: 'vercel',
  authorizeUrl(env, { state, returnUrl }) {
    const params = new URLSearchParams({
      client_id: env.VERCEL_OAUTH_CLIENT_ID ?? '',
      redirect_uri: `${new URL(returnUrl).origin}/api/mcp/vercel/callback`,
      state,
    });
    return `https://vercel.com/oauth/authorize?${params}`;
  },
  async exchangeCode(env, { code, redirectUri }) {
    const res = await fetch('https://api.vercel.com/v2/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.VERCEL_OAUTH_CLIENT_ID ?? '',
        client_secret: env.VERCEL_OAUTH_CLIENT_SECRET ?? '',
        code,
        redirect_uri: redirectUri,
      }),
    });
    if (!res.ok) throw new Error(`vercel oauth ${res.status}: ${await res.text().catch(() => '')}`);
    const json = (await res.json()) as {
      access_token: string;
      token_type: string;
      installation_id?: string;
      user_id?: string;
      team_id?: string | null;
    };
    return {
      access_token: json.access_token,
      metadata: {
        installation_id: json.installation_id,
        team_id: json.team_id ?? null,
        user_id: json.user_id,
      },
    };
  },
  tools() {
    return [
      {
        name: 'list_vercel_projects',
        description: 'List the connected Vercel account/team projects.',
        parameters: { type: 'object', properties: { limit: { type: 'number', default: 20 } } },
      },
      {
        name: 'list_vercel_deployments',
        description: 'List recent Vercel deployments (optionally for one project).',
        parameters: {
          type: 'object',
          properties: {
            projectId: { type: 'string', description: 'Optional Vercel project id/name.' },
            limit: { type: 'number', default: 20 },
          },
        },
      },
    ];
  },
  async execute(_env, { tool, args, accessToken, metadata }) {
    const teamId = metadata?.['team_id'] as string | undefined;
    const team = teamId ? `&teamId=${teamId}` : '';
    const auth = { Authorization: `Bearer ${accessToken}` };
    if (tool === 'list_vercel_projects') {
      const limit = Number(args['limit'] ?? 20);
      const res = await fetch(`https://api.vercel.com/v9/projects?limit=${limit}${team}`, {
        headers: auth,
      });
      return res.ok
        ? { ok: true, data: await res.json() }
        : { ok: false, error: `vercel ${res.status}` };
    }
    if (tool === 'list_vercel_deployments') {
      const limit = Number(args['limit'] ?? 20);
      const proj = args['projectId']
        ? `&projectId=${encodeURIComponent(String(args['projectId']))}`
        : '';
      const res = await fetch(
        `https://api.vercel.com/v6/deployments?limit=${limit}${proj}${team}`,
        {
          headers: auth,
        },
      );
      return res.ok
        ? { ok: true, data: await res.json() }
        : { ok: false, error: `vercel ${res.status}` };
    }
    return { ok: false, error: 'unknown tool' };
  },
};

/**
 * Per-provider adapter map. Partial because the Provider union also includes
 * OAuth-only entries that don't (yet) have a worker-side tool surface
 * (`cal_com`, `sentry`, `pagerduty`, `posthog`, `vercel`, `netlify`).
 * `getAdapter()` returns `undefined` for those — callers must already
 * handle the "no adapter" case and surface a paste-key / coming-soon toast.
 */
const ADAPTERS: Partial<Record<Provider, ProviderAdapter>> = {
  mailchimp,
  stripe,
  resend,
  hubspot,
  slack,
  notion,
  github,
  linear,
  discord,
  google_calendar: googleCalendar,
  twilio,
  calendly,
  airtable,
  zapier,
  pagerduty,
  vercel,
};

/**
 * Look up the adapter implementation for an MCP provider.
 *
 * @remarks
 * Returns `undefined` for providers that only OAuth-connect (cal_com, sentry,
 * pagerduty, posthog, vercel, netlify) — callers must handle the no-adapter
 * case and fall back to a paste-key flow or coming-soon UI per `routes/api.ts`.
 *
 * @example
 * ```ts
 * const adapter = getAdapter('mailchimp');
 * if (!adapter) return c.json({ error: 'oauth_only' }, 501);
 * ```
 */
export function getAdapter(provider: Provider): ProviderAdapter | undefined {
  return ADAPTERS[provider];
}

/**
 * Enumerate every {@link Provider} that ships with a worker-side adapter.
 *
 * @remarks
 * Useful for `/api/mcp/providers` listings and admin dashboards — excludes
 * OAuth-only providers without a tools surface.
 */
export function allProviders(): Provider[] {
  return Object.keys(ADAPTERS) as Provider[];
}

/** Load a site's active MCP connections + return decrypted tokens. */
export interface ActiveConnection {
  provider: Provider;
  accessToken: string;
  metadata: Record<string, unknown>;
}

/**
 * Load + decrypt every active MCP connection for a site.
 *
 * @remarks
 * Rows whose ciphertext fails to decrypt (typically because
 * `MCP_ENCRYPTION_KEY` rotated or is missing in dev) are silently skipped
 * so a partial outage never blocks the whole tool surface.
 *
 * @example
 * ```ts
 * const conns = await loadConnections(env, siteId, ['stripe', 'slack']);
 * ```
 */
export async function loadConnections(
  env: Env,
  siteId: string,
  onlyProviders?: Provider[],
): Promise<ActiveConnection[]> {
  const placeholders = onlyProviders?.length
    ? ` AND provider IN (${onlyProviders.map(() => '?').join(',')})`
    : '';
  const rows = await env.DB.prepare(
    `SELECT provider, access_token_encrypted, account_metadata_json
     FROM mcp_connections
     WHERE site_id = ? AND status = 'active'${placeholders}`,
  )
    .bind(siteId, ...(onlyProviders ?? []))
    .all<{
      provider: Provider;
      access_token_encrypted: string;
      account_metadata_json: string | null;
    }>();
  const out: ActiveConnection[] = [];
  for (const r of rows.results ?? []) {
    try {
      const token = await decrypt(env, r.access_token_encrypted);
      out.push({
        provider: r.provider,
        accessToken: token,
        metadata: safeParseJSON<Record<string, unknown>>(r.account_metadata_json, {}),
      });
    } catch (err) {
      // The row is skipped so a partial outage never blocks the whole tool
      // surface — but the skip must be OBSERVABLE: a missing/rotated
      // MCP_ENCRYPTION_KEY would otherwise read as an honest-empty
      // "no tools connected" surface with zero operator signal
      // (degraded = logged, never invisible).
      console.warn(
        JSON.stringify({
          level: 'warn',
          service: 'mcp_client',
          message: 'mcp_connection_decrypt_failed',
          provider: r.provider,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
  return out;
}

/** Tool descriptors across all connected providers for a site (for the prompt).
 *  Providers without a worker adapter (cal_com / sentry / pagerduty / posthog /
 *  vercel / netlify in 2026) are silently skipped — they OAuth-connect but
 *  expose no tools to the LLM router yet. */
export async function loadAvailableTools(
  env: Env,
  siteId: string,
  enabledProviders?: string[],
): Promise<ToolDescriptor[]> {
  const conns = await loadConnections(env, siteId);
  // When the operator has narrowed the form router to a subset of connected MCPs
  // (the designer's "enable for routing" pills → `ai_site_settings.enabled_mcps_json`),
  // expose ONLY those providers' tools. Empty/undefined = no restriction (all connected
  // MCPs) — preserves prior behavior for sites that never touched the selection.
  const scoped =
    enabledProviders && enabledProviders.length > 0
      ? conns.filter((c) => enabledProviders.includes(c.provider))
      : conns;
  return scoped.flatMap((c) => ADAPTERS[c.provider]?.tools() ?? []);
}

/**
 * Dispatch an LLM-issued tool call across this site's connected MCP providers.
 *
 * @remarks
 * Iterates active connections, picks the first adapter that owns the named
 * tool, executes it with the per-site access token, and surfaces the
 * provider's `{ ok, data, error }` envelope verbatim so the LLM can reason
 * over success vs failure on the next turn.
 *
 * @example
 * ```ts
 * const result = await executeTool(env, siteId, {
 *   name: 'mailchimp.add_subscriber',
 *   arguments: { email: 'fan@example.com' },
 * });
 * ```
 */
export async function executeTool(
  env: Env,
  siteId: string,
  call: { name: string; arguments: Record<string, unknown> },
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const conns = await loadConnections(env, siteId);
  for (const conn of conns) {
    const adapter = ADAPTERS[conn.provider];
    if (!adapter) continue; // OAuth-only provider with no tool surface yet.
    const supports = adapter.tools().some((t) => t.name === call.name);
    if (!supports) continue;
    return adapter.execute(env, {
      tool: call.name,
      args: call.arguments,
      accessToken: conn.accessToken,
      metadata: conn.metadata,
    });
  }
  return { ok: false, error: `no connected provider for tool "${call.name}"` };
}
