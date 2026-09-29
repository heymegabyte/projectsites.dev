/**
 * @module ai-policy
 * @description
 * The ONE shared policy/capability type layer behind every AI entry point
 * (campaign lane-2, §4): capability manifests, grant records, the
 * intersection authorizer (`effectiveAllow`) and principal resolution.
 * See `README.md` in this directory for the consumption contract.
 */
export * from './capability.js';
export * from './principal.js';
export * from './grant.js';
