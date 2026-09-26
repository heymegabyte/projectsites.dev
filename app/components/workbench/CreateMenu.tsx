/**
 * CreateMenu.tsx — the "Create" control that sits in the workbench top strip
 * beside Code / Preview / Functions / Data.
 *
 * A ProjectSites project is an R2-backed git repo, so every creation action here
 * == writing the right starter FILE(S) into the project. The menu offers grouped
 * one-click actions (Add Function / API Endpoint / Schedule Job / Workflow /
 * Templates) plus a "Describe what you want to build…" field that classifies a
 * natural-language request into a typed intent and scaffolds it — all through the
 * pure, tested {@link classifyIntent} / {@link scaffoldForIntent} seam
 * (`~/lib/workbench/create-intents`). Files land via `workbenchStore.createFile`
 * and open in the editor. Classification is kept separate from execution; the
 * AI-Gateway upgrade (model-routed NL→plan) can replace the classifier later
 * without touching the scaffolders. Keyboard/ARIA/Escape come from Radix.
 */
import { memo, useCallback, useState } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { Dropdown, DropdownItem, DropdownSeparator } from '~/components/ui/Dropdown';
import { Dialog, DialogTitle, DialogDescription, DialogButton } from '~/components/ui/Dialog';
import { workbenchStore } from '~/lib/stores/workbench';
import { WORK_DIR } from '~/utils/constants';
import { classNames } from '~/utils/classNames';
import {
  classifyIntent,
  scaffoldForIntent,
  CREATE_TEMPLATES,
  type CreateIntent,
  type ScaffoldResult,
} from '~/lib/workbench/create-intents';

/** Lightweight structured analytics (console.log is blocked; warn carries JSON). */
function track(event: string, props: Record<string, unknown> = {}): void {
  try {
    console.warn(`[create-menu] ${JSON.stringify({ event, ...props })}`);
  } catch {
    /* never let analytics throw into the UI */
  }
}

const AI_EXAMPLES = [
  'Create a contact-form endpoint that validates input and sends an email.',
  'Run a sitemap refresh every night at 2 AM.',
  'Create a workflow that publishes approved pages and purges the cache.',
];

interface CreateMenuProps {
  className?: string;
}

export const CreateMenu = memo(({ className }: CreateMenuProps) => {
  const [aiOpen, setAiOpen] = useState(false);
  const [aiText, setAiText] = useState('');
  const [plan, setPlan] = useState<ScaffoldResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('');

  /** Write the scaffold's file(s) into the project and open the primary one. */
  const runScaffold = useCallback(async (result: ScaffoldResult) => {
    setBusy(true);
    setError(null);
    setStatus(`Creating ${result.intent.kind}…`);

    try {
      for (const f of result.files) {
        const full = `${WORK_DIR}/${f.path.replace(/^\/+/, '')}`;
        const ok = await workbenchStore.createFile(full, f.content);

        if (!ok) {
          throw new Error(`Could not create ${f.path} (it may already exist — open it from the file tree).`);
        }
      }

      // Show the new file in the code editor.
      workbenchStore.currentView.set('code');
      setStatus(`Created ${result.openPath}`);
      track('create.success', {
        kind: result.intent.kind,
        files: result.files.map((f) => f.path),
        openPath: result.openPath,
      });

      // Close the dialog shortly after success so the status is readable.
      setAiOpen(false);
      setPlan(null);
      setAiText('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Creation failed.';
      setError(msg);
      setStatus('');
      track('create.failure', { kind: result.intent.kind, error: msg });
    } finally {
      setBusy(false);
    }
  }, []);

  /** One-click manual action → scaffold a sensible default for that kind. */
  const quickCreate = useCallback(
    (intent: CreateIntent) => {
      track('create.menu.action', { kind: intent.kind, source: 'menu' });

      try {
        void runScaffold(scaffoldForIntent(intent));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not scaffold.');
      }
    },
    [runScaffold],
  );

  /** AI field → classify the request into a typed intent + show a plan preview. */
  const previewFromText = useCallback(() => {
    const text = aiText.trim();

    if (!text) {
      return;
    }

    track('create.ai.submit', { length: text.length });

    try {
      const intent = classifyIntent(text);
      const result = scaffoldForIntent(intent);
      setError(null);
      setPlan(result);
      track('create.plan.preview', { kind: intent.kind });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not understand that request.');
      setPlan(null);
    }
  }, [aiText]);

  const openAi = useCallback(() => {
    track('create.ai.open');
    setError(null);
    setPlan(null);
    setStatus('');
    setAiOpen(true);
  }, []);

  const closeAi = useCallback(() => {
    track('create.cancel', { hadPlan: !!plan });
    setAiOpen(false);
    setPlan(null);
    setError(null);
  }, [plan]);

  const groupLabel =
    'px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-bolt-elements-textTertiary select-none';

  return (
    <>
      <Dropdown
        align="end"
        contentClassName="ps-more-menu"
        trigger={
          <button
            type="button"
            aria-label="Create a function, endpoint, scheduled job, workflow, or template"
            data-testid="workbench-create-menu-trigger"
            onClick={() => track('create.menu.open')}
            className={classNames(
              'flex items-center gap-1 h-7 px-2 rounded-md text-xs font-medium',
              'text-bolt-elements-item-contentAccent',
              'bg-bolt-elements-item-backgroundAccent/10 hover:bg-bolt-elements-item-backgroundAccent/20',
              'border border-bolt-elements-item-contentAccent/25',
              'transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent/50',
              className,
            )}
          >
            <div className="i-ph:sparkle-duotone text-sm" aria-hidden />
            <span>Create</span>
            <div className="i-ph:caret-down text-[10px] opacity-70" aria-hidden />
          </button>
        }
      >
        <DropdownItem className="ps-create-item ps-create-item--accent" onSelect={openAi}>
          <div className="i-ph:magic-wand-duotone text-base" aria-hidden />
          Describe what you want to build…
        </DropdownItem>
        <DropdownSeparator />

        <div className={groupLabel}>Code</div>
        <DropdownItem className="ps-create-item" onSelect={() => quickCreate({ kind: 'function', name: 'my-function' })}>
          <div className="i-ph:function text-base" aria-hidden />
          Add Function
        </DropdownItem>
        <DropdownItem
          className="ps-create-item"
          onSelect={() => quickCreate({ kind: 'endpoint', name: 'my-endpoint', method: 'POST' })}
        >
          <div className="i-ph:plugs-connected-duotone text-base" aria-hidden />
          Add API Endpoint
        </DropdownItem>

        <DropdownSeparator />
        <div className={groupLabel}>Automation</div>
        <DropdownItem
          className="ps-create-item"
          onSelect={() => quickCreate({ kind: 'cron', name: 'nightly-job', schedule: '0 2 * * *' })}
        >
          <div className="i-ph:clock-duotone text-base" aria-hidden />
          Schedule Job
        </DropdownItem>
        <DropdownItem className="ps-create-item" onSelect={() => quickCreate({ kind: 'workflow', name: 'my-workflow' })}>
          <div className="i-ph:flow-arrow-duotone text-base" aria-hidden />
          Create Workflow
        </DropdownItem>

        <DropdownSeparator />
        <div className={groupLabel}>Templates</div>
        {CREATE_TEMPLATES.map((tpl) => (
          <DropdownItem
            key={tpl.id}
            className="ps-create-item"
            onSelect={() => quickCreate({ kind: 'template', name: tpl.intent.name, templateId: tpl.id })}
          >
            <div className="i-ph:file-code-duotone text-base" aria-hidden />
            {tpl.label}
          </DropdownItem>
        ))}
      </Dropdown>

      <RadixDialog.Root open={aiOpen} onOpenChange={(o) => (o ? setAiOpen(true) : closeAi())}>
        {aiOpen && (
          <Dialog onClose={closeAi} onBackdrop={closeAi} className="w-[560px] max-w-[92vw]">
            <div className="p-5">
              <DialogTitle>Create with AI</DialogTitle>
              <DialogDescription>
                Describe what you want to build — I'll turn it into a Function, API endpoint, scheduled job, or workflow
                and add the file to your project.
              </DialogDescription>

              <textarea
                autoFocus
                value={aiText}
                onChange={(e) => {
                  setAiText(e.target.value);
                  setPlan(null);
                }}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    previewFromText();
                  }
                }}
                rows={3}
                data-testid="create-ai-input"
                placeholder="e.g. Create a contact-form endpoint that validates input and sends an email."
                className="mt-3 w-full resize-y rounded-lg bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor px-3 py-2 text-sm text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:outline-none focus:border-bolt-elements-item-contentAccent/50"
              />

              <div className="mt-2 flex flex-wrap gap-1.5">
                {AI_EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    type="button"
                    onClick={() => {
                      setAiText(ex);
                      setPlan(null);
                    }}
                    className="text-[11px] rounded-full px-2 py-0.5 border border-bolt-elements-borderColor text-bolt-elements-textSecondary hover:border-bolt-elements-item-contentAccent/40 hover:text-bolt-elements-textPrimary"
                  >
                    {ex.length > 42 ? `${ex.slice(0, 42)}…` : ex}
                  </button>
                ))}
              </div>

              {error && (
                <div
                  role="alert"
                  className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-300"
                >
                  {error}
                </div>
              )}

              {plan && (
                <div
                  data-testid="create-ai-plan"
                  className="mt-3 rounded-lg border border-bolt-elements-item-contentAccent/25 bg-bolt-elements-item-backgroundAccent/8 px-3 py-2.5 text-[12px] text-bolt-elements-textSecondary"
                >
                  <div className="font-semibold text-bolt-elements-textPrimary capitalize">{plan.intent.kind} plan</div>
                  <div className="mt-1">{plan.summary}</div>
                  <ul className="mt-1.5 space-y-0.5 font-mono text-[11px] text-bolt-elements-textTertiary">
                    {plan.files.map((f) => (
                      <li key={f.path}>+ {f.path}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="mt-3 min-h-[16px] text-[11px] text-bolt-elements-textTertiary" aria-live="polite">
                {status}
              </div>

              <div className="mt-2 flex justify-end gap-2">
                <DialogButton type="secondary" onClick={closeAi}>
                  Cancel
                </DialogButton>
                {plan ? (
                  <DialogButton type="primary" disabled={busy} onClick={() => void runScaffold(plan)}>
                    {busy ? 'Creating…' : 'Create'}
                  </DialogButton>
                ) : (
                  <DialogButton type="primary" disabled={busy || !aiText.trim()} onClick={previewFromText}>
                    Preview
                  </DialogButton>
                )}
              </div>
            </div>
          </Dialog>
        )}
      </RadixDialog.Root>
    </>
  );
});
