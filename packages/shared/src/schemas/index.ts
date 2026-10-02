/**
 * @module schemas
 * @packageDocumentation
 *
 * Zod validation schemas and their inferred TypeScript types for every
 * domain entity in the platform. Each sub-module covers one bounded context
 * and exports both the runtime schema and a corresponding `type` alias.
 *
 * | Sub-module    | Key exports                                                                  |
 * | ------------- | ---------------------------------------------------------------------------- |
 * | `base`        | `baseFields`, `uuidSchema`, `slugSchema`, `emailSchema`, `phoneSchema`, `paginationSchema`, `errorEnvelopeSchema`, `successEnvelopeSchema` |
 * | `org`         | `orgSchema`, `createOrgSchema`, `membershipSchema` + `Org`, `Membership`     |
 * | `site`        | `siteSchema`, `createSiteSchema`, `updateSiteSchema`, `confidenceAttributeSchema`, `researchDataSchema` + inferred types |
 * | `billing`     | `subscriptionSchema`, `entitlementsSchema`, `createCheckoutSessionSchema`, `saleWebhookPayloadSchema` + `Subscription`, `Entitlements` |
 * | `auth`        | `userSchema`, `sessionSchema`, `createMagicLinkSchema`, `loginResponseSchema` + `User`, `Session`, `LoginResponse` |
 * | `audit`       | `auditLogSchema`, `createAuditLogSchema` + `AuditLog`                        |
 * | `webhook`     | `webhookEventSchema`, `webhookIngestionSchema` + `WebhookEvent`              |
 * | `workflow`    | `workflowJobSchema`, `createWorkflowJobSchema`, `jobEnvelopeSchema` + `WorkflowJob`, `JobEnvelope` |
 * | `config`      | `envConfigSchema`, `environmentSchema`, `validateEnvConfig` + `EnvConfig`, `Environment` |
 * | `analytics`   | `analyticsDailySchema`, `funnelEventSchema`, `usageEventSchema` + inferred types |
 * | `hostname`    | `hostnameRecordSchema`, `createHostnameSchema`, `hostnameStatusSchema` + `HostnameRecord`, `HostnameStatus` |
 * | `api`         | `apiErrorCodes`, `apiErrorSchema`, `healthCheckSchema` + `ApiErrorCode`, `ApiError`, `HealthCheck` |
 * | `site-event`  | `SiteEventSchema`, `siteEventActorSchema` + `SiteEvent`, `SiteEventActor`   |
 *
 * @example
 * ```ts
 * import {
 *   createSiteSchema,
 *   type CreateSite,
 *   subscriptionSchema,
 *   envConfigSchema,
 * } from '@bolt/shared/schemas';
 *
 * // Validate an incoming request body
 * const body: CreateSite = createSiteSchema.parse(request.body);
 *
 * // Validate environment variables at Worker boot
 * const env = envConfigSchema.parse(process.env);
 * ```
 */
export * from './base.js';
export * from './org.js';
export * from './site.js';
export * from './billing.js';
export * from './auth.js';
export * from './audit.js';
export * from './webhook.js';
export * from './workflow.js';
export * from './config.js';
export * from './analytics.js';
export * from './hostname.js';
export * from './api.js';
export * from './contact.js';
export * from './confidence.js';
export * from './seed-v3.js';
export * from './forms.js';
export * from './voice.js';
export * from './media.js';
export * from './site-repository.js';
export * from './site-event.js';
