# Audit C — Editor Claude-Code + Sandbox + browser widget (fire-1, 2026-09-28)

Read-only audit, Workstream C. Editor = repo-root `app/` (bolt.diy, Remix/React). Worker =
`apps/project-sites/`. Cited `file:line`.

## Pinned SDK versions (found)

| SDK | Where | Version |
|---|---|---|
| `@cloudflare/sandbox` | — | **ABSENT** (0 hits repo-wide + both package.json + wrangler.toml) |
| `@cloudflare/agents` (`agents`) | — | **ABSENT** |
| `@browserbasehq/stagehand` | `apps/project-sites/package.json:101` (devDep) | **^3.7.0** |
| `@cloudflare/playwright` | `apps/project-sites/package.json:75` | ^1.3.0 |
| `@cloudflare/containers` | `apps/project-sites/package.json:74` | ^0.3.2 |
| `@playwright/test` | `apps/project-sites/package.json:103` | ^1.53.0 |
| `@xterm/xterm` (editor) | `package.json:111` | ^5.5.0 (+addon-fit/web-links) |
| `@webcontainer/api` (editor) | `package.json:108` | 1.6.1-internal.1 |
| `isomorphic-git` (editor) | `package.json:128` | ^1.27.2 |

**Headline:** NO Cloudflare Sandbox SDK and NO Agents SDK. Every "sandbox" is either a client-side
WebContainer (editor) or a D1-backed simulation (`ide_sandbox.ts`). Stagehand is a worker devDep
reachable only via the browser gateway's Browserbase path — not wired into the editor. The editor
Claude-Code loop does not exist; chat is `/api/chat` (Vercel AI SDK) driving WebContainer.

## browser_gateway Live-View / replay assumption

`browser_gateway.ts:26-33` hard-codes `'session_replay' | 'live_view'` in `BrowserSpecialty`;
`chooseBrowserProvider` (`:97-104`) routes them to **Browserbase and throws without `BROWSERBASE_*`
creds**. The CF path (`connectBrowser:206-218`, `@cloudflare/playwright launch`) has no live-view/
replay. `browser_service.ts:58-67` accepts them but only `screenshot`/`pdf` execute (`:117-156`).

## Feature matrix (15 ideas — implement 1–12)

| # | Idea | Existing (file:line) | Current | Gap | Migration | Acceptance (RED-first) |
|---|---|---|---|---|---|---|
| 1 | Per-site Claude-Code workspace from chat | `app/…/Chat.client.tsx:198`; `services/cli_sandbox_config.ts:60` (unused); `wrangler.toml:340` `SiteBuilderContainer` | Chat=LLM→client WebContainer; no server Claude-Code | No Sandbox SDK; no workspace route; no agent loop | add `@cloudflare/sandbox` (or reuse Container DO) + `POST /api/sites/:id/workspace`; wire `cli_sandbox_config` | `/workspace` returns real `{state:'ready'}`; a real command runs |
| 2 | Split terminal + Live View | `app/…/workbench/terminal/*`, `BottomPanelTabs.tsx`; `browser_gateway.ts:30-31` | xterm→WebContainer; no Live-View; Live View Browserbase-only | no split layout; no CF Live-View surface | Live-View pane (CF `page.screencast`/DevTools or BB url) | terminal AND Live-View visible; a job streams frames |
| 3 | Server terminal events→R2+replay | client only; worker NONE | terminal I/O only in browser | no timestamped stream/R2/replay | capture stdout/stderr→R2 ndjson + replay | run cmd → R2 object timestamped → replay in order |
| 4 | Git/R2 snapshot+diff+rollback | `SourceControlPanel.tsx:10-14`; `git-browser-logic.ts` | diff preview-vs-published; client-local snapshots; Promote forward-only | no server snapshot store; no rollback-to-commit | server snapshot API + diff-any-two + rollback (preview only) | snapshot→edit→diff→rollback restores preview byte-identical |
| 5 | Incremental commit-keyed index | `git-browser-logic.ts:16-32,249`; full-tree via `PS_CODE_TREE_REQUEST` | R2-key entries; wholesale tree fetch | no per-commit index/dedupe | commit-keyed manifest (file→hash) | two manifests → only changed paths; 2nd load < full tree |
| 6 | Signed in-chat preview (PS auth) | `Preview.tsx:477,616,1150`; `routes/webcontainer.preview.$id.tsx` | WebContainer iframe / timestamped prod URL; not auth-proxied | no signed session-gated preview | worker signed-URL proxy (short HMAC) | owner 200 renders; anon 401/403 |
| 7 | Sandbox AI code executor + cards | `services/ide_sandbox.ts` (SIM); `routes/agents.ts:328` `executeRun` (stub) | no real execution | no executor; no cards | `@cloudflare/sandbox` executor + card component | chat runs snippet → real stdout+exit card |
| 8 | One-click tests/typecheck/lint/build cards | worker `build_validators.ts`; editor NONE | QA in site-gen container only | no on-demand cards | expose sandbox/WC `npm run` behind buttons | click "Typecheck" → real pass/fail card |
| 9 | Site-scoped outbound/MCP bridge | `routes/mcp_oauth.ts`; `services/ai_env_vars.ts` | per-site MCP + encrypted env for RUNTIME, not editor sandbox | no bridge for sandbox outbound w/ server creds | worker-proxied outbound injecting `ai_env_vars`/`mcp_connections` | sandbox outbound succeeds; creds never reach browser |
| 10 | Durable checkpoints/resume | `workflows/site-generation.ts:567+,1479-1826,1085-1240` | robust for site-gen Workflow | not reusable by interactive job | wrap workspace job in Workflow/DO same pattern | kill mid-job → resumes, no lost work |
| 11 | Disposable dep experiment | editor WebContainer (client); worker `SiteBuilderContainer` (build-only) | WC `npm i` client-side; no server disposable sandbox | no server throwaway isolated from tree | ephemeral sandbox (TTL) | install dep→run→auto-destroy→tree unchanged |
| 12 | Per-site budgets | `services/build_limits.ts` (build only) | budgets for BUILD pipeline only | none for interactive sessions | extend → `workspace_limits` | over-budget → 402/429 w/ reason |

## Orphan / drift flags

- `ide_sandbox.ts` + `__tests__/ide_sandbox.test.ts` + migration `0504_ide_multi_agent_progressive.sql`
  (tables `ide_sandboxes`/`multi_agent_runs`/`progressive_builds`) are unreachable — routes removed
  (`features.ts:630`), flags absent (`registry.ts`). Delete OR make them the real Sandbox impl (1/7/11).
- `cli_sandbox_config.ts` — only its test imports it. Wire (idea 1) or drop.
- `routes/agents.ts` `executeRun` docstring claims sandboxed tool exec it doesn't do — reconcile.

## First slices (RED-testable, ≤15min)

- (a) `workspace_limits` gate — over-budget site → workspace-start 402 (extend `build_limits.ts`).
- (b) commit-keyed manifest diff returns only changed paths (pure fn beside `git-browser-logic.ts`).
- (c) `POST /api/sites/:id/workspace` returns 501 when Sandbox SDK unbound (mirror `isWfpConfigured()`
  →503) — RED until the executor lands.
