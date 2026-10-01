/**
 * Money-path regression — the site-generation workflow's TERMINAL owner-notify must fire
 * the CANONICAL psnotify event (`{ name, subscriberId, payload }`) on BOTH build.complete
 * and build.failed, carrying the live-site URL as the bell row's `action_url` — AND the
 * build.complete bell must flag reduced quality when the build finished DEGRADED (seed-only).
 *
 * We assert the REAL call-site shape, not a mock: both terminal steps in
 * `workflows/site-generation.ts` pass `buildOwnerNotifyEvent(kind, facts)` VERBATIM to
 * `notifyOwnerEvent(env, db, …)`, so asserting this pure builder's output asserts exactly
 * what reaches the DO-write boundary. `notifyOwnerEvent` itself (D1 owner resolution + the
 * `triggerPsnotify` DO write) is covered by `site_generation_build_notify.test.ts`.
 *
 * The gap this closes (fire-66): the completion EMAIL (`notifySiteBuilt` `degraded`) is honest
 * about a seed-only build, but the in-app BELL said a flat "is live 🎉" regardless — lying to an
 * owner who relies on the bell (degraded-success-must-flag-reduced-quality-to-user). The bell is
 * now degraded-aware and the fail/complete event shapes are unit-locked against novu-era drift.
 */
import { buildOwnerNotifyEvent } from '../workflows/site-generation.js';

const SUFFIX = '.projectsites.dev';
const facts = {
  orgId: 'org_1',
  siteId: 'site_1',
  slug: 'acme',
  businessName: "Acme Barbers",
};
const SITE_URL = `https://acme${SUFFIX}`;

describe('buildOwnerNotifyEvent — the terminal owner-notify wire shape (complete + failed)', () => {
  it('build.complete: canonical {name,subscriberId,payload} carrying the site URL as action_url', () => {
    const ev = buildOwnerNotifyEvent('complete', facts);

    // Canonical PsnotifyEventSchema shape — the fire-51 novu-era object failed this.
    expect(ev.workflowId).toBe('build.complete');
    expect(ev.event.name).toBe('build.complete');
    expect(ev.event.subscriberId).toBe('org_1'); // placeholder; owner email resolved server-side
    expect(ev.actionUrl).toBe(SITE_URL);
    // The bell row deep-links to the live site.
    expect(ev.event.payload.action_url).toBe(SITE_URL);
    expect(ev.event.payload.siteId).toBe('site_1');
    // Non-degraded copy is the celebratory "is live" line, degraded flag false.
    expect(String(ev.event.payload.subject)).toContain('live');
    expect(ev.event.payload.degraded).toBe(false);
    expect(String(ev.event.payload.body)).toContain(`acme${SUFFIX}`);
  });

  it('build.complete (DEGRADED): bell flags reduced quality — NOT a flat "is live 🎉"', () => {
    const plain = buildOwnerNotifyEvent('complete', facts);
    const degraded = buildOwnerNotifyEvent('complete', { ...facts, degraded: true });

    // The degraded flag rides in the payload so the bell renderer can style it.
    expect(degraded.event.payload.degraded).toBe(true);
    // The subject + body MUST differ from the celebratory copy (honest reduced-quality framing).
    expect(String(degraded.event.payload.subject)).not.toBe(String(plain.event.payload.subject));
    expect(String(degraded.event.payload.body)).not.toBe(String(plain.event.payload.body));
    // And it must actually SAY the quality is reduced + point at the free regenerate.
    expect(String(degraded.event.payload.body).toLowerCase()).toContain('reduced-quality');
    expect(String(degraded.event.payload.body).toLowerCase()).toContain('regenerate');
    // Still a real build.complete carrying the deep link (the site IS published).
    expect(degraded.event.name).toBe('build.complete');
    expect(degraded.event.payload.action_url).toBe(SITE_URL);
  });

  it('build.failed: canonical event tells the owner WHY + carries the retry deep link', () => {
    const reason = 'Build timed out after 900s';
    const ev = buildOwnerNotifyEvent('failed', { ...facts, reason });

    expect(ev.workflowId).toBe('build.failed');
    expect(ev.event.name).toBe('build.failed');
    expect(ev.event.subscriberId).toBe('org_1');
    // The failure reason is the bell body — the owner is told what happened.
    expect(ev.event.payload.body).toBe(reason);
    expect(String(ev.event.payload.subject)).toContain('attention');
    expect(ev.event.payload.siteId).toBe('site_1');
    expect(ev.actionUrl).toBe(SITE_URL);
    expect(ev.event.payload.action_url).toBe(SITE_URL);
  });

  it('build.failed with a missing slug: omits action_url rather than sending an empty string', () => {
    const ev = buildOwnerNotifyEvent('failed', {
      orgId: 'org_1',
      siteId: 'site_1',
      slug: '',
      businessName: '',
      reason: 'boom',
    });
    // No slug → no deep link field at all (never action_url: '' / null).
    expect(ev.actionUrl).toBeUndefined();
    expect('action_url' in ev.event.payload).toBe(false);
    // Still a valid canonical failure event with a fallback-safe body.
    expect(ev.event.name).toBe('build.failed');
    expect(ev.event.payload.body).toBe('boom');
  });
});
