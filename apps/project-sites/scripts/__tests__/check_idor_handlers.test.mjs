// Unit tests for the per-handler MUTATION cross-org IDOR detector (scanMutationHandler).
// The headline positive is the AL-772 class: a mutating :siteId handler that DELEGATES its write to
// a service method (no in-body dbInsert) with no ownership gate — the exact shape that evaded this
// detector and shipped a real write-authorization IDOR. Negatives are the real gate idioms + the
// read-delegating + public surfaces (per validator-precision-discipline: prefer false-negatives).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanMutationHandler } from '../check-idor-handlers.mjs';

// ── POSITIVE: the AL-772 class — a service-DELEGATED write with NO ownership gate ──
// (the PRE-FIX POST /api/sites/:siteId/hostnames: it called domainService.provisionFreeDomain with
// no in-body dbInsert AND no requireOwnedSite → the old WRITE-only detector skipped it entirely.)
test('FLAGS a mutating :siteId handler that delegates a write to a service with no ownership gate', () => {
  const src = `
    const siteId = c.req.param('siteId');
    const orgId = c.get('orgId');
    if (!orgId) throw unauthorized('Must be authenticated');
    const validated = createHostnameSchema.parse({ ...body, site_id: siteId });
    const result = await domainService.provisionFreeDomain(c.env.DB, c.env, { org_id: orgId, site_id: siteId, slug });
    return c.json({ data: result });
  `;
  assert.equal(scanMutationHandler('/api/sites/:siteId/hostnames', src).flagged, true);
});

// ── NEGATIVE: the SAME handler WITH requireOwnedSite (the AL-772 fix) ──
test('does NOT flag the delegated-write handler once requireOwnedSite gates it', () => {
  const src = `
    const siteId = c.req.param('siteId');
    const orgId = c.get('orgId');
    const validated = createHostnameSchema.parse({ ...body, site_id: siteId });
    await requireOwnedSite(c.env, orgId, siteId, 'id');
    const result = await domainService.provisionFreeDomain(c.env.DB, c.env, { org_id: orgId, site_id: siteId, slug });
    return c.json({ data: result });
  `;
  assert.equal(scanMutationHandler('/api/sites/:siteId/hostnames', src).flagged, false);
});

// ── NEGATIVE: a mutating handler that only READS via a service (read-verb → not a write) ──
test('does NOT flag a mutating handler that only reads via a service (getEntitlements)', () => {
  const src = `
    const siteId = c.req.param('siteId');
    const orgId = c.get('orgId');
    const ent = await billingService.getEntitlements(c.env.DB, orgId);
    return c.json({ can: ent.topBarHidden });
  `;
  assert.equal(scanMutationHandler('/api/sites/:siteId/preview', src).flagged, false);
});

// ── POSITIVE: the original IN-BODY write class still fires (dbInsert, no gate) ──
test('FLAGS a sub-resource mutation with an in-body dbInsert and no ownership gate', () => {
  const src = `
    const siteId = c.req.param('siteId');
    await dbInsert(c.env.DB, 'site_data', { site_id: siteId, key, value });
    return c.json({ ok: true });
  `;
  assert.equal(scanMutationHandler('/api/sites/:siteId/data', src).flagged, true);
});

// ── NEGATIVE: in-body write scoped by an `AND org_id = ?` bind ──
test('does NOT flag an in-body write scoped by AND org_id = ?', () => {
  const src = `
    const siteId = c.req.param('siteId');
    await c.env.DB.prepare('DELETE FROM site_data WHERE site_id = ? AND org_id = ?').bind(siteId, orgId).run();
    return c.json({ ok: true });
  `;
  assert.equal(scanMutationHandler('/api/sites/:siteId/data/:key', src).flagged, false);
});

// ── NEGATIVE: intentionally-public mutation (contact-form to any published site is the feature) ──
test('does NOT flag an allowlisted public mutation endpoint', () => {
  const src = `
    const slug = c.req.param('slug');
    await dbInsert(c.env.DB, 'form_submissions', { slug, ...body });
    return c.json({ ok: true });
  `;
  assert.equal(scanMutationHandler('/api/contact-form/:slug', src).flagged, false);
});

// ── NEGATIVE: no attacker-suppliable sub-resource id in the path (collection POST) ──
test('does NOT flag a collection POST with no resource-id path param', () => {
  const src = `
    const orgId = c.get('orgId');
    await domainService.provisionCustomDomain(c.env.DB, c.env, { org_id: orgId });
    return c.json({ ok: true });
  `;
  assert.equal(scanMutationHandler('/api/domains', src).flagged, false);
});

// ── NEGATIVE: super-admin-gated surface (cross-org by design) ──
test('does NOT flag a super-admin-gated delegated write', () => {
  const src = `
    const siteId = c.req.param('siteId');
    if (!isSuperAdmin(c)) throw forbidden('super-admin only');
    await domainService.deprovisionHostname(hostname);
    return c.json({ ok: true });
  `;
  assert.equal(scanMutationHandler('/api/admin/domains/:siteId/deprovision', src).flagged, false);
});
