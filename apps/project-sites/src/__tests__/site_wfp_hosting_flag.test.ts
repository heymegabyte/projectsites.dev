/**
 * WfP site-hosting — Work Unit 1 guard: the `site_wfp_hosting` flag is RESERVED
 * dark (`docs/wfp-site-hosting.md` §Work units 1).
 *
 * Every new site will be born on a Workers-for-Platforms dispatch namespace
 * (preview + production slots). That serving change is additive and MUST ship
 * behind a default-OFF flag so `serveSiteFromR2` stays byte-identical until the
 * flag is enabled. This suite makes it impossible to land the WfP branch without
 * a registered, dark, promotable flag:
 *
 *   1. `site_wfp_hosting` is in FLAG_REGISTRY (else `resolveFlag` short-circuits
 *      to enabled:false for the UNregistered key → the feature is un-toggleable
 *      dead, the exact class audit-flag-registration.mjs guards).
 *   2. It ships DARK — default_enabled:false, default_rollout_percent:0,
 *      stage:'experimental' — so nothing changes at launch.
 *   3. The registry-row substrate the deploy service will write already exists:
 *      the site_resource_registry model carries the WfP slot shape
 *      (wfp_namespace concept, userWorkerScript, deployedVersion, preview|prod
 *      environment) — reused, not reimplemented.
 */

import { FLAG_REGISTRY } from '../modules/feature_flags/registry.js';
import {
  ResourceConceptSchema,
  ResourceEnvironmentSchema,
  ResourceRecordSchema,
} from '../../libs/features/data_resource_registry/schemas.js';

describe('site_wfp_hosting flag (WfP hosting Unit 1 — reserved dark)', () => {
  it('is registered in FLAG_REGISTRY', () => {
    expect(FLAG_REGISTRY.site_wfp_hosting).toBeDefined();
  });

  it('ships DARK (off, 0% rollout, experimental)', () => {
    const def = FLAG_REGISTRY.site_wfp_hosting;
    expect(def.default_enabled).toBe(false);
    expect(def.default_rollout_percent).toBe(0);
    expect(def.stage).toBe('experimental');
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
