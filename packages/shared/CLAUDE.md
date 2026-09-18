# @project-sites/shared — AI Context Guide

> Shared library providing Zod schemas, constants, RBAC middleware, and utilities
> for the Project Sites platform. Used by both the Worker and future frontend packages.

## Quick Start

```bash
cd packages/shared
npm install --legacy-peer-deps
npm test                         # 509 unit tests across 14 suites
npm run typecheck                # tsc --noEmit
npm run lint                     # eslint
npm run check                    # all of the above
```

## Package Exports

```typescript
import { ... } from '@project-sites/shared';           // Everything
import { ... } from '@project-sites/shared/schemas';   // Zod schemas only
import { ... } from '@project-sites/shared/constants';  // Constants only
import { ... } from '@project-sites/shared/middleware';  // RBAC + entitlements only
import { ... } from '@project-sites/shared/utils';      // Utilities only
```

## Source Layout

```
src/
├── index.ts                    # Barrel re-export of all sub-modules
├── constants/
│   └── index.ts                # DEFAULT_CAPS, PRICING, DUNNING, AUTH, ENTITLEMENTS, ROLES, DOMAINS, BRAND, ERROR_CODES
├── schemas/
│   ├── index.ts                # Barrel export
│   ├── base.ts                 # Primitives: uuid, slug, email, phone, hostname, url, pagination, envelopes
│   ├── org.ts                  # orgSchema, membershipSchema, createOrgSchema, etc.
│   ├── site.ts                 # siteSchema, createSiteSchema, confidenceAttributeSchema, researchDataSchema
│   ├── auth.ts                 # userSchema, sessionSchema, magicLinkSchema, phoneOtpSchema, googleOAuthSchema
│   ├── billing.ts              # subscriptionSchema, checkoutSchema, entitlementsSchema, saleWebhookSchema
│   ├── audit.ts                # auditLogSchema, createAuditLogSchema
│   ├── webhook.ts              # webhookEventSchema, webhookIngestionSchema
│   ├── workflow.ts             # workflowJobSchema, createWorkflowJobSchema, jobEnvelopeSchema
│   ├── config.ts               # envConfigSchema (with Stripe test/live key validation)
│   ├── analytics.ts            # analyticsDailySchema, funnelEventSchema, usageEventSchema
│   ├── hostname.ts             # hostnameRecordSchema, createHostnameSchema
│   ├── confidence.ts           # confidence-attribute schemas (per-field provenance + source URLs)
│   ├── contact.ts              # contact-form payload schemas (per-site contact endpoint)
│   ├── forms.ts                # generic form-submission schemas (prompt-designer overlay)
│   ├── seed-v3.ts              # seed-site-data payload v3 (used by `seed-site-data` workflow step)
│   └── api.ts                  # apiErrorCodes, apiErrorSchema, healthCheckSchema
├── middleware/
│   ├── index.ts                # Barrel export
│   ├── rbac.ts                 # requireRole(), checkPermission(), Permission type
│   └── entitlements.ts         # getEntitlements(), requireEntitlement()
└── utils/
    ├── index.ts                # Barrel export
    ├── errors.ts               # AppError class + factories (badRequest, unauthorized, etc.)
    ├── crypto.ts               # randomHex, randomUUID, generateOtp, sha256Hex, hmacSha256, timingSafeEqual
    ├── sanitize.ts             # sanitizeHtml, stripHtml, sanitizeSlug, businessNameToSlug
    └── redact.ts               # redact() PII from strings, redactObject() from records
```

## Constants Reference

### DEFAULT_CAPS
| Cap | Value |
|-----|-------|
| `LLM_DAILY_SPEND_CENTS` | 2000 ($20/day) |
| `SITES_PER_DAY` | 20 |
| `EMAILS_PER_DAY` | 25 |
| `MAX_REQUEST_BODY_BYTES` | 256KB |
| `MAX_AI_MICROTASK_OUTPUT_BYTES` | 64KB |
| `MAX_COMPUTE_TIME_MS` | 300,000 (5 min) |

### PRICING
| Key | Value |
|-----|-------|
| `MONTHLY_CENTS` | 5000 ($50/mo) |
| `RETENTION_OFFER_CENTS` | 2500 ($25/mo) |
| `RETENTION_OFFER_MONTHS` | 12 |

### AUTH
| Key | Value |
|-----|-------|
| `MAGIC_LINK_EXPIRY_HOURS` | 24 |
| `OTP_EXPIRY_MINUTES` | 5 |
| `OTP_MAX_ATTEMPTS` | 3 |
| `SESSION_EXPIRY_DAYS` | 30 |

### ROLES (ordered by privilege)
`owner` > `admin` > `member` > `viewer`

### ENTITLEMENTS
| Feature | Free | Paid |
|---------|------|------|
| `topBarHidden` | false | true |
| `maxCustomDomains` | 0 | 10 |
| `chatEnabled` | true | true |
| `analyticsEnabled` | false | true |
| `customEndpoints` | false | true |
| `maxTeamSeats` | 1 | 10 |

### DOMAINS
```typescript
SITES_BASE: 'projectsites.dev'
SITES_SUFFIX: '.projectsites.dev'
BOLT_BASE: 'editor.projectsites.dev'
CLAIM_BASE: 'claimyour.site'
```

## Key Schemas

### Base Primitives
- `uuidSchema` — UUID v4 string
- `slugSchema` — 3-63 chars, `[a-z0-9][a-z0-9-]*[a-z0-9]`
- `emailSchema` — Max 254, lowercased
- `phoneSchema` — E.164 format (`^\+[1-9]\d{1,14}$`)
- `hostnameSchema` — Valid hostname, 3-253 chars
- `httpsUrlSchema` — HTTPS only, max 2048
- `safeStringSchema` — Blocks `<script`, `javascript:`, `data:` patterns
- `paginationSchema` — `{ limit: 1-100, offset: 0+ }`

### Entity Schemas (all export inferred types)
- `Org`, `CreateOrg`, `Membership`, `CreateMembership`
- `Site`, `CreateSite`, `UpdateSite`, `ConfidenceAttribute`, `ResearchData`
- `User`, `Session`, `CreateMagicLink`, `VerifyMagicLink`, `CreatePhoneOtp`, `VerifyPhoneOtp`
- `Subscription`, `CreateCheckoutSession`, `Entitlements`, `SaleWebhookPayload`
- `AuditLog`, `CreateAuditLog`
- `WebhookEvent`, `WebhookIngestion`
- `WorkflowJob`, `CreateWorkflowJob`, `JobEnvelope`
- `HostnameRecord`, `CreateHostname`
- `AnalyticsDaily`, `FunnelEventRecord`, `UsageEvent`

## RBAC System

### Roles & Permissions
```typescript
type Permission =
  | 'org:read' | 'org:write' | 'org:delete'
  | 'site:read' | 'site:write' | 'site:delete' | 'site:publish'
  | 'billing:read' | 'billing:write'
  | 'member:read' | 'member:write' | 'member:delete'
  | 'admin:read' | 'admin:write';

// Usage
requireRole('member', 'admin')          // true if member >= admin (false)
checkPermission('admin', 'site:write')  // true
checkPermission('viewer', 'billing:write', true) // true (billing_admin override)
```

## Error Handling

```typescript
import { AppError, badRequest, unauthorized, forbidden, notFound } from '@project-sites/shared';

// Throw typed errors
throw badRequest('Invalid slug format', { slug: 'abc' });
throw unauthorized();
throw notFound('Site not found');

// AppError has: code, statusCode, message, details, requestId
// AppError.toJSON() returns the standard error envelope
```

Available factories: `badRequest(400)`, `unauthorized(401)`, `forbidden(403)`,
`notFound(404)`, `conflict(409)`, `payloadTooLarge(413)`, `rateLimited(429)`,
`internalError(500)`, `validationError(400)`

## Crypto Utilities (Web Crypto API — Workers compatible)
```typescript
randomHex(32)               // 64-char hex string
randomUUID()                // UUID v4
generateOtp(6)              // "042917"
await sha256Hex('data')     // SHA-256 hex digest
await hmacSha256(key, msg)  // HMAC-SHA256 hex
timingSafeEqual(a, b)       // Constant-time comparison
```

## Sanitization
```typescript
sanitizeHtml(input)         // Strip <script>, event handlers, iframes
stripHtml(input)            // Remove all HTML tags
sanitizeSlug(input)         // Lowercase, alphanum + hyphens, max 63 chars
businessNameToSlug(name)    // "Vito's Salon" → "vitos-salon"
```

## PII Redaction
```typescript
redact(logMessage)          // Replace emails, phones, tokens, secrets
redactObject(obj)           // Deep-redact sensitive keys in objects
```

## Testing

14 test suites, 509 tests total:
- `schemas.test.ts` — Base schema validation
- `middleware.test.ts` — RBAC + entitlements
- `utils.test.ts` — Sanitization, errors, OTP
- `sanitize-security.test.ts` — `sanitizeHtml` XSS regression suite (quoted + UNQUOTED + SLASH-separated event handlers, nested + UNTERMINATED `<script>`/`<iframe>` openers, dangerous URIs)
- `redact-secrets.test.ts` — `redact()` secret-format suite (OpenAI/Anthropic `sk-…`, GitHub, Google `AIza`, AWS `AKIA`, Slack, JWT, Stripe, Bearer; no benign-text mangling)
- `crypto-extended.test.ts` — SHA256, HMAC, random generation
- `edge-cases.test.ts` — Redaction, env validation, slug edge cases
- `schemas-extended.test.ts` — All domain entity schemas (incl. auditLogSchema `message`)
- `confidence.test.ts` — Confidence-attribute provenance schemas
- `contact.test.ts` — Contact-form payload schemas
- `forms.test.ts` — Form-submission + newsletter-integration boundary schemas
- `form-schema-null-tolerance.test.ts` — form schemas accept `null` for optional fields (client sends `null`, not omitted)
- `voice.test.ts` — Voice/SMS-agent boundary schemas (E.164, vanity, settings)
- `seed-v3.test.ts` — SmallBizSeedV3 confidence-wrapped seed payload

## Config Notes
- Jest config: `jest.config.cjs` (must be `.cjs` for ESM packages)
- `moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' }` — resolve `.js` imports
- `no-console` rule: use `console.warn` or `console.error` only
