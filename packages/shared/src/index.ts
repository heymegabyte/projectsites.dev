/**
 * @module @bolt/shared
 * @packageDocumentation
 *
 * Root entry point for the `@bolt/shared` package. Re-exports every public
 * symbol from the four sub-modules so consumers can import from a single
 * path: `import { orgSchema, AppError, requireRole } from '@bolt/shared'`.
 *
 * | Sub-module      | What it provides                                                        |
 * | --------------- | ----------------------------------------------------------------------- |
 * | `constants`     | Caps, pricing, dunning, auth, entitlements, roles, domain config, brand |
 * | `schemas`       | Zod schemas and inferred types for every domain entity and API envelope |
 * | `middleware`     | RBAC role/permission checks and plan entitlement guards                 |
 * | `utils`         | Sanitisation, PII redaction, typed errors, and Web Crypto helpers       |
 * | `ai-policy`     | Capability manifests, GrantRecord schemas, `effectiveAllow` authorizer  |
 *
 * @example
 * ```ts
 * import {
 *   // constants
 *   DEFAULT_CAPS, ROLES, PRICING,
 *   // schemas + types
 *   orgSchema, siteSchema, type Org, type Site,
 *   // middleware
 *   requireRole, checkPermission, getEntitlements,
 *   // utils
 *   sanitizeHtml, AppError, badRequest, sha256Hex,
 * } from '@bolt/shared';
 *
 * const org = orgSchema.parse(raw);
 * const canEdit = checkPermission('admin', 'site:write');
 * const hash = await sha256Hex(payload);
 * ```
 */
export * from './constants/index.js';
export * from './schemas/index.js';
export * from './middleware/index.js';
export * from './utils/index.js';
export * from './ai-policy/index.js';
export * from './storage-policy/index.js';
