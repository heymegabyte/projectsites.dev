import { resolveActiveSchedule } from '../service';
import type { PromptSchedule } from '../schemas';

function sched(partial: Partial<PromptSchedule>): PromptSchedule {
  return {
    id: partial.id ?? crypto.randomUUID(),
    org_id: partial.org_id ?? 'org-1',
    prompt_key: partial.prompt_key ?? 'hero',
    variant: partial.variant ?? 'v-default',
    activate_at: partial.activate_at ?? '2026-01-01T00:00:00Z',
    deactivate_at: partial.deactivate_at ?? null,
    label: partial.label ?? null,
    created_at: partial.created_at ?? '2026-01-01T00:00:00Z',
  };
}

const NOW = Date.parse('2026-06-15T12:00:00Z');

describe('resolveActiveSchedule (pure, read-time activation)', () => {
  it('returns null when no schedules exist', () => {
    expect(resolveActiveSchedule([], 'hero', NOW)).toBeNull();
  });

  it('returns null when the only schedule is for a different key', () => {
    expect(resolveActiveSchedule([sched({ prompt_key: 'footer' })], 'hero', NOW)).toBeNull();
  });

  it('activates a schedule whose window contains now', () => {
    const s = sched({ variant: 'holiday', activate_at: '2026-06-01T00:00:00Z', deactivate_at: '2026-07-01T00:00:00Z' });
    expect(resolveActiveSchedule([s], 'hero', NOW)?.variant).toBe('holiday');
  });

  it('ignores a future window (activate_at > now)', () => {
    const s = sched({ variant: 'future', activate_at: '2026-12-01T00:00:00Z' });
    expect(resolveActiveSchedule([s], 'hero', NOW)).toBeNull();
  });

  it('ignores an expired window (deactivate_at <= now)', () => {
    const s = sched({ variant: 'old', activate_at: '2026-01-01T00:00:00Z', deactivate_at: '2026-02-01T00:00:00Z' });
    expect(resolveActiveSchedule([s], 'hero', NOW)).toBeNull();
  });

  it('treats a null deactivate_at as open-ended (still active)', () => {
    const s = sched({ variant: 'evergreen', activate_at: '2026-01-01T00:00:00Z', deactivate_at: null });
    expect(resolveActiveSchedule([s], 'hero', NOW)?.variant).toBe('evergreen');
  });

  it('on overlap, the MOST-RECENTLY-ACTIVATED window wins', () => {
    const older = sched({ variant: 'baseline', activate_at: '2026-01-01T00:00:00Z' });
    const newer = sched({ variant: 'campaign', activate_at: '2026-06-10T00:00:00Z' });
    expect(resolveActiveSchedule([older, newer], 'hero', NOW)?.variant).toBe('campaign');
    // order-independent
    expect(resolveActiveSchedule([newer, older], 'hero', NOW)?.variant).toBe('campaign');
  });

  it('skips a schedule with an unparseable activate_at (never throws)', () => {
    const bad = sched({ variant: 'bad', activate_at: 'not-a-date' });
    const good = sched({ variant: 'good', activate_at: '2026-06-01T00:00:00Z' });
    expect(resolveActiveSchedule([bad, good], 'hero', NOW)?.variant).toBe('good');
  });

  it('boundary: activate_at == now is active; deactivate_at == now is expired (half-open [start, end))', () => {
    const startsNow = sched({ variant: 'starts', activate_at: new Date(NOW).toISOString() });
    expect(resolveActiveSchedule([startsNow], 'hero', NOW)?.variant).toBe('starts');
    const endsNow = sched({ variant: 'ends', activate_at: '2026-01-01T00:00:00Z', deactivate_at: new Date(NOW).toISOString() });
    expect(resolveActiveSchedule([endsNow], 'hero', NOW)).toBeNull();
  });
});
