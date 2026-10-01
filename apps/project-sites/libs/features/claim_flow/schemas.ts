/**
 * claim_flow — Zod boundary schemas.
 *
 * @remarks
 * The claim checkout body is OPTIONAL by design (the claim CTA can POST an empty
 * body): both return URLs default to the admin billing surface, mirroring the
 * origin-based pattern the Pro upgrade uses. When provided they must be real
 * URLs — never trusted raw into a Stripe redirect.
 *
 * @packageDocumentation
 */

import { z } from 'zod';

/** POST /api/sites/:siteId/claim/checkout request body (all optional). */
export const claimCheckoutRequestSchema = z
  .object({
    success_url: z.string().url().optional(),
    cancel_url: z.string().url().optional(),
  })
  .strict();

export type ClaimCheckoutRequest = z.infer<typeof claimCheckoutRequestSchema>;

/** Response payload — key names per the house billing convention (NEVER `url`). */
export const claimCheckoutResponseSchema = z.object({
  checkout_url: z.string().url(),
  session_id: z.string(),
});

export type ClaimCheckoutResponse = z.infer<typeof claimCheckoutResponseSchema>;
