import { subscriptionEventType } from '../routes/webhooks';

/**
 * subscriptionEventType — the pure Stripe-status → billing-bus-event mapper that
 * the /webhooks/stripe handler uses to emit subscription lifecycle events onto
 * the durable outbox (drained to Hatchet orchestration).
 * Pure + total: same status → same event type (or null to skip), no I/O.
 */
describe('subscriptionEventType', () => {
  it('maps active + trialing → subscription.active', () => {
    expect(subscriptionEventType('active')).toBe('subscription.active');
    expect(subscriptionEventType('trialing')).toBe('subscription.active');
  });

  it('maps past_due + unpaid → subscription.past_due', () => {
    expect(subscriptionEventType('past_due')).toBe('subscription.past_due');
    expect(subscriptionEventType('unpaid')).toBe('subscription.past_due');
  });

  it('returns null for non-lifecycle statuses (canceled handled by deleted event)', () => {
    expect(subscriptionEventType('canceled')).toBeNull();
    expect(subscriptionEventType('incomplete')).toBeNull();
    expect(subscriptionEventType('incomplete_expired')).toBeNull();
    expect(subscriptionEventType('paused')).toBeNull();
    expect(subscriptionEventType('')).toBeNull();
    expect(subscriptionEventType('GARBAGE')).toBeNull();
  });
});
