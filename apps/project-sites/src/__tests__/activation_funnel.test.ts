/**
 * Revenue-funnel SSOT (§9). Locks the ordered milestones + the event→stage map
 * that the Tinybird activation_funnel pipe queries. Drift here = the analytics
 * surface counts a different funnel than the product claims.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ACTIVATION_STAGES,
  ACTIVATION_EVENTS,
  ACTIVATION_INGEST_EVENTS,
  DELIVERED_EVENTS,
  funnelStage,
  isActivationEvent,
} from '../services/activation_funnel.js';
import { EVENT_TYPES } from '../services/event_bus.js';

describe('activation funnel', () => {
  it('is four ordered milestones, top → bottom', () => {
    expect(ACTIVATION_STAGES.map((s) => s.event)).toEqual([
      'lead.discovered',
      'site.claim.started',
      'site.published',
      'subscription.active',
    ]);
    // ordinals are 0..3, strictly increasing
    expect(ACTIVATION_STAGES.map((s) => s.ordinal)).toEqual([0, 1, 2, 3]);
  });

  it('every stage event is a real bus event type (no drift)', () => {
    for (const ev of ACTIVATION_EVENTS) {
      expect(EVENT_TYPES).toContain(ev);
    }
  });

  it('funnelStage places a funnel event and returns its label + ordinal', () => {
    expect(funnelStage('site.published')).toEqual({
      event: 'site.published',
      label: 'Delivered',
      ordinal: 2,
    });
    expect(funnelStage('subscription.active')?.ordinal).toBe(3);
  });

  it('funnelStage returns null for a non-funnel event', () => {
    expect(funnelStage('site.created')).toBeNull();
    expect(funnelStage('invoice.failed')).toBeNull();
    expect(funnelStage('not.an.event')).toBeNull();
  });

  it('isActivationEvent discriminates funnel vs non-funnel events', () => {
    expect(isActivationEvent('lead.discovered')).toBe(true);
    expect(isActivationEvent('site.publish.failed')).toBe(false);
  });
});

describe('activation funnel — site.generated Delivered alias (AL-472)', () => {
  it('canonical stages stay 4 (site.generated is an alias, not a 5th stage)', () => {
    expect(ACTIVATION_STAGES).toHaveLength(4);
    expect(ACTIVATION_STAGES.map((s) => s.event)).not.toContain('site.generated');
  });

  it('funnelStage maps site.generated to the Delivered stage (the workflow delivery event)', () => {
    expect(funnelStage('site.generated')).toEqual({
      event: 'site.published',
      label: 'Delivered',
      ordinal: 2,
    });
    expect(isActivationEvent('site.generated')).toBe(true);
  });

  it('DELIVERED_EVENTS = both delivery events; ACTIVATION_INGEST_EVENTS adds the alias to the pipe WHERE set', () => {
    expect(DELIVERED_EVENTS).toEqual(['site.published', 'site.generated']);
    // The pipe's WHERE event IN (...) must ingest all four canonical stage events + site.generated.
    expect([...ACTIVATION_INGEST_EVENTS].sort()).toEqual(
      [...ACTIVATION_EVENTS, 'site.generated'].sort(),
    );
    for (const ev of ACTIVATION_INGEST_EVENTS) expect(EVENT_TYPES).toContain(ev);
  });
});

describe('activation funnel — pipe ↔ TS SSOT lockstep (AL-717)', () => {
  // The .pipe file is deployed to Tinybird and computes the funnel; the TS is the
  // SSOT the app + probes read against. Nothing enforced they agree, so a pipe edit
  // (or a stale prod deploy) could silently under-count Delivered — exactly the
  // AL-472/AL-717 class (site.generated dropped from the WHERE → Delivered froze at
  // the site.published-only count). Parse the ACTUAL pipe file and assert its
  // WHERE event IN (...) list + the site.generated→site.published canonicalization
  // match the TS SSOT, so repo-side drift fails the build the moment it lands.
  const pipeSrc = readFileSync(
    join(__dirname, '..', '..', 'tinybird', 'pipes', 'activation_funnel.pipe'),
    'utf8',
  );

  /** Extract the event-name literals from the pipe's `WHERE event IN ('a','b',...)`. */
  function pipeWhereEvents(src: string): string[] {
    const m = src.match(/WHERE\s+event\s+IN\s*\(([^)]*)\)/i);
    if (!m) return [];
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  }

  it('pipe WHERE event IN (...) is exactly the ACTIVATION_INGEST_EVENTS set (no drift)', () => {
    const where = pipeWhereEvents(pipeSrc);
    expect(where.length).toBeGreaterThan(0); // the regex actually matched the pipe
    expect([...where].sort()).toEqual([...ACTIVATION_INGEST_EVENTS].sort());
  });

  it('pipe canonicalizes site.generated → site.published (Delivered alias merges into the stage)', () => {
    // multiIf(event = 'site.generated', 'site.published', event) AS stage
    expect(pipeSrc).toMatch(
      /multiIf\(\s*event\s*=\s*'site\.generated'\s*,\s*'site\.published'\s*,\s*event\s*\)/,
    );
    // and the DELIVERED_EVENTS union both appear in the ordinal-2 canonicalization
    for (const ev of DELIVERED_EVENTS) expect(pipeSrc).toContain(`'${ev}'`);
  });
});
