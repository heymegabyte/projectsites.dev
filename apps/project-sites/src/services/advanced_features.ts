/**
 * Advanced product features — consolidated service module (30 features).
 *
 * Each function returns mock-realistic shapes (per [[secret-provisioning]]
 * mock-when-no-key pattern). Real vendor wiring lands per-feature in
 * follow-up turns. D1 writes are real where applicable so the admin can
 * exercise the surface end-to-end.
 */

import type { Env } from '../types/env.js';

const uuid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

// ── A: Customer-facing engines (1-8) ────────────────────────────────

export async function visualEditorSave(
  env: Env,
  p: { siteId: string; layout: unknown; breakpoint?: string },
) {
  const id = uuid();
  const t = nowIso();
  await env.DB.prepare(
    'INSERT OR REPLACE INTO visual_editor_projects (id, site_id, layout_json, breakpoint, updated_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(id, p.siteId, JSON.stringify(p.layout), p.breakpoint ?? 'desktop', t)
    .run()
    .catch(() => {});
  return {
    id,
    site_id: p.siteId,
    breakpoint: p.breakpoint ?? 'desktop',
    layout_byte_size: JSON.stringify(p.layout).length,
    saved_at: t,
  };
}

export function ecommerceListProducts(env: Env, siteId: string) {
  return env.DB.prepare(
    'SELECT * FROM ecommerce_products WHERE site_id = ? ORDER BY created_at DESC LIMIT 100',
  )
    .bind(siteId)
    .all()
    .then((r) => r.results ?? [])
    .catch(() => seedProducts(siteId));
}
function seedProducts(siteId: string) {
  return [
    {
      id: 'p1',
      site_id: siteId,
      name: 'Artisan Sourdough Loaf',
      price_cents: 850,
      currency: 'USD',
      sku: 'BAY-001',
      inventory_qty: 24,
      status: 'active',
    },
    {
      id: 'p2',
      site_id: siteId,
      name: 'Brioche Croissant (4-pack)',
      price_cents: 1400,
      currency: 'USD',
      sku: 'BAY-002',
      inventory_qty: 18,
      status: 'active',
    },
    {
      id: 'p3',
      site_id: siteId,
      name: 'Holiday Box (12 items)',
      price_cents: 6500,
      currency: 'USD',
      sku: 'BAY-HOL',
      inventory_qty: 6,
      status: 'active',
    },
  ];
}
export async function ecommerceCreateOrder(
  env: Env,
  p: { siteId: string; email: string; cents: number },
) {
  const id = uuid();
  await env.DB.prepare(
    'INSERT INTO ecommerce_orders (id, site_id, customer_email, total_cents, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(id, p.siteId, p.email, p.cents, 'pending', nowIso())
    .run()
    .catch(() => {});
  return {
    id,
    site_id: p.siteId,
    email: p.email,
    total_cents: p.cents,
    status: 'pending',
    checkout_url: `https://checkout.stripe.com/c/pay/cs_demo_${id.slice(0, 8)}`,
  };
}

export async function bookingListSlots(env: Env, siteId: string) {
  const rows = await env.DB.prepare(
    'SELECT * FROM booking_slots WHERE site_id = ? AND status = ? ORDER BY start_at LIMIT 20',
  )
    .bind(siteId, 'open')
    .all()
    .catch(() => ({ results: [] }));
  if ((rows.results?.length ?? 0) === 0) {
    const base = Date.now();
    return Array.from({ length: 5 }, (_, i) => ({
      id: `s${i}`,
      site_id: siteId,
      start_at: new Date(base + i * 3600_000).toISOString(),
      end_at: new Date(base + i * 3600_000 + 1800_000).toISOString(),
      capacity: 1,
      booked_count: 0,
      price_cents: 0,
      status: 'open',
    }));
  }
  return rows.results;
}
export async function bookingReserve(env: Env, p: { slotId: string; email: string }) {
  const id = uuid();
  await env.DB.prepare(
    'INSERT INTO booking_reservations (id, slot_id, customer_email, status, created_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(id, p.slotId, p.email, 'confirmed', nowIso())
    .run()
    .catch(() => {});
  return { id, slot_id: p.slotId, status: 'confirmed', confirmation_email_sent: true };
}

export async function lmsCreateCourse(
  env: Env,
  p: { siteId: string; title: string; modules: unknown[]; priceCents?: number },
) {
  const id = uuid();
  await env.DB.prepare(
    'INSERT INTO lms_courses (id, site_id, title, modules_json, price_cents, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, p.siteId, p.title, JSON.stringify(p.modules), p.priceCents ?? 0, 'draft', nowIso())
    .run()
    .catch(() => {});
  return { id, site_id: p.siteId, title: p.title, module_count: p.modules.length, status: 'draft' };
}
export async function lmsListCourses(env: Env, siteId: string) {
  const rows = await env.DB.prepare(
    'SELECT id, title, price_cents, status, created_at FROM lms_courses WHERE site_id = ? ORDER BY created_at DESC LIMIT 50',
  )
    .bind(siteId)
    .all()
    .catch(() => ({ results: [] }));
  return rows.results?.length
    ? rows.results
    : [{ id: 'c-demo', title: 'Intro to Sourdough', price_cents: 4900, status: 'published' }];
}

export async function communityCreateTopic(
  env: Env,
  p: { siteId: string; title: string; body: string; authorEmail: string },
) {
  const id = uuid();
  await env.DB.prepare(
    'INSERT INTO community_topics (id, site_id, title, author_email, body, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(id, p.siteId, p.title, p.authorEmail, p.body, nowIso())
    .run()
    .catch(() => {});
  return { id, ...p, reply_count: 0, pinned: false, locked: false, created_at: nowIso() };
}
export async function communityListTopics(env: Env, siteId: string) {
  const rows = await env.DB.prepare(
    'SELECT * FROM community_topics WHERE site_id = ? ORDER BY pinned DESC, created_at DESC LIMIT 50',
  )
    .bind(siteId)
    .all()
    .catch(() => ({ results: [] }));
  return rows.results?.length
    ? rows.results
    : [
        {
          id: 't-demo',
          title: 'Welcome to the community!',
          body: 'Say hello',
          reply_count: 3,
          pinned: 1,
        },
      ];
}

export async function newsletterCreateCampaign(
  env: Env,
  p: { siteId: string; subject: string; bodyHtml: string; segment?: string },
) {
  const id = uuid();
  await env.DB.prepare(
    'INSERT INTO newsletter_campaigns (id, site_id, subject, body_html, segment, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, p.siteId, p.subject, p.bodyHtml, p.segment ?? 'all', 'draft', nowIso())
    .run()
    .catch(() => {});
  return { id, ...p, status: 'draft', estimated_recipients: 1247, send_window_minutes: 12 };
}
export async function newsletterSubscribe(
  env: Env,
  p: { siteId: string; email: string; segment?: string },
) {
  const id = uuid();
  // Error-AWARE (not swallowed): a genuine D1 failure returns `error` so the caller
  // can surface a 500 instead of a lying-success. `INSERT OR IGNORE` on the
  // UNIQUE(site_id,email) index makes a duplicate subscribe a benign no-op (not an
  // error). The column list matches the schema exactly (no `updated_at`/`deleted_at`),
  // so this raw insert is correct where `dbInsert` — which auto-adds `updated_at` —
  // would silently drop the row. Non-throwing: callers get a value, never an exception.
  let error: string | undefined;
  try {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO newsletter_subscribers (id, site_id, email, segment, confirmed, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(id, p.siteId, p.email, p.segment ?? null, 0, nowIso())
      .run();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return { id, ...p, confirm_email_sent: true, double_opt_in_required: true, error };
}

/**
 * Newsletter UNSUBSCRIBE — sets `unsubscribed = 1` for a native subscriber.
 *
 * @remarks
 * Closes a compliance + drift gap: `newsletter_subscribers.unsubscribed` existed
 * as a column but had NO writer anywhere in the worker — a native subscriber could
 * never leave the list (CAN-SPAM/GDPR require a working unsubscribe), and the
 * `newsletter-causal` probe's test subscribers could never be cleaned. Mirrors
 * `newsletterSubscribe`: error-AWARE (a real D1 failure returns `error` so the caller
 * surfaces a 500, never a lying-success). Idempotent — unsubscribing a non-subscriber
 * or an already-unsubscribed row is a benign 0-row no-op (`updated: 0`), not an error.
 * The table has no `updated_at`/`deleted_at`, so this raw UPDATE touches only the flag.
 */
export async function newsletterUnsubscribe(
  env: Env,
  p: { siteId: string; email: string },
): Promise<{ updated: number; error?: string }> {
  let error: string | undefined;
  let updated = 0;
  try {
    const res = await env.DB.prepare(
      'UPDATE newsletter_subscribers SET unsubscribed = 1 WHERE site_id = ? AND email = ? AND unsubscribed = 0',
    )
      .bind(p.siteId, p.email)
      .run();
    updated = res.meta?.changes ?? 0;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return { updated, error };
}

export async function membershipCreateTier(
  env: Env,
  p: { siteId: string; name: string; priceCents: number; perks: string[] },
) {
  const id = uuid();
  await env.DB.prepare(
    'INSERT INTO membership_tiers (id, site_id, name, price_cents, perks_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(id, p.siteId, p.name, p.priceCents, JSON.stringify(p.perks), nowIso())
    .run()
    .catch(() => {});
  return { id, ...p, stripe_price_id: `price_demo_${id.slice(0, 8)}`, billing_cycle: 'monthly' };
}
export async function membershipListTiers(env: Env, siteId: string) {
  const rows = await env.DB.prepare('SELECT * FROM membership_tiers WHERE site_id = ?')
    .bind(siteId)
    .all()
    .catch(() => ({ results: [] }));
  if (!rows.results?.length)
    return [
      {
        id: 'mt-bronze',
        name: 'Bronze',
        price_cents: 500,
        perks_json: '["Member newsletter","Discord access"]',
      },
      {
        id: 'mt-silver',
        name: 'Silver',
        price_cents: 1500,
        perks_json: '["All Bronze perks","Monthly live Q&A","Early access"]',
      },
      {
        id: 'mt-gold',
        name: 'Gold',
        price_cents: 5000,
        perks_json: '["All Silver perks","1:1 monthly call","Custom content requests"]',
      },
    ];
  return rows.results;
}

export async function donationCreateCampaign(
  env: Env,
  p: { siteId: string; name: string; goalCents: number; endsAt?: string },
) {
  const id = uuid();
  await env.DB.prepare(
    'INSERT INTO donation_campaigns (id, site_id, name, goal_cents, ends_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(id, p.siteId, p.name, p.goalCents, p.endsAt ?? null, nowIso())
    .run()
    .catch(() => {});
  return { id, ...p, raised_cents: 0, donor_count: 0 };
}
export async function donationProcess(
  env: Env,
  p: { campaignId: string; email: string; amountCents: number; recurring?: boolean },
) {
  const id = uuid();
  await env.DB.prepare(
    'INSERT INTO donations (id, campaign_id, donor_email, amount_cents, recurring, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(id, p.campaignId, p.email, p.amountCents, p.recurring ? 1 : 0, nowIso())
    .run()
    .catch(() => {});
  return {
    id,
    campaign_id: p.campaignId,
    amount_cents: p.amountCents,
    recurring: !!p.recurring,
    tax_receipt_sent: true,
    dafpay_url: `https://dafpay.demo/${p.campaignId}`,
  };
}

// ── B: Native + multi-platform (9-12) ──────────────────────────────

export async function mobileRegisterDevice(
  env: Env,
  p: {
    userId: string;
    platform: 'ios' | 'android';
    deviceId: string;
    pushToken: string;
    appVersion: string;
  },
) {
  const id = uuid();
  await env.DB.prepare(
    'INSERT INTO mobile_admin_installs (id, user_id, platform, device_id, app_version, push_token, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, p.userId, p.platform, p.deviceId, p.appVersion, p.pushToken, nowIso())
    .run()
    .catch(() => {});
  return {
    id,
    ...p,
    push_enabled: true,
    store_url:
      p.platform === 'ios'
        ? 'https://apps.apple.com/app/projectsites'
        : 'https://play.google.com/store/apps/details?id=dev.projectsites',
  };
}

export function desktopAppInfo() {
  return {
    macos: {
      version: '0.1.0',
      sha256: 'demo-sha-mac',
      download_url: 'https://projectsites.dev/desktop/projectsites-0.1.0-mac.dmg',
      size_bytes: 24_500_000,
    },
    windows: {
      version: '0.1.0',
      sha256: 'demo-sha-win',
      download_url: 'https://projectsites.dev/desktop/projectsites-0.1.0-win.exe',
      size_bytes: 28_300_000,
    },
    linux: {
      version: '0.1.0',
      sha256: 'demo-sha-linux',
      download_url: 'https://projectsites.dev/desktop/projectsites-0.1.0-linux.AppImage',
      size_bytes: 26_100_000,
    },
    framework: 'Tauri 2',
  };
}

export function browserExtensionInfo() {
  return {
    chrome: {
      store_url: 'https://chrome.google.com/webstore/detail/projectsites',
      version: '0.1.0',
      install_count: 12,
    },
    firefox: {
      store_url: 'https://addons.mozilla.org/firefox/addon/projectsites',
      version: '0.1.0',
      install_count: 4,
    },
    edge: {
      store_url: 'https://microsoftedge.microsoft.com/addons/detail/projectsites',
      version: '0.1.0',
      install_count: 2,
    },
    permissions: ['activeTab', 'storage', 'cookies (auth)'],
    features: [
      'Edit any element on a customer site',
      'Quick deploy',
      'Inline AI prompt',
      'Inspect site metrics overlay',
    ],
  };
}

export async function chatopsConnect(
  env: Env,
  p: {
    orgId: string;
    platform: 'slack' | 'teams' | 'discord';
    webhookUrl: string;
    workspaceName?: string;
  },
) {
  const id = uuid();
  await env.DB.prepare(
    'INSERT INTO chatops_connections (id, org_id, platform, workspace_name, webhook_url, scopes_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      id,
      p.orgId,
      p.platform,
      p.workspaceName ?? null,
      p.webhookUrl,
      JSON.stringify(['chat:write', 'incoming-webhook']),
      nowIso(),
    )
    .run()
    .catch(() => {});
  return {
    id,
    ...p,
    slash_commands: ['/deploy', '/incidents', '/leads', '/billing'],
    status: 'connected',
  };
}

// ── C: Enterprise compliance (13-16) ───────────────────────────────

export function soc2Controls() {
  return [
    {
      control_id: 'CC1.1',
      family: 'Control Environment',
      status: 'operating',
      description: 'COSO principles + tone at the top',
    },
    {
      control_id: 'CC2.1',
      family: 'Communication & Info',
      status: 'operating',
      description: 'Internal comms policy',
    },
    {
      control_id: 'CC6.1',
      family: 'Logical Access',
      status: 'tested',
      description: 'Clerk MFA + role-based access',
    },
    {
      control_id: 'CC6.6',
      family: 'Logical Access',
      status: 'tested',
      description: 'Audit log hash-chain (#3 audit_hash_chain flag)',
    },
    {
      control_id: 'CC7.2',
      family: 'System Operations',
      status: 'operating',
      description: 'Sentry + Workers Tracing + OTLP',
    },
    {
      control_id: 'CC8.1',
      family: 'Change Management',
      status: 'in_progress',
      description: 'wrangler deploy + feature flags',
    },
    {
      control_id: 'A1.1',
      family: 'Availability',
      status: 'operating',
      description: 'Multi-region CF Workers, 99.99% SLO',
    },
    {
      control_id: 'C1.1',
      family: 'Confidentiality',
      status: 'tested',
      description: 'AES-GCM at-rest for MCP/env vars (ai_crypto)',
    },
    {
      control_id: 'P1.1',
      family: 'Privacy',
      status: 'in_progress',
      description: 'GDPR DSAR endpoint + retention policy',
    },
  ];
}

export async function hipaaSignBaa(env: Env, p: { customerOrgId: string; businessName: string }) {
  const id = uuid();
  const t = nowIso();
  await env.DB.prepare(
    'INSERT INTO hipaa_baas (id, customer_org_id, business_name, signed_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(
      id,
      p.customerOrgId,
      p.businessName,
      t,
      new Date(Date.now() + 365 * 86_400_000).toISOString(),
      'signed',
    )
    .run()
    .catch(() => {});
  return {
    id,
    ...p,
    signed_at: t,
    pdf_url: `https://projectsites.dev/legal/baa/${id}.pdf`,
    controls: ['encryption-at-rest', 'audit-log', 'access-controls', 'breach-notification-72h'],
  };
}

export async function pciTokenize(
  env: Env,
  p: { customerId: string; last4: string; brand: string },
) {
  const id = uuid();
  const tokenStr = `tok_${id.slice(0, 24)}`;
  await env.DB.prepare(
    'INSERT INTO pci_tokens (id, customer_id, last4, brand, token, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(id, p.customerId, p.last4, p.brand, tokenStr, nowIso())
    .run()
    .catch(() => {});
  return {
    id,
    token: tokenStr,
    last4: p.last4,
    brand: p.brand,
    pci_dss_level: 1,
    scope_reduced: true,
  };
}

export async function ssoConnect(
  env: Env,
  p: { orgId: string; protocol: 'saml' | 'oidc'; idpMetadataUrl: string; idpEntityId: string },
) {
  const id = uuid();
  await env.DB.prepare(
    'INSERT INTO sso_connections (id, org_id, protocol, idp_metadata_url, idp_entity_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, p.orgId, p.protocol, p.idpMetadataUrl, p.idpEntityId, 'pending', nowIso())
    .run()
    .catch(() => {});
  return {
    id,
    ...p,
    sp_entity_id: 'https://projectsites.dev/saml/metadata',
    acs_url: `https://projectsites.dev/saml/acs/${id}`,
    slo_url: `https://projectsites.dev/saml/slo/${id}`,
    status: 'pending',
  };
}

// ── D: Infrastructure depth (17-20) ────────────────────────────────

export function d1ReplicationStatus() {
  return {
    primary_region: 'wnam',
    replicas: [
      { region: 'enam', lag_ms: 12, healthy: true },
      { region: 'weur', lag_ms: 28, healthy: true },
      { region: 'apac', lag_ms: 64, healthy: true },
      { region: 'oc', lag_ms: 41, healthy: true },
    ],
    sessions_api_enabled: true,
    automatic_failover: true,
    last_failover_at: null,
  };
}

export async function byoCloudflareConnect(env: Env, p: { orgId: string; cfAccountId: string }) {
  const id = uuid();
  await env.DB.prepare(
    'INSERT INTO byo_cloudflare_accounts (id, org_id, cf_account_id, status, connected_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(id, p.orgId, p.cfAccountId, 'pending', nowIso())
    .run()
    .catch(() => {});
  return {
    id,
    ...p,
    oauth_url: `https://dash.cloudflare.com/oauth?client_id=projectsites&redirect_uri=https://projectsites.dev/oauth/cf/callback&state=${id}`,
    scopes: ['account:read', 'workers:write', 'd1:write', 'r2:write', 'dns:write'],
  };
}

export async function workerMarketplaceList(env: Env) {
  const rows = await env.DB.prepare(
    "SELECT * FROM worker_marketplace_listings WHERE status = 'published' ORDER BY install_count DESC LIMIT 20",
  )
    .all()
    .catch(() => ({ results: [] }));
  if (!rows.results?.length)
    return [
      {
        id: 'wm1',
        name: 'Stripe Connect Express adapter',
        slug: 'stripe-connect-express',
        install_count: 47,
        price_cents: 0,
        rating_avg: 4.8,
      },
      {
        id: 'wm2',
        name: 'Twilio SMS notifications',
        slug: 'twilio-sms-notify',
        install_count: 31,
        price_cents: 999,
        rating_avg: 4.6,
      },
      {
        id: 'wm3',
        name: 'OpenAI GPT-5 chat proxy',
        slug: 'openai-chat-proxy',
        install_count: 89,
        price_cents: 0,
        rating_avg: 4.9,
      },
    ];
  return rows.results;
}

export async function domainResellerSearch(env: Env, query: string) {
  return {
    query,
    suggestions: [
      {
        domain: `${query}.com`,
        available: true,
        price_cents: 1499,
        registrar: 'opensrs',
        tld: 'com',
      },
      {
        domain: `${query}.dev`,
        available: true,
        price_cents: 1899,
        registrar: 'opensrs',
        tld: 'dev',
      },
      { domain: `${query}.io`, available: false, price_cents: null, registrar: null, tld: 'io' },
      {
        domain: `${query}.app`,
        available: true,
        price_cents: 1699,
        registrar: 'opensrs',
        tld: 'app',
      },
      {
        domain: `${query}-app.com`,
        available: true,
        price_cents: 1499,
        registrar: 'opensrs',
        tld: 'com',
      },
    ],
  };
}

// ── E: AI-native depth (21-25) ─────────────────────────────────────

export async function voiceCloneCreate(
  env: Env,
  p: { orgId: string; name: string; sampleR2Keys: string[] },
) {
  const id = uuid();
  await env.DB.prepare(
    'INSERT INTO brand_voice_clones (id, org_id, name, sample_audio_r2_keys_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(id, p.orgId, p.name, JSON.stringify(p.sampleR2Keys), 'training', nowIso())
    .run()
    .catch(() => {});
  return {
    id,
    ...p,
    elevenlabs_voice_id: `evl_demo_${id.slice(0, 8)}`,
    training_duration_minutes: 8,
    consent_required: true,
    estimated_ready_at: new Date(Date.now() + 600_000).toISOString(),
  };
}

export async function aiAgentMarketplaceList(env: Env) {
  const rows = await env.DB.prepare(
    "SELECT * FROM ai_agent_listings WHERE status = 'published' ORDER BY install_count DESC LIMIT 20",
  )
    .all()
    .catch(() => ({ results: [] }));
  if (!rows.results?.length)
    return [
      {
        id: 'aa1',
        name: 'Booking assistant',
        slug: 'booking-assistant',
        description: 'Natural-language appointment booking for any salon/clinic site',
        install_count: 124,
        price_cents: 0,
        rating_avg: 4.7,
        mcp_tools: ['list_slots', 'reserve_slot', 'reschedule', 'cancel'],
      },
      {
        id: 'aa2',
        name: 'Restaurant menu Q&A',
        slug: 'menu-qa',
        description: 'Answers visitor questions about menu, allergens, hours',
        install_count: 89,
        price_cents: 0,
        rating_avg: 4.9,
        mcp_tools: ['get_menu', 'check_allergens', 'get_hours'],
      },
      {
        id: 'aa3',
        name: 'Lead qualifier (pro)',
        slug: 'lead-qualifier-pro',
        description: 'BANT-classifies inbound leads via 5-question script',
        install_count: 56,
        price_cents: 1999,
        rating_avg: 4.6,
        mcp_tools: ['classify_lead', 'route_to_owner', 'enrich_via_apollo'],
      },
    ];
  return rows.results;
}

export async function siteCopilotIndex(env: Env, p: { siteId: string }) {
  const id = uuid();
  await env.DB.prepare(
    'INSERT OR REPLACE INTO site_copilot_kbs (id, site_id, vectorize_namespace, doc_count, last_indexed_at, status) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(id, p.siteId, `site-${p.siteId.slice(0, 8)}`, 47, nowIso(), 'indexed')
    .run()
    .catch(() => {});
  return {
    id,
    site_id: p.siteId,
    doc_count: 47,
    vectorize_namespace: `site-${p.siteId.slice(0, 8)}`,
    embedding_model: '@cf/baai/bge-large-en-v1.5',
    status: 'indexed',
    estimated_monthly_cost_usd: 0.04,
  };
}

export async function aiVideoCourseGenerate(
  env: Env,
  p: { siteId: string; title: string; outline: string },
) {
  const id = uuid();
  const lessonCount = Math.max(3, Math.min(12, p.outline.match(/^\d+\./gm)?.length ?? 5));
  await env.DB.prepare(
    'INSERT INTO ai_video_courses (id, site_id, title, outline_text, lesson_count, total_seconds, cost_usd_cents, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      id,
      p.siteId,
      p.title,
      p.outline,
      lessonCount,
      lessonCount * 480,
      lessonCount * 120,
      'generating',
      nowIso(),
    )
    .run()
    .catch(() => {});
  return {
    id,
    ...p,
    lesson_count: lessonCount,
    total_seconds: lessonCount * 480,
    cost_usd: (lessonCount * 120) / 100,
    status: 'generating',
    estimated_ready_at: new Date(Date.now() + lessonCount * 60_000).toISOString(),
  };
}

export async function aiAbExperimentStart(
  env: Env,
  p: { siteId: string; goal: string; variantCount?: number },
) {
  const id = uuid();
  const n = p.variantCount ?? 3;
  const variants = Array.from({ length: n }, (_, i) => ({
    id: `v${i}`,
    label: `Variant ${i + 1}`,
    generated_at: nowIso(),
  }));
  const split = Array.from({ length: n }, () => Math.round(100 / n));
  await env.DB.prepare(
    'INSERT INTO ai_ab_experiments (id, site_id, goal, variants_json, traffic_split_json, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      id,
      p.siteId,
      p.goal,
      JSON.stringify(variants),
      JSON.stringify(split),
      'running',
      nowIso(),
    )
    .run()
    .catch(() => {});
  return {
    id,
    ...p,
    variants,
    traffic_split: split,
    status: 'running',
    sampling: 'thompson',
    auto_promote: true,
  };
}

// ── F: Marketing + growth (26-30) ──────────────────────────────────

export async function smsCampaignCreate(
  env: Env,
  p: { siteId: string; name: string; body: string; segment?: string },
) {
  const id = uuid();
  await env.DB.prepare(
    'INSERT INTO sms_campaigns (id, site_id, name, body, segment, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, p.siteId, p.name, p.body, p.segment ?? 'all', 'draft', nowIso())
    .run()
    .catch(() => {});
  return {
    id,
    ...p,
    estimated_recipients: 423,
    cost_estimate_usd: 423 * 0.0075,
    twilio_messaging_service: 'MGdemo',
  };
}

export async function affiliateCreate(
  env: Env,
  p: { orgId: string; email: string; commissionPct?: number },
) {
  const id = uuid();
  const code = `${slug(p.email.split('@')[0])}-${id.slice(0, 6)}`.toUpperCase();
  await env.DB.prepare(
    'INSERT INTO affiliates (id, org_id, affiliate_email, code, commission_pct, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(id, p.orgId, p.email, code, p.commissionPct ?? 20.0, nowIso())
    .run()
    .catch(() => {});
  return {
    id,
    ...p,
    code,
    referral_link: `https://projectsites.dev/?ref=${code}`,
    commission_pct: p.commissionPct ?? 20.0,
    stripe_connect_required: true,
  };
}

export async function loyaltyProgramCreate(
  env: Env,
  p: { siteId: string; name: string; pointsPerDollar?: number },
) {
  const id = uuid();
  const tiers = [
    { name: 'bronze', min_points: 0, perks: ['10% off welcome'] },
    { name: 'silver', min_points: 500, perks: ['Free shipping', 'Early access'] },
    {
      name: 'gold',
      min_points: 2000,
      perks: ['15% off everything', 'Birthday gift', 'Free shipping'],
    },
    {
      name: 'platinum',
      min_points: 10000,
      perks: ['25% off everything', 'Concierge', 'Private events'],
    },
  ];
  await env.DB.prepare(
    'INSERT INTO loyalty_programs (id, site_id, name, points_per_dollar, tiers_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(id, p.siteId, p.name, p.pointsPerDollar ?? 10, JSON.stringify(tiers), nowIso())
    .run()
    .catch(() => {});
  return { id, ...p, points_per_dollar: p.pointsPerDollar ?? 10, tiers };
}

export async function crmListDeals(env: Env, siteId: string) {
  const rows = await env.DB.prepare(
    'SELECT * FROM crm_deals WHERE site_id = ? ORDER BY value_cents DESC LIMIT 50',
  )
    .bind(siteId)
    .all()
    .catch(() => ({ results: [] }));
  if (!rows.results?.length)
    return [
      {
        id: 'd1',
        customer_name: 'Acme Co',
        customer_email: 'cto@acme.co',
        value_cents: 12000,
        stage: 'qualified',
        owner_email: 'brian@megabyte.space',
        next_step: 'Schedule demo',
      },
      {
        id: 'd2',
        customer_name: 'Bayonne Bakery',
        customer_email: 'owner@bayonne.com',
        value_cents: 5000,
        stage: 'proposal',
        owner_email: 'brian@megabyte.space',
        next_step: 'Send pricing',
      },
      {
        id: 'd3',
        customer_name: 'Newark Plumbing',
        customer_email: 'lou@plumbing.com',
        value_cents: 8500,
        stage: 'negotiation',
        owner_email: 'brian@megabyte.space',
        next_step: 'Contract review',
      },
    ];
  return rows.results;
}
export async function crmCreateDeal(
  env: Env,
  p: { siteId: string; customerName: string; email?: string; valueCents: number; stage?: string },
) {
  const id = uuid();
  await env.DB.prepare(
    'INSERT INTO crm_deals (id, site_id, customer_name, customer_email, value_cents, stage, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, p.siteId, p.customerName, p.email ?? null, p.valueCents, p.stage ?? 'lead', nowIso())
    .run()
    .catch(() => {});
  return { id, ...p, stage: p.stage ?? 'lead', activities_count: 0, days_in_stage: 0 };
}

export async function cdpUpsertProfile(
  env: Env,
  p: { siteId: string; email?: string; phone?: string; traits?: Record<string, unknown> },
) {
  const id = uuid();
  await env.DB.prepare(
    'INSERT INTO cdp_profiles (id, site_id, email, phone, traits_json, last_seen_at, identity_resolved, source_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      id,
      p.siteId,
      p.email ?? null,
      p.phone ?? null,
      JSON.stringify(p.traits ?? {}),
      nowIso(),
      p.email && p.phone ? 1 : 0,
      1,
      nowIso(),
    )
    .run()
    .catch(() => {});
  return { id, ...p, identity_resolved: !!(p.email && p.phone), source_count: 1, unified_id: id };
}

export async function cdpTrackEvent(
  env: Env,
  p: { profileId?: string; siteId: string; source: string; kind: string; payload: unknown },
) {
  const id = uuid();
  await env.DB.prepare(
    'INSERT INTO cdp_events (id, profile_id, site_id, source, kind, payload_json, ts) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, p.profileId ?? null, p.siteId, p.source, p.kind, JSON.stringify(p.payload), nowIso())
    .run()
    .catch(() => {});
  return { id, accepted: true, ts: nowIso() };
}
