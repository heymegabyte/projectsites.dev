/**
 * redact() — secret-format regression suite.
 *
 * Guards the fix that extended TOKEN_REGEX beyond Stripe/Bearer to the API-key
 * formats this stack actually uses. The old pattern was `_`-prefixed only, so
 * OpenAI/Anthropic (`sk-…`, hyphen), GitHub, Google, AWS, Slack, and JWTs leaked
 * verbatim into logs/Sentry/PostHog despite `redact()`. Each case asserts the
 * raw secret is gone and a redaction placeholder took its place — and that
 * clearly-benign text is not mangled.
 */
import { redact, redactObject } from '../utils/redact.js';

describe('redact() — provider secret formats', () => {
  const secrets: Array<[string, string]> = [
    ['OpenAI project key', 'sk-proj-AbCdEf0123456789' + 'AbCdEf0123456789'],
    ['OpenAI legacy key', 'sk-AbCdEf0123456789' + 'AbCdEf01'],
    ['Anthropic key', 'sk-ant-api03-AbCdEf0123456789' + '_AbCdEf01-23'],
    ['GitHub PAT (classic)', 'ghp_AbCdEf0123456789' + 'AbCdEf0123456789abcd'],
    ['GitHub fine-grained PAT', 'github_pat_11ABCDEFG0' + 'aBcDeFgHiJk_lMnOpQrStUvWxYz'],
    ['Google API key', 'AIzaSyA0123456789' + 'AbCdEf0123456789AbCdEf0'],
    ['AWS access key', 'AKIAIOSFODNN7EXAMPLE'],
    ['Slack bot token', 'xoxb-1234567890-' + 'ABCDEFGHIJKLMNOP'],
    ['Stripe live secret', 'sk_live_AbCdEf0123456789' + 'AbCd'],
    ['Stripe webhook secret', 'whsec_AbCdEf0123456789' + 'AbCd'],
    ['Bearer token', 'Bearer AbCdEf0123456789AbCdEf01'],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'],
  ];

  for (const [name, secret] of secrets) {
    it(`redacts ${name}`, () => {
      const out = redact(`auth header: ${secret} end`);
      // (Jest's expect() takes no message arg; the test name identifies the case.)
      expect(out).not.toContain(secret);
      expect(out).toContain('[REDACTED');
      // the surrounding non-secret text survives
      expect(out).toContain('auth header:');
      expect(out).toContain('end');
    });
  }

  it('still redacts email + phone alongside tokens', () => {
    const out = redact('alice@example.com called +14155550123 with sk-AbCdEf0123456789' + 'AbCdEf01');
    expect(out).toContain('[REDACTED_EMAIL]');
    expect(out).toContain('[REDACTED_PHONE]');
    expect(out).toContain('[REDACTED_TOKEN]');
    expect(out).not.toContain('alice@example.com');
  });

  it('does not mangle clearly-benign text', () => {
    expect(redact('Hello world — order shipped')).toBe('Hello world — order shipped');
    expect(redact('Build finished in 4 minutes')).toBe('Build finished in 4 minutes');
  });

  it('redactObject masks sensitive keys and redacts nested token strings', () => {
    const out = redactObject({
      user: 'bob',
      authorization: 'Bearer xyz123456789',
      meta: { note: 'key is sk-ant-api03-AbCdEf0123456789' + '_AbCdEf01-23', count: 3 },
    });
    expect(out['user']).toBe('bob');
    expect(out['authorization']).toBe('[REDACTED]');
    const meta = out['meta'] as Record<string, unknown>;
    expect(meta['note']).toContain('[REDACTED_TOKEN]');
    expect(meta['note']).not.toContain('sk-ant-');
    expect(meta['count']).toBe(3);
  });

  // Regression (sweep — redactObject array leak): arrays were passed through
  // UNREDACTED, leaking PII/secrets nested in arrays into logs/Sentry/PostHog.
  it('redactObject redacts PII in an array of strings (not passed through raw)', () => {
    const out = redactObject({ recipients: ['alice@example.com', 'bob@example.com', 'ok text'] });
    const recipients = out['recipients'] as string[];
    expect(recipients[0]).toBe('[REDACTED_EMAIL]');
    expect(recipients[1]).toBe('[REDACTED_EMAIL]');
    expect(recipients[2]).toBe('ok text');
    expect(JSON.stringify(out)).not.toContain('@example.com');
  });

  it('redactObject redacts secrets/PII inside an array of objects', () => {
    const out = redactObject({
      users: [
        { name: 'carol', email: 'carol@example.com', token: 'Bearer abc123456789' },
        { name: 'dave', email: 'dave@example.com' },
      ],
    });
    const users = out['users'] as Array<Record<string, unknown>>;
    expect(users[0]?.['name']).toBe('carol');
    expect(users[0]?.['email']).toBe('[REDACTED_EMAIL]');
    expect(users[0]?.['token']).toBe('[REDACTED]'); // sensitive KEY masked even inside an array element
    expect(users[1]?.['email']).toBe('[REDACTED_EMAIL]');
    expect(JSON.stringify(out)).not.toContain('@example.com');
    expect(JSON.stringify(out)).not.toContain('abc123456789');
  });

  it('redactObject masks a sensitive KEY whose value is an array (never walked/leaked)', () => {
    const out = redactObject({ tokens: ['sk_live_abc123456789', 'sk_live_def987654321'] });
    expect(out['tokens']).toBe('[REDACTED]');
    expect(JSON.stringify(out)).not.toContain('sk_live_');
  });

  it('redactObject redacts PII in a deeply-nested array (array → object → array)', () => {
    const out = redactObject({ batch: [{ contacts: ['eve@example.com'] }] });
    const batch = out['batch'] as Array<Record<string, unknown>>;
    const contacts = batch[0]?.['contacts'] as string[];
    expect(contacts[0]).toBe('[REDACTED_EMAIL]');
    expect(JSON.stringify(out)).not.toContain('@example.com');
  });
});
