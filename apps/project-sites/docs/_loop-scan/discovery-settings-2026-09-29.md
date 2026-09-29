# Discovery — Admin › Settings (`/admin/settings`, main project-scoped settings)

**Headline:** Honest, well-built surface (9 tabs, correct single H1, `aria-selected`
tablist, server-backed General/Team/AI-Chat/MCP, graceful fallbacks). Real defects: the
**AI-Chat MCP allow-list persists to localStorage only** (never sent to the worker, so it
does nothing to the published chat widget), a **1597-LOC split candidate**, three **dead CSS
blocks** (theme-card/status-pill/btn-oauth) + **3 dead security fields** left after the theme
picker + session-defaults were removed, and a **set-but-never-rendered `loadingConnections`
skeleton** on the MCP tab.

**Surface:** `frontend/src/app/pages/admin/sections/settings.component.ts` — **1597 LOC**
(template + ~230-line styles block + logic). Tabs (all project-scoped except env-vars/api-tokens
= org-wide): General · Team · AI Chat · MCP · AI Env Vars · Webhooks · Email · Domains · API Tokens.
Route heading is a correct single `<h1>` (line 69); each tabpanel child is an `<h2>`.

**A11y verified good:** tablist uses `role="tab"` + `aria-selected` (line 85, correct — not
`aria-pressed`); `aria-invalid`/`aria-describedby`/`role="alert"` on the contact-email + invite
fields; `aria-live="polite"` status spans on save-in-flight + biz-error rows. No `aria-pressed`
misuse found.

## Next-wave tasks

- [DEAD] AI-Chat MCP allow-list @ settings.component.ts:1552-1560,1004-1011 — `chatMcps` reads/writes
  ONLY `localStorage['ps_chat_mcps']`; `saveChat()` PUTs `chat_system_prompt` alone. Grep for
  `ps_chat_mcps|chat_mcps|allowed_mcps` across `apps/project-sites/src/` = **zero worker refs** →
  the "MCP available to AI Chat" checkboxes (template line 383) are a doomed control: checking a box
  changes nothing on the published chat widget. Either persist it via `/sites/:id/ai-settings`
  (`chat_allowed_mcps` field, read on load) or remove the section. — action: wire allow-list into the
  ai-settings PUT + load path (server SSOT), or delete the dead UI. **[READY]** (~1.5h if worker field
  already accepts extra keys)
- [DEAD] Unused `security` fields @ settings.component.ts:1141,1231 — `security` object carries
  `session_hours:168, idle_minutes:60, allowed_domains:''` but they're never rendered (JSDoc at 1204
  says "removed from the UI"); `toggleRequire2FA` still spreads them into the `/admin/security` PUT body
  (line 1231 `{ ...this.security, require_2fa: next }`), sending stale defaults the server keeps for
  forward-compat. — action: send `{ require_2fa: next }` only; drop the three dead keys from the
  `security` type + initializer. **[READY]** (~20min)
- [DEAD] Dead CSS blocks @ settings.component.ts:700-701,711-721 — `.theme-card`/`.theme-card:hover`/
  `.theme-card.active` + `.theme-swatch{.dk,.lt,.sy}` (theme picker moved to `/admin/user`, comment line
  403) and `.status-pill{,.is-active,.is-pending,.is-error}` + `.btn-oauth`/`.btn-oauth:hover` have ZERO
  template usage (only `.mcp-btn-oauth` is used, line 495). ~25 dead style lines. — action: delete the
  four unused rule groups. **[READY]** (~15min)
- [DEAD] `loadingConnections` never rendered @ settings.component.ts:904,1380-1384 — the signal is
  set true/false around the MCP-connections fetch but the MCP tab template has NO
  `@if (loadingConnections())` skeleton (Team tab HAS one at line 244). So the MCP provider grid renders
  its "not connected" state first, then flips connected rows in — a flash of wrong state on open. —
  action: add a connections skeleton (mirror the Team skeleton) OR drop the unused signal.
  **[READY]** (~30min)
- [SPLIT] settings.component.ts @ 1597 LOC — one god-component holds 9 tabs + a ~230-line styles block +
  all their handlers (General identity+brand-upload, Team+2FA+invites, AI-Chat+knowledge-PDF-XHR, MCP
  OAuth/paste, plus 4 embedded child components). Over the 1500-LOC ceiling. — action: extract per-tab
  child components (`SettingsGeneralComponent`, `SettingsTeamComponent`, `SettingsAiChatComponent`,
  `SettingsMcpComponent`) each under budget, keeping the tablist shell here; mirrors how webhooks/
  deliverability/domains/api-tokens are already embedded child components. (~3-4h, real wave — not READY)
- [RT] No manual Refresh controls — none present (good). Connections/team/env-vars load on tab open +
  after mutations; no user-facing "Refresh"/"Reconcile" button. Note: data is load-on-open, NOT live —
  a teammate added in another tab won't appear until re-open. Acceptable for a settings surface;
  flagging only for completeness. — no action.
- [A11Y] MCP paste-key form has no confirm state parity — the OAuth path shows "Connecting…"/toast, but
  the paste-key `<input type=password>` + Save (template lines 488-493) gives only `pasteSaving()`
  disabled state, no `aria-busy`/`aria-live`. Minor. — action: add `[attr.aria-busy]="pasteSaving()"` +
  a status span. **[READY]** (~20min)
- [VQA] Hardcoded hex vs `--ps-*` tokens @ settings.component.ts styles block — 17 raw `#00E5FF`/`#00e5ff`
  literals + `#060610`/`#f4f4ff`/`#7C3AED` where `--ps-accent`/`--ps-bg`/`--ps-ink` tokens exist (project
  CLAUDE.md: "hard-coded brand colors get flagged in audits"). The `.mcp-aivars`/`.coming-soon-pill` blocks
  already use `color-mix(... var(--ps-accent) ...)` correctly — the older `.badge`/`.btn-oauth`/`.kb-dropzone.drag`
  rules don't. — action: replace raw brand hexes with `var(--ps-accent)` etc. (cosmetic, batch with SPLIT).
- [FLOW] "Email › Configure SMTP" is a disabled coming-soon button (template line 592, honest — has
  `aria-disabled` + tooltip + benefits preview, NOT a dead-end) — good pattern, no action. Same for the
  MCP "Coming soon" pills on adapter-less providers (line 484, gated by `mcpAvailable`). Both correctly
  avoid doomed CTAs.

## Sub-area NOT reached

- The **embedded child components** rendered by these tabs (`AdminWebhooksComponent`,
  `AdminDeliverabilityComponent`, `AdminDomainsComponent`, `AdminApiTokensComponent`,
  `EnvVarsManagerComponent`) — each has (or warrants) its own scan; webhooks/deliverability/domains/
  api-tokens already have discovery docs, env-vars-manager does not.
- Worker-side `/admin/security`, `/team/*`, `/sites/:id/ai-settings`, `/sites/:id/mcp/connections`
  endpoints not verified against the DB (this was a frontend-only read).
- `settings.component.spec.ts` (49K) coverage not audited.
