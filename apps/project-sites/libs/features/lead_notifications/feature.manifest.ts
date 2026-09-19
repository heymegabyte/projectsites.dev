import { defineFeatureManifest } from '@projectsites/feature-manifests';
export default defineFeatureManifest({
  slug: 'lead_notifications',
  name: 'Lead Notifications',
  description:
    'Email the site owner the moment a public contact form is submitted, so a new lead is never missed. Fires fire-and-forget + fail-soft on the /api/contact-form/:slug submit path (dark by default).',
  lifecycle: 'alpha',
  flagKey: 'lead_notifications',
  owner: 'brian@megabyte.space',
  createdAt: '2026-09-19',
  updatedAt: '2026-09-19',
  routes: [],
  apiRoutes: [],
  permissions: [],
  dependencies: [],
  e2eTests: ['e2e/admin-verify/verify-forms-causal.mjs'],
  unitTests: ['../libs/features/lead_notifications/__tests__/lead_notifications.test.ts'],
  integrationTests: [],
  testStatus: 'partial',
  zodSchemas: ['schemas.ts'],
  observability: { axiom: false, logs: true, analytics: false },
  rollout: {
    defaultEnabled: false,
    environments: { development: true },
    notes:
      'Dark by default (experimental). Flag off = no owner email fires (the pre-existing behavior). No server route — the notification is a fire-and-forget side-effect on the existing public contact-form submit path.',
  },
  risks: [
    'When promoted, every public form submission triggers a transactional email to the owner — verify SES sending reputation + the reply_email/owner-email resolution before rollout to avoid mis-delivery.',
    'Recipient resolution prefers ai_site_settings.reply_email then the org owner; a site with neither resolvable simply sends nothing (no error surfaced to the visitor).',
  ],
  removalNotes:
    'Remove the lead-notification waitUntil block in src/routes/forms.ts + notifyNewLead in src/services/notifications.ts + this flag. The contact-form submit + /admin/forms recording are unaffected (the notification is a pure side-effect).',
});
