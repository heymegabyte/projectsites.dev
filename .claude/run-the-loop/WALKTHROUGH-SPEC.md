# Claude Code prompt: apply my walkthrough to the running /run-the-loop

Continue the active `/run-the-loop` session and incorporate this instruction into the work already underway. Preserve the current repository, unfinished changes, task ownership, schedule, and useful existing behavior. At the next safe boundary, update the loop's durable instructions, reconcile the actual TODO ledger, and immediately implement the highest-priority work below. Continue through the remaining unblocked work under the loop's existing execution and spending limits.

This is an implementation request. A plan, new TODO entries, mock controls, or a rewritten skill alone do not complete it.

“STT” here means my speech-to-text product walkthrough. The requirements below turn that walkthrough into concrete work. The primary product is ProjectSites.dev, with Lone Mountain Global as a named reproduction target. If the active repository has already consolidated this product into megabyte.space, apply the work to the corresponding migrated features and preserve ProjectSites.dev's simpler product experience. Inspect the repository to determine the real situation.

## 1. Join the running work and preserve its state

1. Read `CLAUDE.md`, applicable repository instructions, the active loop definition, its checkpoint, current TODO ledger, recent relevant changes, and the code serving the affected screens. Use `rg` for focused discovery. Inspect the working tree before editing; preserve unrelated work.
2. Resolve which definition actually provides `/run-the-loop`. Inspect relevant project and personal command/skill locations, including `.claude/commands/run-the-loop.md`, `.claude/skills/run-the-loop/SKILL.md`, and their existing `~/.claude/` equivalents. Follow the installed Claude Code version and its actual command resolution. Avoid introducing competing definitions.
3. Update the existing owner of the command. Put detailed product requirements in a repository reference document and keep the loop entry point concise. If a global loop wrapper is already used, update its generic feedback-ingestion behavior and reference the current repository's requirements; keep ProjectSites-specific details in the project.
4. Apply this message immediately as current-session steering. Explicitly read the revised reference before selecting the next task. Check supported reload behavior for future invocations; file changes do not prove that already-dispatched work has received new instructions. Send affected running workers a concise delta through the existing coordination mechanism, if available.
5. Preserve one scheduler and the current coordinator. Do not recursively launch another `/run-the-loop` or duplicate its recurring jobs. If the loop already parallelizes work, retain bounded concurrency, disjoint ownership or isolated worktrees, and one writer for the shared ledger and integration state.
6. Record a checkpoint with the active branch/worktree, task IDs, implementation state, outstanding tests, blockers, and next action. Continue from it after compaction, interruption, or a subsequent iteration.

The paths above are discovery candidates, not an instruction to create every file. Reuse the repository's actual structure. Legacy command files and skills can both define slash commands; resolve the existing command before changing formats. See reference 1.

## 2. Normalize the walkthrough using these decisions

My later corrections supersede my earlier tentative suggestions where they conflict. Keep unrelated existing requirements and completed work.

| Topic | Decision to implement |
| --- | --- |
| Resources navigation | Remove **Site Files** and **Media Library** from Resources. Rename/move **Advanced** to **Manage**, beside **Buckets**. Preserve required file-management capabilities in Code and Buckets. |
| AI context files | Support both uploaded files and multiple connected Google accounts with selected folders/documents. Put these together in Settings → AI / Knowledge, or the equivalent existing area. |
| Site storage | Each environment gets its own physical R2 bucket. Preview exists first. Create production on first publication for new sites. Preserve and migrate existing production sites safely. |
| Snapshots | Remove the standalone snapshots screen and obsolete shared-bucket deployment mechanism after replacement works. Preserve user-visible history, version inspection, restore, and publishing in the editor selector. |
| Publish UI | Remove the standalone **Promote** button and redundant old menu items. Put an obvious publish action inside the main environment/bucket/history selector. Publishing remains available. |
| Editor footer | Keep the file/connection/branch status bar on Code only; hide it on Preview, Database, and Resources. |
| Feature flags | Keep flags and add **Enable All Feature Flags** and **Disable All Feature Flags** buttons. Do not change every flag merely because these buttons were added. |
| Agent prompts | Keep the site's base system prompt and one shared Voice + SMS agent prompt/override. Remove separate Voice and SMS prompt editors. |
| Lead scanner | Replace automatic scans with saved query tabs, estimates, explicit job start, budgets, pause/resume/cancel, and separate human approval for outgoing email. |
| Cross-site drag and drop | Preserve as a future design consideration only; I explicitly said not to implement this interaction now. |
| Megabyte Space entry | Preserve the future Chat integration in the roadmap. Avoid shipping an inert navigation button. |
| “Cloud Code WASM” | Resolve this as the desired Claude Code experience beside the terminal, sharing the repository. Verify a real supported runtime instead of assuming a browser-only WASM package exists. |

When a request names an unsupported provider capability, preserve the intended experience using a verified implementation and record the limitation. Do not silently replace a requested physical resource with a misleading label.

## 3. Update the real TODO ledger now

Find the canonical ledger and use its format. Merge by meaning; reuse existing IDs and retain completed-item evidence. Use the `WLK-*` IDs below as source references, mapping them to existing task IDs where appropriate. Create a canonical ledger only if none exists.

For each item record: source reference, user outcome, priority, status, dependencies, owner if applicable, affected surfaces, acceptance criteria, evidence links, and next action or concrete blocker. Keep this compact using existing conventions. Break large items into independently verifiable subtasks; preserve their parent source reference.

Suggested statuses are `todo`, `in_progress`, `blocked`, `verified`, and `superseded`, translated into the ledger's vocabulary. A blocked item names the missing resource/permission/API and the work that can still proceed. “Verified” requires observed behavior. A duplicate becomes a cross-reference, not another task.

Use P0 for the reported broken paths and loop intake, P1 for requested core behavior, and P2 for larger extensions. Escalate a lower-priority dependency when it blocks a P0 repair. All rows remain in scope even when they cannot fit into the first iteration.

| Source | Priority | Deliverable and minimum acceptance evidence |
| --- | --- | --- |
| WLK-01 | P0 | Upgrade the active loop, persist this specification, merge the ledger, and show that the next task selection reads the new requirements. |
| WLK-02 | P0 | One-click **Use AI to load sample data** creates suitable tables when absent and seeds contextual synthetic rows; no “create a table first” dead end. |
| WLK-03 | P0 | Fix editable table cells: change a name, save, reload, and read the same value from the correct database. Show errors and preserve failed edits. |
| WLK-04 | P0 | Replace AI Column / AI Filter fragmentation with one **AI** action; reproduce and fix the “three attempts / bad gateway” failure. Verify filtering and column creation. |
| WLK-05 | P0 | Make SQL text readable. Presets visibly populate SQL before execution; preserve presets that already work and fix the unreadable cases. |
| WLK-06 | P1 | Persist recent SQL runs and saved queries with searchable titles and concise AI explanations; reopen the application and verify persistence. |
| WLK-07 | P1 | Implement a genuine D1 recovery interface with supported Time Travel operations and clear retention/restore semantics, distinct from application query history. |
| WLK-08 | P0 | Fix Lone Mountain Global's KV purchase/provision/open path that ends in “failed to load resource”; verify entitlement, provisioning, and editor access without a duplicate charge. |
| WLK-09 | P0 | Fix Lone Mountain Global's Hosting → Preview link; test generated URL, route resolution, redirect, TLS, and page load. Investigate the observed double dash without assuming it is inherently invalid. |
| WLK-10 | P1 | Implement explicit site/environment/resource mappings and separate R2 buckets; new unpublished sites have preview storage and no phantom production resource. |
| WLK-11 | P1 | Migrate the old shared-bucket `sites/<site>/<date>` layout with resumable copy, integrity checks, validated routing, and rollback; retire obsolete code only after cutover succeeds. |
| WLK-12 | P1 | Implement durable preview autosave/version history with Git-backed state and AI-generated title, summary, and expandable Markdown detail. |
| WLK-13 | P1 | Build the main selector for authorized environments/buckets, current selection, file count, history, restore, and publish. Remove redundant Promote/snapshot/Git-menu controls after replacement works. |
| WLK-14 | P1 | Make Code's file tree, source/search panels, and controls compact; relocate **Open in StackBlitz** below **Sync to Local Folder** in the hamburger menu; scope the footer to Code. |
| WLK-15 | P1 | Remove obsolete standalone Queues, Vectorize, R2, and KV inspectors plus System Services navigation/code after checking and preserving any still-needed capabilities in the editor. |
| WLK-16 | P1 | Deliver Resources → Buckets / Manage with resource counts, friendly names, monospace technical IDs, environment labels, explanations, health, bindings, and relevant actions. |
| WLK-17 | P1 | Add per-bucket credential management, masked display, upload/drop zone, file browsing, and appropriate key lifecycle actions using real scoped credentials. |
| WLK-18 | P1 | Support creating resources, supported cloning/backup operations, and assigning compatible resources to environment slots; show operation progress and truthful limitations. |
| WLK-19 | P1 | Replace the unhelpful Durable Objects panel with useful namespace/object information and supported, authorized inspection capabilities. |
| WLK-20 | P1 | Discover site-associated Workflows and list their instances/status automatically; manual instance ID lookup becomes optional. |
| WLK-21 | P1 | Create the unified AI knowledge area for website context, prompts, uploaded files, connected MCP data, multiple Google accounts, selected folders, and observable indexing/sync status. |
| WLK-22 | P1 | Reuse one compact MCP attachment widget under all applicable prompt editors: system, agent, voice/SMS, forms, and lead queries. Persist each prompt's selected connections. |
| WLK-23 | P1 | Animate form-prompt opening and closing; show 3–4 template variables plus an expand control; handle no connected MCPs with **None available** and an actionable connection path. |
| WLK-24 | P1 | Simplify Voice + SMS into the shared agent prompt, compact MCP row, clear history, and useful tabular management; remove share/snippet clutter and redundant business-hours controls. |
| WLK-25 | P1 | Route model selection automatically across AI features using task quality, latency, reliability, and cost. Keep expert overrides only where useful. |
| WLK-26 | P1 | Automate eligible call recording and browser/video assistance, with observable recording/browser state, playback/history, working policy controls, and text/audio-only fallback. |
| WLK-27 | P1 | Fix Social's connected-account layout so it no longer fills the screen unnecessarily; complete the requested 30 documented visual review passes across relevant states. |
| WLK-28 | P0 | Fix empty error details and generic, unhelpful log rows; show useful errors, stack traces where captured, resource context, and navigation to the related request/trace. |
| WLK-29 | P1 | Correlate Log Explorer, audit actions, traces, and attributable costs across site resources; distinguish measured, estimated, shared, and unavailable costs. |
| WLK-30 | P1 | Expand Analytics with available Cloudflare datasets, useful site/environment filters, source/freshness information, and honest unavailable states. |
| WLK-31 | P1 | Keep Feature Flags and add working bulk enable/disable actions with correct scope, persisted results, and partial-failure reporting. |
| WLK-32 | P1 | Rework Super Admin into useful spreadsheet-style operations with live global search, grounded AI answers, and explicit contextual actions such as preparing a refund. |
| WLK-33 | P1 | Apply stable-size search experiences throughout the app, with useful transitions, keyboard behavior, loading/error/empty states, and grounded AI overviews where valuable. |
| WLK-34 | P1 | Redesign Lead Scanner around saved query tabs, a context-aware initial suggestion, **Improve Prompt Even More**, per-query MCP selection, and **Attach Recommended MCPs**. |
| WLK-35 | P1 | Add evidence-based lead-job scope/cost estimates, budgeted options, immutable running query versions, resumable execution, metering, and pause/resume/cancel. Remove automatic scanning. |
| WLK-36 | P1 | Provide an advanced leads grid with search, score sorting both ways, filters, selection, column management, export, and useful AI-assisted operations. |
| WLK-37 | P1 | Implement a separate outreach draft/review/approval stage; no outgoing lead email until the exact recipients and current content are approved by a human. |
| WLK-38 | P2 | Expand the Apps catalog from the existing roadmap, explicitly including EmDash and the intended Slink repository; verify runtime compatibility and provide functioning installs. |
| WLK-39 | P2 | Put a working Claude Code launch/control next to the editor terminal, using the current repository state and a verified execution environment. |
| WLK-40 | P2 | Add a paid **Full IDE** entry backed by a real code-server runtime, durable workspace recovery, authentication, custom configuration, and visible usage policy. |
| WLK-41 | P1 | Add prominent Dashboard, Editor, and Analytics action tiles with useful subtitles; improve Settings and remaining editor layouts using the established design system. |
| WLK-42 | P1 | Add tasteful API-doc page transitions and update examples/endpoints/authentication details against actual API contracts. |
| WLK-43 | P1 | Make OAuth-capable MCP expansion and contextual AI enhancements a recurring, bounded loop activity with verified capability and a concrete user benefit. |
| WLK-44 | P1 | Maintain a full route/state visual and functional coverage matrix, including the named site's golden paths, as implementation progresses. |
| WLK-45 | P2 | Evaluate and record the 20 Super Admin ideas below; combine compatible ideas into coherent views and progressively deliver the highest-value capabilities. |

## 4. Start implementation in this session

After a focused repository inspection and ledger merge, begin a real repair. Do not spend the entire iteration rewriting instructions or generating architecture proposals.

Use this execution order unless a reproduced dependency changes it:

1. Reproduce and repair table-cell persistence, AI action failures, the KV provisioning/open error, and the broken preview link. Track the actual root cause for each.
2. Implement immediately accessible UI changes: SQL readability, Code-only footer, StackBlitz relocation, compact panels, form-variable collapse, form open/close motion, and Feature Flags bulk controls. Retire obsolete controls as their replacements become usable.
3. Build a complete Resources → Manage slice connected to the real resource inventory. In parallel only where the existing loop permits, establish the environment mapping and migration work needed for the R2 changes.
4. Connect version history, autosave, restore, and publishing through the selector. Exercise preview/production isolation before removing the old serving implementation.
5. Continue through knowledge/MCP widgets, voice/social, observability, Super Admin, lead jobs, Apps, and IDE work according to dependencies and measured impact.

The first substantive checkpoint must include the reconciled ledger, loop changes, and a working implementation slice with verification. If one path needs unavailable access, complete the local/code/test portion and continue another unblocked path. If every implementation path is genuinely blocked, report the exact blockers and prepared changes; never manufacture success.

Use the current development/preview deployment workflow and existing production-release policy. Return the actual accessible preview URL and revision when available. Preserve existing authorization; do not change permissions or silently perform new financial actions to validate a feature.

## 5. Implementation contracts

### Database and AI operations

- **Contextual seeding:** Use permitted site content and the relevant business context to choose a small, useful schema and clearly synthetic sample rows. Create the schema when absent. Scope the operation to the selected site/environment, show progress and results, avoid overwriting existing data, and make retries idempotent.
- **Editable grid:** Trace the whole path from cell editor through validation, request, authorization, SQL write, response, and cache invalidation. Handle typed values, nulls, stable row identity, save/cancel, errors, and concurrent edits. Verify with a reload and a backend read.
- **One AI action:** Interpret intent as filtering, sorting, explaining, adding a column, or another supported operation. Validate a typed action plan before execution. Keep read operations and schema/data mutations distinguishable. Use bounded retries for transient failures; do not retry non-idempotent writes blindly. Trace the actual gateway failure instead of masking it with more retries.
- **SQL UX:** Load visible SQL before running a preset. Preserve editable text and readable contrast. Store recent runs and saved queries durably, scoped by permissions and site/environment, with timestamps, outcome, duration, and exact SQL. Generate cached descriptions from the SQL; a label must not imply different behavior from the query.
- **Two kinds of history:** Application query history and saved queries are application data. D1 Time Travel provides database recovery. Provide both. Check the account's retention and supported API, record recovery bookmarks and the affected database, and test restore on a disposable database. Use verified export/import for cloning where necessary; do not assume Time Travel provides clone/fork. See reference 2.
- **KV billing failure:** Verify the payment/entitlement/provisioning state machine and resource binding. Show actionable error details and a retry that does not create another charge or duplicate namespace. Use existing test entitlements/payment test facilities for verification.

### Environment storage, Git history, and publishing

Use an explicit mapping equivalent to `site → environment → resource role → resource ID`, with ownership and provisioning state. Reuse the existing schema where possible.

- Each configured environment owns a separate R2 bucket. For new sites, preview is provisioned first and production on first publish. Additional named environments remain possible. An existing live production environment must keep serving during migration.
- Validate account bucket/token quotas, provisioning permissions, API limits, and operating costs. The target architecture uses physical buckets; report a real quota blocker instead of quietly implementing shared prefixes with bucket-like labels. See reference 3.
- R2 stores objects; implement the Git/filesystem adapter or synchronization layer explicitly. Keep Git objects, immutable content, version metadata, manifests, and reference updates internally consistent. Use a proven serialization or compare-and-swap mechanism for concurrent saves and publish operations.
- Keep private source, Git internals, credentials, and internal manifests inaccessible through public asset routes. Serve the intended build/output surface for each environment.
- Autosave persists changed work promptly and creates debounced, meaningful history entries. Bound autosave frequency. Deduplicate no-op saves. Preserve content even when AI metadata generation is slow or fails; generate a deterministic fallback title and enrich it asynchronously.
- Store a machine-readable title, summary, Markdown detail, revision, timestamp, and affected-file summary for each autosave. Derive metadata from actual changes. The dropdown shows compact titles/summaries and expandable details.
- Selecting an old revision opens it for inspection. The restore action checkpoints current work and restores into preview without erasing later history. Switching buckets protects unsaved work and resets stale editor state.
- Publishing operates on a pinned revision: build, validate, stage/copy, verify completeness, switch the serving reference, and refresh the correct caches. Readers must see a complete old or new version. Do not stream a partial deployment over the currently served version.
- Production remains unchanged during preview edits. Creating production can copy the selected initial revision; subsequent publishes reuse production's assigned bucket and preserve rollback. Database schema/data promotion has its own explicit migration semantics; never overwrite live business data as a side effect of copying site files.
- Migrate with a recorded inventory, recoverable source, copy manifest, integrity checks, resumable checkpoints, catch-up or a bounded write pause, and rollback mapping. Validate on a disposable fixture before the named site. Remove old serving and snapshot code after cutover verification; retain existing data according to the actual retention policy.

### Resources and credentials

- Manage lists real R2, D1, KV, Worker, Durable Objects, Workflows, Queues, Vectorize, Domains/Routing, and other supported site resources. Show exact counts where discoverable; distinguish physical assets, shared allocations, and environment bindings to avoid double-counting.
- Give every resource a friendly heading, compact technical ID, environment/role, help text, status, and supported actions. Explain unfamiliar Cloudflare terms in place.
- Creating, copying, or assigning a resource is an observable job with progress, retry, and failure information. Cloning data, copying configuration, and backing up state are different operations. Expose only supported semantics for each resource type.
- For slot reassignment, validate ownership, permissions, type, and environment compatibility, then change the mapping atomically and provide rollback. Cross-site drag-and-drop remains deferred.
- Buckets has real drag-and-drop upload, progress, retry/cancel, pagination, browse/download, and authorized file operations. Select the proper bucket explicitly.
- Provide a credential pair scoped to the selected bucket where supported. Persist newly issued secrets encrypted server-side if later reveal is required; mask them by default, require authorization for reveal/copy, support rotation/revocation, and audit access without logging secrets. Cloudflare does not redisplay a lost secret. Keep account-wide control-plane credentials out of the browser; use server-mediated access or scoped upload mechanisms for routine uploads. Validate token provisioning/scaling limits. See reference 4.
- Workflows should list registered workflows and instances automatically using supported APIs, then show status, steps, logs, and available lifecycle controls. Do not require users to know an instance ID to start browsing. See reference 5.
- Durable Objects should show real namespaces, known objects, health, relevant logs/metrics, and storage inspection where supported. Verify provider capabilities. If object enumeration or application storage access needs an application registry or diagnostic method, implement that explicitly and show its coverage; avoid invented universal introspection.

### AI knowledge, prompt widgets, and voice

- Put website content, base prompts, uploads, connected Google accounts/folders/documents, and permitted MCP data under one understandable AI-context model. Resolve the walkthrough's final decision in favor of both Google connections and uploads.
- Support multiple accounts without mixing their permissions. Show selected sources, last sync, indexing progress, errors, disconnect/removal, and access revocation. Incrementally refresh context and retrieve relevant permitted content for each request; show stale/unavailable sources honestly.
- Treat retrieved documents and MCP content as data, not instructions that can change agent permissions. Separate context retrieval from action permissions. Avoid loading every connected document into every model call.
- Build one reusable prompt editor/footer: compact MCP icons, selected connections, search, connection picker, and inline connect or a short route to connections. Reuse it across the system, forms, Voice + SMS, lead scanner, and other applicable prompts. The empty state says **None available** and explains how to connect.
- Keep base-site instructions plus one shared Voice + SMS agent override; render it as one shared agent prompt editor. Put attached MCPs immediately beneath it. Keep a clear history tab and remove redundant share/snippet controls.
- Remove the redundant business-hours toggle only after the new prompt/context flow preserves scheduling behavior. Validate tool execution against structured, derived schedule data rather than relying on a model to improvise whether the business is open.
- Select models through a shared routing policy: fast suitable models for simple tasks, stronger models when evidence warrants them, explicit failover and budget/latency accounting. Apply it to replies, sentiment analysis where used, summaries, and other AI tasks. Verify model availability/pricing; “free” must mean a real applicable allowance. Preserve existing model budgets and override conventions.
- Make recording and browser/video assistance automatic when enabled under the existing account policy and required caller controls. Show their live state and recordings in history. Browser assistance should execute when useful to the task; avoid launching a costly browser for every trivial message. Preserve responsive conversation while work runs, allow cancellation, and support text/audio-only fallback. Migrate existing recording preferences deliberately.

### Search, design, forms, and Social

Create or extend a reusable UX skill/reference and have the loop read it whenever it changes search, prompt dialogs, dense tables, or resource controls.

- Keep search panels visually stable while typing/loading. Reserve useful space, retain prior results during refresh when appropriate, debounce requests, cancel stale requests, and smoothly animate legitimate size changes. Avoid collapsing into a spinner and jumping back to a different height.
- Include keyboard navigation, visible focus, useful empty/error states, and concise AI overviews when they explain results or help recover from no matches. Ground overviews in authorized results; separate suggested next steps from factual matches. Basic search works without waiting for AI.
- Compact means better density and hierarchy while retaining legibility and usable pointer/touch targets. Use the existing component system and shared spacing tokens; avoid one-off CSS for every screen.
- Forms show 3–4 variable chips with an accessible expand/collapse control. Open and close animations both work, preserve focus, and respect reduced-motion settings.
- Improve Settings, editor navigation, Social account lists, and API-doc transitions through live inspection. Include empty, loading, populated, error, long-name, narrow-screen, dropdown, and keyboard states.
- For Social, perform the requested 30 inspect → critique → refine → verify passes, distributing them across real layout states and viewports. Record each pass, finding, change or justified acceptance, and evidence. Reinspect the result of substantive changes. Avoid arbitrary churn merely to reach a count; if the run's budget is reached, checkpoint the exact remaining passes in the ledger.
- Dashboard, Editor, and Analytics get prominent action tiles with useful contextual subtitles. The rest of the interface stays compact. Future Megabyte Space Chat remains a documented integration until it has a working destination.

### Logs, analytics, audit, and cost

- Replace generic “HTTP request” rows with useful summaries: operation, status, resource, timestamp, duration, and correlation IDs. Errors open to captured messages, stacks, source context when available, related logs, and trace navigation. Clearly identify historical events whose missing detail cannot be recovered; fix instrumentation for new events.
- Correlate audit events with actor, action, target, outcome, resource, and request/trace. Join cost events when attributable. Costs can be measured, estimated, shared, pending, or unavailable; never invent per-action precision or interpret missing telemetry as zero cost.
- Integrate available Cloudflare analytics and observability datasets using supported APIs. Maintain a capability inventory covering permissions, account-plan availability, retention, sampling, freshness, and site attribution. Deliver useful views first, then expand; do not claim every component exposes identical logs or exact real-time data.
- Provide consistent site/environment/resource/time filters and useful drill-downs. Preserve audit evidence while removing temporary test fixtures; cleaning tests does not mean deleting operational logs.

### Super Admin: combine these 20 ideas into a coherent operations workspace

Evaluate all 20 and map each to an existing task or WLK-45 subtask. Group them into a small set of navigable, spreadsheet-style views; share filtering, sorting, saved views, column controls, row detail, and action components. Implement the core search/table/action infrastructure early, then add capabilities progressively.

| # | Capability | Useful operator outcome |
| --- | --- | --- |
| 1 | Global entity search | Find the right user, site, invoice, domain, job, or conversation quickly. |
| 2 | Customer overview | See the user's sites, plan, entitlement, activity, and unresolved issues together. |
| 3 | Site/environment inventory | Understand live state, preview state, ownership, and resource usage. |
| 4 | Billing and invoices | Inspect charges, invoices, status, and payment-related failures. |
| 5 | Refund workbench | Resolve “refund Alex” to the correct customer/charge, prepare an amount, and offer an explicit action. |
| 6 | Plans and entitlements | Explain why a customer can or cannot use a feature. |
| 7 | Credits and usage ledger | Reconcile credits, consumption, reservations, and adjustments. |
| 8 | Resource health/cost | Find waste, quota pressure, failed provisioning, and orphaned assets. |
| 9 | Domains and certificates | Identify routing, DNS, TLS, and ownership problems. |
| 10 | Deployment history | Inspect rollout failures and available rollback versions. |
| 11 | Errors and incidents | Group repeated errors and navigate to actionable evidence. |
| 12 | Queue/workflow operations | Inspect delayed, stuck, failed, paused, and retrying work. |
| 13 | AI latency and spend | Compare task quality, model failures, latency, and cost attribution. |
| 14 | MCP/OAuth health | Spot expired connections and guide reconnection. |
| 15 | Lead/outreach operations | Inspect jobs, budgets, approval queues, and sending outcomes. |
| 16 | Calls and conversations | Review outcomes, failures, permitted recordings, and assistance state. |
| 17 | Flags and configuration | Compare state and perform scoped bulk actions. |
| 18 | Access and audit | Review actor permissions and trace consequential actions. |
| 19 | Support context | Assemble relevant customer evidence and a grounded operator summary. |
| 20 | Saved views and exports | Reuse investigations and export authorized filtered records. |

Global search should return ordinary results promptly and layer grounded AI interpretation over them. A query such as “refund Alex” prepares a contextual operation; submitting search text alone must not issue a refund. Resolve ambiguous customers and enforce the existing billing permissions and idempotency.

### Lead scanner and human-approved outreach

- The first visit proposes a useful editable query from the site's actual context. For ProjectSites.dev, consider businesses without websites in selected locations. Avoid presenting unverified global coverage as complete.
- Each saved query has its own tab, prompt, selected MCPs, estimate, job history, and results. Add a plus control, **Improve Prompt Even More**, and **Attach Recommended MCPs**. Recommendations use real available integrations and make missing connections actionable.
- Before starting, generate a structured, provider-grounded plan with geography, sources, pagination, expected volume, sampling assumptions, quotas, deduplication, estimated cost range, and confidence. Offer narrower or broader scope options. The dollar examples in my transcript illustrate the UX; they are not valid prices to hard-code.
- Freeze the query revision, selected sources, price basis, and spending cap when a job starts. Editing creates a new revision for the next run. Use the existing billing system to reserve/limit spending, meter actual usage, and reconcile unused budget without double billing.
- Use a resumable job state machine with idempotent work units, checkpoints, bounded retries, pause/resume/cancel, partial results, and an enforced budget. Explain any in-flight usage incurred after pause/cancel. Recheck authorizations before provider calls and after resuming.
- Make the leads grid excellent: useful columns, source/evidence, searchable records, score sorting ascending/descending, filters, column visibility, selection, deduplication, export, and saved views. Evaluate an existing grid library if it materially improves delivery; verify license and bundle/runtime suitability.
- Keep acquisition, enrichment, drafting, approval, sending, and outcomes as explicit stages. Human approval applies to the exact recipient set and current email content. Edits invalidate approval. Support suppression/unsubscribe state and cancellation. Test with fixtures or sandbox transports; this implementation task does not authorize sending real outreach.

### Apps, Claude Code, and Full IDE

- Recover the existing Apps roadmap from the repository and ledger. Include EmDash and the intended Slink app. Resolve ambiguous names to actual upstream repositories and check license, runtime, persistence, background tasks, and tenancy before labelling them Cloudflare-native. Use the existing catalog deployment pattern and real health checks.
- Preserve the fast initial editor/WebContainer experience where currently supported. Add a Claude Code action beside the terminal that operates on the same site's current repository state, with clear connection/session status and cancellation.
- Add **Full IDE** at the top of Code for entitled paid users. Use an authenticated, isolated code-server runtime with the required shell, Git, package installation, extensions, and preview forwarding. Evaluate Cloudflare Sandboxes/Containers against actual requirements; do not treat R2 or a browser session as the Linux runtime. See references 6–7.
- Persist workspace state independently of compute lifetime. Verify save, disconnect, stop/recreate, and restore. Keep editor/IDE synchronization version-aware so one view cannot silently overwrite another. Preserve secrets outside repository sync. Show metered compute and storage behavior, and apply the product's idle/retention policy rather than assuming an indefinitely running free machine.

## 6. Permanent additions to /run-the-loop

Integrate these behaviors into the existing loop, preserving its useful prior instructions:

1. **Read new feedback:** At each iteration boundary, inspect the canonical ledger and newly accepted feedback. Normalize contradictions, deduplicate tasks, and propagate relevant deltas to work in progress.
2. **Finish useful work:** Prioritize broken golden paths and their dependencies. Select a bounded set of verifiable outcomes, implement them, and maintain forward progress on larger items. Brainstorming must not displace delivery.
3. **Inspect before and after:** Visit the affected live UI before changes when available. Open real menus, type into searches, inspect long/empty/error states, and capture relevant screenshots. After implementation, repeat the same path and compare.
4. **Use AI where it helps:** Look for valuable contextual enhancements: query explanations, commit summaries, useful defaults, resource explanations, grounded search summaries, and suggested next actions. Prefer deterministic code for deterministic work; cache repeatable AI output and measure latency/cost. Record the best adjacent improvements without allowing endless scope expansion to starve committed tasks.
5. **Review Cloudflare and MCP fit:** Each round, consider whether a current Cloudflare capability or OAuth-capable MCP improves the chosen task. Research only the relevant uncertainty, verify official APIs and account access, and implement a useful improvement or record why none is warranted. No quota of speculative integrations.
6. **Keep evidence and budgets:** Preserve existing model-router and visual-inspection budgets. Track real calls/costs where possible and labelled estimates elsewhere. Record functional and visual evidence with the task ID, route/state, and revision.
7. **Integrate safely:** Use the repository's existing lint/type/build checks and focused behavioral tests. Test integration paths that changed. Keep migrations and release steps explicit, preserve recoverable data, and clean only owned test fixtures.
8. **Close or checkpoint:** Update the ledger with the observed result, remaining issue, and exact next action. Continue the scheduled loop under its existing limits. Never mark a feature done because a button exists or a test was proposed.

Create reusable skills/references for stable search layouts, shared prompt/MCP UI, contextual AI enrichment, resource/environment management, and feedback intake only where existing guidance does not already cover them. Avoid duplicating the same rules across many files. Keep instructions versioned through the repository's established workflow.

## 7. Verification and completion

Maintain a route/state matrix as you touch the product. At minimum, cover:

- Lone Mountain Global: Hosting → Preview; Database → AI seed → cell edit → reload; AI filter and column creation; SQL preset/run/history; KV entitlement → provision → open.
- Resources: inventory/counts, bucket upload/browse, credential access control, environment assignment, supported clone jobs, Workflows listing, Durable Objects inspection.
- Code: compact tree/search, the footer's route scope, autosave, simultaneous changes, history inspection, restore, bucket switching, first publish, later publish, and preview/production isolation.
- Prompts/knowledge: multiple Google connections, selected source ingestion/removal, file upload, MCP selection persistence, no-connections state, form variable expansion, open/close motion, Voice + SMS shared configuration.
- Operations: populated error detail, trace links, cost attribution labels, Analytics filters, feature-flag bulk actions, Super Admin result search and prepared actions.
- Leads: initial suggested query, tabs, estimate, scope selection, budget boundary, pause/resume/cancel, resume after interruption, grid/export, and approval invalidation after a draft/recipient edit.
- Apps/IDE: real install/health checks, paid entitlement, repository synchronization, terminal operation, reconnect, and workspace restoration after compute restart.

Use disposable site/environment fixtures for writes and recovery tests, and read-only checks on real customer state where appropriate. Keep test data tagged for targeted cleanup; do not erase genuine audit trails. Visual verification must include actual screenshots, not only DOM assertions. Functional completion must include the real backend persistence or provider interaction where available; clearly label mocked or locally verified coverage.

After each meaningful checkpoint, report briefly:

- What changed and the user-visible result.
- Ledger IDs verified, in progress, and blocked.
- Tests and live paths actually exercised, with evidence locations.
- The real preview/deployment URL and revision, when available.
- The next implementation action.

Do not ask whether to start. Make the durable loop and ledger changes, implement the first working slice, verify it, and continue.

## 8. Official reference starting points

These references were checked while preparing this prompt on October 1, 2026. Recheck the applicable documentation and installed versions before depending on exact API behavior, quotas, or availability. Architectural choices and acceptance criteria above are implementation recommendations, not claims that Cloudflare supplies the complete product UI.

1. [Claude Code skills and command discovery](https://code.claude.com/docs/en/skills)
2. [D1 Time Travel, recovery, and cloning limitations](https://developers.cloudflare.com/d1/reference/time-travel/)
3. [R2 quotas and operation limits](https://developers.cloudflare.com/r2/platform/limits/)
4. [R2 credentials, scoped permissions, and secret lifecycle](https://developers.cloudflare.com/r2/api/tokens/)
5. [Workflows instance discovery and lifecycle API](https://developers.cloudflare.com/api/resources/workflows/subresources/instances/)
6. [Cloudflare Sandboxes](https://developers.cloudflare.com/sandbox/)
7. [code-server runtime requirements](https://coder.com/docs/code-server)
8. [Durable Objects storage access](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)
