# Discovery — security / IDOR + boundary audit (loop fire, 2026-09-29)

> Read-only security audit of the Worker's `/api/sites/:siteId` handlers + untyped boundaries.
> Feeds `_RUN_THE_LOOP.md` §4.6 + §5. Headline: **zero confirmed LIVE IDOR** — ownership-guard
> discipline is strong (`assertSiteOwned`/`assertSiteOwnership`/`loadOwnedSite` universal; always
> 404 on a foreign site, never 403). Recent adds (`site_cost.ts:42`, `voice.ts` purchase) guard correctly.

## Next-wave tasks

1. **[ZOD · READY · LIVE] `forms.ts:1027` form-router/improve** — body read as `as { value?: unknown }`, NO Zod. Reachable in prod. Action: colocate a `FormRouterImproveBody` Zod schema + `zValidator`/`safeParse`. ~30min. (Only LIVE untyped boundary found.)
2. **[CI · 2h] `scripts/validate-idor-gates.mjs`** — no automated gate asserts every `:siteId` handler calls an ownership guard (grep found none missing today, but it's undefended against drift). Action: build the grep-based validator + wire to CI + a `new-site-id-handler-needs-assertsiteowned` gate row.
3. **[ARCH · 0.5h] `docs/SECURITY-PATTERNS.md` § IDOR** — document the universal ownership-check pattern (assertSiteOwned → 404) so new handlers copy it. Guidance-only.
4. **[ZOD · latent] `vision_qa.ts:213`** (`as { url?: string }`) + **`ai_admin.ts:195/330/436/700`** (4 casts) — NOT site-scoped / admin-only + flag-gated → latent. Retrofit Zod on promotion.
5. **[AUTHZ · latent · standing] `features.ts` 123 flag-gated handlers** — untyped `as` casts, all DARK (default_enabled:false → 404 in prod). Per-feature Zod retrofit ON promotion only (never blind mass-retrofit — per CLAUDE.md §10). Not a live gap.

## Sub-area NOT reached (rotate next fire)
- Voice/SMS auth flows (Twilio) · MCP connection boundaries · custom Functions WfP dispatch authz.
