import { ZodError } from 'zod';
import { redact, redactObject } from '../utils/redact.js';
import { sanitizeHtml } from '../utils/sanitize.js';
import { environmentSchema, stripeModeSchema, envConfigSchema, validateEnvConfig } from '../schemas/config.js';
import { requireRole, checkPermission } from '../middleware/rbac.js';
import { slugSchema, emailSchema, metadataSchema } from '../schemas/base.js';
import { createCheckoutSessionSchema } from '../schemas/billing.js';
import { PRICING, AUTH, DUNNING, ROLES } from '../constants/index.js';

// ─── Helpers ────────────────────────────────────────────────

const makeValidConfig = (overrides = {}) => ({
  ENVIRONMENT: 'test',
  STRIPE_SECRET_KEY: 'sk_test_1234567890',
  STRIPE_PUBLISHABLE_KEY: 'pk_test_1234567890',
  STRIPE_WEBHOOK_SECRET: 'whsec_test123',
  CF_API_TOKEN: 'cf-token',
  CF_ZONE_ID: 'zone-id',
  SENDGRID_API_KEY: 'sg-key',
  GOOGLE_CLIENT_ID: 'google-id',
  GOOGLE_CLIENT_SECRET: 'google-secret',
  GOOGLE_PLACES_API_KEY: 'places-key',
  SENTRY_DSN: 'https://sentry.example.com/1',
  ...overrides,
});

// ─── 1. redact() and redactObject() edge cases ─────────────

describe('redact() edge cases', () => {
  it('redacts password=value as SECRET_KV pattern', () => {
    const result = redact('password=mySecret123');
    expect(result).toContain('[REDACTED_SECRET]');
  });

  it('redacts otp: value as SECRET_KV pattern', () => {
    const result = redact('otp: 12345678');
    expect(result).toContain('[REDACTED_SECRET]');
  });

  it('redacts code="value" as SECRET_KV pattern', () => {
    const result = redact('code="verification_abc123"');
    expect(result).toContain('[REDACTED_SECRET]');
  });

  it('redacts both a token and an email in the same string', () => {
    const result = redact('key: sk_test_abc123xyz and email: user@example.com');
    expect(result).toContain('[REDACTED_TOKEN]');
    expect(result).toContain('[REDACTED_EMAIL]');
    expect(result).not.toContain('sk_test_');
    expect(result).not.toContain('user@example.com');
  });
});

describe('redactObject() edge cases', () => {
  it('passes through null values unchanged', () => {
    const result = redactObject({ key: null } as Record<string, unknown>);
    expect(result.key).toBeNull();
  });

  it('recurses into array values, redacting PII/secrets at every element (no leak)', () => {
    // Previously arrays were passed through raw — a PII/secret-into-logs leak.
    // Now every element is redacted: primitives pass, strings run through redact(),
    // object elements recurse (sensitive KEYS masked). A new array is returned.
    const arr = [1, 'ping alice@example.com', { password: 'abc12345' }];
    const result = redactObject({ items: arr } as Record<string, unknown>);
    const items = result.items as unknown[];
    expect(items).not.toBe(arr); // new array, original not mutated
    expect(items[0]).toBe(1);
    expect(items[1]).toBe('ping [REDACTED_EMAIL]');
    expect((items[2] as Record<string, unknown>).password).toBe('[REDACTED]');
    expect(JSON.stringify(result)).not.toContain('@example.com');
  });

  it('redacts deeply nested objects (3 levels)', () => {
    const result = redactObject({
      level1: {
        level2: {
          level3: {
            api_key: 'deep-secret',
            safe: 'visible',
          },
        },
      },
    });
    const l1 = result.level1 as Record<string, unknown>;
    const l2 = l1.level2 as Record<string, unknown>;
    const l3 = l2.level3 as Record<string, unknown>;
    expect(l3.api_key).toBe('[REDACTED]');
    expect(l3.safe).toBe('visible');
  });

  it('redacts sensitive key "authorization" to [REDACTED]', () => {
    const result = redactObject({ authorization: 'Bearer xyz123456' });
    expect(result.authorization).toBe('[REDACTED]');
  });

  it('redacts sensitive key "cookie" to [REDACTED]', () => {
    const result = redactObject({ cookie: 'session=abc123' });
    expect(result.cookie).toBe('[REDACTED]');
  });

  it('passes through numeric values unchanged', () => {
    const result = redactObject({ count: 42, ratio: 3.14 });
    expect(result.count).toBe(42);
    expect(result.ratio).toBe(3.14);
  });
});

// ─── 2. sanitizeHtml() edge cases ──────────────────────────

describe('sanitizeHtml() edge cases', () => {
  it('strips uppercase SCRIPT tags (case-insensitive)', () => {
    const result = sanitizeHtml('<SCRIPT>alert(1)</SCRIPT>');
    expect(result.toLowerCase()).not.toContain('<script');
  });

  it('strips event handlers from img tags', () => {
    const result = sanitizeHtml('<img onerror="alert(1)" src="x">');
    expect(result).not.toContain('onerror');
  });

  it('strips multiple dangerous elements in one string', () => {
    const result = sanitizeHtml('<script>a</script><iframe src="x"></iframe>');
    expect(result).not.toContain('<script');
    expect(result).not.toContain('<iframe');
  });

  it('passes through HTML entities unchanged (regex matches literal tags, not entities)', () => {
    const result = sanitizeHtml('&#60;script&#62;');
    expect(result).toBe('&#60;script&#62;');
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeHtml('')).toBe('');
  });
});

// ─── 3. Config schema edge cases ───────────────────────────

describe('environmentSchema', () => {
  it('accepts "development"', () => {
    expect(environmentSchema.parse('development')).toBe('development');
  });

  it('accepts "staging"', () => {
    expect(environmentSchema.parse('staging')).toBe('staging');
  });

  it('rejects invalid environment string', () => {
    expect(() => environmentSchema.parse('invalid')).toThrow(ZodError);
  });
});

describe('stripeModeSchema', () => {
  it('accepts "test"', () => {
    expect(stripeModeSchema.parse('test')).toBe('test');
  });

  it('accepts "live"', () => {
    expect(stripeModeSchema.parse('live')).toBe('live');
  });

  it('rejects invalid mode string', () => {
    expect(() => stripeModeSchema.parse('invalid')).toThrow(ZodError);
  });
});

describe('envConfigSchema', () => {
  it('rejects production env with mixed keys (sk_live_ + pk_test_)', () => {
    const config = makeValidConfig({
      ENVIRONMENT: 'production',
      STRIPE_SECRET_KEY: 'sk_live_1234567890',
      STRIPE_PUBLISHABLE_KEY: 'pk_test_1234567890',
    });
    expect(() => envConfigSchema.parse(config)).toThrow();
  });

  it('rejects development env with live keys', () => {
    const config = makeValidConfig({
      ENVIRONMENT: 'development',
      STRIPE_SECRET_KEY: 'sk_live_1234567890',
      STRIPE_PUBLISHABLE_KEY: 'pk_live_1234567890',
    });
    expect(() => envConfigSchema.parse(config)).toThrow();
  });

  it('validateEnvConfig succeeds with complete valid config', () => {
    const config = makeValidConfig();
    const result = validateEnvConfig(config);
    expect(result.ENVIRONMENT).toBe('test');
  });

  it('allows optional fields (OPENAI_API_KEY, etc.) to be omitted', () => {
    const config = makeValidConfig();
    // Ensure no optional keys are present
    delete (config as Record<string, unknown>).OPENAI_API_KEY;
    delete (config as Record<string, unknown>).OPEN_ROUTER_API_KEY;
    delete (config as Record<string, unknown>).GROQ_API_KEY;
    const result = envConfigSchema.parse(config);
    expect(result.OPENAI_API_KEY).toBeUndefined();
    expect(result.OPEN_ROUTER_API_KEY).toBeUndefined();
    expect(result.GROQ_API_KEY).toBeUndefined();
  });
});

// ─── 4. RBAC edge cases ────────────────────────────────────

describe('requireRole() edge cases', () => {
  it('returns true when user role equals the minimum (member === member)', () => {
    expect(requireRole('member', 'member')).toBe(true);
  });

  it('returns true when user role equals the minimum (viewer === viewer)', () => {
    expect(requireRole('viewer', 'viewer')).toBe(true);
  });
});

describe('checkPermission() edge cases', () => {
  it('admin has admin:read permission', () => {
    expect(checkPermission('admin', 'admin:read')).toBe(true);
  });

  it('admin does NOT have admin:write (only owner does)', () => {
    expect(checkPermission('admin', 'admin:write')).toBe(false);
  });

  it('member does NOT have member:delete (only owner does)', () => {
    expect(checkPermission('member', 'member:delete')).toBe(false);
  });

  it('member has site:write permission', () => {
    expect(checkPermission('member', 'site:write')).toBe(true);
  });

  it('viewer with billing_admin flag gets billing:write', () => {
    expect(checkPermission('viewer', 'billing:write', true)).toBe(true);
  });

  it('viewer does NOT have site:write', () => {
    expect(checkPermission('viewer', 'site:write')).toBe(false);
  });
});

// ─── 5. Schema boundary value tests ────────────────────────

describe('slugSchema boundary values', () => {
  it('accepts exactly 3 characters', () => {
    expect(slugSchema.parse('abc')).toBe('abc');
  });

  it('accepts exactly 63 characters', () => {
    const slug = 'a' + 'b'.repeat(61) + 'c';
    expect(slug).toHaveLength(63);
    expect(slugSchema.parse(slug)).toBe(slug);
  });

  it('rejects 2 characters', () => {
    expect(() => slugSchema.parse('ab')).toThrow(ZodError);
  });

  it('rejects 64 characters', () => {
    const slug = 'a' + 'b'.repeat(62) + 'c';
    expect(slug).toHaveLength(64);
    expect(() => slugSchema.parse(slug)).toThrow(ZodError);
  });
});

describe('emailSchema boundary values', () => {
  it('accepts email with + addressing (user+tag@example.com)', () => {
    const result = emailSchema.parse('user+tag@example.com');
    expect(result).toBe('user+tag@example.com');
  });
});

describe('metadataSchema boundary values', () => {
  it('accepts object whose JSON.stringify is exactly 65536 bytes', () => {
    // {"k":"..."} overhead is 8 chars, so value length = 65536 - 8 = 65528
    const value = 'x'.repeat(65528);
    const obj = { k: value };
    expect(JSON.stringify(obj)).toHaveLength(65536);
    expect(() => metadataSchema.parse(obj)).not.toThrow();
  });

  it('rejects object whose JSON.stringify exceeds 65536 bytes', () => {
    const value = 'x'.repeat(65529);
    const obj = { k: value };
    expect(JSON.stringify(obj).length).toBeGreaterThan(65536);
    expect(() => metadataSchema.parse(obj)).toThrow();
  });
});

describe('createCheckoutSessionSchema boundary values', () => {
  const validUuid = '550e8400-e29b-41d4-a716-446655440000';

  it('succeeds with optional site_id omitted', () => {
    const result = createCheckoutSessionSchema.parse({
      org_id: validUuid,
      success_url: 'https://example.com/success',
      cancel_url: 'https://example.com/cancel',
    });
    expect(result.org_id).toBe(validUuid);
    expect(result.site_id).toBeUndefined();
  });

  it('succeeds with site_id included', () => {
    const siteId = '660e8400-e29b-41d4-a716-446655440001';
    const result = createCheckoutSessionSchema.parse({
      org_id: validUuid,
      site_id: siteId,
      success_url: 'https://example.com/success',
      cancel_url: 'https://example.com/cancel',
    });
    expect(result.site_id).toBe(siteId);
  });
});

// ─── 6. Constants validation ────────────────────────────────

describe('constants validation', () => {
  it('PRICING.MONTHLY_CENTS equals 5000 ($50)', () => {
    expect(PRICING.MONTHLY_CENTS).toBe(5000);
  });

  it('PRICING.CURRENCY equals "usd"', () => {
    expect(PRICING.CURRENCY).toBe('usd');
  });

  it('AUTH.OTP_LENGTH equals 6', () => {
    expect(AUTH.OTP_LENGTH).toBe(6);
  });

  it('DUNNING.DOWNGRADE_DAY is greater than all REMINDER_DAYS values', () => {
    for (const day of DUNNING.REMINDER_DAYS) {
      expect(DUNNING.DOWNGRADE_DAY).toBeGreaterThan(day);
    }
  });

  it('ROLES has exactly 4 elements: owner, admin, member, viewer', () => {
    expect(ROLES).toHaveLength(4);
    expect([...ROLES]).toEqual(['owner', 'admin', 'member', 'viewer']);
  });
});
