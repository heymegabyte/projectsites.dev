/**
 * Tests for the Review Requests pure core (flag `review_requests`).
 * Focus: deterministic rating routing (public/private/invalid) + the policy-safe throttle
 * (genuine trigger · min-age · cooldown · already-reviewed). Time is injected — no Date.now().
 */
import {
  routeByRating,
  isGenuineTrigger,
  shouldRequestReview,
  POSITIVE_THRESHOLD,
} from '../services/review_routing.js';

const T = 1_700_000_000_000; // fixed "now" (epoch ms)
const HOURS = 3_600_000;
const DAYS = 86_400_000;

describe('review_routing: routeByRating', () => {
  it('sends 4–5 stars public, 1–3 stars private', () => {
    expect(routeByRating(5)).toBe('public');
    expect(routeByRating(4)).toBe('public');
    expect(routeByRating(3)).toBe('private');
    expect(routeByRating(1)).toBe('private');
    expect(POSITIVE_THRESHOLD).toBe(4);
  });
  it('rejects out-of-range or non-integer ratings', () => {
    expect(routeByRating(0)).toBe('invalid');
    expect(routeByRating(6)).toBe('invalid');
    expect(routeByRating(4.5)).toBe('invalid');
  });
  it('honors a stricter threshold', () => {
    expect(routeByRating(4, 5)).toBe('private');
    expect(routeByRating(5, 5)).toBe('public');
  });
});

describe('review_routing: isGenuineTrigger', () => {
  it('accepts completed-interaction triggers, rejects page views', () => {
    expect(isGenuineTrigger('booking_completed')).toBe(true);
    expect(isGenuineTrigger('order_delivered')).toBe(true);
    expect(isGenuineTrigger('page_view')).toBe(false);
    expect(isGenuineTrigger('')).toBe(false);
  });
});

describe('review_routing: shouldRequestReview', () => {
  it('sends for a genuine, settled, first-time interaction', () => {
    const r = shouldRequestReview({
      trigger: 'order_delivered',
      completedAt: T - 2 * HOURS,
      now: T,
    });
    expect(r.send).toBe(true);
    expect(r.reason).toBe('eligible');
  });
  it('refuses a non-genuine trigger', () => {
    expect(
      shouldRequestReview({ trigger: 'page_view', completedAt: T - 2 * HOURS, now: T }).send,
    ).toBe(false);
  });
  it('refuses when the customer already reviewed', () => {
    expect(
      shouldRequestReview({
        trigger: 'booking_completed',
        completedAt: T - 2 * HOURS,
        now: T,
        alreadyReviewed: true,
      }).send,
    ).toBe(false);
  });
  it('refuses too soon after the interaction (default 60 min)', () => {
    expect(
      shouldRequestReview({ trigger: 'booking_completed', completedAt: T - 10 * 60_000, now: T })
        .send,
    ).toBe(false);
  });
  it('refuses within the cooldown, sends past it', () => {
    const base = { trigger: 'service_completed', completedAt: T - 2 * HOURS, now: T } as const;
    expect(shouldRequestReview({ ...base, lastRequestedAt: T - 10 * DAYS }).send).toBe(false);
    expect(shouldRequestReview({ ...base, lastRequestedAt: T - 100 * DAYS }).send).toBe(true);
  });
  it('honors a custom cooldown', () => {
    const base = {
      trigger: 'service_completed',
      completedAt: T - 2 * HOURS,
      now: T,
      cooldownDays: 30,
    } as const;
    expect(shouldRequestReview({ ...base, lastRequestedAt: T - 20 * DAYS }).send).toBe(false);
    expect(shouldRequestReview({ ...base, lastRequestedAt: T - 40 * DAYS }).send).toBe(true);
  });
});
