/**
 * Feature manifest — Claim Flow (fire-60, LAUNCH BAR "Pricing claim-flow implementation").
 *
 * $0 preview → $29/mo claim: a generated site stays viewable FREE on its subdomain
 * (the unpaid top-bar is the pitch); CLAIMING is a $29/mo Stripe subscription that
 * unlocks custom domain + edits + AI ops + email. This module owns the claim
 * checkout route (`POST /api/sites/:siteId/claim/checkout`, `assertSiteOwned`-guarded),
 * the lookup-or-create "ProjectSites Claim" price (stable `lookup_key`, KV-cached,
 * test-mode-only creation), the `isSiteClaimed` entitlement seam, and the top-bar
 * claim-pitch attributes (`data-claim`/`data-business`) that `site_serving.ts`
 * appends when the flag is ON. The claim→paid transition rides the EXISTING
 * `checkout.session.completed` webhook via `metadata[site_id]` — zero new webhook
 * code. Flag DARK by default → the route 404s and the generic register bar serves.
 */
export const manifest = {
  slug: 'claim_flow',
  name: 'Site Claim Flow ($29/mo)',
  description:
    'Paid-claim funnel: free preview on the subdomain, $29/mo Stripe subscription to claim — unlocking custom domain, edits, AI ops, and email. Checkout + price config + top-bar pitch. DARK when off.',
  flagKey: 'claim_flow',
  owner: 'brian@megabyte.space',
  stage: 'experimental' as const,
  createdAt: '2026-10-01',
  apiPaths: ['/api/sites/:siteId/claim/checkout'],
  unitTests: ['../libs/features/claim_flow/__tests__/claim_flow.test.ts'],
};
