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
 * Deferred (per the WLK-39 plan in BACKLOG.md): the LIVE WebContainer end-to-end proof
 * (edit → Preview reflects) is browser follow-on S7; files-touched diff (S2), tests (S3),
 * deploy-state (S4), subagents (S5), and the dual-provider research→synthesis core (S6) are later
 * slices. This slice's bar is unit + build proof.
 */
import { memo, useCallback, useRef, useState, type FormEvent } from 'react';
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '~/utils/constants';
import { workbenchStore } from '~/lib/stores/workbench';
import { classNames } from '~/utils/classNames';
import { PanelShell, PanelHeader, PanelLoading, PanelEmpty, PanelSegmentedNav } from './panel';
import { parseClaudeCodeStream, type ClaudeCodeEvent } from './claude-code-stream';

/** The panel's sub-nav. Activity ships first (S1); Files/Tests/Deploy arrive in S2-S4. */
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
  '{"kind":"file_touched","path":"src/App.tsx","change":"edit"}',
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
  const [prompt, setPrompt] = useState('');
  const [events, setEvents] = useState<ClaudeCodeEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  /** POST the prompt to the existing /api/llmcall streaming path and map the stream to events. */
  const run = useCallback(
    async (text: string) => {
      const trimmed = text.trim();

      if (trimmed === '' || running) {
        return;
      }

      setRunning(true);
      setError(null);
      setEvents([]);

      const controller = new AbortController();
      abortRef.current = controller;

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
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') {
          return;
        }

        setError(err instanceof Error ? err.message : 'Claude Code could not complete the run.');
      } finally {
        setRunning(false);
        abortRef.current = null;
      }
    },
    [running],
  );

  const onSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      void run(prompt);
    },
    [run, prompt],
  );

  /**
   * Apply ONE file edit through the EXISTING workbench mechanism — `workbenchStore.createFile()`,
   * the same rail `<boltAction type="file">` drives (the ONE WebContainer). This proves the
   * panel writes into the canonical workspace, not a parallel filesystem. It also seeds the
   * Activity log from the deterministic sample so the surface is never an empty demo.
   */
  const applySampleEdit = useCallback(async () => {
    setError(null);
    setEvents(parseClaudeCodeStream(SAMPLE_ACTIVITY_STREAM));

    try {
      await workbenchStore.createFile(
        'CLAUDE_CODE_SAMPLE.md',
        '# Claude Code sample edit\n\nWritten by the embedded Claude Code panel through the shared workbench (one WebContainer).\n',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not apply the sample edit.');
    }
  }, []);

  const hasEvents = events.length > 0;

  return (
    <PanelShell testId={testId ?? 'claude-code-panel'}>
      <PanelHeader
        icon="i-ph:sparkle-duotone"
        title="Claude Code"
        subtitle="Agentic edits in your workspace — actions, decisions, and evidence (never private reasoning)"
        toolbar={
          <PanelSegmentedNav
            testId="cc-subnav"
            ariaLabel="Claude Code views"
            activeId={activeTab}
            onSelect={(id) => setActiveTab(id as NavId)}
            items={NAV_ITEMS.map((i) => ({ id: i.id, label: i.label, icon: i.icon }))}
          />
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
          Ask Claude Code to change your site
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
                void run(prompt);
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

      {/* Body — Activity is the only wired tab this slice; the rest preview the roadmap. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {activeTab !== 'activity' ? (
          <PanelEmpty
            testId="cc-tab-coming-soon"
            icon="i-ph:traffic-cone-duotone"
            title={`${NAV_ITEMS.find((i) => i.id === activeTab)?.label ?? 'This view'} is coming soon`}
            description="Files diff, test results, and deploy state land in the next slices. Use Activity to run Claude Code now."
          />
        ) : running && !hasEvents ? (
          <PanelLoading testId="cc-loading" label="Claude Code is working…" />
        ) : hasEvents ? (
          <ul data-testid="cc-activity-list" className="flex flex-col gap-1.5 p-4">
            {events.map((event, index) => (
              <ActivityRow key={index} event={event} index={index} />
            ))}
          </ul>
        ) : (
          <PanelEmpty
            testId="cc-empty"
            icon="i-ph:sparkle-duotone"
            title="Run Claude Code on your site"
            description="Describe a change above and press Run. Its actions, decisions, and file edits stream here — never its private reasoning."
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
