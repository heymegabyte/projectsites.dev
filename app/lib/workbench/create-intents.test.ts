import { describe, it, expect } from 'vitest';
import {
  CreateIntentSchema,
  classifyIntent,
  cronFromText,
  scaffoldForIntent,
  slugify,
  nameFromText,
  CREATE_TEMPLATES,
} from './create-intents';

describe('slugify', () => {
  it('kebab-cases and strips unsafe chars', () => {
    expect(slugify('Contact Form!')).toBe('contact-form');
    expect(slugify('  Ada/Lovelace ')).toBe('ada-lovelace');
  });
  it('falls back when empty', () => {
    expect(slugify('', 'x')).toBe('x');
    expect(slugify('!!!', 'fallback')).toBe('fallback');
  });
});

describe('cronFromText', () => {
  it('parses "every night at 2 AM" → 0 2 * * *', () => {
    expect(cronFromText('refresh the sitemap every night at 2 AM')).toBe('0 2 * * *');
  });
  it('parses PM correctly', () => {
    expect(cronFromText('run at 5 pm')).toBe('0 17 * * *');
  });
  it('parses "every 15 minutes"', () => {
    expect(cronFromText('poll every 15 minutes')).toBe('*/15 * * * *');
  });
  it('parses hourly + weekly + monthly', () => {
    expect(cronFromText('every hour')).toBe('0 * * * *');
    expect(cronFromText('weekly digest')).toBe('0 2 * * 1');
    expect(cronFromText('monthly report')).toBe('0 2 1 * *');
  });
  it('defaults to nightly 02:00', () => {
    expect(cronFromText('nightly cleanup')).toBe('0 2 * * *');
  });
});

describe('nameFromText', () => {
  it('honors an explicit "called X"', () => {
    expect(nameFromText('a function called order sync', 'function')).toBe('order-sync');
  });
  it('derives from a domain keyword', () => {
    expect(nameFromText('an endpoint to receive contact submissions', 'endpoint')).toBe('contact');
  });
});

describe('classifyIntent', () => {
  it('classifies a scheduled job from natural language', () => {
    const i = classifyIntent('Run a sitemap refresh every night at 2 AM.');
    expect(i.kind).toBe('cron');
    if (i.kind === 'cron') expect(i.schedule).toBe('0 2 * * *');
  });
  it('classifies an API endpoint (POST) and validates', () => {
    const i = classifyIntent('Create a contact-form endpoint that validates input and sends an email.');
    expect(i.kind).toBe('endpoint');
    if (i.kind === 'endpoint') expect(i.method).toBe('POST');
    expect(() => CreateIntentSchema.parse(i)).not.toThrow();
  });
  it('classifies a GET endpoint when read/list phrasing', () => {
    const i = classifyIntent('an api route to list recent orders');
    expect(i.kind).toBe('endpoint');
    if (i.kind === 'endpoint') expect(i.method).toBe('GET');
  });
  it('classifies a workflow', () => {
    const i = classifyIntent('Create a workflow that publishes approved pages and purges the cache.');
    expect(i.kind).toBe('workflow');
  });
  it('defaults to a function', () => {
    const i = classifyIntent('something that formats a phone number');
    expect(i.kind).toBe('function');
  });
});

describe('CreateIntentSchema', () => {
  it('rejects an unknown kind', () => {
    expect(() => CreateIntentSchema.parse({ kind: 'nope', name: 'x' })).toThrow();
  });
  it('rejects an empty name', () => {
    expect(() => CreateIntentSchema.parse({ kind: 'function', name: '' })).toThrow();
  });
  it('defaults endpoint method to POST', () => {
    const parsed = CreateIntentSchema.parse({ kind: 'endpoint', name: 'contact' });
    if (parsed.kind === 'endpoint') expect(parsed.method).toBe('POST');
  });
});

describe('scaffoldForIntent', () => {
  it('scaffolds a function to functions/api/<slug>.ts with onRequest handlers', () => {
    const r = scaffoldForIntent({ kind: 'function', name: 'Phone Formatter' });
    expect(r.files).toHaveLength(1);
    expect(r.files[0].path).toBe('functions/api/phone-formatter.ts');
    expect(r.openPath).toBe('functions/api/phone-formatter.ts');
    expect(r.files[0].content).toContain('onRequestGet');
    expect(r.files[0].content).toContain('onRequestPost');
    expect(r.sensitive).toBe(false);
  });
  it('scaffolds a POST endpoint with input validation', () => {
    const r = scaffoldForIntent({ kind: 'endpoint', name: 'contact', method: 'POST' });
    expect(r.files[0].path).toBe('functions/api/contact.ts');
    expect(r.files[0].content).toContain('onRequestPost');
    expect(r.files[0].content).toMatch(/errors/);
  });
  it('scaffolds a cron to functions/_scheduled.ts with the cron export', () => {
    const r = scaffoldForIntent({ kind: 'cron', name: 'sitemap', schedule: '0 2 * * *' });
    expect(r.files[0].path).toBe('functions/_scheduled.ts');
    expect(r.files[0].content).toContain("export const cron = '0 2 * * *'");
    expect(r.files[0].content).toContain('export const scheduled');
  });
  it('scaffolds a workflow as an ordered multi-step endpoint', () => {
    const r = scaffoldForIntent({ kind: 'workflow', name: 'publish-and-purge' });
    expect(r.files[0].path).toBe('functions/api/publish-and-purge.ts');
    expect(r.files[0].content).toContain('step-1');
    expect(r.files[0].content).toContain('waitUntil');
  });
  it('resolves a template id to its underlying intent', () => {
    const r = scaffoldForIntent({ kind: 'template', name: 'contact', templateId: 'contact-endpoint' });
    expect(r.files[0].path).toBe('functions/api/contact.ts');
  });
  it('throws on an unknown template id', () => {
    expect(() => scaffoldForIntent({ kind: 'template', name: 'x', templateId: 'nope' })).toThrow();
  });
  it('every curated template scaffolds cleanly', () => {
    for (const tpl of CREATE_TEMPLATES) {
      const r = scaffoldForIntent(tpl.intent);
      expect(r.files.length).toBeGreaterThan(0);
      expect(r.openPath).toBeTruthy();
    }
  });
});
