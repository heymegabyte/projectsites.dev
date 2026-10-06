/**
 * @module mocks/fixtures/webhooks
 *
 * @description
 * Mock fixtures for the admin **Outbound Webhooks** section
 * (`pages/admin/sections/webhooks.component.ts`) — the per-site surface where an owner
 * subscribes their own https endpoints to site events (`site.published`, `form.submitted`,
 * …) and watches the recent signed-delivery log. The component fires TWO per-site GET reads
 * the moment a site resolves, both through {@link import('../../services/api.service').ApiService}:
 *
 * | Registry key                           | Factory                      | Worker contract (traced)                                              |
 * | -------------------------------------- | ---------------------------- | --------------------------------------------------------------------- |
 * | `GET /sites/:id/webhooks`              | {@link webhooksFixture}         | `{ ok, endpoints: StoredEndpoint[] }` (`webhooks_admin.ts:55` → `listWebhookEndpoints`) |
 * | `GET /sites/:id/webhooks/deliveries`   | {@link webhookDeliveriesFixture}| `{ ok, deliveries: StoredDelivery[] }` (`webhooks_admin.ts:64` → `listDeliveries`)       |
 *
 * **These two `:param` keys ALREADY EXIST in the registry** ({@link import('./index').FIXTURES},
 * P2c "#34 shell sweep") pointing at the EMPTY-but-well-formed stubs in `per-site.fixture.ts`
 * (`endpoints: unknown[]` / `deliveries: unknown[]`, `state` ignored — the toast-free clean
 * default). This module UPGRADES those two to the SECTION's own typed, state-aware bodies so the
 * Webhooks tab actually SHOWS endpoints + a mixed delivery log in the demo. Wiring: **RE-POINT**
 * the two existing lines to these factories — do NOT add duplicate keys (a second entry for the
 * same key is dead; the first wins). The `per-site.fixture.ts` stubs can then be retired.
 *
 * **Flag-gating:** the real routes are gated on the `outbound_webhooks` flag — the worker returns
 * `404` when it's OFF, which the component reads as a calm cyan "Webhooks not available" notice
 * (NOT a red error). In `?mock=1` the interceptor serves these bodies directly (the flag is never
 * consulted), so the section renders its POPULATED surface with NO flag flip — the demo SHOWS the
 * feature rather than gating it. (A real prod user still needs the flag ON.)
 *
 * @remarks
 * - The envelopes are the worker's CAMELCASE service projections (`StoredEndpoint` /
 *   `StoredDelivery`), which map 1:1 onto the component's `Endpoint` / `Delivery` interfaces —
 *   so wiring the real endpoint later is a provider SWAP, not a rewrite.
 * - Believable data, not lorem: two live endpoints subscribed to realistic event mixes, and a
 *   recent delivery log that spans a 2xx success, a retried 5xx (`attempt: 2`), a hard 401, and a
 *   network timeout (`statusCode: 0`) — so every delivery badge (OK / fail), the per-attempt
 *   failure-reason hover, and the `—` no-response rendering all light up.
 * - `state` variants: `empty` → no endpoints + no deliveries (the honest brand-new-site surface
 *   that drives the "Add your first endpoint" launchpad + hides the deliveries block);
 *   `populated`/`loading`/default → the rich believable set. `error` is handled by the
 *   interceptor (it throws a 500 before these run).
 */
import type { FixtureFactory, MockState } from './index';

/** A recent anchor so `createdAt` reads as believable ISO timestamps. */
const ANCHOR = Date.parse('2026-10-06T13:00:00Z');
const iso = (minutesAgo: number): string => new Date(ANCHOR - minutesAgo * 60_000).toISOString();

// ───────────────────────── GET /sites/:id/webhooks ─────────────────────────

/**
 * One subscribed endpoint — the worker's `StoredEndpoint` projection
 * (`outbound_webhooks.ts`, camelCase; `event_types` JSON is parsed to `eventTypes`). Maps 1:1
 * onto the component's `Endpoint` interface (`id`/`url`/`eventTypes`/`enabled`).
 */
export interface WebhookEndpointRow {
  id: string;
  url: string;
  eventTypes: string[];
  enabled: boolean;
}

/** The `GET /api/sites/:siteId/webhooks` envelope — `{ ok, endpoints }` (NOT `{ data }`). */
export interface WebhooksResponse {
  ok: boolean;
  endpoints: WebhookEndpointRow[];
}

/**
 * Two believable live endpoints, newest-first (the worker's `ORDER BY created_at DESC`): a
 * general ops webhook subscribed to the full lifecycle, and a narrow CRM hook that only wants
 * form submissions. Every event is on the worker's `WEBHOOK_EVENT_TYPES` allowlist.
 */
const ENDPOINTS: readonly WebhookEndpointRow[] = [
  {
    id: 'wh-ep-001',
    url: 'https://hooks.beverwyckventures.test/projectsites',
    eventTypes: ['site.published', 'form.submitted', 'payment.succeeded', 'build.failed'],
    enabled: true,
  },
  {
    id: 'wh-ep-002',
    url: 'https://crm.beverwyckventures.test/webhooks/leads',
    eventTypes: ['form.submitted'],
    enabled: true,
  },
];

/**
 * Endpoints factory. `empty` → `[]` (the honest brand-new-site surface → the "Add your first
 * endpoint" empty-state launchpad); `populated`/`loading`/default → the two believable
 * endpoints. `error` is handled by the interceptor.
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const webhooksFixture: FixtureFactory<WebhooksResponse> = (
  state: MockState,
): WebhooksResponse => ({
  ok: true,
  endpoints: state === 'empty' ? [] : ENDPOINTS.map((e) => ({ ...e, eventTypes: [...e.eventTypes] })),
});

// ───────────────────────── GET /sites/:id/webhooks/deliveries ─────────────────────────

/**
 * One delivery attempt — the worker's `StoredDelivery` projection (`outbound_webhooks.ts`,
 * camelCase; `status_code`/`event_type`/`endpoint_id`/`created_at` + `ok` INTEGER→boolean). Maps
 * 1:1 onto the component's `Delivery` interface. A FAILED attempt carries the worker's own
 * `error` reason (`timeout` / `unauthorized` / `network_error`) the component surfaces on hover.
 */
export interface WebhookDeliveryRow {
  id: string;
  endpointId: string;
  eventType: string;
  statusCode: number;
  ok: boolean;
  attempt: number;
  error: string | null;
  createdAt: string;
}

/** The `GET /api/sites/:siteId/webhooks/deliveries` envelope — `{ ok, deliveries }`. */
export interface WebhookDeliveriesResponse {
  ok: boolean;
  deliveries: WebhookDeliveryRow[];
}

/**
 * A believable recent delivery log, newest-first (the worker's `ORDER BY created_at DESC`),
 * spanning every rendered branch the component has:
 * - a clean 2xx success (`ok:true`, `attempt:1`, `error:null`) → cyan "200 OK";
 * - a retried delivery that succeeded on its 2nd attempt after a 5xx (`attempt:2`);
 * - a hard client error (`401`, not retried — a permanent 4xx) with an `unauthorized` reason;
 * - a transient timeout to the CRM hook (`statusCode:0`, `network_error`) → renders "— fail"
 *   with the failure reason on hover (exercises the `d.statusCode || '—'` no-response path).
 */
const DELIVERIES: readonly WebhookDeliveryRow[] = [
  {
    id: 'wh-dl-001',
    endpointId: 'wh-ep-001',
    eventType: 'site.published',
    statusCode: 200,
    ok: true,
    attempt: 1,
    error: null,
    createdAt: iso(6),
  },
  {
    id: 'wh-dl-002',
    endpointId: 'wh-ep-001',
    eventType: 'form.submitted',
    statusCode: 200,
    ok: true,
    attempt: 2, // succeeded on retry after a transient 5xx
    error: null,
    createdAt: iso(42),
  },
  {
    id: 'wh-dl-003',
    endpointId: 'wh-ep-002',
    eventType: 'form.submitted',
    statusCode: 401,
    ok: false,
    attempt: 1, // permanent 4xx — not retried
    error: 'unauthorized',
    createdAt: iso(97),
  },
  {
    id: 'wh-dl-004',
    endpointId: 'wh-ep-002',
    eventType: 'form.submitted',
    statusCode: 0,
    ok: false,
    attempt: 3, // network-level failure, exhausting retries → renders "— fail"
    error: 'network_error',
    createdAt: iso(180),
  },
];

/**
 * Deliveries factory. `empty` → `[]` (no endpoints → no deliveries → the component hides the
 * "Recent deliveries" block entirely); `populated`/`loading`/default → the believable mixed log.
 * `error` is handled by the interceptor.
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const webhookDeliveriesFixture: FixtureFactory<WebhookDeliveriesResponse> = (
  state: MockState,
): WebhookDeliveriesResponse => ({
  ok: true,
  deliveries: state === 'empty' ? [] : DELIVERIES.map((d) => ({ ...d })),
});
