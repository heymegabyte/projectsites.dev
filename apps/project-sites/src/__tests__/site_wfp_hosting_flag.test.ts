/**
 * WfP site-hosting — the `site_wfp_hosting` flag is now the DEFAULT serve POLICY
 * (`docs/wfp-site-hosting.md`; promoted 2026-09-29 after end-to-end proof, fire-50).
 *
 * Every new site is born on a Workers-for-Platforms dispatch namespace (preview +
 * production slots). The serving change is additive AND fail-soft: a site WITH a
 * live WfP prod slot serves via dispatch; a site WITHOUT one still falls back to
 * the byte-identical `serveSiteFromR2` path — so promoting the flag to default-ON
 * has ~zero immediate blast radius (only sites with a recorded slot change behavior).
 * This suite makes it impossible to LOSE the flag or its default-on promotion:
 *
 *   1. `site_wfp_hosting` is in FLAG_REGISTRY (else `resolveFlag` short-circuits
 *      to enabled:false for the UNregistered key → the feature is un-toggleable
 *      dead, the exact class audit-flag-registration.mjs guards).
 *   2. It is the DEFAULT policy — default_enabled:true, default_rollout_percent:100,
 *      stage:'beta' — so WfP hosting is the serve default (fail-soft to R2 for any
 *      site without a slot; killswitch OFF reverts everything to R2, no redeploy).
 *   3. The registry-row substrate the deploy service writes exists: the
 *      site_resource_registry model carries the WfP slot shape (wfp_namespace
 *      concept, userWorkerScript, deployedVersion, preview|prod environment) —
 *      reused, not reimplemented.
 */

import { FLAG_REGISTRY } from '../modules/feature_flags/registry.js';
import {
  ResourceConceptSchema,
  ResourceEnvironmentSchema,
  ResourceRecordSchema,
} from '../../libs/features/data_resource_registry/schemas.js';

describe('site_wfp_hosting flag (WfP hosting — DEFAULT serve policy)', () => {
  it('is registered in FLAG_REGISTRY', () => {
    expect(FLAG_REGISTRY.site_wfp_hosting).toBeDefined();
  });

  it('is the DEFAULT policy (on, 100% rollout, beta) — WfP is the serve default, R2 is the fail-soft fallback', () => {
    const def = FLAG_REGISTRY.site_wfp_hosting;
    expect(def.default_enabled).toBe(true);
    expect(def.default_rollout_percent).toBe(100);
    expect(def.stage).toBe('beta');
  });

  it('has an owner + a runbook-grade description (>=240 chars, per feature-flags)', () => {
    const def = FLAG_REGISTRY.site_wfp_hosting;
    expect(def.key).toBe('site_wfp_hosting');
    expect(def.owner_email).toContain('@');
    expect(def.description.length).toBeGreaterThanOrEqual(240);
  });
});

describe('site_resource_registry substrate (reused by the WfP deploy service)', () => {
  it('models the WfP dispatch-namespace concept', () => {
    expect(ResourceConceptSchema.safeParse('wfp_namespace').success).toBe(true);
  });

  it('splits every resource into isolated preview | production environments', () => {
    expect(ResourceEnvironmentSchema.safeParse('preview').success).toBe(true);
    expect(ResourceEnvironmentSchema.safeParse('production').success).toBe(true);
  });

  it('carries the per-slot script + deployed-version fields the registry row needs', () => {
    const shape = ResourceRecordSchema.shape;
    expect(shape.userWorkerScript).toBeDefined();
    expect(shape.wfpDispatchNamespace).toBeDefined();
    expect(shape.deployedVersion).toBeDefined();
    expect(shape.environment).toBeDefined();
  });
});
