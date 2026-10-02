# CANONICAL MEGABYTE ECOSYSTEM CONTEXT

> Persisted verbatim 2026-10-02 (PENDING-DIRECTIVES Directive 4; source: Brian, delivered at
> context ceiling). Completeness check: 38 numbered sections + the END marker on the last line.

Treat this file as durable product, architecture, implementation, UX, infrastructure, and AI-agent context.

When making decisions, preserve these principles unless a newer explicit instruction overrides them.

Do not merely repeat these ideas. Use them to influence implementation, architecture, prompts, skills, TODOs, tests, interfaces, infrastructure, and future recommendations.

---

# 1. OVERALL MISSION

The ecosystem is a Cloudflare-first collection of interoperable products centered around autonomous software, autonomous websites, personal AI computing, and AI-assisted business operations.

The major products should have sharply distinct responsibilities.

Avoid creating overlapping products, redundant infrastructure, or unnecessary subdomains.

Prefer:

- one clear product responsibility
- one canonical domain
- path-based application routing
- shared primitives
- reusable skills
- interoperable agent infrastructure
- Cloudflare-native services
- AI automation with strong human control
- aggressive cost/performance optimization
- open standards where possible
- permissively licensed/high-momentum FOSS where appropriate

The products should integrate tightly but remain conceptually clean.

---

# 2. CANONICAL PRODUCT MAP

## megabyte.space

Megabyte is the personal AI workspace / operating environment for a power user.

Think:

> A personal AI operating system where applications, agents, browser sessions, code, files, workflows, models, integrations, and tools live together.

Megabyte should eventually run Cloudflare OS directly at:

megabyte.space

Do NOT require:

os.megabyte.space

The existing/current public Megabyte homepage should initially appear when visiting megabyte.space.

The user can enter the OS from the homepage.

Once the user enters Cloudflare OS:
- the OS becomes the primary experience
- preserve their workspace/session state where practical
- do not repeatedly send them back to the homepage
- provide a special Home icon to intentionally return to the homepage

The homepage and OS are two views of the same product/domain.

Avoid separate identity/model/etc. subdomains unless there is a genuine technical reason.

Prefer:

megabyte.space/auth
megabyte.space/api
megabyte.space/mcp
megabyte.space/settings
megabyte.space/os/...

instead of:

id.megabyte.space
ai.megabyte.space
os.megabyte.space

If MCP technically works cleanly at:

megabyte.space/mcp

prefer that over:

mcp.megabyte.space

Only preserve a dedicated MCP hostname if protocol/runtime/security constraints genuinely justify it.

---

# 3. deskl.ink

DeskLink is NOT currently a standalone remote desktop product, visual automation product, or autonomous screenshot agent.

Canonical definition:

> deskl.ink is the shared-link and deep-link system for megabyte.space.

Anything meaningful inside Megabyte should be shareable through DeskLink.

Examples:

deskl.ink/code/projectsites

could restore:

- Code app
- ProjectSites workspace
- repository
- branch
- file
- selected lines
- panel state
- associated AI conversation

Other examples:

deskl.ink/slides/q4-review
deskl.ink/browser/luigis
deskl.ink/file/proposal
deskl.ink/chat/projectsites
deskl.ink/agent/run-921
deskl.ink/dashboard/bricklabor

Every shareable Megabyte application should conceptually support:

serializeContext()

and:

restoreContext()

A DeskLink should normally point to a durable context object rather than encode massive state directly in the URL.

Conceptually:

deskl.ink/<short-id>
        ↓
DeskLink context record
        ↓
megabyte.space
        ↓
restore exact application state

Support sharing depth such as:

- app
- workspace
- project
- document
- exact view
- exact selection
- current complete context

Possible permissions:

- private
- organization
- explicitly shared
- public

DeskLink should support:
- revocation
- expiration
- permission updates
- durable references
- state restoration

Important distinction:

linkbl.ink
= generic web links / redirects / tracking

deskl.ink
= Megabyte-native context sharing

Do not duplicate those responsibilities.

---

# 4. gitl.ink / GitLink

GitLink is the AI layer over Git repositories.

Core proposition:

> Connect a repository. Give it AI instructions and a budget. GitLink continuously improves it.

GitLink should allow:

- GitHub SSO
- GitHub App installation
- selecting repositories
- creating repositories
- selecting branches
- cloning repositories into workspaces
- AI coding agents
- branch/worktree isolation
- commits
- PRs
- testing
- visual review
- scheduled autonomous work
- cost budgets
- project-specific settings
- skills
- MCP
- hooks
- prompts
- model routing
- agent topologies
- human intervention
- Cloudflare-native execution

GitLink should NOT merely be a wrapper around Claude Code.

Build a provider-neutral coding-agent product.

A good technical foundation is a permissively licensed provider-neutral coding agent such as OpenCode rather than attempting to rebrand proprietary Claude Code internals.

Claude Code may still be offered as an optional external engine if legitimately installed/configured.

DeepSeek should be a first-class/default low-cost provider where appropriate.

Other providers may include:

- Anthropic Claude
- OpenAI
- Gemini
- additional providers
- local/open models where useful

Prefer automatic task-aware model routing.

Examples:

cheap/simple repository analysis
→ inexpensive model

normal coding
→ strong cost-efficient coding model

difficult architecture/debugging
→ stronger model

vision
→ best appropriate low-cost vision model

Avoid using the most expensive model for everything.

---

# 5. GITLINK SKILLS

Skills are core infrastructure.

GitLink should work with skills similar to the existing:

heymegabyte/claude-skills

The user should be able to:

- load the default recommended skill set
- add skills
- remove skills
- disable skills
- customize skills
- override skills
- select project-specific skill topology
- select organization-wide skills
- import skills
- create their own

Support compatibility where sensible with:

~/.claude/skills/
.claude/skills/

~/.agents/skills/
.agents/skills/

OpenCode/Agent Skills-compatible locations

SKILL.md

CLAUDE.md

AGENTS.md

MCP

existing commands/hooks/configuration when legally and technically appropriate

Do NOT maintain multiple divergent physical copies as the true source of a skill.

Prefer one canonical registry/profile and materialize/symlink/copy it into compatibility locations as required.

---

# 6. GITLINK WORKSPACE BOOTSTRAP

When creating/running a GitLink project:

1. authenticate via GitHub
2. select or create repository
3. select branch
4. create isolated Cloudflare workspace
5. clone/fetch repository
6. checkout requested branch
7. install GitLink recommended settings/profile
8. materialize selected skills
9. configure MCPs
10. configure hooks
11. configure agent/model topology
12. apply seed prompt/context
13. make workspace ready for autonomous and interactive use

The repository must actually exist inside the working environment.

The project should contain the user's chosen branch and relevant configuration.

Default to the user's preferred Megabyte/GitLink profile, but allow total customization.

---

# 7. GIT + HUMAN WORK

Humans remain first-class participants.

A human should continue to use Git normally.

Example:

git add -A
git commit
git push

AI agents should work in isolated branches/worktrees.

Conceptually:

main
├── human/editor-redesign
├── agent/testing-123
├── agent/ui-review-124
├── agent/refactor-125
└── agent/docs-126

Agents should not blindly overwrite human work.

If a human pushes changes while an agent is working:

- fetch latest state
- understand the new human changes
- rebase safely where appropriate
- invalidate stale assumptions/tests/screenshots
- rerun affected validation
- resolve only safe/trivial conflicts automatically
- escalate ambiguous conflicts

Human commits should be treated as authoritative new information.

Give GitLink agents their own Git identity rather than pretending commits came from the human.

Prefer GitHub Apps/service identities over storing personal tokens.

---

# 8. GITLINK BUDGET MODEL

A major GitLink concept is:

> Specify how much money you want to spend improving a repository.

Example:

ProjectSites
Monthly AI budget: $200

GitLink should continuously decide:

> What is the most valuable safe work that can be accomplished with the remaining budget?

Do not interpret this as "spend money blindly."

Prefer adaptive scheduling.

A cheap project heartbeat may run frequently, while expensive multi-agent fan-outs should only run when useful.

Possible architecture:

15-minute lightweight heartbeat
→ inspect state
→ decide whether useful work exists

larger fan-out
→ triggered based on:
- meaningful commits
- TODO backlog
- failures
- design findings
- production issues
- budget pacing
- scheduled deep review

Model usage should be adaptive.

The goal is maximum useful engineering output per dollar, not maximum model invocations.

---

# 9. PROJECTSITES.DEV

ProjectSites is an autonomous website operating system.

It should:

- create sites
- host sites
- operate sites
- improve sites
- continuously inspect sites
- manage content
- manage resources
- manage domains
- manage SEO
- manage social/content automation
- manage analytics
- manage leads
- manage forms
- manage business integrations
- manage deployments
- autonomously improve sites

Canonical primary domain:

projectsites.dev

Avoid unnecessary feature-specific subdomains.

Prefer:

projectsites.dev/dashboard
projectsites.dev/editor
projectsites.dev/analytics
projectsites.dev/snapshots
projectsites.dev/resources
projectsites.dev/settings
projectsites.dev/billing
projectsites.dev/api/...
projectsites.dev/mcp/...

Do NOT unnecessarily create:

app.projectsites.dev
admin.projectsites.dev
api.projectsites.dev
assets.projectsites.dev

Prefer absorbing those into projectsites.dev.

MCP should preferably live at:

projectsites.dev/mcp

unless a dedicated MCP hostname is technically required.

---

# 10. PROJECTSITES WILDCARD DOMAINS

These ARE legitimate hostname boundaries.

Use:

*.sites.projectsites.dev

for production-hosted websites.

Use:

*.preview.projectsites.dev

for previews / revisions / branches / temporary builds.

These exist because wildcard multi-tenant routing is a real infrastructure boundary.

Customer custom domains should map into the same ProjectSites hosting platform.

Do not create a generic:

assets.projectsites.dev

Normal assets should be served using the site's own domain where practical.

Examples:

business.sites.projectsites.dev/images/logo.webp

or:

business.com/images/logo.webp

Users may intentionally expose:
- an R2 bucket URL
- a custom DNS alias to a bucket
- another explicitly selected asset endpoint

but this should be opt-in, not the default ProjectSites asset architecture.

---

# 11. PROJECTSITES STORAGE

Current preferred model:

Each website normally receives:

- Preview R2/storage
- Production R2/storage

unless a future architecture proves a superior namespaced method.

Preview environment uses preview storage.

Production uses production storage.

Customer-facing URLs must not expose storage architecture unnecessarily.

---

# 12. claimyour.site

ClaimYour.Site is NOT a separate product.

It is a ProjectSites intent-entry domain.

Core proposition:

> The URL itself is a natural-language request for a website.

Examples:

claimyour.site/luigis-pizza
claimyour.site/luigis-pizza-morristown
claimyour.site/luigis-pizza-morristown-nj
claimyour.site/make-a-site-for-luigis-pizza-in-morristown

ProjectSites should use as much useful non-invasive context as available to understand the user's intent:

- pathname
- query parameters
- known aliases
- prior resolved aliases
- campaign metadata
- UTM data
- referrer when available
- existing ProjectSites projects
- existing businesses/sites
- coarse location where appropriate
- semantic matching
- public business information
- web research

The URL itself remains the main fallback prompt.

Example:

claimyour.site/weird-text-marios-pizza

If ProjectSites has already confirmed that this maps to:

marios-pizza

then future requests should resolve deterministically.

AI ambiguity resolution should turn into permanent deterministic aliases where appropriate.

Use escalating-cost resolution:

1. exact alias lookup
2. exact site/business match
3. lexical/fuzzy match
4. semantic/vector match
5. inexpensive AI classification
6. public web/business research
7. ask user

Do NOT call an LLM unnecessarily on every request.

---

# 13. claimyour.site AMBIGUITY

Example:

claimyour.site/luigis-pizza

If multiple plausible businesses exist:

Which Luigi's Pizza?

○ Luigi's Pizza — Morristown, NJ
○ Luigi's Pizza — Madison, NJ
○ Luigi's Pizza — Randolph, NJ
○ None of these

Ask only questions whose answers materially improve the result.

Once enough information is known, show what ProjectSites intends to build.

The user MUST explicitly confirm before a new website is generated.

This prevents:
- bots
- crawlers
- accidental requests
- huge volumes of false websites

GET requests alone should never trigger an expensive irreversible website build.

---

# 14. claimyour.site BUILD EXPERIENCE

After confirmation:

CONFIRMED
→ RESEARCHING
→ PLANNING
→ GENERATING
→ VISUAL REVIEW
→ TESTING
→ READY

The site should progressively become available rather than forcing the user to stare at an opaque loading spinner.

Show:
- real research progress
- actual generated sections
- real preview improvements
- meaningful status updates

Do not fake progress.

Preview URLs belong under:

*.preview.projectsites.dev

Once finished/claimed/published:

*.sites.projectsites.dev

or the customer's own domain.

---

# 15. linkbl.ink

LinkBL is the canonical generic link-management infrastructure.

Use:

https://github.com/miantiao-me/Sink

as the primary implementation.

Sink is Cloudflare-native and already provides:

- short links
- customizable slugs
- D1
- KV caching
- Analytics Engine
- QR codes
- UTM support
- expirations
- password links
- smart country/device routing
- social previews
- analytics
- API
- MCP
- optional Workers AI
- optional R2 snapshots

Do NOT recreate these capabilities independently inside:
- ProjectSites
- GitLink
- Megabyte
- Brick Labor

Use Sink through API/MCP.

Keep proprietary business logic outside Sink.

Sink is AGPL-3.0.

Keep the Sink deployment reasonably close to upstream so:
- upgrades remain manageable
- proprietary logic stays separate
- licensing boundaries remain clean

Canonical meaning:

> linkbl.ink = generic short links, redirects, QR codes, campaigns, routing, and analytics.

Do not confuse LinkBL with DeskLink.

---

# 16. thebestsites.com

TheBestSites is a public SEO/discovery/promotion catalog of excellent websites.

It exists primarily to:

- attract organic traffic
- showcase excellent sites
- publish useful editorial content
- create backlinks
- promote ProjectSites
- promote related ecosystem products
- provide website inspiration
- generate inbound leads

Potential categories:

- best restaurant websites
- best contractor websites
- best nonprofit websites
- best church websites
- best animated websites
- best AI websites
- best portfolios
- best local business websites

Do NOT turn this into thin programmatic SEO spam.

Pages should have genuine:
- editorial quality
- analysis
- utility
- comparisons
- design observations
- performance information
- inspiration

TheBestSites may eventually connect to ProjectSites so users can:

analyze their current site
→ see opportunities
→ generate/improve a ProjectSites version

---

# 17. bricklabor.com

Brick Labor is the backbone for:

- property-management consulting
- property maintenance
- service work
- field operations
- customers
- properties
- estimates
- crews
- jobs
- equipment
- recurring service
- photos
- inspection records
- invoices
- payments
- service history
- consulting work

Authenticated application functionality should normally live under paths such as:

bricklabor.com/dashboard

Do NOT create:

admin.bricklabor.com

merely for organizational reasons.

---

# 18. DOMAIN CONSOLIDATION PRINCIPLE

This is a major permanent architecture rule.

Prefer one canonical domain.

Use paths by default.

Create a subdomain/domain only when there is a genuine technical or product reason.

Before introducing a new hostname ask:

1. Does this require wildcard DNS?
2. Is this a separate product?
3. Does it require a separate runtime?
4. Is there a materially different security boundary?
5. Is there a protocol requirement?
6. Does a vendor/service require independent DNS?
7. Would same-origin routing create a real technical problem?

If the answer is no:

USE A PATH.

Avoid hostname proliferation such as:

api.*
admin.*
app.*
auth.*
ai.*

when ordinary routing works.

Benefits include:

- simpler OAuth
- simpler cookies
- less CORS
- simpler CSP
- simpler analytics
- fewer certificates
- fewer DNS records
- simpler deployment
- simpler service workers
- simpler API calls
- fewer configuration variables
- easier authentication
- reduced architectural complexity

Do not sacrifice good internal code boundaries merely because services share a hostname.

Logical/application modules should still be well separated.

---

# 19. CLOUDFLARE-FIRST ARCHITECTURE

Cloudflare-native should be the default.

Strongly prefer Cloudflare primitives where appropriate:

- Workers
- Workers Static Assets
- Durable Objects
- D1
- R2
- KV
- Queues
- Workflows
- Workers for Platforms
- Cloudflare for SaaS
- Browser Run
- Sandbox / Containers
- AI Gateway
- Workers AI
- Hyperdrive
- Access
- Turnstile
- Analytics Engine
- Cloudflare security/network products

Do not expose one public hostname per Cloudflare service.

Implementation details should stay behind clean product URLs.

Cloudflare-native should generally be preferred over always-on VPS infrastructure.

Use external managed services only where they provide a material advantage.

---

# 20. PLATFORM ABSTRACTION

Cloudflare should be the preferred implementation but avoid hard-coding every domain object directly to Cloudflare.

Use thin interfaces where practical.

Examples:

WorkspaceProvider

SiteRuntime

ModelGateway

BrowserProvider

StorageProvider

LinkProvider

This allows future evolution without weakening the current Cloudflare-first strategy.

Cloudflare implementations should remain the default.

---

# 21. FOSS PRINCIPLES

Before recommending/adopting a FOSS project:

Evaluate:

- license
- current maintenance
- release cadence
- contributor activity
- issue activity
- security
- adoption
- GitHub momentum
- compatibility with Cloudflare
- operational complexity
- ability to scale to zero
- ecosystem maturity

Prefer high-momentum projects.

The user strongly prefers projects with meaningful adoption rather than obscure projects with a few hundred stars unless there is a compelling reason.

Prefer permissive licenses when otherwise comparable.

Use AGPL projects behind clean service/API boundaries where appropriate.

Avoid duplicating mature functionality unnecessarily.

---

# 22. IMPORTANT FOSS / TECHNOLOGY DIRECTIONS

Useful technologies to keep in mind include:

OpenCode
- candidate base for provider-neutral GitLink coding agent
- permissively licensed
- provider-neutral
- skill compatibility
- DeepSeek support

Cloudflare Agents SDK
- agent state
- durable execution
- scheduling
- realtime agent communication
- MCP integration

MCP TypeScript SDK
- canonical tool protocol

Better Auth
- authentication
- GitHub OAuth
- organizations
- future SSO/passkeys

OpenFGA
- complex authorization where warranted

Sink
- LinkBL implementation

Stagehand / Browser Run / Playwright
- browser control
- visual inspection
- golden paths

xterm.js
- browser terminal where needed

OpenVSCode Server / equivalent
- browser coding workspace where appropriate

Yjs
- collaborative state only where CRDTs provide real value

Avoid adding external infrastructure where a Cloudflare primitive already handles the requirement cleanly.

---

# 23. VISUAL AI + BROWSER LOOPS

Visual agents remain an important primitive, but they do NOT define deskl.ink.

Visual automation belongs inside Megabyte/GitLink/ProjectSites agent infrastructure.

Preferred perception hierarchy:

1. structured APIs/WebMCP/tool interfaces
2. DOM
3. accessibility tree
4. console/network/runtime state
5. screenshot/vision fallback

Do not blindly use expensive screenshot vision if deterministic browser information answers the question.

For UI improvement:

observe
→ analyze
→ act
→ wait for stable state
→ observe again
→ compare
→ repeat

Visual agents should be able to identify:
- broken layouts
- ugly spacing
- visual hierarchy problems
- interaction problems
- browser errors
- network failures
- mobile issues
- inaccessible controls
- poor UX
- regression issues

GitLink can then modify source code to resolve findings.

---

# 24. /run-the-loop PHILOSOPHY

The ecosystem uses continuous multi-agent improvement loops.

A loop should not merely repeat the same prompt.

It should intelligently allocate attention.

Typical fan-out responsibilities include:

- feature implementation
- repository understanding
- new feature discovery
- unit tests
- E2E tests
- golden-path simulation
- browser testing
- visual inspection
- architecture improvements
- documentation
- dead-code removal
- unused-file cleanup
- dependency upgrades
- style-guide alignment
- performance
- accessibility
- security
- TODO cleanup
- UX polish

Loops should improve their own loop infrastructure over time.

A persistent TODO ledger should contain actionable work.

Tasks should be small enough to execute independently where practical.

Parallelism should be used aggressively but safely.

---

# 25. DOCUMENTATION + REPOSITORY HYGIENE

Every repeated autonomous run should spend some effort maintaining repository quality.

Prefer:

- concise documentation
- useful TypeDoc/JSDoc
- architecture decision documentation
- code comments that explain WHY, not trivial syntax
- removal of stale examples
- removal of dead code
- removal of empty files
- .gitignore cleanup
- dependency cleanup
- unused-export detection
- style-guide alignment
- AI-readable documentation
- human-readable documentation

Avoid massive redundant markdown.

Documentation should become smaller and clearer over time rather than endlessly growing.

---

# 26. TESTING EXPECTATIONS

Use TDD where practical.

Testing should include the appropriate combination of:

- unit tests
- integration tests
- E2E tests
- Playwright
- Cloudflare Browser Run
- golden paths
- visual review
- responsive/mobile tests
- accessibility
- Lighthouse/performance
- security validation

Golden paths should correspond to actual business outcomes, not arbitrary clicks.

Agents should simulate users accomplishing meaningful tasks.

---

# 27. MODEL ROUTING PRINCIPLE

Use the cheapest model capable of completing the job well.

Do not equate higher price with better architecture.

Possible routing pattern:

cheap routine analysis
→ DeepSeek / low-cost model

normal coding
→ strong cost-efficient coding model

complex reasoning/debugging
→ Claude / stronger model

vision/UI
→ appropriate vision model

flagship/release review
→ strongest model only when justified

Escalate after evidence of difficulty rather than defaulting to premium models.

Prompt caching and stable context reuse should be used aggressively when provider capabilities allow.

---

# 28. HUMAN CONTROL

Autonomy should remain observable and interruptible.

Humans should be able to:

- inspect
- pause
- message
- redirect
- approve
- reject
- take over
- undo
- stop
- review diffs
- review previews
- inspect costs

Do not hide significant irreversible work behind autonomous processes.

Require human confirmation for:
- ambiguous destructive actions
- site creation from untrusted GET traffic
- purchases
- major irreversible changes
- sensitive external actions where appropriate

---

# 29. BUSINESS/PRODUCT DESIGN PREFERENCE

Prefer:

- delight
- visual polish
- automation
- clear value
- minimal configuration
- rapid time-to-result
- progressive results
- reusable primitives
- high leverage
- systems that become smarter over time

Avoid:

- dashboards full of unnecessary controls
- complexity for complexity's sake
- enterprise ceremony without real value
- duplicating existing infrastructure
- enormous setup flows
- meaningless AI gimmicks
- static waiting screens when progressive work can be displayed

The user strongly values iterative visual improvement.

When designing UI:
- inspect repeatedly
- improve repeatedly
- compare before/after
- keep iterating until changes stop providing meaningful improvement

---

# 30. IMPORTANT PRODUCT POSITIONING

Canonical shorthand:

megabyte.space
= personal AI workspace / Cloudflare OS

gitl.ink
= AI workforce + budgets for Git repositories

deskl.ink
= shared/deep links into Megabyte contexts

projectsites.dev
= autonomous website operating system

claimyour.site
= natural-language ProjectSites intent + creation routing

thebestsites.com
= SEO/discovery/promotion catalog of excellent sites

linkbl.ink
= Sink-powered generic link/QR/analytics infrastructure

bricklabor.com
= property-management consulting + field-services operational backbone

Keep these meanings distinct.

---

# 31. INTER-PRODUCT RELATIONSHIPS

Conceptually:

                        megabyte.space
                     Personal AI Workspace
                              |
              +---------------+---------------+
              |                               |
          gitl.ink                        deskl.ink
     Repository AI Layer            Megabyte Shared Context
              |
              |
       projectsites.dev
 Autonomous Website Operating System
              |
      +-------+----------+
      |                  |
claimyour.site      thebestsites.com
 intent/acquisition      SEO/discovery

linkbl.ink
provides generic short-link infrastructure across products where needed

bricklabor.com
uses the ecosystem to support real property/service business workflows

Do not force every product through every other product.

Use integration where it reduces duplication or creates clear value.

---

# 32. NEW DOMAIN RULE

Do not register/build another domain merely because a clever name exists.

A new domain should represent one of:

- a genuinely separate product
- a major acquisition funnel
- a distinct public semantic
- a trust/security boundary
- a protocol/infrastructure boundary that users meaningfully benefit from

Otherwise use an existing product/path.

---

# 33. AGENT DECISION-MAKING RULE

Whenever implementing a request:

1. inspect the existing codebase
2. understand what's already implemented
3. reuse good primitives
4. identify contradictory legacy decisions
5. implement the explicit request
6. improve adjacent architecture where clearly beneficial
7. remove obsolete code
8. update tests
9. update persistent context
10. update TODO ledger
11. run relevant validation
12. report what changed

Do not stop at writing a plan when safe implementation is possible.

Do not ask unnecessary clarifying questions when the intended direction is clear.

Make the strongest reasonable implementation using available information.

---

# 34. TEN-PASS IMPROVEMENT METHOD

For substantial architecture/product work, internally run repeated critique passes.

Useful dimensions:

1. product clarity
2. simplicity
3. Cloudflare nativeness
4. cost
5. latency
6. security
7. autonomy
8. human control
9. FOSS leverage
10. convergence/removal

The final result should be one converged design, NOT ten redundant versions.

Each pass should improve the implementation rather than merely append ideas.

---

# 35. IMPLEMENTATION STYLE

Prefer:

- TypeScript
- strict typing
- Hono on Workers where appropriate
- Zod/schema-driven validation
- clean interfaces
- small composable modules
- testability
- observability
- explicit state machines for complex workflows
- typed Cloudflare bindings
- strong tenant isolation
- queue/workflow-based long jobs
- idempotency
- retries with bounds
- durable state where necessary
- stateless edge paths where possible

Avoid:
- giant monolith files
- hidden magic
- unnecessary abstractions
- premature distributed architecture
- vendor-specific coupling where a tiny interface solves it
- duplicated implementation across products

---

# 36. COST RULE

Always think about cost.

Especially for autonomous loops:

- don't wake expensive compute without useful work
- use scale-to-zero infrastructure
- cache aggressively where correct
- avoid unnecessary LLM calls
- deduplicate work
- use deterministic matching before AI
- use cheap models before premium models
- reuse repository/context caches
- store learned aliases/resolutions
- suspend Cloudflare Sandboxes when idle
- use queues/workflows instead of holding requests open

The objective is:

> maximum useful autonomous work per dollar.

---

# 37. FUTURE RECOMMENDATIONS

When suggesting future ideas, first ask:

- Does an existing ecosystem product already own this responsibility?
- Can this be a route instead of a subdomain?
- Can this be a skill instead of a service?
- Can this be an MCP instead of custom integration code?
- Can Cloudflare already do this?
- Can Sink/OpenCode/another approved FOSS project already do it?
- Can deterministic logic handle this instead of AI?
- Can cheap AI handle it instead of premium AI?
- Can the result become reusable infrastructure?

Favor leverage over proliferation.

---

# 38. OVERRIDING PRINCIPLE

The ecosystem should feel like a coherent autonomous computing platform rather than a collection of unrelated apps.

Every architectural decision should aim toward:

- fewer duplicated systems
- clearer product responsibilities
- more automation
- more reuse
- better visual quality
- lower cost
- stronger Cloudflare integration
- stronger human agency
- easier AI reasoning
- easier long-term maintenance
- faster iteration

If a proposed implementation conflicts with these principles, reconsider the implementation rather than blindly following the first obvious design.

<!-- END OF CANONICAL ECOSYSTEM CONTEXT — 38/38 sections, verbatim, complete. -->

---

## fire-89 Downloads intake — new wisdom (2026-10-02)

> Appended BELOW the verbatim marker (sections 1-38 stay untouched). Decomposed from two
> `~/Downloads` master prompts — `projectsites-chatgpt-final-prompt-compiler-v7.md` +
> `projectsites-claude-code-homepage-domains-seo-evaluation-prompt.md` — deduped hard against
> §§1-38 + BACKLOG. Only genuinely-NEW context below; everything already captured (CF Flagship
> flags · three-bucket/30MB storage · AWOS homepage/SEO/daily-content) was dropped.

### Ops / reliability — 95% availability is a DEV target, not an SLA

- Target **95% availability** as a development/quality aim, measured SEPARATELY for the three
  planes: **editor** · **control-plane** (admin/API) · **published-site serving**. It is NOT an
  enterprise SLA and NEVER an excuse to tolerate an outage — a red plane is a fire, not a budget.
- Separate measurement matters: a healthy editor can mask a broken serving plane (and vice versa);
  one blended number hides the plane that's actually down.

### Quality / evals — evidence-optimized assignment prep + route-eval (NOT verbosity)

- Every NEW assignment runs an **evidence-optimized preparation pipeline** before orchestration:
  **Workers AI enrichment → OpenAI research/preparation → constraints validation → Claude Code
  orchestration**. The **original request is kept IMMUTABLE** — preparation augments, never rewrites
  the ask.
- **Route quality is measured, not asserted** — compare raw-request vs prepared-request outcomes via
  **Langfuse** (traces/scores) + **Promptfoo** (A/B eval). Quality is the measured delta in OUTCOME,
  NOT prompt verbosity, token count, or a fabricated "N-pass reasoning" tally. A longer prompt ≠ a
  better route; only the eval decides.

### Product focus — website-business-autopilot, HOMEPAGE + Preview-publish first

- Restated product spine: **website-business-autopilot** — HOMEPAGE-first and **Preview-publish-first**
  (deliver a working preview; publishing/promotion is the gated step, per the open question below).
- **Daily marketing-blog publication is a SEPARATE, NARROW rule** (one content surface) that MUST NOT
  auto-deploy APPLICATION changes — publishing a blog post ≠ shipping code/app config. Keep the
  content-publish path strictly isolated from the app-deploy path (backlog: narrow daily-blog rule).

### Pointer

- The v7 prompts also demand **production deployment OFF by default** with an explicit single-release
  grant to promote — this CONTRADICTS the loop's canonical answer #3 (full autonomy on reversible
  prod). Captured as an **OPEN QUESTION for Brian** in `OPERATING-PRINCIPLES.md` §
  "Open question — prod-off-by-default vs canonical answer #3"; NOT applied (behavior unchanged).
