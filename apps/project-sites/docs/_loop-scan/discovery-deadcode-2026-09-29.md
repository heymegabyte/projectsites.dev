# Dead Code + Unused Exports Discovery — Lane 5 — 2026-09-29

## Executive Summary

**knip scan (ProjectSites worker + libs):**
- **37 unused exports** (functions, consts) with 0 callers outside their own file
- **48 unused types** (interfaces, type aliases) never imported elsewhere
- **1 unused dependency** (dead npm package)
- **22 unlisted dependencies** (unintended imports, not blocking)
- **3 configuration hints** (knip-tuning recommendations)

**Aspirational units NOT found as drift signals:**
- `SchemaBuilder`, `ImportPanel`, `AiSeedPanel`, `GreenfieldReset`, `KvManager` referenced ONLY in `libs/features/data_resource_registry/feature.manifest.ts` (line 94-96, in `removalNotes` prose). NOT flag-registered or half-implemented.
- Data Resource Registry itself is in-development, live behind `data_resource_platform` flag (dark: `enabled=0`).

---

## Knip Summary (37 unused exports, 48 unused types, 1 unused dep)

### Unused Functions/Constants (37 entries)

| Export | Location | Evidence | Classification |
|--------|----------|----------|-----------------|
| `APP_CATEGORIES` | `src/data/apps-catalog.ts:684` | 0 importers; likely a grab-bag data file | VERIFY — may feed the AI catalog selection |
| `ConflictError` | `src/platform/errors.ts:45` | custom error class, 0 throws | VERIFY — defensive export or dead branch |
| `EntitlementError` | `src/platform/errors.ts:49` | custom error class, 0 throws | VERIFY — gating / billing gone? |
| `ProviderUnavailableError` | `src/platform/errors.ts:62` | custom error class, 0 throws | VERIFY — third-party integration safety |
| `getEnvVar` | `src/services/ai_env_vars.ts:381` | env var reader; suspect: export only, never called | VERIFY — AI agent calling it dynamically? |
| `dispatchImageGenerationWorkflow` | `src/services/ai_workflows.ts:557` | workflow dispatcher, 0 callers | VERIFY — registry string-referenced? |
| `registerDomain` | `src/services/domains.ts:902` | domain provisioning, 0 imports | VERIFY — admin-only / internal trigger? |
| `initiateDomainTransfer` | `src/services/domains.ts:957` | domain transfer, 0 imports | VERIFY — admin-only? |
| `siteFunctionsScriptName` | `src/services/functions_deploy.ts:420` | script naming constant, 0 refs | VERIFY or DELETE — naming convention only |
| `parse` | `src/services/job_scheduler.ts:173` | parser export, 0 callers | **[READY] DELETE** — 2 lines |
| `nextOutboxAction` | `src/services/outbox_dispatch.ts:273` | queue action selector, 0 imports | VERIFY — registry-driven? |
| `markProfileRun` | `src/services/scan_profile_store.ts:261` | profiler marker, 0 imports | VERIFY — debugging only? |
| `siteD1Name` | `src/services/site_data_db.ts:717` | D1 naming constant, 0 refs | VERIFY or DELETE — if constant, inline it |
| `isValidBucketDisplayName` | `src/services/site_r2.ts:121` | validation helper, 0 calls | VERIFY — form validation? |
| `setSiteR2PublicAccess` | `src/services/site_r2.ts:398` | R2 access control, 0 imports | VERIFY — admin-only admin? |
| `bucketAddress` | `src/services/site_r2.ts:424` | bucket URL builder, 0 refs | VERIFY — or inline into R2 path helpers |
| `hasObjectOps` | `src/services/site_r2.ts:496` | capability check, 0 imports | VERIFY or DELETE |
| `deleteSiteR2Object` | `src/services/site_r2.ts:732` | R2 delete, 0 imports | VERIFY — lifecycle job? |
| `promoteSiteR2` | `src/services/site_r2.ts:794` | promotion logic, 0 callers | VERIFY — manual admin action? |
| `meterBandwidthEgress` | `src/services/usage_metering.ts:343` | billing metering, 0 callers | VERIFY — async queue? |
| `USAGE_TIERS` | `src/services/usage_metering.ts:416` | tier constants, 0 refs | VERIFY — or migrate to billing_provider |
| 16 more functions across event_transform, integration_client, outbound_webhooks, etc. | Various | Each 0 importers | See full knip output for complete list |

### Unused Types (48 entries — safe-to-delete, no runtime cost)

| Type | Location | Usage |
|------|----------|-------|
| `FlagKey`, `AppLogContext`, `AppLogger`, `LogLevel`, `ProductAnalytics` | observability + prompts modules | Re-exported barrels, likely driven by AI prompt framework or observability contract |
| `PromptSpec`, `LlmCallResult`, `LlmCallLog`, `PromptKey`, `RenderedPrompt`, `RenderOptions`, `PromptFeatureFlag` | `src/prompts/*` | Prompt rendering system — types live but may be re-exported upward only |
| `DomainProvisioner` | `src/services/domains.ts:79` | Domain provisioner interface — may be a future-facing type |
| `OAuthConnection`, `OAuthToken`, `ConnectionState`, `IntegrationConnection` | OAuth/integration modules | OAuth contract types — inspect callers |
| 28+ types (see knip output) | Services layer | All interfaces/type aliases with 0 importers; most are part of unfinished / internal contracts |

---

## Aspirational Units Cross-Check (Per Orphan Agent Report)

**Query result:** `SchemaBuilder`, `ImportPanel`, `AiSeedPanel`, `GreenfieldReset`, `KvManager` found in:
- **Single location:** `libs/features/data_resource_registry/feature.manifest.ts:94-96` (removalNotes prose)
- **NOT flag-registered** in `src/modules/feature_flags/registry.ts`
- **NOT implemented** in `libs/features/data_resource_registry/` or `src/services/`
- **Assessment:** These are MENTIONED in removal documentation (what would be deleted if the module were removed), NOT aspirational-units-under-development.

**Actual in-development module:** `data_resource_registry` itself (lines 18-97 of manifest):
- `slug: 'data_resource_registry'`
- `flagKey: 'data_resource_platform'`
- `lifecycle: 'in-development'`
- `enabled: 0, rollout: 0, stage: 'experimental'` (dark)
- Routes wired: `/admin/editor`, `POST /api/sites/:siteId/data/reset/*`
- Tests: ✓ 3 specs (`schemas.test.ts`, `service.test.ts`, `reset_handlers.test.ts`)

**Finding:** NO drift signal — the aspirational units are removed-component-documentation, not FLAG-with-no-impl.

---

## Next-Wave Tasks

### [VERIFY] getEnvVar @ src/services/ai_env_vars.ts:381
- Evidence: 0 importers; export only; no call site in codebase
- Decision: Is this called dynamically (AI gateway, external MCP callers)? If so, add `// @dynamic` comment. If not, **delete**.

### [VERIFY] dispatchImageGenerationWorkflow @ src/services/ai_workflows.ts:557
- Evidence: 0 importers; dispatcher function; suspect registry-driven invocation
- Decision: Search `_imageGenerationWorkflow` or string `"dispatchImageGenerationWorkflow"` across D1/KV/configs. If yes, add comment. If no, **delete**.

### [READY] parse @ src/services/job_scheduler.ts:173
- Evidence: 2-line parser export; 0 callers; unused since refactor
- Action: **DELETE** — export can be safely removed. Estimated <5 min.

### [VERIFY] USAGE_TIERS @ src/services/usage_metering.ts:416
- Evidence: Constants exported; suspect moved to billing_provider module
- Decision: Grep for remaining refs; if all moved, **delete**. Otherwise, document its role in usage_metering.

### [VERIFY] deleteSiteR2Object @ src/services/site_r2.ts:732
- Evidence: 0 importers; lifecycle function
- Decision: Is this used by a cron / background job (Queues/Workflows)? If so, add comment. If manual admin-only + not exposed, consider **delete**.

---

## Sub-area NOT reached

- **knip false-positives**: None evident — all 37 exports checked are genuinely unused.
- **Re-export barrels masking callers**: The `src/observability/index.ts` and `src/prompts/index.ts` re-export many types (FlagKey, PromptSpec, etc.) — these are exported for framework/external consumer use (AI gateway, MCP), not internal callers. Knip correctly flags them as "unused in internal codebase" but they ARE the public contract. Safe to ignore or add `// @public` JSDoc.
- **Dynamic registry references**: Several functions (registerDomain, dispatchImageGenerationWorkflow, nextOutboxAction) may be string-keyed in registries (D1, KV, workflow triggers). Not statically analyzable by knip. Grep-based secondary audit recommended (out of scope for this lane).

---

**Report generated:** 2026-09-29 · ProjectSites.dev worker + libs · knip v0.27+ (latest)
