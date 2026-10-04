// functions/_middleware.ts — server-side Sentry for Cloudflare Pages Functions.
//
// Runs BEFORE every other Function (including the Remix catch-all
// `[[path]].ts`), wrapping the request so render/loader/action errors are
// captured with request context. Pages variant of the estate recipe
// (see template.projectsites.dev/docs/SENTRY.md → "Pages Functions variant").
//
// No-op safe: when SENTRY_DSN is unset the SDK is disabled, so this ships
// before the secret exists. Set the DSN as a Pages secret:
//   npx wrangler pages secret put SENTRY_DSN --project-name <project>
//
// Requires `nodejs_compat` (declared in wrangler.toml).
import * as Sentry from "@sentry/cloudflare";

export const onRequest = [
  // Sentry MUST be the first middleware in the chain.
  Sentry.sentryPagesPlugin((context) => {
    const dsn = (context.env as { SENTRY_DSN?: string }).SENTRY_DSN ?? "";
    return {
      dsn,
      enabled: Boolean(dsn),
      tracesSampleRate: 0.1,
    };
  }),
];
