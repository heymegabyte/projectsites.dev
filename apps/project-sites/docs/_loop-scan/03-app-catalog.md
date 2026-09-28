# App catalog + containers — scan + recommendations

Scope: the owner-facing App catalog (`/admin/apps`) + platform infra containers. Two catalogs
exist in lockstep — FE `frontend/.../sections/apps-catalog.data.ts` (what users SEE, bundled, no
worker fetch) + worker `src/data/apps-catalog.ts` (served by `GET /api/apps/catalog`, apps.ts:277).
The `index.ts:583 "different catalog"` memory is STALE (index.ts was route-decomposed; both files
now share `APPS_CATALOG`). Boot backend = `AppRuntime` DO (`app_runtime_subclasses.ts`, ~56 wired
classes) for container apps; `cloudflare_provisioner` (D1+R2+Worker via WfP) for `cf-native:` apps.
Live/Soon = per-app `supported` flag (SSOT). Broader infra map: `docs/CONTAINER_MANIFEST.md`.

## Current members (member — what — deploy model — top rec [HIGH/MED])
Catalog = 9 entries; only 4 flagged `supported:true` (bootable today). CF_NATIVE_SLUGS = {payload}.

- **Umami** — cookieless web analytics — CFC container DO + Neon Postgres — `supported:true`. Rec [HIGH]: convert to **cf-native** (D1 + Analytics Engine) like Payload; a container for analytics is heavy vs the platform's own edge analytics.
- **Listmonk** — newsletter/campaign email — CFC container + Neon (`projectsites_listmonk`) + SES relay — `supported:true`; LIVE at `mail.projectsites.dev`. Rec [MED]: auto-wire SES SMTP creds at deploy so an owner never pastes them (embarrassingly-easy).
- **Open WebUI** — chat UI for Ollama/OpenAI/Anthropic — CFC container + SQLite/volume — `supported:true`. Rec [MED]: prefill `OPENAI_API_KEY`/base-URL from the platform LiteLLM gateway so it works zero-config.
- **Payload CMS** — TS headless CMS — **cf-native** (own D1+R2+Worker, no container; delete cascades; ≤3/site) — `supported:true`; LIVE `cms.projectsites.dev`. Rec [HIGH]: this is the golden pattern — make it the template every new member copies.
- **Lobe Chat** — polished multi-provider chat UI — CFC + Neon — `supported:false` (Coming soon). Rec [MED]: overlaps Open WebUI; pick ONE flagship chat app, drop the other.
- **Langflow** — visual LangChain/agent builder — CFC + Neon + volume — `supported:false`. Rec [MED]: 1GB RAM + Python cold-boot risks the <30s/≤1GiB catalog rule; verify boot before flagging supported.
- **LiteLLM** — OpenAI-compatible proxy for 100+ providers — CFC + Neon — `supported:false` in catalog but LIVE as infra at `llm.megabyte.space`. Rec [HIGH]: fix the drift — either flag supported (owner-installable) or move it out of the owner catalog into platform-only.
- **Arize Phoenix** — LLM tracing + evals — CFC + volume — `supported:false`; Elastic-2.0 license. Rec [MED]: Langfuse (already an infra container) is the friendlier owner-facing trace tool — prefer it.
- **Stirling PDF** — 60+ PDF tools — CFC, no DB — `supported:false`. Rec [MED]: cheapest quick win to flag supported (no infra) — a genuinely useful SMB utility.

Also wired as DO classes but NOT in catalog (~47): ghost, cal, nocodb, n8n, plausible, uptime-kuma,
directus, immich, vaultwarden, gitea/forgejo, mattermost, teable, pocketbase, qdrant, searxng, etc.
Rec [HIGH]: these are built-but-unwired (interconnectedness) — surface the best ~10 as catalog cards.

## New members to add [prioritized: name — value — CF-native deploy path]
1. **Cal.com** [HIGH] — appointment scheduling; #1 SMB ask (salons, clinics, trades). DO class `cal` already wired → add catalog card + Neon; or cf-native Worker + D1 later.
2. **NocoDB / Teable** [HIGH] — Airtable-style DB UI over the owner's per-site D1. DO classes wired. Best fit: cf-native pointing at the site's existing per-site D1 (`per_site_data` plane) — no new Postgres.
3. **Ghost** [HIGH] — best-in-class blog/newsletter/membership. DO class `ghost` wired → card + Neon + R2 for media. High perceived value for content-led SMBs.
4. **Chatwoot** [HIGH] — helpdesk/live-chat shared inbox; defined at `support.projectsites.dev` (container dir exists). CFC + Neon + Redis(Upstash). Pairs with the site contact form.
5. **Plausible** [MED] — lighter analytics alt if Umami stays container; DO class wired. Or fold into the cf-native Umami rec instead.
6. **Uptime Kuma** [MED] — status/uptime monitoring for the owner's own site. DO class wired; SQLite/volume — cheap, no external DB.
7. **Documenso** [MED] — OSS DocuSign (e-sign); container dir already exists (`containers/documenso`). CFC + Neon. Real revenue-doc value for trades/contractors.
8. **n8n** [MED] — no-code automation/Zapier-alt; DO class wired. CFC + Neon; gate behind a paid plan (compute-heavy).

## Catalog UX + integration-depth recs
- [HIGH] **cf-native is the north star.** Every container app that CAN run on Workers+D1+R2 should migrate off CFC (Payload proves the pattern) — cheaper, no cold-boot, no Neon project burn. Container-only for apps that genuinely need a long-lived process (Ghost, Chatwoot, n8n).
- [HIGH] **Kill the container-centric copy leak.** Per memory, apps-UI copy (Dockerfile card, Port/RAM pills, "booting container") must gate on `image?.startsWith('cf-native:')` — grep the whole apps section every time a cf-native app is added.
- [HIGH] **Close catalog↔`supported`↔infra drift.** LiteLLM is live infra but `supported:false` in-catalog; ~47 DO classes are wired but uncatalogued. One SSOT reconcile: catalog card ⇔ `supported` flag ⇔ wrangler `[[containers]]` block ⇔ live subdomain.
- [MED] **Real logos, not emoji.** FE catalog now supports `logo` + `screenshots` (Payload has them); backfill every card with a real logo + 2-3 screenshots — emoji glyphs read cheap.
- [MED] **Zero-config installs.** Auto-provision + auto-wire every `auto:'secret'`/`postgres_url`/`public_url` env at deploy so an owner clicks Deploy and it just works (no paste-key step) — per embarrassingly-easy-to-use.
- [MED] **Real-time instance status.** Per real-time-data rule, the instances list must live-poll (no manual Refresh/Reconcile button) — verify the Apps section obeys it.
- [MED] **Never reduce DO subclasses** (deploy-break 10064) — only ADD classes; removal needs a `deleted_classes` migration.
