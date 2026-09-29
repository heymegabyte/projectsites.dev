/**
 * @module libs/features/psnotify
 *
 * Feature manifest for the psnotify Durable Object inbox (first slice) — the
 * in-app notification center backbone. A SQLite-backed DO (`PsNotifyDO`), one
 * instance per user, stores notifications and powers the authed
 * `/api/notifications` list + mark-read endpoints. `notifyUser(...)` writes into
 * it. Zero D1 tables. Email/push fan-out + bell-feed unification are follow-on
 * slices. Dark behind `psnotify` (server 404s when off).
 */
import { defineFeatureManifest } from '@projectsites/feature-manifests';

export default defineFeatureManifest({
  // ---- identity ----
  slug: 'psnotify',
  name: 'psnotify Notification Inbox',
  description:
    'psnotify DO inbox: a per-user SQLite Durable Object storing notifications. notifyUser writes to ' +
    'it; authed GET/POST /api/notifications read+mark the caller OWN inbox, returning the legacy bell ' +
    'contract. Canonical type enum. Zero D1 tables. Dark behind psnotify, 404 when off.',
  lifecycle: 'alpha',
  flagKey: 'psnotify',
  owner: 'brian@megabyte.space',
  createdAt: '2026-09-28',
  updatedAt: '2026-09-28',

  // ---- surfaces ----
  routes: [],
  apiRoutes: [
    'GET /api/notifications',
    'POST /api/notifications/:id/read',
    'POST /api/notifications/read-all',
  ],

  // ---- governance ----
  permissions: [],
  dependencies: [],

  // ---- tests ----
  e2eTests: [],
  unitTests: [
    '../libs/features/psnotify/__tests__/psnotify_do.test.ts',
    '../libs/features/psnotify/__tests__/psnotify_handlers.test.ts',
  ],
  integrationTests: [],
  testStatus: 'passing',

  // ---- schemas ----
  zodSchemas: ['schemas.ts'],

  // ---- canonical notification types (schemas.ts NOTIFICATION_TYPES enum) ----
  // Every stored notification `type` is one of these six buckets. The incoming
  // workflow id / event name from notifyUser is coerced to the nearest bucket on
  // write via coerceNotificationType (unknown maps to system), so the enum is
  // enforced WITHOUT rejecting live fire-and-forget writes:
  //   site_lifecycle — publish / build-complete / reset / deploy / snapshot
  //   domain         — custom-hostname / DNS / subdomain / CNAME
  //   billing        — subscription / payment / plan / invoice / entitlement
  //   build_progress — in-flight generation progress (non-terminal)
  //   security       — auth / login / access / secret / suspicious activity
  //   system         — platform + generic notices (the catch-all default)

  // ---- observability ----
  observability: {
    axiom: false,
    logs: true,
    analytics: false,
  },

  // ---- rollout ----
  rollout: {
    defaultEnabled: false,
    environments: {
      development: false,
    },
    notes:
      'Ship dark (enabled=0, rollout=0, stage=experimental). Server guard 404s until promoted. ' +
      'Requires a `wrangler deploy --env production` to apply the PsNotifyDO SQLite DO migration ' +
      '(new_sqlite_classes=["PsNotifyDO"]) + bind PSNOTIFY_DO before enabling. Until the binding ' +
      'lands the handlers fail-soft to an empty inbox and notifyUser() no-ops the in-app write.',
  },

  risks: [
    'Activating a NEW Durable Object class REQUIRES the migration in the SAME deploy; a wrong/duplicate ' +
      'tag can 10074 and block ALL deploys — the migration tag is fresh (v_psnotify_do) and cannot be dry-run-verified.',
    'The inbox is resolved by getByName(userId) from the AUTHED session, never a request-supplied id — ' +
      'a resolver that trusted a client id would be a cross-user IDOR. Off → 404 (never 403).',
  ],

  removalNotes:
    'Remove: this module (libs/features/psnotify), the `psnotify` FLAG_REGISTRY + FLAG_DOCS entries, the ' +
    'psnotifyInbox app.route() mount + PsNotifyDO export in src/index.ts, and the PSNOTIFY_DO binding in ' +
    'wrangler.toml. Deleting the DO class needs a separate deploy with deleted_classes=["PsNotifyDO"] ' +
    '(destructive — drops all stored inboxes). Revert src/services/psnotify.ts to the console.warn stub to ' +
    'un-wire the notifyUser in-app write.',
});
