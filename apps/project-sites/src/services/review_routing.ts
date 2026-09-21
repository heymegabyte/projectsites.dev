/**
 * review_routing.ts — pure core of the "Review Requests" reputation engine (flag `review_requests`).
 * The #1 local-business conversion lever: automate genuine Google-review collection (2–3× volume;
 * ~20% of local-pack ranking) via a smart-routing "How was it?" step — happy customers are sent to
 * the public Google review link, unhappy ones to a PRIVATE feedback form (resolve privately, never
 * suppress a real review). This module owns the two decisions that MUST be deterministic + policy-
 * safe: (1) route a rating public-vs-private, (2) decide whether it's even allowed to ask (throttle
 * + genuine-trigger gate — Google forbids incentivized/spammed requests). The AI layers (sentiment
 * on free-text feedback, AI-drafted owner responses) and the send channel wire ON TOP of this seam.
 *
 * Time is injected (`now`, epoch ms) — pure + testable, no `Date.now()` here.
 */

export type ReviewRoute = 'public' | 'private' | 'invalid';

/** 4–5 stars → public (Google); 1–3 → private feedback. The recovery boundary. */
export const POSITIVE_THRESHOLD = 4;

/**
 * Smart-route a star rating. Compliance-safe: it directs genuine feedback, never incentivizes.
 * `rating` must be an integer 1–5, else `invalid` (the caller re-prompts, never guesses).
 *
 * @example routeByRating(5) // 'public'  (→ Google review link)
 * @example routeByRating(2) // 'private' (→ owner-only feedback form)
 * @example routeByRating(4, 5) // 'private' (stricter threshold)
 */
export function routeByRating(rating: number, positiveThreshold = POSITIVE_THRESHOLD): ReviewRoute {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return 'invalid';
  return rating >= positiveThreshold ? 'public' : 'private';
}

/** Genuine, COMPLETED interactions that may trigger a request — never a page view / bounce
 *  (Google policy: only ask real customers after a real interaction). */
export const GENUINE_TRIGGERS = ['booking_completed', 'order_delivered', 'service_completed', 'form_reply_closed'] as const;
export type ReviewTrigger = (typeof GENUINE_TRIGGERS)[number];

/** True when `t` is a genuine completed-interaction trigger. */
export function isGenuineTrigger(t: string): t is ReviewTrigger {
  return (GENUINE_TRIGGERS as readonly string[]).includes(t);
}

/** Inputs to the throttle decision. All times epoch ms. */
export interface ReviewRequestContext {
  trigger: string;
  /** When the interaction completed. */
  completedAt: number;
  /** Last time THIS customer was asked (omit if never). */
  lastRequestedAt?: number;
  /** Whether this customer has already left a review. */
  alreadyReviewed?: boolean;
  /** Current time. */
  now: number;
  /** Days before the same customer may be asked again (default 90). */
  cooldownDays?: number;
  /** Minutes to wait after completion before asking (default 60 — don't ask mid-visit). */
  minAgeMinutes?: number;
}

/**
 * Decide whether to SEND a review request — the policy + UX gate that prevents spamming (which
 * violates Google's guidelines and annoys customers). Sends only when the trigger is a genuine
 * completed interaction, the customer hasn't already reviewed, enough time has passed since the
 * interaction, and we're past the cooldown since the last ask. Returns a reason for observability.
 *
 * @example shouldRequestReview({ trigger:'booking_completed', completedAt: t-3600000*2, now: t }) // { send:true, reason:'eligible' }
 * @example shouldRequestReview({ trigger:'page_view', completedAt: t, now: t }) // { send:false, reason:'not a genuine completed interaction' }
 */
export function shouldRequestReview(ctx: ReviewRequestContext): { send: boolean; reason: string } {
  const cooldownMs = (ctx.cooldownDays ?? 90) * 86_400_000;
  const minAgeMs = (ctx.minAgeMinutes ?? 60) * 60_000;

  if (!isGenuineTrigger(ctx.trigger)) return { send: false, reason: 'not a genuine completed interaction' };
  if (ctx.alreadyReviewed) return { send: false, reason: 'customer already reviewed' };
  if (!Number.isFinite(ctx.completedAt) || ctx.now - ctx.completedAt < minAgeMs) {
    return { send: false, reason: 'too soon after the interaction' };
  }
  if (typeof ctx.lastRequestedAt === 'number' && ctx.now - ctx.lastRequestedAt < cooldownMs) {
    return { send: false, reason: 'within cooldown of the last request' };
  }
  return { send: true, reason: 'eligible' };
}
