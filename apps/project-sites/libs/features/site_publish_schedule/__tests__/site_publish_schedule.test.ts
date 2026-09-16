import { resolveDueSchedules } from '../service';
import { CreatePublishScheduleSchema, PublishScheduleSchema } from '../schemas';
import type { PublishSchedule } from '../schemas';

const NOW = Date.parse('2026-12-01T12:00:00.000Z');

function row(over: Partial<PublishSchedule>): PublishSchedule {
  return {
    id: over.id ?? crypto.randomUUID(),
    org_id: 'org-1',
    site_id: 'site-1',
    publish_at: over.publish_at ?? '2026-11-01T00:00:00.000Z',
    status: over.status ?? 'pending',
    label: over.label ?? null,
    created_at: '2026-10-01T00:00:00.000Z',
    fired_at: over.fired_at ?? null,
    ...over,
  };
}

describe('resolveDueSchedules — the cron due-set (pure)', () => {
  it('includes a PENDING row whose publish_at has passed', () => {
    const due = resolveDueSchedules([row({ publish_at: '2026-11-01T00:00:00.000Z' })], NOW);
    expect(due).toHaveLength(1);
  });

  it('excludes a PENDING row whose publish_at is still in the future', () => {
    const due = resolveDueSchedules([row({ publish_at: '2027-01-01T00:00:00.000Z' })], NOW);
    expect(due).toHaveLength(0);
  });

  it('includes a row due EXACTLY at now (<= boundary)', () => {
    const due = resolveDueSchedules([row({ publish_at: '2026-12-01T12:00:00.000Z' })], NOW);
    expect(due).toHaveLength(1);
  });

  it('never re-fires a fired / canceled / skipped row even when past', () => {
    const past = '2026-11-01T00:00:00.000Z';
    for (const status of ['fired', 'canceled', 'skipped'] as const) {
      expect(resolveDueSchedules([row({ publish_at: past, status })], NOW)).toHaveLength(0);
    }
  });

  it('excludes a row with an unparseable publish_at (never throws)', () => {
    expect(resolveDueSchedules([row({ publish_at: 'not-a-date' })], NOW)).toHaveLength(0);
  });

  it('preserves input order among the due rows', () => {
    const a = row({ id: 'a', publish_at: '2026-10-01T00:00:00.000Z' });
    const b = row({ id: 'b', publish_at: '2026-11-15T00:00:00.000Z' });
    expect(resolveDueSchedules([a, b], NOW).map((s) => s.id)).toEqual(['a', 'b']);
  });
});

describe('CreatePublishScheduleSchema — Zod boundary', () => {
  it('accepts a valid ISO publish_at + optional label', () => {
    const r = CreatePublishScheduleSchema.safeParse({
      publish_at: '2026-12-25T09:00:00.000Z',
      label: 'Grand opening',
    });
    expect(r.success).toBe(true);
  });

  it('rejects a non-datetime publish_at', () => {
    expect(CreatePublishScheduleSchema.safeParse({ publish_at: 'soon' }).success).toBe(false);
  });

  it('rejects an unknown field (.strict)', () => {
    const r = CreatePublishScheduleSchema.safeParse({
      publish_at: '2026-12-25T09:00:00.000Z',
      site_id: 'sneaky',
    });
    expect(r.success).toBe(false);
  });
});

describe('PublishScheduleSchema — status enum', () => {
  it('rejects an out-of-enum status', () => {
    expect(PublishScheduleSchema.safeParse(row({ status: 'weird' as never })).success).toBe(false);
  });
});
