# Discovery — app catalog (Lane 9) drift audit (loop fire, 2026-09-29)

> Read-only audit of the deployable-OSS-app catalog + its cf-native north star. Feeds
> `_RUN_THE_LOOP.md` §4.3 + Lane 9. Headline: a large **catalog↔DO-class↔binding drift** —
> 52 app DO classes are defined in code, only ~10 appear in the catalog, and ALL 52 app
> runtime bindings are commented out in `wrangler.toml` (only `SITE_BUILDER` + `PSNOTIFY_DO`
> are active). One SSOT reconciliation is overdue.

## Next-wave tasks

1. **[ORPHAN · READY · <30min] Catalog↔class↔binding inventory matrix.** `src/durable_objects/app_runtime_subclasses.ts` exports **52** app DO classes; `apps-catalog.ts` lists ~10; `wrangler.toml` has **0** active `[[durable_objects.bindings]]` for apps. Land `docs/APP_CATALOG_INVENTORY.md`: a grid `slug ⇔ DO-class ⇔ in-catalog ⇔ wrangler-binding-active ⇔ catalog.supported`. Cross-link `CONTAINER_MANIFEST.md`. Makes the drift visible + actionable.
2. **[COPY · READY · <45min] Gate container-metadata UI on `cf-native:`.** The catalog schema carries `port`/`memoryMB`/`dockerfile` for ALL apps incl. Payload (`image:'cf-native:payload-d1'`). The card/deploy-wizard should HIDE Port/RAM/Dockerfile + "booting container" copy when `image.startsWith('cf-native:')` and show a "D1 + R2 + Worker (no container)" badge instead. Grep the catalog-card + deploy components; wrap those fields.
3. **[CATALOG · READY · <15min decision] Listmonk `supported` drift.** `SUPPORTED_APP_SLUGS` includes `listmonk` (so the API accepts it) but the catalog entry lacks `supported:true` AND its wrangler binding is commented out → the two SSOTs disagree. Decide: promote (uncomment binding + `supported:true`) OR demote (`supported:false` "coming soon"). Document in `CONTAINER_MANIFEST.md`.
4. **[CF-NATIVE] Umami/Listmonk cf-native port candidates.** Umami (postgres-only) + Listmonk (postgres + mail) could run cf-native (D1 + R2 + SES) like Payload — killing container cold-start + idle cost. Write a feasibility-spike ADR (schema size, query patterns, effort) before committing.
5. **[ORPHAN · ~2h] Surface the ~42 uncatalogued app DO classes.** AnythingLLM, Cal.com, Ghost, Gitea, n8n, Nextcloud, NocoDB, Plausible, Uptime-Kuma, Vaultwarden, … exist as DO classes but have no catalog card → undiscoverable. Batch-add cards (`supported:false` "coming soon") reusing the class metadata, so users see the roadmap.

## Sub-area NOT reached (rotate next fire)
- wrangler-toml binding activation flow · runtime integration/E2E deploy verification per verification-loop · the container-vs-cf-native cost display.
