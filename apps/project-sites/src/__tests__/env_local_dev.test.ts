/**
 * @module __tests__/env_local_dev
 * @description Regression for the Long-Trail LIVE-slice RED: `parseEnv` used to
 * hard-fail EVERY request (VALIDATION_ERROR) on a `wrangler dev` box because the
 * nine third-party integration secrets (Stripe / Places / PostHog / CF-for-SaaS)
 * were `.min(1)`-required and legitimately absent locally — so the entire local
 * stack (health, auth/test-login, /api/auth/me) 400'd before any route ran and
 * the app could never come up connected for E2E.
 *
 * The fix makes those nine secrets required in production but optional when
 * `ENVIRONMENT` is a local/dev tag (`development`/`dev`/`local`/`test`). These
 * tests pin BOTH halves so a future edit can't silently re-harden local dev OR
 * silently relax prod.
 */
import { parseEnv, isLocalDevEnv, buildEnvSchema } from '../lib/env';

/** The nine secrets that are prod-required but local-optional. */
const PROD_REQUIRED_SECRETS = [
  'POSTHOG_API_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_PUBLISHABLE_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'CF_API_TOKEN',
  'CF_ZONE_ID',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_PLACES_API_KEY',
];

/** A full prod env with every required secret populated + a platform binding. */
function fullProdEnv(): Record<string, unknown> {
  const env: Record<string, unknown> = { ENVIRONMENT: 'production' };
  for (const k of PROD_REQUIRED_SECRETS) env[k] = 'x-value';
  // A non-string platform binding must be skipped, never parsed as a string.
  env.DB = { prepare: () => ({}) };
  return env;
}

describe('lib/env — local-dev secret relaxation', () => {
  describe('isLocalDevEnv', () => {
    it.each(['development', 'dev', 'local', 'test', 'DEVELOPMENT'])(
      'is true for ENVIRONMENT=%s',
      (tag) => {
        expect(isLocalDevEnv({ ENVIRONMENT: tag })).toBe(true);
      },
    );

    it.each(['production', 'prod', 'staging', '', undefined])(
      'is false for ENVIRONMENT=%s',
      (tag) => {
        expect(isLocalDevEnv({ ENVIRONMENT: tag })).toBe(false);
      },
    );
  });

  describe('parseEnv — local dev (the reproduced RED)', () => {
    it('parses a bare local box (only ENVIRONMENT=development) WITHOUT throwing', () => {
      // This is the exact shape `wrangler dev` + .dev.vars produced. Pre-fix this
      // threw a ZodError → VALIDATION_ERROR 400 on every request.
      expect(() => parseEnv({ ENVIRONMENT: 'development' })).not.toThrow();
    });

    it('leaves the nine integration secrets undefined (not fabricated) in dev', () => {
      const parsed = parseEnv({ ENVIRONMENT: 'development' });
      for (const k of PROD_REQUIRED_SECRETS) {
        expect((parsed as Record<string, unknown>)[k]).toBeUndefined();
      }
      expect(parsed.ENVIRONMENT).toBe('development');
    });

    it('still requires ENVIRONMENT itself even in a local shape', () => {
      // No ENVIRONMENT → not a local box → prod-strict → throws on the missing set.
      expect(() => parseEnv({})).toThrow();
    });
  });

  describe('parseEnv — production stays fail-fast', () => {
    it('throws when a prod box is missing the required secrets', () => {
      expect(() => parseEnv({ ENVIRONMENT: 'production' })).toThrow();
    });

    it('passes when a prod box has every required secret', () => {
      expect(() => parseEnv(fullProdEnv())).not.toThrow();
    });

    it('names every still-missing required secret in the prod error', () => {
      let issues: string[] = [];
      try {
        parseEnv({ ENVIRONMENT: 'production' });
      } catch (err) {
        const zerr = err as { issues?: { path: (string | number)[] }[] };
        issues = (zerr.issues ?? []).map((i) => String(i.path[0]));
      }
      for (const k of PROD_REQUIRED_SECRETS) expect(issues).toContain(k);
    });
  });

  describe('buildEnvSchema', () => {
    it('local variant accepts an empty-but-tagged object', () => {
      expect(buildEnvSchema(true).safeParse({ ENVIRONMENT: 'development' }).success).toBe(true);
    });

    it('prod variant rejects an object missing the required secrets', () => {
      expect(buildEnvSchema(false).safeParse({ ENVIRONMENT: 'production' }).success).toBe(false);
    });
  });
});
