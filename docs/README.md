# Docs

Canonical documentation for projectsites.dev. The published MkDocs site builds from
[`docs/docs/`](./docs/) (`mkdocs.yml`); the files below are the source-of-truth references.

## Start here

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — shipped Worker topology, data flow, D1 schema, Fly/Cloudflare split, as-deployed map
- [`DEPLOYMENT.md`](./DEPLOYMENT.md) — auth chain, bindings, smoke-test matrix, rollback, Fly runbook, post-deploy verification
- [`SUBDOMAINS.md`](./SUBDOMAINS.md) — public subdomain/service map
- [`TESTING.md`](./TESTING.md) — Jest + Playwright guide

## AI + prompts

- [`AI_INTEGRATION.md`](./AI_INTEGRATION.md) — AI Gateway, Vectorize/RAG, PostHog LLM-obs
- [`PROMPTS.md`](./PROMPTS.md) — prompt infrastructure (`.prompt.md`, registry, A/B)
- [`generated-site-quality.md`](./generated-site-quality.md) — `{slug}.projectsites.dev` quality gates (repo-delta; generic budgets in global rules)

## Subsystems (consolidated)

- [`OBSERVABILITY.md`](./OBSERVABILITY.md) — logging, OTel, PostHog, Sentry, Axiom, CF Analytics Engine/RUM, AI-observability
- [`SERVICES-AND-SOCIAL.md`](./SERVICES-AND-SOCIAL.md) — native social + Postiz, Chatwoot support
- [`deployments/`](./deployments/) — per-service deploy runbooks (chatwoot, langflow, onyx, activepieces)

## Policy (repo-delta; canonical doctrine in `~/.agentskills`)

- [`ai-agent-rules.md`](./ai-agent-rules.md) · [`security-supply-chain.md`](./security-supply-chain.md)

## Decisions

- [`../DECISIONS.md`](../DECISIONS.md) — root architecture ADR log (0001–0011)
- [`../apps/project-sites/docs/decisions/`](../apps/project-sites/docs/decisions/) — convergence ADR series

The Worker's own deep docs live in [`../apps/project-sites/docs/`](../apps/project-sites/docs/).
