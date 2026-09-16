import {
  Component,
  type OnInit,
  type OnDestroy,
  ElementRef,
  inject,
  signal,
  computed,
  effect,
  viewChild,
} from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { timer, takeWhile, switchMap, forkJoin } from 'rxjs';
import { ApiService, type LogEntry } from '../../services/api.service';
import { ToastService } from '../../services/toast.service';

/** Ordered pipeline steps for progress display */
const PIPELINE_STEPS = [
  { action: 'workflow.started', label: 'Starting build pipeline...', step: 1 },
  {
    action: 'workflow.step.profile_research_started',
    label: 'Researching your business...',
    step: 2,
  },
  {
    action: 'workflow.step.profile_research_complete',
    label: 'Profile research complete',
    step: 2,
  },
  {
    action: 'workflow.step.parallel_research_started',
    label: 'Analyzing brand, social presence, and images...',
    step: 3,
  },
  { action: 'workflow.step.parallel_research_complete', label: 'Research complete', step: 3 },
  { action: 'workflow.step.structure_plan_started', label: 'Planning site structure...', step: 4 },
  { action: 'workflow.step.structure_plan_complete', label: 'Structure planned', step: 4 },
  { action: 'workflow.step.multipage_generation_started', label: 'Generating pages...', step: 5 },
  { action: 'workflow.step.multipage_generation_complete', label: 'Pages generated', step: 5 },
  { action: 'workflow.step.html_generation_started', label: 'Generating website...', step: 5 },
  { action: 'workflow.step.html_generation_complete', label: 'Website generated', step: 5 },
  { action: 'workflow.step.legal_scoring_started', label: 'Running quality checks...', step: 6 },
  { action: 'workflow.step.legal_and_scoring_complete', label: 'Quality checks passed', step: 6 },
  { action: 'workflow.step.optimization_started', label: 'Optimizing and uploading...', step: 7 },
  { action: 'workflow.step.upload_started', label: 'Uploading files...', step: 7 },
  { action: 'workflow.step.upload_to_r2_complete', label: 'Files uploaded', step: 7 },
  { action: 'workflow.completed', label: 'Your site is live!', step: 8 },
] as const;

const TOTAL_STEPS = 8;

/** The 8 build phases shown as live chips in the log widget header. */
const PHASES: readonly { step: number; label: string }[] = [
  { step: 1, label: 'Start' },
  { step: 2, label: 'Research' },
  { step: 3, label: 'Brand & media' },
  { step: 4, label: 'Structure' },
  { step: 5, label: 'Generate' },
  { step: 6, label: 'Quality' },
  { step: 7, label: 'Optimize' },
  { step: 8, label: 'Live' },
];

/** One rendered terminal line. */
export interface BuildLogLine {
  time: string;
  text: string;
  kind: 'phase' | 'info' | 'error' | 'success';
}

/** One phase chip with its live state. */
export interface BuildPhaseChip {
  label: string;
  state: 'done' | 'active' | 'error' | 'pending';
}

/**
 * Terminal-state decision for the build-progress poll. A `published` row is only
 * "live" once its build actually landed (`hasBuild`) — a published row with NO
 * `current_build_version` never finished uploading and serves a 503, so it is a
 * FAILED build, not a live site (the lying-published class). Pure + exported so
 * the decision is unit-tested without instantiating the polling component.
 *
 * @param status - The site's lifecycle status from the poll.
 * @param hasBuild - Whether `current_build_version` is set (a real R2 build exists).
 * @returns `'live'` (announce + stop), `'failed'` (retry + stop), or `'pending'` (keep polling).
 */
export function resolveBuildOutcome(
  status: string,
  hasBuild: boolean,
): 'live' | 'failed' | 'pending' {
  if (status === 'published' && hasBuild) return 'live';
  if (status === 'error' || (status === 'published' && !hasBuild)) return 'failed';
  return 'pending';
}

/**
 * Scrub anything secret-shaped out of a build-log line BEFORE it reaches the DOM.
 * The container streams real Claude Code output; a leaked key/token must never be
 * rendered. Pure + exported for unit coverage.
 */
export function redactBuildLogSecrets(text: string): string {
  return text
    .replace(
      /(AUTH_TOKEN|API_KEY|ACCESS_KEY|SECRET(?:_KEY)?|PASSWORD|TOKEN)(\s*[=:]\s*)\S+/gi,
      '$1$2***REDACTED***',
    )
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, 'sk-***REDACTED***')
    .replace(/\bAKIA[0-9A-Z]{8,}\b/g, 'AKIA***REDACTED***')
    .replace(/\bphc_[A-Za-z0-9]{16,}\b/g, 'phc_***REDACTED***')
    .replace(/\bre_[A-Za-z0-9]{12,}\b/g, 're_***REDACTED***')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{10,}\b/gi, 'Bearer ***REDACTED***');
}

/** Humanize a raw event action (`workflow.step.upload_started` → `upload started`). */
function humanizeAction(action: string): string {
  return action
    .replace(/^workflow\.(step\.)?/, '')
    .replace(/^container\./, '')
    .replace(/[._]/g, ' ')
    .trim();
}

/**
 * Classify a build-log line for terminal COLORING (STREAMING BUILD THEATER). Pure +
 * exported for unit coverage. Precedence:
 *   1. error  — an error-shaped action OR message (red).
 *   2. phase  — a `workflow.*` pipeline action (cyan), OR streamed stdout describing
 *               in-progress work (present-participle: running/building/generating/…).
 *   3. success — streamed stdout announcing a finished unit (past-tense/✓:
 *               created/wrote/installed/done/✓…) → green, so the live terminal reads as
 *               steady forward progress rather than one flat grey wall.
 *   4. info   — everything else (dim).
 * The content split matters only for streamed `claude.output` lines; known pipeline
 * actions keep their phase/error class regardless of message.
 *
 * @param action - The audit-log entry action (e.g. `claude.output`, `workflow.step.…`).
 * @param message - The rendered line text (raw container stdout or a humanized label).
 */
export function classifyLogLine(action: string, message: string): BuildLogLine['kind'] {
  if (/error|fail/i.test(action) || /\b(error|failed|failure|exception|denied|cannot|✗|✘)\b/i.test(message))
    return 'error';
  if (action.startsWith('workflow.')) return 'phase';
  if (/(^|\s)(✓|✔|✅|done|complete|completed|created|wrote|added|installed|generated|published|deployed|passed|success|succeeded)\b/i.test(message))
    return 'success';
  if (/(^|\s)(running|executing|analy[sz]ing|building|installing|fetching|generating|writing|reading|planning|scaffolding|updating|creating)\b/i.test(message))
    return 'phase';
  return 'info';
}

/**
 * Map a raw audit-log entry to a redacted terminal line. Prefers the raw
 * `metadata_json.message` (the actual container stdout) when present, else a
 * human label for the known pipeline action. Pure + exported for unit coverage.
 */
export function toBuildLogLine(entry: LogEntry): BuildLogLine {
  let message = '';
  if (entry.metadata_json) {
    try {
      const meta = JSON.parse(entry.metadata_json) as Record<string, unknown>;
      message = String(meta['message'] ?? meta['msg'] ?? '');
    } catch {
      /* non-JSON metadata → fall back to the label */
    }
  }
  const label =
    PIPELINE_STEPS.find((s) => s.action === entry.action)?.label ?? humanizeAction(entry.action);
  const kind: BuildLogLine['kind'] = classifyLogLine(entry.action, message || label);
  let time = '';
  try {
    time = new Date(entry.created_at).toLocaleTimeString([], { hour12: false });
  } catch {
    /* keep empty on bad date */
  }
  return { time, text: redactBuildLogSecrets(message || label), kind };
}

/**
 * Build the /waiting terminal HEARTBEAT string (pure — exported for unit coverage). Keeps the
 * terminal visibly alive during long silent gaps in the container build. Returns '' once the
 * build is terminal (published/error) or before it starts; escalates to "still working" after
 * 10s of no new log line so a ~40-min build step never looks frozen.
 *
 * @param status - The site's current lifecycle status.
 * @param buildStartedAtMs - Epoch ms when the /waiting page began tracking (0 = not started).
 * @param lastActivityAtMs - Epoch ms of the last new build log line.
 * @param nowMs - Current epoch ms (injected — pure).
 */
export function formatHeartbeat(
  status: string,
  buildStartedAtMs: number,
  lastActivityAtMs: number,
  nowMs: number,
): string {
  if (status === 'published' || status === 'error' || buildStartedAtMs === 0) return '';
  const fmt = (s: number): string => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
  const elapsed = Math.max(0, Math.floor((nowMs - buildStartedAtMs) / 1000));
  const idle = Math.max(0, Math.floor((nowMs - lastActivityAtMs) / 1000));
  return idle > 10
    ? `still building — ${fmt(elapsed)} elapsed · working (${fmt(idle)} since last update)`
    : `building — ${fmt(elapsed)} elapsed`;
}

@Component({
  selector: 'app-waiting',
  standalone: true,
  templateUrl: './waiting.component.html',
  styleUrl: './waiting.component.scss',
})
export class WaitingComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  siteId = '';
  slug = '';
  status = signal('building');
  statusMessage = signal('Preparing your project...');
  currentStep = signal(1);
  totalSteps = TOTAL_STEPS;
  alive = true;

  /** Raw build events, newest last — rendered live in the terminal widget. */
  logs = signal<LogEntry[]>([]);

  logScroll = viewChild<ElementRef<HTMLElement>>('logScroll');

  stepProgress = computed(() => `Step ${this.currentStep()} of ${this.totalSteps}`);

  /** Redacted, human/raw terminal lines for the live-logs widget. */
  logLines = computed<BuildLogLine[]>(() => this.logs().map(toBuildLogLine));

  /** Per-phase chips with live state derived from the current step + status. */
  phases = computed<BuildPhaseChip[]>(() => {
    const cur = this.currentStep();
    const errored = this.status() === 'error';
    return PHASES.map((p) => ({
      label: p.label,
      state: p.step < cur ? 'done' : p.step === cur ? (errored ? 'error' : 'active') : 'pending',
    }));
  });

  // Heartbeat — keeps the terminal visibly ALIVE during the long container build, where
  // minutes pass with no new audit line (the ~40-min build-orchestrator step) and the widget
  // would otherwise look frozen. A 1s ticker drives an elapsed/idle readout in the cursor line.
  private buildStartedAt = 0;
  private lastLogCount = 0;
  readonly lastActivityAt = signal(0);
  readonly nowTick = signal(0);

  /** Live "building — {elapsed}" line; escalates to "still working" after 10s of silence. Empty once done. */
  readonly heartbeat = computed<string>(() => {
    this.nowTick(); // recompute every tick so the readout breathes each second
    return formatHeartbeat(this.status(), this.buildStartedAt, this.lastActivityAt(), Date.now());
  });

  constructor() {
    // Tail the terminal to the newest line whenever the stream grows.
    effect(() => {
      this.logLines();
      const el = this.logScroll()?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  ngOnInit(): void {
    this.siteId = this.route.snapshot.queryParams['id'] || '';
    this.slug = this.route.snapshot.queryParams['slug'] || '';

    if (!this.siteId) {
      this.router.navigate(['/']);
      return;
    }

    this.buildStartedAt = Date.now();
    this.lastActivityAt.set(Date.now());
    this.startPolling();
    this.startHeartbeat();
  }

  ngOnDestroy(): void {
    this.alive = false;
  }

  /** 1s ticker driving the heartbeat readout; stops when the build finishes (alive=false). */
  private startHeartbeat(): void {
    timer(0, 1000)
      .pipe(takeWhile(() => this.alive))
      .subscribe(() => this.nowTick.update((n) => n + 1));
  }

  private startPolling(): void {
    // timer(0, …) fires immediately so the widget is never blank for the first tick.
    timer(0, 3000)
      .pipe(
        takeWhile(() => this.alive),
        switchMap(() =>
          forkJoin({
            site: this.api.getSite(this.siteId),
            logs: this.api.getSiteLogs(this.siteId, 200),
          }),
        ),
      )
      .subscribe({
        next: ({ site: siteRes, logs: logsRes }) => {
          const site = siteRes.data;
          this.status.set(site.status);

          const logs = logsRes?.data ?? [];
          this.logs.set(logs);
          // Heartbeat activity marker — reset the idle timer whenever a new build line arrives.
          if (logs.length > this.lastLogCount) {
            this.lastLogCount = logs.length;
            this.lastActivityAt.set(Date.now());
          }
          this.updateStatusFromLogs(logs, site.status);

          // A published row is "live" ONLY once its build landed — a published +
          // null-build row serves a 503, so it's a FAILED build (lying-published),
          // never announced as live. Decision extracted to resolveBuildOutcome().
          const outcome = resolveBuildOutcome(site.status, !!site.current_build_version);
          if (outcome === 'live') {
            this.alive = false;
            this.statusMessage.set('Your site is live!');
            this.currentStep.set(TOTAL_STEPS);
            this.status.set('published');
            this.toast.success('Your site is live!');
            return;
          }

          if (outcome === 'failed') {
            this.alive = false;
            this.statusMessage.set('Build failed. Please try again.');
            this.toast.error('Build failed.');
          }
        },
        error: () => {
          /* retry next interval */
        },
      });
  }

  private updateStatusFromLogs(logs: LogEntry[], siteStatus: string): void {
    const logActions = new Set(logs.map((l) => l.action));

    let latestStep = 1;
    let latestLabel = 'Preparing your project...';

    for (const pipelineStep of PIPELINE_STEPS) {
      if (logActions.has(pipelineStep.action) && pipelineStep.step >= latestStep) {
        latestStep = pipelineStep.step;
        latestLabel = pipelineStep.label;
      }
    }

    if (latestStep === 1 && siteStatus !== 'building') {
      const statusMap: Record<string, { step: number; label: string }> = {
        collecting: { step: 2, label: 'Researching your business...' },
        imaging: { step: 3, label: 'Generating images and assets...' },
        generating: { step: 5, label: 'Generating pages...' },
        uploading: { step: 7, label: 'Uploading files...' },
        published: { step: 8, label: 'Your site is live!' },
      };
      const mapped = statusMap[siteStatus];
      if (mapped) {
        latestStep = mapped.step;
        latestLabel = mapped.label;
      }
    }

    this.currentStep.set(latestStep);
    this.statusMessage.set(latestLabel);
  }

  goHome(): void {
    this.router.navigate(['/']);
  }

  goAdmin(): void {
    this.router.navigate(['/admin']);
  }

  viewSite(): void {
    window.location.href = `https://${this.slug}.projectsites.dev`;
  }

  editWithAI(): void {
    this.router.navigate(['/editor', this.slug]);
  }
}
