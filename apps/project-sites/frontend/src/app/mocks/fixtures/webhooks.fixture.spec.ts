import {
  webhooksFixture,
  webhookDeliveriesFixture,
  type WebhooksResponse,
  type WebhookDeliveriesResponse,
} from './webhooks.fixture';
import { toRegistryKey } from './index';

/**
 * webhooks.fixture — mock bodies for the admin **Outbound Webhooks** section
 * (`pages/admin/sections/webhooks.component.ts`). The section fires two per-site GET reads once
 * a site resolves:
 *
 *   GET /sites/:id/webhooks             → { ok, endpoints: StoredEndpoint[] }   (webhooks_admin.ts)
 *   GET /sites/:id/webhooks/deliveries  → { ok, deliveries: StoredDelivery[] }  (webhooks_admin.ts)
 *
 * Both envelopes are the worker's CAMELCASE service projections, which map 1:1 onto the
 * component's `Endpoint` / `Delivery` interfaces — so the real endpoint is a drop-in swap. These
 * factories UPGRADE the empty P2c stubs in `per-site.fixture.ts` to state-aware, believable
 * bodies so the Webhooks tab SHOWS data in the demo. The worker routes are flag-gated
 * (`outbound_webhooks`); `?mock=1` serves these directly, so the section renders with no flip.
 */
function q(search = ''): URLSearchParams {
  return new URLSearchParams(search);
}

/** The worker's `WEBHOOK_EVENT_TYPES` allowlist — mirrored so a fixture typo can't leak a phantom event. */
const ALLOWED_EVENTS = [
  'site.published',
  'form.submitted',
  'payment.succeeded',
  'review.received',
  'build.failed',
  'domain.active',
];

describe('webhooksFixture (GET /sites/:id/webhooks → { ok, endpoints })', () => {
  it('returns the worker envelope shape { ok:true, endpoints:[] } (NOT { data })', () => {
    const res: WebhooksResponse = webhooksFixture('populated', q());
    expect(res.ok).toBe(true);
    expect(Array.isArray(res.endpoints)).toBe(true);
  });

  it('populated → believable endpoints, newest-first, each matching the component Endpoint shape', () => {
    const { endpoints } = webhooksFixture('populated', q());
    expect(endpoints.length).toBeGreaterThan(0);
    for (const e of endpoints) {
      // The exact fields the component's `Endpoint` reads: id · url · eventTypes[] · enabled.
      expect(typeof e.id).toBe('string');
      expect(typeof e.url).toBe('string');
      expect(typeof e.enabled).toBe('boolean');
      expect(Array.isArray(e.eventTypes)).toBe(true);
      expect(e.eventTypes.length).toBeGreaterThan(0);
      // https only (the worker rejects plaintext delivery; the component validates the same).
      expect(e.url.startsWith('https://')).toBe(true);
      // Every subscribed event is on the worker's allowlist (no phantom event types).
      for (const ev of e.eventTypes) expect(ALLOWED_EVENTS).toContain(ev);
    }
  });

  it('empty → no endpoints (drives the "Add your first endpoint" launchpad)', () => {
    const res = webhooksFixture('empty', q());
    expect(res.ok).toBe(true);
    expect(res.endpoints).toEqual([]);
  });

  it('loading/default behave like populated (the believable set)', () => {
    expect(webhooksFixture('loading', q()).endpoints.length).toBeGreaterThan(0);
    expect(webhooksFixture('populated', q()).endpoints.length).toBeGreaterThan(0);
  });

  it('returns a fresh deep copy each call (no shared mutable eventTypes arrays across demos)', () => {
    const a = webhooksFixture('populated', q());
    a.endpoints[0].eventTypes.push('tampered');
    const b = webhooksFixture('populated', q());
    expect(b.endpoints[0].eventTypes).not.toContain('tampered');
  });

  it('normalizes to the :param registry key GET /sites/:id/webhooks', () => {
    expect(toRegistryKey('GET', '/api/sites/site-001/webhooks').key).toBe(
      'GET /sites/site-001/webhooks',
    );
  });
});

describe('webhookDeliveriesFixture (GET /sites/:id/webhooks/deliveries → { ok, deliveries })', () => {
  it('returns the worker envelope shape { ok:true, deliveries:[] }', () => {
    const res: WebhookDeliveriesResponse = webhookDeliveriesFixture('populated', q());
    expect(res.ok).toBe(true);
    expect(Array.isArray(res.deliveries)).toBe(true);
  });

  it('populated → delivery rows matching the component Delivery shape exactly', () => {
    const { deliveries } = webhookDeliveriesFixture('populated', q());
    expect(deliveries.length).toBeGreaterThan(0);
    for (const d of deliveries) {
      // The exact fields the component's `Delivery` reads.
      expect(typeof d.id).toBe('string');
      expect(typeof d.eventType).toBe('string');
      expect(typeof d.statusCode).toBe('number');
      expect(typeof d.ok).toBe('boolean');
      expect(typeof d.attempt).toBe('number');
      expect(typeof d.createdAt).toBe('string');
      // error is string | null (worker's own failure reason, surfaced on hover).
      expect(d.error === null || typeof d.error === 'string').toBe(true);
      // ISO timestamp the component renders.
      expect(Number.isNaN(Date.parse(d.createdAt))).toBe(false);
    }
  });

  it('covers both delivery branches — ≥1 success (ok:true) and ≥1 failure (ok:false)', () => {
    const { deliveries } = webhookDeliveriesFixture('populated', q());
    expect(deliveries.some((d) => d.ok)).toBe(true);
    expect(deliveries.some((d) => !d.ok)).toBe(true);
  });

  it('a failed delivery carries a non-null error reason (drives the hover + reason chip)', () => {
    const { deliveries } = webhookDeliveriesFixture('populated', q());
    const failed = deliveries.filter((d) => !d.ok);
    expect(failed.length).toBeGreaterThan(0);
    for (const d of failed) expect(typeof d.error).toBe('string');
  });

  it('includes a no-response failure (statusCode 0) so the "— fail" rendering is exercised', () => {
    const { deliveries } = webhookDeliveriesFixture('populated', q());
    expect(deliveries.some((d) => d.statusCode === 0 && !d.ok)).toBe(true);
  });

  it('a success + ok flag are internally consistent (2xx ⇒ ok, non-2xx ⇒ !ok)', () => {
    const { deliveries } = webhookDeliveriesFixture('populated', q());
    for (const d of deliveries) {
      const is2xx = d.statusCode >= 200 && d.statusCode < 300;
      expect(d.ok).toBe(is2xx);
    }
  });

  it('includes a retried delivery (attempt > 1) so the "· attempt N" rendering is real', () => {
    const { deliveries } = webhookDeliveriesFixture('populated', q());
    expect(deliveries.some((d) => d.attempt > 1)).toBe(true);
  });

  it('empty → no deliveries (the component hides the "Recent deliveries" block)', () => {
    const res = webhookDeliveriesFixture('empty', q());
    expect(res.ok).toBe(true);
    expect(res.deliveries).toEqual([]);
  });

  it('normalizes to the :param registry key GET /sites/:id/webhooks/deliveries', () => {
    expect(toRegistryKey('GET', '/api/sites/site-001/webhooks/deliveries').key).toBe(
      'GET /sites/site-001/webhooks/deliveries',
    );
  });
});
