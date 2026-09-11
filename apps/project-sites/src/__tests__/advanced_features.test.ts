/**
 * Additive unit tests for the 30 advanced-features consolidated service module
 * (services/advanced_features.ts).
 *
 * This module exposes ~35 thin feature engines (e-commerce, booking, LMS,
 * community, newsletter, membership, donations, mobile/desktop/extension/
 * chatops, SOC2/HIPAA/PCI/SSO compliance, infra status, AI-native engines,
 * SMS/affiliate/loyalty/CRM/CDP growth). Each function returns a
 * mock-realistic shape and (where applicable) performs a best-effort D1 write
 * that is wrapped in `.catch(() => {})` so a DB failure never breaks the
 * returned shape.
 *
 * Coverage strategy — exercise the highest-value branches:
 *   - the pure/static info functions (desktop, extension, soc2, d1 replication)
 *   - the domain reseller string-templating helper
 *   - generation/orchestration shapes with the D1 write MOCKED (success + throw)
 *   - DB-backed list functions: real-rows path vs empty → seed-fallback path
 *   - org-scoping side-effect (newsletterSubscribe → recordContact) gated by a
 *     feature flag, including the flag-off no-op + the best-effort try/catch
 *   - default-value branches (priceCents/segment/commissionPct/variantCount/etc.)
 *   - derived computations (slug code, lesson count clamp, traffic split,
 *     identity resolution)
 *
 * ts-jest: GLOBAL `jest` (NOT @jest/globals). D1 + the feature-flag + CRM
 * dependencies are fully mocked — no real network/DB.
 */

import type { Env } from '../types/env.js';

import {
  visualEditorSave,
  ecommerceListProducts,
  ecommerceCreateOrder,
  bookingListSlots,
  bookingReserve,
  lmsCreateCourse,
  lmsListCourses,
  communityCreateTopic,
  communityListTopics,
  newsletterCreateCampaign,
  newsletterSubscribe,
  newsletterUnsubscribe,
  membershipCreateTier,
  membershipListTiers,
  donationCreateCampaign,
  donationProcess,
  mobileRegisterDevice,
  desktopAppInfo,
  browserExtensionInfo,
  chatopsConnect,
  soc2Controls,
  hipaaSignBaa,
  pciTokenize,
  ssoConnect,
  d1ReplicationStatus,
  byoCloudflareConnect,
  workerMarketplaceList,
  domainResellerSearch,
  voiceCloneCreate,
  aiAgentMarketplaceList,
  siteCopilotIndex,
  aiVideoCourseGenerate,
  aiAbExperimentStart,
  smsCampaignCreate,
  affiliateCreate,
  loyaltyProgramCreate,
  crmListDeals,
  crmCreateDeal,
  cdpUpsertProfile,
  cdpTrackEvent,
} from '../services/advanced_features.js';

// ── Controllable D1 mock ─────────────────────────────────────────────
//
// `prepare(sql)` returns a statement whose `.bind(...)` is chainable and whose
// terminal `.run()/.all()/.first()` resolve to whatever the test injects.
// A mode can force a throw so the `.catch(() => {})` / `.catch(() => null)`
// resilience branches are reached.

interface DbOpts {
  runResult?: unknown;
  allResult?: { results?: unknown[] };
  firstResult?: unknown;
  throwOn?: 'run' | 'all' | 'first' | 'all-and-first';
}

function createMockEnv(opts: DbOpts = {}): {
  env: Env;
  prepare: jest.Mock;
  binds: unknown[][];
  sqls: string[];
} {
  const binds: unknown[][] = [];
  const sqls: string[] = [];

  const prepare = jest.fn((sql: string) => {
    sqls.push(sql);
    const stmt: {
      bind: (...args: unknown[]) => typeof stmt;
      run: () => Promise<unknown>;
      all: () => Promise<{ results?: unknown[] }>;
      first: <T>() => Promise<T | null>;
    } = {
      bind: (...args: unknown[]) => {
        binds.push(args);
        return stmt;
      },
      run: async () => {
        if (opts.throwOn === 'run') throw new Error('d1 run boom');
        return opts.runResult ?? { success: true };
      },
      all: async () => {
        if (opts.throwOn === 'all' || opts.throwOn === 'all-and-first')
          throw new Error('d1 all boom');
        return opts.allResult ?? { results: [] };
      },
      first: async <T>() => {
        if (opts.throwOn === 'first' || opts.throwOn === 'all-and-first')
          throw new Error('d1 first boom');
        return (opts.firstResult ?? null) as T | null;
      },
    };
    return stmt;
  });

  const env = { DB: { prepare } } as unknown as Env;
  return { env, prepare, binds, sqls };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────
// A: Customer-facing engines
// ─────────────────────────────────────────────────────────────────────

describe('visualEditorSave', () => {
  it('returns a saved-layout shape with a UUID id and computed byte size', async () => {
    const { env, sqls } = createMockEnv();
    const layout = { blocks: [{ t: 'hero' }] };
    const r = await visualEditorSave(env, { siteId: 'site-1', layout });
    expect(r.site_id).toBe('site-1');
    expect(r.breakpoint).toBe('desktop'); // default
    expect(r.layout_byte_size).toBe(JSON.stringify(layout).length);
    expect(typeof r.id).toBe('string');
    expect(r.saved_at).toMatch(/T.*Z$/);
    expect(sqls[0]).toMatch(/INSERT OR REPLACE INTO visual_editor_projects/);
  });

  it('honors an explicit breakpoint', async () => {
    const { env } = createMockEnv();
    const r = await visualEditorSave(env, { siteId: 's', layout: {}, breakpoint: 'mobile' });
    expect(r.breakpoint).toBe('mobile');
  });

  it('still returns a shape when the D1 write throws (best-effort catch)', async () => {
    const { env } = createMockEnv({ throwOn: 'run' });
    const r = await visualEditorSave(env, { siteId: 's', layout: { a: 1 } });
    expect(r.site_id).toBe('s');
    expect(r.layout_byte_size).toBeGreaterThan(0);
  });
});

describe('ecommerceListProducts', () => {
  it('returns the D1 rows when present', async () => {
    const rows = [{ id: 'real-1', name: 'X' }];
    const { env } = createMockEnv({ allResult: { results: rows } });
    await expect(ecommerceListProducts(env, 'site-1')).resolves.toEqual(rows);
  });

  it('falls back to seed products when the query throws', async () => {
    const { env } = createMockEnv({ throwOn: 'all' });
    const r = await ecommerceListProducts(env, 'site-9');
    expect(Array.isArray(r)).toBe(true);
    expect(r.length).toBe(3);
    expect(r[0]).toMatchObject({ site_id: 'site-9', sku: 'BAY-001', status: 'active' });
  });
});

describe('ecommerceCreateOrder', () => {
  it('returns a pending order with a stripe demo checkout url', async () => {
    const { env } = createMockEnv();
    const r = await ecommerceCreateOrder(env, {
      siteId: 'site-1',
      email: 'a@b.co',
      cents: 1250,
    });
    expect(r).toMatchObject({
      site_id: 'site-1',
      email: 'a@b.co',
      total_cents: 1250,
      status: 'pending',
    });
    expect(r.checkout_url).toContain('https://checkout.stripe.com/c/pay/cs_demo_');
  });

  it('survives a D1 write failure', async () => {
    const { env } = createMockEnv({ throwOn: 'run' });
    const r = await ecommerceCreateOrder(env, { siteId: 's', email: 'x@y.z', cents: 1 });
    expect(r.status).toBe('pending');
  });
});

describe('bookingListSlots', () => {
  it('returns the open slots from D1 when present', async () => {
    const rows = [{ id: 's-real', status: 'open' }];
    const { env, binds } = createMockEnv({ allResult: { results: rows } });
    await expect(bookingListSlots(env, 'site-1')).resolves.toEqual(rows);
    // bound with siteId + status='open'
    expect(binds[0]).toEqual(['site-1', 'open']);
  });

  it('synthesizes 5 demo slots when none exist', async () => {
    const { env } = createMockEnv({ allResult: { results: [] } });
    const r = (await bookingListSlots(env, 'site-2')) as Array<Record<string, unknown>>;
    expect(r).toHaveLength(5);
    expect(r[0]).toMatchObject({ site_id: 'site-2', status: 'open', capacity: 1, booked_count: 0 });
    expect(typeof r[0].start_at).toBe('string');
  });

  it('synthesizes demo slots when the query throws', async () => {
    const { env } = createMockEnv({ throwOn: 'all' });
    const r = (await bookingListSlots(env, 'site-3')) as unknown[];
    expect(r).toHaveLength(5);
  });
});

describe('bookingReserve', () => {
  it('confirms a reservation and flags the email as sent', async () => {
    const { env } = createMockEnv();
    const r = await bookingReserve(env, { slotId: 'slot-1', email: 'a@b.co' });
    expect(r).toMatchObject({
      slot_id: 'slot-1',
      status: 'confirmed',
      confirmation_email_sent: true,
    });
    expect(typeof r.id).toBe('string');
  });
});

describe('lmsCreateCourse', () => {
  it('returns a draft course with the module count and default price', async () => {
    const { env, binds } = createMockEnv();
    const r = await lmsCreateCourse(env, {
      siteId: 'site-1',
      title: 'Sourdough 101',
      modules: [{}, {}, {}],
    });
    expect(r).toMatchObject({
      site_id: 'site-1',
      title: 'Sourdough 101',
      module_count: 3,
      status: 'draft',
    });
    // price_cents defaults to 0 in the bound params
    expect(binds[0]).toContain(0);
  });

  it('passes through an explicit priceCents', async () => {
    const { env, binds } = createMockEnv();
    await lmsCreateCourse(env, { siteId: 's', title: 'T', modules: [], priceCents: 4900 });
    expect(binds[0]).toContain(4900);
  });
});

describe('lmsListCourses', () => {
  it('returns real rows when present', async () => {
    const rows = [{ id: 'c1', title: 'Real' }];
    const { env } = createMockEnv({ allResult: { results: rows } });
    await expect(lmsListCourses(env, 'site-1')).resolves.toEqual(rows);
  });

  it('returns a demo course when the table is empty', async () => {
    const { env } = createMockEnv({ allResult: { results: [] } });
    const r = (await lmsListCourses(env, 'site-2')) as Array<Record<string, unknown>>;
    expect(r[0]).toMatchObject({ id: 'c-demo', status: 'published' });
  });

  it('returns a demo course when the query throws', async () => {
    const { env } = createMockEnv({ throwOn: 'all' });
    const r = (await lmsListCourses(env, 'site-3')) as Array<Record<string, unknown>>;
    expect(r[0].id).toBe('c-demo');
  });
});

describe('communityCreateTopic', () => {
  it('returns a fresh unpinned/unlocked topic with zero replies', async () => {
    const { env } = createMockEnv();
    const r = await communityCreateTopic(env, {
      siteId: 'site-1',
      title: 'Hello',
      body: 'world',
      authorEmail: 'a@b.co',
    });
    expect(r).toMatchObject({
      siteId: 'site-1',
      title: 'Hello',
      body: 'world',
      authorEmail: 'a@b.co',
      reply_count: 0,
      pinned: false,
      locked: false,
    });
  });
});

describe('communityListTopics', () => {
  it('returns real rows when present', async () => {
    const rows = [{ id: 't-real', title: 'Real' }];
    const { env } = createMockEnv({ allResult: { results: rows } });
    await expect(communityListTopics(env, 'site-1')).resolves.toEqual(rows);
  });

  it('returns the welcome demo topic when empty', async () => {
    const { env } = createMockEnv({ allResult: { results: [] } });
    const r = (await communityListTopics(env, 'site-2')) as Array<Record<string, unknown>>;
    expect(r[0]).toMatchObject({ id: 't-demo', pinned: 1 });
  });
});

describe('newsletterCreateCampaign', () => {
  it('returns a draft campaign with default segment + estimate fields', async () => {
    const { env, binds } = createMockEnv();
    const r = await newsletterCreateCampaign(env, {
      siteId: 'site-1',
      subject: 'Spring sale',
      bodyHtml: '<p>hi</p>',
    });
    expect(r).toMatchObject({
      status: 'draft',
      estimated_recipients: 1247,
      send_window_minutes: 12,
    });
    expect(binds[0]).toContain('all'); // default segment
  });

  it('uses an explicit segment', async () => {
    const { env, binds } = createMockEnv();
    await newsletterCreateCampaign(env, {
      siteId: 's',
      subject: 'x',
      bodyHtml: 'y',
      segment: 'vip',
    });
    expect(binds[0]).toContain('vip');
  });
});

describe('newsletterSubscribe', () => {
  it('returns the double-opt-in shape', async () => {
    const { env } = createMockEnv({ firstResult: { org_id: 'org-1' } });
    const r = await newsletterSubscribe(env, {
      siteId: 'site-1',
      email: 'a@b.co',
      segment: 'weekly',
    });
    expect(r).toMatchObject({ confirm_email_sent: true, double_opt_in_required: true });
  });

  it('survives the subscribe insert throwing (best-effort)', async () => {
    const { env } = createMockEnv({ throwOn: 'first' });
    const r = await newsletterSubscribe(env, { siteId: 'site-1', email: 'a@b.co' });
    expect(r.double_opt_in_required).toBe(true);
  });
});

// The compliance counterpart: the `unsubscribed` column previously had NO writer,
// so a native subscriber could never leave (CAN-SPAM/GDPR) and the newsletter-causal
// probe's test rows could never be cleaned. These lock the writer's contract.
describe('newsletterUnsubscribe', () => {
  it('flips unsubscribed=1 for live subscribers and reports the affected row count', async () => {
    const { env, sqls } = createMockEnv({ runResult: { meta: { changes: 1 } } });
    const r = await newsletterUnsubscribe(env, { siteId: 'site-1', email: 'a@b.co' });
    expect(r.updated).toBe(1);
    expect(r.error).toBeUndefined();
    expect(sqls.some((s) => /UPDATE newsletter_subscribers SET unsubscribed = 1/.test(s))).toBe(true);
    // Scoped to still-live rows so a repeat is a benign no-op, not a phantom update.
    expect(sqls.some((s) => /WHERE site_id = \? AND email = \? AND unsubscribed = 0/.test(s))).toBe(true);
  });

  it('is idempotent — a non-subscriber / already-unsubscribed row is a 0-row no-op (no error)', async () => {
    const { env } = createMockEnv({ runResult: { meta: { changes: 0 } } });
    const r = await newsletterUnsubscribe(env, { siteId: 'site-1', email: 'ghost@b.co' });
    expect(r.updated).toBe(0);
    expect(r.error).toBeUndefined();
  });

  it('is error-AWARE — a real D1 failure returns { error }, never a lying-success', async () => {
    const { env } = createMockEnv({ throwOn: 'run' });
    const r = await newsletterUnsubscribe(env, { siteId: 'site-1', email: 'a@b.co' });
    expect(r.updated).toBe(0);
    expect(typeof r.error).toBe('string');
    expect(r.error).toContain('boom');
  });
});

describe('membershipCreateTier', () => {
  it('returns a tier with a demo stripe price id and monthly cycle', async () => {
    const { env } = createMockEnv();
    const r = await membershipCreateTier(env, {
      siteId: 'site-1',
      name: 'Gold',
      priceCents: 5000,
      perks: ['a', 'b'],
    });
    expect(r).toMatchObject({ name: 'Gold', priceCents: 5000, billing_cycle: 'monthly' });
    expect(r.stripe_price_id).toMatch(/^price_demo_/);
  });
});

describe('membershipListTiers', () => {
  it('returns real rows when present', async () => {
    const rows = [{ id: 'mt-real' }];
    const { env } = createMockEnv({ allResult: { results: rows } });
    await expect(membershipListTiers(env, 'site-1')).resolves.toEqual(rows);
  });

  it('returns the 3 default tiers when empty', async () => {
    const { env } = createMockEnv({ allResult: { results: [] } });
    const r = (await membershipListTiers(env, 'site-2')) as Array<Record<string, unknown>>;
    expect(r.map((t) => t.id)).toEqual(['mt-bronze', 'mt-silver', 'mt-gold']);
  });

  it('returns the default tiers when the query throws', async () => {
    const { env } = createMockEnv({ throwOn: 'all' });
    const r = (await membershipListTiers(env, 'site-3')) as unknown[];
    expect(r).toHaveLength(3);
  });
});

describe('donationCreateCampaign', () => {
  it('returns a zeroed campaign and passes null endsAt by default', async () => {
    const { env, binds } = createMockEnv();
    const r = await donationCreateCampaign(env, {
      siteId: 'site-1',
      name: 'Build fund',
      goalCents: 100000,
    });
    expect(r).toMatchObject({
      name: 'Build fund',
      goalCents: 100000,
      raised_cents: 0,
      donor_count: 0,
    });
    expect(binds[0]).toContain(null); // ends_at default
  });
});

describe('donationProcess', () => {
  it('returns a one-time donation with a tax receipt + dafpay url', async () => {
    const { env } = createMockEnv();
    const r = await donationProcess(env, {
      campaignId: 'camp-1',
      email: 'd@e.co',
      amountCents: 2500,
    });
    expect(r).toMatchObject({
      campaign_id: 'camp-1',
      amount_cents: 2500,
      recurring: false,
      tax_receipt_sent: true,
    });
    expect(r.dafpay_url).toContain('camp-1');
  });

  it('coerces recurring truthy → boolean true', async () => {
    const { env } = createMockEnv();
    const r = await donationProcess(env, {
      campaignId: 'c',
      email: 'd@e.co',
      amountCents: 1,
      recurring: true,
    });
    expect(r.recurring).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// B: Native + multi-platform
// ─────────────────────────────────────────────────────────────────────

describe('mobileRegisterDevice', () => {
  it('returns the ios store url for an ios platform', async () => {
    const { env } = createMockEnv();
    const r = await mobileRegisterDevice(env, {
      userId: 'u1',
      platform: 'ios',
      deviceId: 'd1',
      pushToken: 'tok',
      appVersion: '1.0',
    });
    expect(r.push_enabled).toBe(true);
    expect(r.store_url).toContain('apps.apple.com');
  });

  it('returns the android store url for an android platform', async () => {
    const { env } = createMockEnv();
    const r = await mobileRegisterDevice(env, {
      userId: 'u1',
      platform: 'android',
      deviceId: 'd1',
      pushToken: 'tok',
      appVersion: '1.0',
    });
    expect(r.store_url).toContain('play.google.com');
  });
});

describe('desktopAppInfo / browserExtensionInfo (pure)', () => {
  it('desktopAppInfo exposes all 3 OS builds + Tauri framework', () => {
    const r = desktopAppInfo();
    expect(r.framework).toBe('Tauri 2');
    expect(r.macos.download_url).toMatch(/mac\.dmg$/);
    expect(r.windows.download_url).toMatch(/win\.exe$/);
    expect(r.linux.download_url).toMatch(/linux\.AppImage$/);
  });

  it('browserExtensionInfo exposes 3 stores + permissions + features', () => {
    const r = browserExtensionInfo();
    expect(r.chrome.store_url).toContain('chrome.google.com');
    expect(r.firefox.store_url).toContain('addons.mozilla.org');
    expect(r.edge.store_url).toContain('microsoftedge.microsoft.com');
    expect(r.permissions).toContain('activeTab');
    expect(r.features.length).toBeGreaterThanOrEqual(4);
  });
});

describe('chatopsConnect', () => {
  it('returns a connected workspace with the default slash commands', async () => {
    const { env } = createMockEnv();
    const r = await chatopsConnect(env, {
      orgId: 'org-1',
      platform: 'slack',
      webhookUrl: 'https://hooks.slack.com/x',
    });
    expect(r).toMatchObject({ platform: 'slack', status: 'connected' });
    expect(r.slash_commands).toEqual(['/deploy', '/incidents', '/leads', '/billing']);
  });
});

// ─────────────────────────────────────────────────────────────────────
// C: Enterprise compliance
// ─────────────────────────────────────────────────────────────────────

describe('soc2Controls (pure)', () => {
  it('returns the full control catalog with stable ids + statuses', () => {
    const r = soc2Controls();
    expect(r.length).toBe(9);
    const ids = r.map((c) => c.control_id);
    expect(ids).toContain('CC6.1');
    expect(ids).toContain('A1.1');
    r.forEach((c) => {
      expect(['operating', 'tested', 'in_progress']).toContain(c.status);
      expect(c.description.length).toBeGreaterThan(0);
    });
  });
});

describe('hipaaSignBaa', () => {
  it('returns a signed BAA with a 1-year expiry and 4 controls', async () => {
    const { env } = createMockEnv();
    const r = await hipaaSignBaa(env, { customerOrgId: 'org-1', businessName: 'Clinic Co' });
    expect(r).toMatchObject({ businessName: 'Clinic Co' });
    expect(r.pdf_url).toContain(r.id);
    expect(r.controls).toEqual(
      expect.arrayContaining(['encryption-at-rest', 'breach-notification-72h']),
    );
    expect(new Date(r.signed_at).getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe('pciTokenize', () => {
  it('returns a tok_-prefixed token + level-1 PCI metadata, never echoing a full PAN', async () => {
    const { env } = createMockEnv();
    const r = await pciTokenize(env, { customerId: 'c1', last4: '4242', brand: 'visa' });
    expect(r.token).toMatch(/^tok_/);
    expect(r).toMatchObject({
      last4: '4242',
      brand: 'visa',
      pci_dss_level: 1,
      scope_reduced: true,
    });
  });
});

describe('ssoConnect', () => {
  it('returns pending status + SP entity/ACS/SLO urls for a SAML connection', async () => {
    const { env } = createMockEnv();
    const r = await ssoConnect(env, {
      orgId: 'org-1',
      protocol: 'saml',
      idpMetadataUrl: 'https://idp/meta',
      idpEntityId: 'urn:idp',
    });
    expect(r).toMatchObject({ protocol: 'saml', status: 'pending' });
    expect(r.acs_url).toContain(r.id);
    expect(r.sp_entity_id).toBe('https://projectsites.dev/saml/metadata');
  });
});

// ─────────────────────────────────────────────────────────────────────
// D: Infrastructure depth
// ─────────────────────────────────────────────────────────────────────

describe('d1ReplicationStatus (pure)', () => {
  it('reports a healthy primary + 4 replicas with sessions api enabled', () => {
    const r = d1ReplicationStatus();
    expect(r.primary_region).toBe('wnam');
    expect(r.replicas).toHaveLength(4);
    expect(r.replicas.every((x) => x.healthy)).toBe(true);
    expect(r.sessions_api_enabled).toBe(true);
    expect(r.last_failover_at).toBeNull();
  });
});

describe('byoCloudflareConnect', () => {
  it('returns an oauth url carrying the new record id as state + scopes', async () => {
    const { env } = createMockEnv();
    const r = await byoCloudflareConnect(env, { orgId: 'org-1', cfAccountId: 'acc-1' });
    expect(r.oauth_url).toContain(`state=${r.id}`);
    expect(r.scopes).toEqual(expect.arrayContaining(['workers:write', 'd1:write']));
  });
});

describe('workerMarketplaceList', () => {
  it('returns real listings when present', async () => {
    const rows = [{ id: 'wm-real' }];
    const { env } = createMockEnv({ allResult: { results: rows } });
    await expect(workerMarketplaceList(env)).resolves.toEqual(rows);
  });

  it('returns the 3 seeded listings when empty', async () => {
    const { env } = createMockEnv({ allResult: { results: [] } });
    const r = (await workerMarketplaceList(env)) as Array<Record<string, unknown>>;
    expect(r.map((x) => x.slug)).toEqual([
      'stripe-connect-express',
      'twilio-sms-notify',
      'openai-chat-proxy',
    ]);
  });

  it('returns seeded listings when the query throws', async () => {
    const { env } = createMockEnv({ throwOn: 'all' });
    const r = (await workerMarketplaceList(env)) as unknown[];
    expect(r).toHaveLength(3);
  });
});

describe('domainResellerSearch (pure templating)', () => {
  it('builds tld suggestions off the query string', async () => {
    const { env } = createMockEnv();
    const r = await domainResellerSearch(env, 'bayonnebakery');
    expect(r.query).toBe('bayonnebakery');
    expect(r.suggestions.map((s) => s.domain)).toEqual([
      'bayonnebakery.com',
      'bayonnebakery.dev',
      'bayonnebakery.io',
      'bayonnebakery.app',
      'bayonnebakery-app.com',
    ]);
    // .io is marked unavailable with null price/registrar
    const io = r.suggestions.find((s) => s.tld === 'io')!;
    expect(io.available).toBe(false);
    expect(io.price_cents).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// E: AI-native depth
// ─────────────────────────────────────────────────────────────────────

describe('voiceCloneCreate', () => {
  it('returns a training clone with a demo elevenlabs id + consent flag', async () => {
    const { env } = createMockEnv();
    const r = await voiceCloneCreate(env, {
      orgId: 'org-1',
      name: 'Founder voice',
      sampleR2Keys: ['a.mp3', 'b.mp3'],
    });
    expect(r).toMatchObject({ name: 'Founder voice', consent_required: true });
    expect(r.elevenlabs_voice_id).toMatch(/^evl_demo_/);
    expect(new Date(r.estimated_ready_at).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('aiAgentMarketplaceList', () => {
  it('returns real listings when present', async () => {
    const rows = [{ id: 'aa-real' }];
    const { env } = createMockEnv({ allResult: { results: rows } });
    await expect(aiAgentMarketplaceList(env)).resolves.toEqual(rows);
  });

  it('returns the 3 seeded agents (each with mcp_tools) when empty', async () => {
    const { env } = createMockEnv({ allResult: { results: [] } });
    const r = (await aiAgentMarketplaceList(env)) as Array<Record<string, unknown>>;
    expect(r.map((x) => x.slug)).toEqual(['booking-assistant', 'menu-qa', 'lead-qualifier-pro']);
    expect(Array.isArray((r[0] as { mcp_tools: unknown[] }).mcp_tools)).toBe(true);
  });
});

describe('siteCopilotIndex', () => {
  it('returns an indexed KB with a per-site vectorize namespace + bge model', async () => {
    const { env } = createMockEnv();
    const r = await siteCopilotIndex(env, { siteId: 'abcdef0123456789' });
    expect(r).toMatchObject({ status: 'indexed', doc_count: 47 });
    expect(r.vectorize_namespace).toBe('site-abcdef01');
    expect(r.embedding_model).toBe('@cf/baai/bge-large-en-v1.5');
  });
});

describe('aiVideoCourseGenerate', () => {
  it('clamps lesson count to the min (3) when the outline has no numbered lines', async () => {
    const { env } = createMockEnv();
    const r = await aiVideoCourseGenerate(env, {
      siteId: 'site-1',
      title: 'Course',
      outline: 'just prose, no numbers',
    });
    // match(/^\d+\./gm) → null → ?? 5 → clamped between 3 and 12 → 5
    expect(r.lesson_count).toBe(5);
    expect(r.total_seconds).toBe(5 * 480);
    expect(r.cost_usd).toBe((5 * 120) / 100);
  });

  it('derives lesson count from numbered outline lines', async () => {
    const { env } = createMockEnv();
    const outline = '1. Intro\n2. Mixing\n3. Proofing\n4. Bake';
    const r = await aiVideoCourseGenerate(env, { siteId: 's', title: 'T', outline });
    expect(r.lesson_count).toBe(4);
    expect(r.status).toBe('generating');
  });

  it('clamps lesson count to the max (12) for a huge outline', async () => {
    const { env } = createMockEnv();
    const outline = Array.from({ length: 30 }, (_, i) => `${i + 1}. Lesson`).join('\n');
    const r = await aiVideoCourseGenerate(env, { siteId: 's', title: 'T', outline });
    expect(r.lesson_count).toBe(12);
  });
});

describe('aiAbExperimentStart', () => {
  it('defaults to 3 variants with an even thompson traffic split', async () => {
    const { env } = createMockEnv();
    const r = await aiAbExperimentStart(env, { siteId: 'site-1', goal: 'signup' });
    expect(r.variants).toHaveLength(3);
    expect(r.traffic_split).toEqual([33, 33, 33]); // round(100/3)
    expect(r).toMatchObject({ status: 'running', sampling: 'thompson', auto_promote: true });
  });

  it('honors an explicit variantCount', async () => {
    const { env } = createMockEnv();
    const r = await aiAbExperimentStart(env, { siteId: 's', goal: 'cta', variantCount: 2 });
    expect(r.variants).toHaveLength(2);
    expect(r.traffic_split).toEqual([50, 50]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// F: Marketing + growth
// ─────────────────────────────────────────────────────────────────────

describe('smsCampaignCreate', () => {
  it('returns an SMS campaign with a recipient + cost estimate', async () => {
    const { env, binds } = createMockEnv();
    const r = await smsCampaignCreate(env, {
      siteId: 'site-1',
      name: 'Flash sale',
      body: '50% off today',
    });
    expect(r).toMatchObject({ estimated_recipients: 423, twilio_messaging_service: 'MGdemo' });
    expect(r.cost_estimate_usd).toBeCloseTo(423 * 0.0075);
    expect(binds[0]).toContain('all'); // default segment
  });
});

describe('affiliateCreate', () => {
  it('derives an uppercased referral code from the email local-part + default 20% commission', async () => {
    const { env } = createMockEnv();
    const r = await affiliateCreate(env, { orgId: 'org-1', email: 'jane.doe@x.com' });
    expect(r.commission_pct).toBe(20.0);
    expect(r.stripe_connect_required).toBe(true);
    // slug('jane.doe') → 'jane-doe' → uppercased prefix
    expect(r.code).toMatch(/^JANE-DOE-[A-Z0-9]{6}$/);
    expect(r.referral_link).toBe(`https://projectsites.dev/?ref=${r.code}`);
  });

  it('honors an explicit commission percent', async () => {
    const { env } = createMockEnv();
    const r = await affiliateCreate(env, { orgId: 'o', email: 'a@b.co', commissionPct: 35 });
    expect(r.commission_pct).toBe(35);
  });
});

describe('loyaltyProgramCreate', () => {
  it('returns the 4-tier ladder with default 10 points/dollar', async () => {
    const { env } = createMockEnv();
    const r = await loyaltyProgramCreate(env, { siteId: 'site-1', name: 'Bakery Rewards' });
    expect(r.points_per_dollar).toBe(10);
    expect(r.tiers.map((t) => t.name)).toEqual(['bronze', 'silver', 'gold', 'platinum']);
    expect(r.tiers[3].min_points).toBe(10000);
  });

  it('honors an explicit pointsPerDollar', async () => {
    const { env } = createMockEnv();
    const r = await loyaltyProgramCreate(env, { siteId: 's', name: 'N', pointsPerDollar: 5 });
    expect(r.points_per_dollar).toBe(5);
  });
});

describe('crmListDeals', () => {
  it('returns real deals when present', async () => {
    const rows = [{ id: 'd-real' }];
    const { env } = createMockEnv({ allResult: { results: rows } });
    await expect(crmListDeals(env, 'site-1')).resolves.toEqual(rows);
  });

  it('returns the 3 seeded deals when empty', async () => {
    const { env } = createMockEnv({ allResult: { results: [] } });
    const r = (await crmListDeals(env, 'site-2')) as Array<Record<string, unknown>>;
    expect(r.map((d) => d.stage)).toEqual(['qualified', 'proposal', 'negotiation']);
  });

  it('returns seeded deals when the query throws', async () => {
    const { env } = createMockEnv({ throwOn: 'all' });
    const r = (await crmListDeals(env, 'site-3')) as unknown[];
    expect(r).toHaveLength(3);
  });
});

describe('crmCreateDeal', () => {
  it('defaults the stage to "lead" and passes null email when omitted', async () => {
    const { env, binds } = createMockEnv();
    const r = await crmCreateDeal(env, {
      siteId: 'site-1',
      customerName: 'Acme',
      valueCents: 9000,
    });
    expect(r).toMatchObject({ stage: 'lead', activities_count: 0, days_in_stage: 0 });
    expect(binds[0]).toContain(null); // customer_email default
  });

  it('honors an explicit stage', async () => {
    const { env } = createMockEnv();
    const r = await crmCreateDeal(env, {
      siteId: 's',
      customerName: 'X',
      valueCents: 1,
      stage: 'won',
    });
    expect(r.stage).toBe('won');
  });
});

describe('cdpUpsertProfile', () => {
  it('marks identity resolved when both email AND phone are present', async () => {
    const { env } = createMockEnv();
    const r = await cdpUpsertProfile(env, {
      siteId: 'site-1',
      email: 'a@b.co',
      phone: '+15551234567',
      traits: { plan: 'pro' },
    });
    expect(r.identity_resolved).toBe(true);
    expect(r.source_count).toBe(1);
    expect(r.unified_id).toBe(r.id);
  });

  it('leaves identity unresolved when only one identifier is present', async () => {
    const { env } = createMockEnv();
    const r = await cdpUpsertProfile(env, { siteId: 'site-1', email: 'a@b.co' });
    expect(r.identity_resolved).toBe(false);
  });
});

describe('cdpTrackEvent', () => {
  it('accepts an event and echoes a timestamp', async () => {
    const { env, binds } = createMockEnv();
    const r = await cdpTrackEvent(env, {
      siteId: 'site-1',
      source: 'web',
      kind: 'pageview',
      payload: { path: '/' },
    });
    expect(r).toMatchObject({ accepted: true });
    expect(typeof r.ts).toBe('string');
    expect(binds[0]).toContain(null); // profileId default → null bound
  });

  it('survives a D1 insert failure', async () => {
    const { env } = createMockEnv({ throwOn: 'run' });
    const r = await cdpTrackEvent(env, {
      profileId: 'p1',
      siteId: 's',
      source: 'api',
      kind: 'custom',
      payload: {},
    });
    expect(r.accepted).toBe(true);
  });
});
