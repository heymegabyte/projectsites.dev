/**
 * @file ClaudeCodePanel — the embedded "Claude Code" editor tab (WLK-39 §75 flagship, slice S1).
 *
 * @remarks
 * The first WIRE-COMPLETE vertical of the §75 flagship — NOT a scaffold. It composes the shared
 * panel spine ({@link PanelShell}/{@link PanelHeader}/{@link PanelLoading}/{@link PanelEmpty} +
 * {@link PanelSegmentedNav}), so chrome/tokens/empty/loading read identically + on-brand
 * (black `--ps-bg` + cyan `--ps-accent`, WCAG AA, reduced-motion inherited from the spine).
 *
 * ## What it does (end-to-end, this slice)
 *   1. A prompt input (one obvious primary action — "Run") POSTs to the EXISTING
 *      `POST /api/llmcall` with `streamOutput:true` — the path that already routes to ProjectSites
 *      AI via the AI Gateway (`PS_BOLT_AI=true`). No new provider/route/gateway.
 *   2. The text stream is read chunk-by-chunk and fed through the PURE
 *      {@link parseClaudeCodeStream}, which yields {@link ClaudeCodeEvent}s and — by construction —
 *      can never carry chain-of-thought (no `thought`/`reasoning` variant exists).
 *   3. Those events render in the Activity tab as actions / decisions / evidence / file-touches /
 *      test-results / deploy-state / raw output. CoT is structurally unrenderable.
 *   4. "Apply sample edit" writes ONE file through the EXISTING workbench mechanism
 *      (`workbenchStore.createFile()` → the ONE WebContainer) — the same rail the chat's
 *      `boltArtifact`/`<boltAction type="file">` uses. NO parallel filesystem (root CLAUDE.md:
 *      never build a parallel editor).
 *
 * ## The CoT guardrail at the render layer
 * The renderer switches over `event.kind`; the union has no CoT member, so there is no branch that
 * could display reasoning. The firewall is enforced twice — in the parser (drops CoT lines) and
 * here (no type to render).
 *
 * ## S2-S4 (this slice): the read-surface review tabs
 *   - **Files** lists the run's `file_touched` events (path + add/mod/del badge); selecting one opens
 *     a reviewable per-file DIFF via {@link ClaudeCodeFileDiff}, which REUSES the editor's existing
 *     `diffLines` renderer (the same green-add/red-remove/context row language as EditorPanel's inline
 *     diff) — NOT a new diff engine.
 *   - **Tests** renders `test_result` events (pass/fail tally + a row per test, failing first).
 *   - **Deploy** renders `deploy_state` events (latest status hero + transition history).
 *
 * ## S6-b-ii (this slice): Resolution mode
 *   - A header "Single | Resolution" toggle (reduced-motion, `bolt-elements-*` tokens, WCAG AA,
 *     radio semantics) chooses the run path. Single (the default) streams the existing
 *     `/api/llmcall`; Resolution POSTs `/api/resolve` ONCE (dual-provider research → Claude
 *     synthesis, S6-b-i) and reuses the SAME S5 run-lifecycle (running → done | error, Stop).
 *   - On a Resolution response the Activity body renders a **Research** section (the two legs, each
 *     collapsible + provider/model-labeled via {@link parseResolveResult}) and an emphasized
 *     **Synthesis** section. A `synthesis.ok===false` marker shows the legs + a calm
 *     "synthesis unavailable" note — NOT an error.
 *   - Flag-off: `/api/resolve` 404 (the `resolution_engine` flag is dark) ⇒ "Resolution mode
 *     unavailable" — the toggle is DISABLED with a tooltip (never an error toast), and the panel
 *     stays on Single mode, which always works.
 *
 * Deferred (per the WLK-39 plan in BACKLOG.md): the LIVE WebContainer end-to-end proof
 * (edit → Preview reflects) is browser follow-on S7. This slice's bar is unit + build proof.
 */
import { memo, useCallback, useMemo, useReducer, useRef, useState, type FormEvent } from 'react';
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '~/utils/constants';
import { workbenchStore } from '~/lib/stores/workbench';
import { classNames } from '~/utils/classNames';
import { PanelShell, PanelHeader, PanelLoading, PanelEmpty, PanelSegmentedNav } from './panel';
import {
  parseClaudeCodeStream,
  type ClaudeCodeEvent,
  type ClaudeCodeFileTouchedEvent,
  type ClaudeCodeTestResultEvent,
  type ClaudeCodeDeployStateEvent,
} from './claude-code-stream';
import {
  runReducer,
  initialRunState,
  summarizePrompt,
  formatRelative,
  RUN_STATUS_META,
  RUN_PHASE_META,
  type RunState,
  type RunStatus,
  type RunTransition,
} from './claude-code-run';
import { ClaudeCodeFileDiff } from './ClaudeCodeFileDiff';
import {
  parseResolveResult,
  providerLabel,
  type ResolveResult,
  type ResolveResearchLeg,
} from './claude-code-resolve';

/** The panel's sub-nav. Activity (S1) + Files/Tests/Deploy (S2-S4) are all wired. */
const NAV_ITEMS = [
  { id: 'activity', label: 'Activity', icon: 'i-ph:list-bullets-duotone' },
  { id: 'files', label: 'Files', icon: 'i-ph:file-dashed-duotone' },
  { id: 'tests', label: 'Tests', icon: 'i-ph:test-tube-duotone' },
  { id: 'deploy', label: 'Deploy', icon: 'i-ph:rocket-launch-duotone' },
] as const;

type NavId = (typeof NAV_ITEMS)[number]['id'];

/** The system prompt that teaches the model the structured line protocol the parser reads. */
const CLAUDE_CODE_SYSTEM = [
  'You are Claude Code embedded in a web IDE. Narrate your run as structured event lines, one per line.',
  'Emit ONLY these JSON shapes (one object per line): ',
  '{"kind":"action","label":"…","detail":"…"} · {"kind":"decision","label":"…","rationale":"…"} · ',
  '{"kind":"evidence","label":"…","source":"…"} · {"kind":"file_touched","path":"…","change":"create|edit|delete"} · ',
  '{"kind":"test_result","name":"…","passed":true,"summary":"…"} · {"kind":"deploy_state","state":"building|deployed|failed"}.',
  'NEVER emit your private reasoning or chain-of-thought — only concrete actions, decisions (with a user-facing rationale), and evidence.',
].join('');

/** A deterministic sample stream — used by the "Apply sample edit" demo + asserted by the spec. */
export const SAMPLE_ACTIVITY_STREAM = [
  '{"kind":"decision","label":"Add a greeting to the homepage","rationale":"The brief asks for a hero line"}',
  '{"kind":"action","label":"Read src/App.tsx"}',
  '{"kind":"thought","label":"this private reasoning MUST be stripped"}',
  // Carries before/after so the Files tab renders a REAL reviewable diff (not just metadata).
  JSON.stringify({
    kind: 'file_touched',
    path: 'src/App.tsx',
    change: 'edit',
    before: 'export function App() {\n  return <main>Welcome</main>;\n}\n',
    after: 'export function App() {\n  return <main><h1>Welcome home</h1></main>;\n}\n',
  }),
  '{"kind":"test_result","name":"homepage renders","passed":true,"summary":"1 passed"}',
  '{"kind":"deploy_state","state":"deployed","detail":"v128 live at editor.projectsites.dev"}',
  'Edited the hero copy.',
].join('\n');

/** Human labels + accent glyphs per event kind for the Activity log. */
const KIND_META: Record<ClaudeCodeEvent['kind'], { label: string; icon: string }> = {
  action: { label: 'Action', icon: 'i-ph:lightning-duotone' },
  decision: { label: 'Decision', icon: 'i-ph:git-branch-duotone' },
  evidence: { label: 'Evidence', icon: 'i-ph:magnifying-glass-duotone' },
  file_touched: { label: 'File', icon: 'i-ph:file-duotone' },
  test_result: { label: 'Test', icon: 'i-ph:test-tube-duotone' },
  deploy_state: { label: 'Deploy', icon: 'i-ph:rocket-launch-duotone' },
  output_delta: { label: 'Output', icon: 'i-ph:terminal-window-duotone' },
};

/** Render a single event's primary + secondary text (never CoT — no such kind exists). */
function eventText(event: ClaudeCodeEvent): { primary: string; secondary?: string } {
  switch (event.kind) {
    case 'action':
      return { primary: event.label, secondary: event.detail };
    case 'decision':
      return { primary: event.label, secondary: event.rationale };
    case 'evidence':
      return { primary: event.label, secondary: event.source };
    case 'file_touched':
      return { primary: event.path, secondary: event.change };
    case 'test_result':
      return { primary: event.name, secondary: event.summary ?? (event.passed ? 'passed' : 'failed') };
    case 'deploy_state':
      return { primary: event.state, secondary: event.detail };
    case 'output_delta':
      return { primary: event.text };
  }
}

/** One Activity row — an accent kind-chip + the event's text. */
const ActivityRow = memo(function ActivityRow({ event, index }: { event: ClaudeCodeEvent; index: number }) {
  const meta = KIND_META[event.kind];
  const { primary, secondary } = eventText(event);

  return (
    <li
      data-testid={`cc-event-${index}`}
      data-kind={event.kind}
      className="flex items-start gap-2.5 rounded-lg border border-bolt-elements-borderColor/60 bg-bolt-elements-background-depth-2 px-3 py-2"
    >
      <span className="mt-0.5 inline-flex items-center gap-1 rounded-md border border-bolt-elements-item-contentAccent/25 bg-bolt-elements-item-contentAccent/[0.08] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-bolt-elements-item-contentAccent">
        <span className={classNames(meta.icon, 'text-sm')} aria-hidden="true" />
        {meta.label}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block break-words text-[13px] leading-snug text-bolt-elements-textPrimary">{primary}</span>
        {secondary != null && secondary !== '' && (
          <span className="mt-0.5 block break-words text-[11px] leading-snug text-bolt-elements-textTertiary">
            {secondary}
          </span>
        )}
      </span>
    </li>
  );
});

/** Per-change badge copy + tint for the Files list (create=add-green, edit=accent, delete=red). */
const CHANGE_META: Record<ClaudeCodeFileTouchedEvent['change'], { label: string; className: string }> = {
  create: { label: 'Added', className: 'border-green-500/30 bg-green-500/10 text-green-500' },
  edit: {
    label: 'Modified',
    className:
      'border-bolt-elements-item-contentAccent/30 bg-bolt-elements-item-contentAccent/[0.08] text-bolt-elements-item-contentAccent',
  },
  delete: { label: 'Deleted', className: 'border-red-500/30 bg-red-500/10 text-red-500' },
};

/**
 * S2 — the Files tab. Lists every `file_touched` event (path + add/mod/del badge); selecting one
 * opens a reviewable per-file DIFF via {@link ClaudeCodeFileDiff} (which REUSES the editor's
 * `diffLines` renderer). Master/detail: the list is always visible, the diff fills the rest.
 */
const FilesTab = memo(function FilesTab({
  files,
  selectedIndex,
  onSelect,
}: {
  files: ClaudeCodeFileTouchedEvent[];
  selectedIndex: number;
  onSelect: (index: number) => void;
}) {
  if (files.length === 0) {
    return (
      <PanelEmpty
        testId="cc-files-empty"
        icon="i-ph:file-dashed-duotone"
        title="No files changed yet"
        description="When Claude Code edits your site, every file it touches appears here with a reviewable diff."
      />
    );
  }

  // Clamp the selection so a shrinking list never points past the end.
  const activeIndex = selectedIndex >= 0 && selectedIndex < files.length ? selectedIndex : 0;
  const active = files[activeIndex];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ul
        data-testid="cc-files-list"
        className="shrink-0 max-h-[40%] overflow-y-auto border-b border-bolt-elements-borderColor p-2"
      >
        {files.map((file, index) => {
          const meta = CHANGE_META[file.change];
          const isActive = index === activeIndex;

          return (
            <li key={`${file.path}-${index}`}>
              <button
                type="button"
                data-testid={`cc-file-${index}`}
                data-change={file.change}
                aria-pressed={isActive}
                onClick={() => onSelect(index)}
                className={classNames(
                  'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors',
                  isActive
                    ? 'bg-bolt-elements-item-contentAccent/[0.1] ring-1 ring-bolt-elements-item-contentAccent/30'
                    : 'hover:bg-bolt-elements-background-depth-2',
                )}
              >
                <span
                  className="i-ph:file-duotone shrink-0 text-sm text-bolt-elements-textTertiary"
                  aria-hidden="true"
                />
                <code className="min-w-0 flex-1 truncate text-[12px] text-bolt-elements-textPrimary">{file.path}</code>
                <span
                  className={classNames(
                    'shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                    meta.className,
                  )}
                >
                  {meta.label}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {active != null && <ClaudeCodeFileDiff event={active} />}
    </div>
  );
});

/**
 * S3 — the Tests tab. Renders `test_result` events: a pass/fail tally header + a row per test
 * (green check / red x), failing names first so a reviewer sees breakage immediately.
 */
const TestsTab = memo(function TestsTab({ tests }: { tests: ClaudeCodeTestResultEvent[] }) {
  if (tests.length === 0) {
    return (
      <PanelEmpty
        testId="cc-tests-empty"
        icon="i-ph:test-tube-duotone"
        title="No test results yet"
        description="Test runs from Claude Code — pass/fail counts and any failing names — appear here."
      />
    );
  }

  const passed = tests.filter((t) => t.passed).length;
  const failed = tests.length - passed;
  // Failing tests first — the reviewer's eye should land on breakage.
  const ordered = [...tests].sort((a, b) => Number(a.passed) - Number(b.passed));

  return (
    <div className="flex flex-col gap-2 p-4">
      <div data-testid="cc-tests-summary" className="flex items-center gap-3 text-[12px]">
        <span className="font-semibold text-bolt-elements-textPrimary">
          {tests.length} {tests.length === 1 ? 'test' : 'tests'}
        </span>
        <span className="inline-flex items-center gap-1 text-green-500">
          <span className="i-ph:check-circle-duotone" aria-hidden="true" />
          {passed} passed
        </span>
        {failed > 0 && (
          <span className="inline-flex items-center gap-1 text-red-500">
            <span className="i-ph:x-circle-duotone" aria-hidden="true" />
            {failed} failed
          </span>
        )}
      </div>

      <ul data-testid="cc-tests-list" className="flex flex-col gap-1.5">
        {ordered.map((test, index) => (
          <li
            key={`${test.name}-${index}`}
            data-testid={`cc-test-${index}`}
            data-passed={test.passed}
            className="flex items-start gap-2.5 rounded-lg border border-bolt-elements-borderColor/60 bg-bolt-elements-background-depth-2 px-3 py-2"
          >
            <span
              className={classNames(
                'mt-0.5 text-base',
                test.passed ? 'i-ph:check-circle-duotone text-green-500' : 'i-ph:x-circle-duotone text-red-500',
              )}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1">
              <span className="block break-words text-[13px] leading-snug text-bolt-elements-textPrimary">
                {test.name}
              </span>
              {test.summary != null && test.summary !== '' && (
                <span className="mt-0.5 block break-words text-[11px] leading-snug text-bolt-elements-textTertiary">
                  {test.summary}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
});

/** Per-deploy-state glyph + tint for the Deploy tab's latest-status hero. */
const DEPLOY_META: Record<ClaudeCodeDeployStateEvent['state'], { label: string; icon: string; className: string }> = {
  idle: { label: 'Idle', icon: 'i-ph:circle-dashed-duotone', className: 'text-bolt-elements-textTertiary' },
  building: {
    label: 'Building',
    icon: 'i-ph:circle-notch-duotone',
    className: 'text-bolt-elements-item-contentAccent',
  },
  deploying: {
    label: 'Deploying',
    icon: 'i-ph:cloud-arrow-up-duotone',
    className: 'text-bolt-elements-item-contentAccent',
  },
  deployed: { label: 'Deployed', icon: 'i-ph:check-circle-duotone', className: 'text-green-500' },
  failed: { label: 'Failed', icon: 'i-ph:warning-circle-duotone', className: 'text-red-500' },
};

/**
 * S4 — the Deploy tab. Shows the LATEST `deploy_state` as a status hero, plus the transition
 * history beneath it (most-recent first) so a reviewer sees how the pipeline got here.
 */
const DeployTab = memo(function DeployTab({ deploys }: { deploys: ClaudeCodeDeployStateEvent[] }) {
  if (deploys.length === 0) {
    return (
      <PanelEmpty
        testId="cc-deploy-empty"
        icon="i-ph:rocket-launch-duotone"
        title="No deploys yet"
        description="When Claude Code ships your change, the live deploy status appears here."
      />
    );
  }

  const latest = deploys[deploys.length - 1];
  const latestMeta = DEPLOY_META[latest.state];
  const history = [...deploys].reverse();

  return (
    <div className="flex flex-col gap-3 p-4">
      <div
        data-testid="cc-deploy-latest"
        data-state={latest.state}
        className="flex items-center gap-3 rounded-xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-4 py-3"
      >
        <span className={classNames(latestMeta.icon, 'text-2xl', latestMeta.className)} aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className={classNames('block text-sm font-semibold', latestMeta.className)}>{latestMeta.label}</span>
          {latest.detail != null && latest.detail !== '' && (
            <span className="mt-0.5 block break-words text-[11px] text-bolt-elements-textTertiary">
              {latest.detail}
            </span>
          )}
        </span>
      </div>

      {history.length > 1 && (
        <ul data-testid="cc-deploy-history" className="flex flex-col gap-1">
          {history.map((deploy, index) => {
            const meta = DEPLOY_META[deploy.state];

            return (
              <li
                key={index}
                className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[11px] text-bolt-elements-textSecondary"
              >
                <span className={classNames(meta.icon, 'text-sm', meta.className)} aria-hidden="true" />
                <span className="font-medium text-bolt-elements-textPrimary">{meta.label}</span>
                {deploy.detail != null && deploy.detail !== '' && (
                  <span className="truncate text-bolt-elements-textTertiary">{deploy.detail}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
});

/**
 * S5 — the CURRENT-TASK affordance that lives in the {@link PanelHeader} `actions` slot
 * (directive §25). While running it shows the active prompt summary + a live status (spinner /
 * check / x / "stopped") and a Stop control; in a terminal state it shows the final status pill
 * (no Stop). At idle it renders nothing — the header stays clean. The status line is
 * `aria-live="polite"` so a screen reader hears "Running → Done" without a focus change, and the
 * spinner is `motion-reduce:animate-none` (reduced-motion-safe, matching the panel spine).
 */
const CurrentTask = memo(function CurrentTask({ run, onStop }: { run: RunState; onStop: () => void }) {
  if (run.status === 'idle') {
    return null;
  }

  const meta = RUN_STATUS_META[run.status];
  const isRunning = run.status === 'running';

  return (
    <div data-testid="cc-current-task" data-status={run.status} className="flex items-center gap-2">
      {/* The active prompt summary — the "current task" (hidden on the narrowest widths). */}
      {run.promptSummary != null && (
        <span
          data-testid="cc-current-task-summary"
          title={run.promptSummary}
          className="hidden max-w-[220px] truncate text-[11px] text-bolt-elements-textSecondary sm:inline"
        >
          {run.promptSummary}
        </span>
      )}

      {/* Live status pill — announced politely; glyph spins only while running + motion is allowed. */}
      <span
        role="status"
        aria-live="polite"
        data-testid="cc-run-status"
        data-status={run.status}
        className={classNames(
          'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
          'border-current/25 bg-current/[0.08]',
          meta.className,
        )}
      >
        <span
          className={classNames(meta.icon, 'text-sm', meta.spin && 'animate-spin motion-reduce:animate-none')}
          aria-hidden="true"
        />
        {meta.label}
      </span>

      {/* Stop/cancel — only while in-flight. Aborts the stream via the panel's AbortController. */}
      {isRunning && (
        <button
          type="button"
          data-testid="cc-stop-button"
          onClick={onStop}
          aria-label="Stop the current Claude Code run"
          className={classNames(
            'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold transition-colors',
            'border border-bolt-elements-borderColor text-bolt-elements-textSecondary',
            'hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-500',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40',
          )}
        >
          <span className="i-ph:stop-circle-bold text-sm" aria-hidden="true" />
          Stop
        </button>
      )}
    </div>
  );
});

/**
 * S5 — one Activity TIMELINE beat (started → streaming → finished/failed/cancelled), stamped with
 * a relative time from the run's first beat. Interleaved with the event rows so the run reads as a
 * living story (directive §29 — delightful coding activity), not a flat log.
 */
const TimelineRow = memo(function TimelineRow({
  transition,
  startedAt,
}: {
  transition: RunTransition;
  startedAt: number;
}) {
  const meta = RUN_PHASE_META[transition.phase];

  return (
    <li
      data-testid={`cc-timeline-${transition.phase}`}
      data-phase={transition.phase}
      className="flex items-center gap-2.5 rounded-lg border border-dashed border-bolt-elements-borderColor/70 bg-bolt-elements-background-depth-1 px-3 py-1.5"
    >
      <span className={classNames(meta.icon, 'shrink-0 text-base', meta.className)} aria-hidden="true" />
      <span className="min-w-0 flex-1 text-[12px] font-medium text-bolt-elements-textSecondary">
        {meta.label}
        {transition.detail != null && transition.detail !== '' && transition.phase !== 'started' && (
          <span className="ml-1.5 font-normal text-bolt-elements-textTertiary">— {transition.detail}</span>
        )}
      </span>
      <span className="shrink-0 text-[10px] tabular-nums text-bolt-elements-textTertiary">
        {formatRelative(transition.at - startedAt)}
      </span>
    </li>
  );
});

/** The run path: Single = stream `/api/llmcall`; Resolution = POST `/api/resolve` (dual research). */
type RunMode = 'single' | 'resolution';

/** Whether Resolution mode is reachable: unknown until first probed, then on (flag live) / off (404). */
type ResolutionAvailability = 'unknown' | 'available' | 'unavailable';

/** The two mode segments. Single is always first + the default; Resolution gates on the flag. */
const MODE_ITEMS: ReadonlyArray<{ id: RunMode; label: string; icon: string; hint: string }> = [
  {
    id: 'single',
    label: 'Single',
    icon: 'i-ph:chat-circle-dots-duotone',
    hint: 'One provider answers directly.',
  },
  {
    id: 'resolution',
    label: 'Resolution',
    icon: 'i-ph:intersect-duotone',
    hint: 'Two providers research in parallel, then Claude synthesizes the best combined answer.',
  },
];

/**
 * S6-b-ii — the "Single | Resolution" mode toggle in the {@link PanelHeader} `toolbar` slot. A
 * real radio group (`role="radiogroup"` + `role="radio"` + `aria-checked`) so a screen reader
 * announces the choice; black+cyan, AA, and reduced-motion-safe (`motion-reduce:transition-none`,
 * matching the panel spine). When Resolution is `unavailable` (the `resolution_engine` flag is
 * dark → `/api/resolve` 404) the Resolution segment is DISABLED with an explanatory `title`
 * tooltip + `aria-disabled` — never an error, never a doomed control that errors on click.
 */
const ModeToggle = memo(function ModeToggle({
  mode,
  onSelect,
  resolutionAvailability,
  disabled,
}: {
  mode: RunMode;
  onSelect: (mode: RunMode) => void;
  resolutionAvailability: ResolutionAvailability;
  /** True while a run is in flight — the mode can't change mid-run. */
  disabled: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Claude Code run mode"
      data-testid="cc-mode-toggle"
      data-mode={mode}
      className="inline-flex items-center gap-0.5 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-0.5"
    >
      {MODE_ITEMS.map((item) => {
        const isActive = item.id === mode;
        // Resolution is only clickable once PROVEN available; `unknown` stays clickable (optimistic —
        // the probe happens on first run and downgrades to Single + disabled if it 404s).
        const modeUnavailable = item.id === 'resolution' && resolutionAvailability === 'unavailable';
        const isDisabled = disabled || modeUnavailable;
        const title = modeUnavailable
          ? 'Resolution mode is unavailable right now. Single mode is ready to use.'
          : item.hint;

        return (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={isActive}
            aria-disabled={isDisabled || undefined}
            disabled={isDisabled}
            title={title}
            data-testid={`cc-mode-${item.id}`}
            data-active={isActive}
            onClick={() => {
              if (!isDisabled) {
                onSelect(item.id);
              }
            }}
            className={classNames(
              'inline-flex min-h-[24px] items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors duration-150 motion-reduce:transition-none',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent/50',
              isActive
                ? 'bg-bolt-elements-item-contentAccent/[0.14] text-bolt-elements-item-contentAccent ring-1 ring-bolt-elements-item-contentAccent/30'
                : 'text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary',
              isDisabled && 'cursor-not-allowed opacity-50 hover:text-bolt-elements-textSecondary',
            )}
          >
            <span className={classNames(item.icon, 'text-sm')} aria-hidden="true" />
            {item.label}
          </button>
        );
      })}
    </div>
  );
});

/**
 * One Research leg — a collapsible `<details>` labelled with its provider + model. An OK leg opens
 * by default (the reviewer should see the research); a DOWN leg (provider errored/unconfigured)
 * renders a calm "unavailable" note with its safe reason instead of content — NOT an error row.
 * Native `<details>`/`<summary>` keeps it keyboard + screen-reader accessible for free.
 */
const ResearchLeg = memo(function ResearchLeg({ leg, index }: { leg: ResolveResearchLeg; index: number }) {
  const label = providerLabel(leg.provider);

  return (
    <details
      data-testid={`cc-research-leg-${index}`}
      data-provider={leg.provider}
      data-ok={leg.ok}
      open={leg.ok}
      className="group rounded-lg border border-bolt-elements-borderColor/60 bg-bolt-elements-background-depth-2"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent/40">
        <span
          className="i-ph:caret-right-bold shrink-0 text-[11px] text-bolt-elements-textTertiary transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none"
          aria-hidden="true"
        />
        <span className="inline-flex items-center gap-1.5 rounded-md border border-bolt-elements-item-contentAccent/25 bg-bolt-elements-item-contentAccent/[0.08] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-bolt-elements-item-contentAccent">
          <span className="i-ph:flask-duotone text-sm" aria-hidden="true" />
          Research {index + 1}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium text-bolt-elements-textPrimary">{label}</span>
        {leg.ok ? (
          leg.model !== '' && (
            <code className="shrink-0 truncate text-[10px] text-bolt-elements-textTertiary">{leg.model}</code>
          )
        ) : (
          <span className="shrink-0 rounded-md border border-bolt-elements-textTertiary/30 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-bolt-elements-textTertiary">
            Unavailable
          </span>
        )}
      </summary>
      <div className="border-t border-bolt-elements-borderColor/60 px-3 py-2.5">
        {leg.ok ? (
          <p className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-bolt-elements-textSecondary">
            {leg.content}
          </p>
        ) : (
          <p className="text-[12px] leading-relaxed text-bolt-elements-textTertiary">
            This provider was unavailable for this run. {leg.reason}
          </p>
        )}
      </div>
    </details>
  );
});

/**
 * The Resolution render — the two Research legs (collapsible) above an emphasized Synthesis card.
 * When `synthesis.ok === false` the legs still render and the Synthesis slot shows a CALM
 * "synthesis unavailable" note (reason included) — the research is valuable and the panel invites a
 * retry, so this is NEVER an error state (directive: a down synthesis is non-fatal).
 */
const ResolutionView = memo(function ResolutionView({ result }: { result: ResolveResult }) {
  return (
    <div data-testid="cc-resolution" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      {/* Research — the two independent legs. */}
      <section aria-label="Research" className="flex flex-col gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-bolt-elements-textTertiary">Research</h3>
        {result.research.length === 0 ? (
          <p data-testid="cc-research-empty" className="text-[12px] text-bolt-elements-textTertiary">
            No research legs were returned for this run.
          </p>
        ) : (
          <div data-testid="cc-research-legs" className="flex flex-col gap-2">
            {result.research.map((leg, index) => (
              <ResearchLeg key={`${leg.provider}-${index}`} leg={leg} index={index} />
            ))}
          </div>
        )}
      </section>

      {/* Synthesis — the emphasized combined answer, or a calm unavailable note. */}
      <section aria-label="Synthesis" className="flex flex-col gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-bolt-elements-item-contentAccent">
          Synthesis
        </h3>
        {result.synthesis.ok ? (
          <div
            data-testid="cc-synthesis"
            data-ok="true"
            className="rounded-xl border border-bolt-elements-item-contentAccent/30 bg-bolt-elements-item-contentAccent/[0.06] px-4 py-3"
          >
            <div className="mb-1.5 flex items-center gap-2 text-[11px] text-bolt-elements-textTertiary">
              <span className="i-ph:sparkle-duotone text-sm text-bolt-elements-item-contentAccent" aria-hidden="true" />
              <span className="font-semibold text-bolt-elements-item-contentAccent">
                {providerLabel(result.synthesis.provider)}
              </span>
              {result.synthesis.model !== '' && <code className="truncate">{result.synthesis.model}</code>}
            </div>
            <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-bolt-elements-textPrimary">
              {result.synthesis.content}
            </p>
          </div>
        ) : (
          <div
            data-testid="cc-synthesis-unavailable"
            data-ok="false"
            className="flex items-start gap-2.5 rounded-xl border border-dashed border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-4 py-3"
          >
            <span
              className="i-ph:info-duotone mt-0.5 shrink-0 text-base text-bolt-elements-textSecondary"
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] font-semibold text-bolt-elements-textSecondary">
                Synthesis unavailable
              </span>
              <span className="mt-0.5 block break-words text-[11px] leading-snug text-bolt-elements-textTertiary">
                The research above is ready — combining it into one answer didn't complete this time. You can run it
                again. {result.synthesis.reason}
              </span>
            </span>
          </div>
        )}
      </section>
    </div>
  );
});

export interface ClaudeCodePanelProps {
  /** Override the panel root's `data-testid` (defaults to `claude-code-panel`). */
  testId?: string;
}

/**
 * The embedded Claude Code panel. Self-contained + spine-composed; owns its own prompt/stream
 * state and applies edits through the shared `workbenchStore` (the ONE WebContainer).
 */
export const ClaudeCodePanel = memo(function ClaudeCodePanel({ testId }: ClaudeCodePanelProps) {
  const [activeTab, setActiveTab] = useState<NavId>('activity');
  const [mode, setMode] = useState<RunMode>('single');
  const [prompt, setPrompt] = useState('');
  const [events, setEvents] = useState<ClaudeCodeEvent[]>([]);
  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  // Resolution mode availability — `unknown` until first probed; a `/api/resolve` 404 (the
  // `resolution_engine` flag is dark) downgrades it to `unavailable` → the toggle disables.
  const [resolutionAvailability, setResolutionAvailability] = useState<ResolutionAvailability>('unknown');
  // The parsed `/api/resolve` result (two research legs + a synthesis) for Resolution mode. `null`
  // until a Resolution run completes; cleared when a new run starts.
  const [resolution, setResolution] = useState<ResolveResult | null>(null);
  // The typed RUN-LIFECYCLE machine (idle → running → done | error | cancelled). Pure reducer in
  // `claude-code-run.ts`; the panel only dispatches at the fetch/stream boundary.
  const [run_, dispatch] = useReducer(runReducer, initialRunState);
  const abortRef = useRef<AbortController | null>(null);

  const running = run_.status === 'running';
  const error = run_.errorMessage;

  // Project the single event stream into the per-tab views (the brief's S2/S3/S4 render already-
  // defined events — no new fetches). Recomputed only when `events` changes.
  const fileEvents = useMemo(
    () => events.filter((e): e is ClaudeCodeFileTouchedEvent => e.kind === 'file_touched'),
    [events],
  );
  const testEvents = useMemo(
    () => events.filter((e): e is ClaudeCodeTestResultEvent => e.kind === 'test_result'),
    [events],
  );
  const deployEvents = useMemo(
    () => events.filter((e): e is ClaudeCodeDeployStateEvent => e.kind === 'deploy_state'),
    [events],
  );

  /**
   * POST the prompt to the existing /api/llmcall streaming path, map the stream to events, and
   * drive the run-lifecycle machine (start → streaming → finish | fail). A cancel is handled by the
   * AbortController (see {@link stop}): an `AbortError` is swallowed here because the machine was
   * ALREADY moved to `cancelled` by the stop handler, and — crucially — once aborted this loop
   * stops pushing events, so nothing further renders.
   */
  const run = useCallback(
    async (text: string) => {
      const trimmed = text.trim();

      if (trimmed === '' || running) {
        return;
      }

      setEvents([]);
      setResolution(null);
      setSelectedFileIndex(0);

      const controller = new AbortController();
      abortRef.current = controller;
      dispatch({ type: 'start', summary: summarizePrompt(trimmed), at: Date.now() });

      try {
        const res = await fetch('/api/llmcall', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            system: CLAUDE_CODE_SYSTEM,
            message: trimmed,
            model: DEFAULT_MODEL,
            provider: DEFAULT_PROVIDER,
            streamOutput: true,
          }),
        });

        if (!res.ok || !res.body) {
          throw new Error(`Claude Code is unavailable (HTTP ${res.status}).`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const collected: ClaudeCodeEvent[] = [];

        // Read the stream chunk-by-chunk; parse COMPLETE lines so a half-line never mis-parses.
        while (true) {
          const { value, done } = await reader.read();

          if (done) {
            break;
          }

          // A cancel aborts mid-read: stop consuming + rendering immediately (the machine is already
          // in `cancelled`; pushing more events would contradict the "stopped" status the user sees).
          if (controller.signal.aborted) {
            return;
          }

          dispatch({ type: 'streaming', at: Date.now() });

          buffer += decoder.decode(value, { stream: true });

          const newlineIdx = buffer.lastIndexOf('\n');

          if (newlineIdx === -1) {
            continue;
          }

          const ready = buffer.slice(0, newlineIdx);
          buffer = buffer.slice(newlineIdx + 1);

          const parsed = parseClaudeCodeStream(ready);

          if (parsed.length > 0) {
            collected.push(...parsed);
            setEvents([...collected]);
          }
        }

        // Flush any trailing partial line.
        const tail = parseClaudeCodeStream(buffer);

        if (tail.length > 0) {
          collected.push(...tail);
          setEvents([...collected]);
        }

        dispatch({ type: 'finish', at: Date.now() });
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') {
          // The stop handler already transitioned the machine to `cancelled`.
          return;
        }

        dispatch({
          type: 'fail',
          message: err instanceof Error ? err.message : 'Claude Code could not complete the run.',
          at: Date.now(),
        });
      } finally {
        abortRef.current = null;
      }
    },
    [running],
  );

  /**
   * S6-b-ii — the RESOLUTION run. POSTs `/api/resolve {prompt}` ONCE (dual-provider research →
   * Claude synthesis) and reuses the SAME S5 run-lifecycle machine (start → finish | fail) and the
   * SAME AbortController/Stop wiring as Single mode. Not a stream: one request, one structured body.
   *
   * Flag-off handling: a **404** means the `resolution_engine` flag is dark → Resolution mode is
   * unavailable. We mark it `unavailable` (the toggle disables with a tooltip), snap back to Single
   * mode, and `reset` the lifecycle to idle — NEVER an error toast (a dark feature isn't a failure).
   * A `synthesis.ok===false` body is NON-fatal: the research legs still render with a calm note.
   */
  const runResolution = useCallback(
    async (text: string) => {
      const trimmed = text.trim();

      if (trimmed === '' || running) {
        return;
      }

      setEvents([]);
      setResolution(null);
      setSelectedFileIndex(0);

      const controller = new AbortController();
      abortRef.current = controller;
      dispatch({ type: 'start', summary: summarizePrompt(trimmed), at: Date.now() });

      try {
        const res = await fetch('/api/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({ prompt: trimmed }),
        });

        // Flag-off (DARK): 404 → Resolution unavailable. Downgrade calmly, drop back to Single, and
        // return the machine to idle — this is NOT an error the user should see as a failure.
        if (res.status === 404) {
          setResolutionAvailability('unavailable');
          setMode('single');
          dispatch({ type: 'reset' });

          return;
        }

        if (!res.ok) {
          throw new Error(`Resolution is unavailable (HTTP ${res.status}).`);
        }

        // Reaching a 200 proves the flag is live — mark it available for the toggle.
        setResolutionAvailability('available');

        const body = (await res.json()) as unknown;

        // A cancel may have landed while awaiting the body — don't render a stale result.
        if (controller.signal.aborted) {
          return;
        }

        setResolution(parseResolveResult(body));
        dispatch({ type: 'finish', at: Date.now() });
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') {
          // The stop handler already transitioned the machine to `cancelled`.
          return;
        }

        dispatch({
          type: 'fail',
          message: err instanceof Error ? err.message : 'Resolution could not complete the run.',
          at: Date.now(),
        });
      } finally {
        abortRef.current = null;
      }
    },
    [running],
  );

  /** Route a submit to the active mode's runner (Single streams `/api/llmcall`; Resolution POSTs `/api/resolve`). */
  const start = useCallback(
    (text: string) => {
      if (mode === 'resolution') {
        void runResolution(text);
      } else {
        void run(text);
      }
    },
    [mode, run, runResolution],
  );

  /**
   * Stop/cancel the in-flight run: abort the active request via the AbortController and move the
   * machine to `cancelled`. The reducer makes `cancel` a no-op unless running, so a stray click is
   * harmless; the Single `run` loop sees `signal.aborted` and stops rendering further events, and
   * the Resolution run bails before setting a stale result.
   */
  const stop = useCallback(() => {
    dispatch({ type: 'cancel', at: Date.now() });
    abortRef.current?.abort();
  }, []);

  const onSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      start(prompt);
    },
    [start, prompt],
  );

  /**
   * Apply ONE file edit through the EXISTING workbench mechanism — `workbenchStore.createFile()`,
   * the same rail `<boltAction type="file">` drives (the ONE WebContainer). This proves the
   * panel writes into the canonical workspace, not a parallel filesystem. It also seeds the
   * Activity log from the deterministic sample so the surface is never an empty demo.
   */
  const applySampleEdit = useCallback(async () => {
    dispatch({ type: 'reset' });
    setSelectedFileIndex(0);
    setEvents(parseClaudeCodeStream(SAMPLE_ACTIVITY_STREAM));

    try {
      await workbenchStore.createFile(
        'CLAUDE_CODE_SAMPLE.md',
        '# Claude Code sample edit\n\nWritten by the embedded Claude Code panel through the shared workbench (one WebContainer).\n',
      );
    } catch {
      // The sample edit is a best-effort demo seed; a workbench hiccup shouldn't surface as a run
      // error (the run machine is idle here). The Activity log still shows the seeded events.
    }
  }, []);

  const hasEvents = events.length > 0;
  // The Activity tab is a launchpad ONLY when truly idle with nothing seeded; once a run starts (a
  // timeline beat exists) OR events are seeded, it shows the living timeline + event rows.
  const hasActivity = hasEvents || run_.timeline.length > 0;
  const startedAt = run_.timeline[0]?.at ?? 0;

  // Split the lifecycle beats: the opening `started` renders at the TOP of the Activity log; the
  // later beats (streaming / finished / failed / cancelled) render at the BOTTOM, after the event
  // rows — so the run reads as a story (started → what it did → how it ended).
  const [openingBeat, ...laterBeats] = run_.timeline;

  return (
    <PanelShell testId={testId ?? 'claude-code-panel'}>
      <PanelHeader
        icon="i-ph:sparkle-duotone"
        title="Claude Code"
        subtitle="Agentic edits in your workspace — actions, decisions, and evidence (never private reasoning)"
        actions={<CurrentTask run={run_} onStop={stop} />}
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <PanelSegmentedNav
              testId="cc-subnav"
              ariaLabel="Claude Code views"
              activeId={activeTab}
              onSelect={(id) => setActiveTab(id as NavId)}
              items={NAV_ITEMS.map((i) => ({ id: i.id, label: i.label, icon: i.icon }))}
            />
            {/* Single | Resolution mode toggle — disabled for Resolution when the flag is dark. */}
            <ModeToggle
              mode={mode}
              onSelect={setMode}
              resolutionAvailability={resolutionAvailability}
              disabled={running}
            />
          </div>
        }
      />

      {/* Prompt composer — the ONE obvious primary action. Always visible so the surface is a
          launchpad, not a dead wall. */}
      <form
        onSubmit={onSubmit}
        className="shrink-0 border-b border-bolt-elements-borderColor px-4 py-3"
        data-testid="cc-prompt-form"
      >
        <label htmlFor="cc-prompt" className="mb-1.5 block text-[11px] font-medium text-bolt-elements-textSecondary">
          {mode === 'resolution'
            ? 'Ask a research question — two providers research it, then Claude synthesizes'
            : 'Ask Claude Code to change your site'}
        </label>
        <div className="flex items-end gap-2">
          <textarea
            id="cc-prompt"
            data-testid="cc-prompt-input"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                start(prompt);
              }
            }}
            rows={2}
            placeholder="e.g. Add a bold hero headline to the homepage"
            disabled={running}
            className="min-h-[2.5rem] flex-1 resize-y rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-3 py-2 text-[13px] text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:border-bolt-elements-item-contentAccent/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent/40 disabled:opacity-60"
          />
          <button
            type="submit"
            data-testid="cc-run-button"
            disabled={running || prompt.trim() === ''}
            className={classNames(
              'inline-flex h-10 items-center gap-1.5 rounded-lg px-4 text-sm font-semibold transition-colors',
              'bg-bolt-elements-item-contentAccent/[0.12] text-bolt-elements-item-contentAccent',
              'border border-bolt-elements-item-contentAccent/30 hover:bg-bolt-elements-item-contentAccent/20',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent/50',
              'disabled:cursor-not-allowed disabled:opacity-50',
            )}
          >
            <span className="i-ph:paper-plane-tilt-duotone text-base" aria-hidden="true" />
            {running ? 'Running…' : 'Run'}
          </button>
        </div>
        {error != null && (
          <p data-testid="cc-error" role="alert" className="mt-2 text-[11px] text-bolt-elements-icon-error">
            {error}
          </p>
        )}
      </form>

      {/* Body — Activity runs Claude Code; Files/Tests/Deploy project the stream into review views. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {activeTab === 'files' ? (
          <FilesTab files={fileEvents} selectedIndex={selectedFileIndex} onSelect={setSelectedFileIndex} />
        ) : activeTab === 'tests' ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <TestsTab tests={testEvents} />
          </div>
        ) : activeTab === 'deploy' ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <DeployTab deploys={deployEvents} />
          </div>
        ) : mode === 'resolution' && resolution != null ? (
          // Resolution mode finished — the two research legs + the emphasized synthesis (reusing the
          // same Activity surface Single mode uses). A down synthesis renders a calm note, not an error.
          <ResolutionView result={resolution} />
        ) : running && !hasActivity ? (
          <PanelLoading
            testId="cc-loading"
            label={mode === 'resolution' ? 'Researching with two providers, then synthesizing…' : 'Claude Code is working…'}
          />
        ) : hasActivity ? (
          <ul data-testid="cc-activity-list" className="min-h-0 flex-1 overflow-y-auto flex flex-col gap-1.5 p-4">
            {/* Opening lifecycle beat (Run started) — the top of the story. */}
            {openingBeat != null && <TimelineRow transition={openingBeat} startedAt={startedAt} />}

            {/* What Claude Code did — the stream's concrete event rows (never CoT). */}
            {events.map((event, index) => (
              <ActivityRow key={index} event={event} index={index} />
            ))}

            {/* Closing lifecycle beats (streaming / finished / failed / cancelled) — how it ended. */}
            {laterBeats.map((transition) => (
              <TimelineRow key={transition.phase} transition={transition} startedAt={startedAt} />
            ))}
          </ul>
        ) : (
          <PanelEmpty
            testId="cc-empty"
            icon="i-ph:sparkle-duotone"
            title="Describe a change to start"
            description="Type what you want changed above and press Run. Its actions, decisions, and file edits stream here live — never its private reasoning."
            action={
              <button
                type="button"
                data-testid="cc-apply-sample"
                onClick={() => void applySampleEdit()}
                className={classNames(
                  'inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors',
                  'bg-bolt-elements-item-contentAccent/[0.12] text-bolt-elements-item-contentAccent',
                  'border border-bolt-elements-item-contentAccent/30 hover:bg-bolt-elements-item-contentAccent/20',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent/50',
                )}
              >
                <span className="i-ph:file-plus-duotone text-sm" aria-hidden="true" />
                Apply a sample edit
              </button>
            }
          />
        )}
      </div>
    </PanelShell>
  );
});
