# ai-policy — shared AI capability + grant policy layer (campaign lane-2, §4)

- The ONE policy/capability type layer for every AI entry point. EVERY entry point — OpenAI/Anthropic
  compat APIs, the ProjectSites MCP server, Chat, per-site agents, scheduled workflows — MUST call the
  SAME authorizer (`effectiveAllow`) immediately before EVERY tool execution/external effect.
- §4 intersection rule: owner RBAC ∩ key/OAuth grant ∩ selected site/resource ∩ selected concrete
  connection ∩ allowed action ∩ feature entitlement ∩ current revocation/approval/budget. Each leg is
  a named predicate (`POLICY_LEG_PREDICATES`); `deniedBy` reports every failing leg precisely.
- Fail closed on ANY unknown/missing leg. Grants snapshot CONCRETE ids (never wildcards, never future
  resources). Unknown/discovered tools inherit NOTHING — MCP annotations are hints, not permission
  evidence. Caller-supplied org/site/connection ids can never expand access.
- Files: `capability.ts` (manifests + id grammar) · `grant.ts` (records + `effectiveAllow`) ·
  `principal.ts` (resolution schema + interface stub — Worker wiring is a later slice).
