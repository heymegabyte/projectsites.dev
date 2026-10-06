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
import { timer, takeWhile, switchMap, forkJoin, catchError, of } from 'rxjs';
import { ApiService, type LogEntry, type Site } from '../../services/api.service';
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

/** One rendered terminal line. */
export interface BuildLogLine {
  time: string;
  text: string;
  kind: 'phase' | 'info' | 'error' | 'success';
}

/** The live state of a single build phase row (owner-facing stepper + legacy terminal chips). */
export type BuildPhaseState = 'done' | 'active' | 'error' | 'pending';

/**
 * One OWNER-FACING build phase — the human story a non-technical business owner watches, NEVER a
 * raw status token. `index` is its position in the 4-phase arc; `phaseLabel` is the short title;
 * `friendlyCopy` is the reassuring one-liner beneath it.
 */
export interface OwnerPhase {
  index: number;
  phaseLabel: string;
  friendlyCopy: string;
}

/**
 * The four cinematic, owner-facing build phases — the ONLY words the owner sees while their site
 * generates. Deliberately NON-technical: a busy small-business owner understands "Designing your
 * brand & logo", never "imaging". Ordered research → design → build → polish/live.
 */
export const OWNER_PHASES: readonly OwnerPhase[] = [
  {
    index: 0,
    phaseLabel: 'Researching your business',
    friendlyCopy: "We're learning what makes your business special.",
  },
  {
    index: 1,
    phaseLabel: 'Designing your brand & logo',
    friendlyCopy: 'Crafting your colors, logo, and a look that feels like you.',
  },
  {
    index: 2,
    phaseLabel: 'Building your pages',
    friendlyCopy: 'Writing your words and assembling every page, section by section.',
  },
  {
    index: 3,
    phaseLabel: 'Polishing & going live',
    friendlyCopy: 'Final touches, quality checks, and publishing your site to the web.',
  },
] as const;

/**
 * The HONESTY SEAM. Translate the REAL backend `sites.status` (read via `getSite().data.status`)
 * into ONE of the four owner-facing {@link OWNER_PHASES}. This is the ONLY place a raw status token
 * becomes owner-visible copy — the owner never sees `collecting` / `imaging` / `generating`.
 *
 * Mapping (authoritative status machine `draft → collecting → imaging → generating → published`,
 * plus `building`/`queued`/`uploading` the Worker also writes):
 *   draft · queued · building · collecting → phase 0 (Researching your business)
 *   imaging                                → phase 1 (Designing your brand & logo)
 *   generating                             → phase 2 (Building your pages)
 *   uploading · published                  → phase 3 (Polishing & going live)
 *
 * HOLD-THE-LAST-REAL-PHASE: if the backend sits between known statuses (an UNKNOWN value), we do NOT
 * invent progress — we return the phase at `lastIndex` (the monotonic floor), never snapping back to
 * phase 0. MONOTONIC: a known status that maps BELOW `lastIndex` (a stale/second-instance poll) is
 * clamped UP to `lastIndex` so the visible arc never regresses. `error` is NOT special-cased here —
 * it holds the last real phase; the component's dedicated `status()==='error'` UI owns the failure
 * messaging so a build failure is never masked as progress. Pure + exported for unit coverage.
 *
 * @param status - The site's REAL lifecycle status from the poll (authoritative forward signal).
 * @param lastIndex - The highest phase index already shown (monotonic floor). Default 0 (first poll).
 * @returns The resolved {@link OwnerPhase} to display, carrying `total` for "Step X of Y" readouts.
 */
export function mapStatusToPhase(
  status: string,
  lastIndex = 0,
): OwnerPhase & { total: number } {
  const STATUS_TO_INDEX: Record<string, number> = {
    draft: 0,
    queued: 0,
    building: 0,
    collecting: 0,
    imaging: 1,
    generating: 2,
    uploading: 3,
    published: 3,
  };
  const mapped = STATUS_TO_INDEX[status];
  // Unknown / between-statuses → HOLD the last real phase (no fabricated progress). A known status
  // is clamped to the monotonic floor so the arc never regresses.
  const index = mapped === undefined ? lastIndex : Math.max(mapped, lastIndex);
  const phase = OWNER_PHASES[index] ?? OWNER_PHASES[0];
  return { ...phase, total: OWNER_PHASES.length };
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
 * Decide whether the build-status poll should DEGRADE to the graceful load-error card (AL-827).
 * The poll fires every 3s; if it has NEVER successfully loaded the site and has failed ≥2
 * consecutive times (~6s — a 401 expired session / unauth shared /waiting?id= link / bad id), we
 * stop the fake "Building…" overlay and show a sign-in card. A failure AFTER a successful load
 * (`everLoaded`) is a transient blip mid-build → keep retrying, never disrupt a live build. Pure +
 * exported so the decision is unit-tested without instantiating the polling component.
 *
 * @param everLoaded - Whether any poll tick has already loaded the site.
 * @param consecutiveErrors - Count of consecutive poll failures with no prior success.
 * @returns true when the UI should show the graceful load-error card.
 */
export function shouldDegradeToLoadError(everLoaded: boolean, consecutiveErrors: number): boolean {
  return !everLoaded && consecutiveErrors >= 2;
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

/**
 * Strip ANSI escape sequences + C0/C1 control characters from a build-log line so raw terminal
 * control bytes (colour codes, cursor moves, spinner carriage-returns) never render as garbage in
 * the /waiting terminal. Server mirror of `build_log.ts` stripControlChars (defense-in-depth: the
 * stored row is already scrubbed, but old rows + any drift are cleaned here on render too). A
 * carriage-return progress line collapses to its final frame. Implemented with `charCodeAt` (no
 * regex over raw control bytes) so this source stays 100% ASCII. Pure + exported for unit coverage.
 */
export function stripControlChars(text: string): string {
  const cr = text.lastIndexOf(String.fromCharCode(13)); // carriage return
  const s = cr >= 0 ? text.slice(cr + 1) : text;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 27) {
      // ESC — skip an ANSI CSI/OSC sequence up to its final byte (0x40-0x7e).
      i++;
      if (i < s.length && (s.charCodeAt(i) === 91 || s.charCodeAt(i) === 93)) i++; // '[' or ']'
      while (i < s.length) {
        const c = s.charCodeAt(i);
        if (c >= 0x40 && c <= 0x7e) break; // final byte terminates the sequence
        i++;
      }
      continue; // the for-loop's i++ steps past the final byte
    }
    // Keep tab (9) + newline (10) + printables ≥32, dropping DEL (127) and C1 (128-159).
    if (code === 9 || code === 10 || (code >= 32 && code !== 127 && !(code >= 128 && code <= 159))) {
      out += s[i];
    }
  }
  return out;
}

/**
 * Claude Code control-plane + provider-transport lines that must NEVER render in the
 * owner-facing terminal — internal telemetry / model-catalog warnings and raw upstream
 * API errors (e.g. `402 Insufficient Balance` when the build LLM balance is exhausted).
 * Server mirror of `build_log.ts` isBuildLogNoise (defense-in-depth: the stored row is
 * already filtered, but old rows + any future drift are also scrubbed here on render).
 * SPECIFIC by design — a GENUINE build error (`Error: Cannot find module …`) still renders
 * (and `classifyLogLine` colors it red); only Claude Code's own noise + transport errors drop.
 */
const BUILD_LOG_NOISE: readonly RegExp[] = [
  /\[claude-code:/i,
  /\bunrecognized_model\b/i,
  /\bgenerate_session_title\b/i,
  /model catalog/i,
  /\bbehavesAs\b/i,
  /"query_source"\s*:/i,
  /^\s*API Error:\s*\d{3}\b/i,
  /\binsufficient balance\b/i,
];

/**
 * True when a build-log line is Claude Code control-plane / provider-transport NOISE that
 * must be dropped before it renders in the /waiting terminal. Pure + exported for unit
 * coverage; mirrors the server `build_log.ts` isBuildLogNoise so display == stored intent.
 */
export function isBuildLogNoise(text: string): boolean {
  return BUILD_LOG_NOISE.some((re) => re.test(text));
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
  return { time, text: redactBuildLogSecrets(stripControlChars(message || label)), kind };
}

/**
 * Map the newest-first /logs slice into CHRONOLOGICAL terminal lines (oldest→newest, newest LAST),
 * dropping Claude Code control-plane + provider-transport noise. Pure + exported so the ordering
 * contract is unit-tested.
 *
 * WHY the reverse: the /logs API returns rows `created_at DESC` (newest first — correct for the
 * admin audit LIST). A live TERMINAL reads top→bottom and auto-scrolls to the BOTTOM, so it must
 * render oldest→newest — otherwise new lines prepend off-screen at the top while the viewport stays
 * pinned to the oldest line and the whole stream looks FROZEN (defeating STREAMING BUILD THEATER).
 */
export function buildTerminalLines(logs: LogEntry[]): BuildLogLine[] {
  return logs
    .slice()
    .reverse()
    .map(toBuildLogLine)
    .filter((l) => !isBuildLogNoise(l.text));
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

/**
 * Format the owner-facing ELAPSED readout ("2m 14s elapsed"). Pure + exported for unit coverage.
 * Returns '' once the build is terminal (published/error) or before it starts, so a finished build
 * never shows a live clock. Clamps negatives under clock skew. The clock measures REAL wall time —
 * it does NOT drive the phase (the phase tracks backend status), so this can never fabricate progress.
 *
 * @param status - The site's current lifecycle status.
 * @param buildStartedAtMs - Epoch ms when /waiting began tracking (0 = not started).
 * @param nowMs - Current epoch ms (injected — pure).
 */
export function formatElapsed(status: string, buildStartedAtMs: number, nowMs: number): string {
  if (status === 'published' || status === 'error' || buildStartedAtMs === 0) return '';
  const s = Math.max(0, Math.floor((nowMs - buildStartedAtMs) / 1000));
  const txt = s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
  return `${txt} elapsed`;
}

/**
 * Derive the current build step + label from the fetched audit logs and the site status. Pure +
 * exported for unit coverage. Prefers the furthest-reached `workflow.*` PIPELINE_STEP action in the
 * log window; falls back to the coarse site-status map when no pipeline action is present.
 *
 * IMPORTANT: the /logs window is capped (200 rows). During STREAMING BUILD THEATER a heavy build
 * floods the window with `claude.output` lines, pushing the early `workflow.*` events OUT of it —
 * so a fresh derivation can drop back to step 1. The caller applies a MONOTONIC guard on top of
 * this so the visible progress never regresses. Kept pure/windowed here; the never-go-backward
 * policy lives in the component.
 *
 * @param logs - The fetched audit-log slice (newest-first, capped).
 * @param siteStatus - The site's lifecycle status (authoritative forward signal, never windowed).
 * @returns The derived `{ step, label }` for this poll (pre-monotonic).
 */
export function deriveBuildStep(
  logs: LogEntry[],
  siteStatus: string,
): { step: number; label: string } {
  const logActions = new Set(logs.map((l) => l.action));
  let step = 1;
  let label = 'Preparing your project...';
  for (const pipelineStep of PIPELINE_STEPS) {
    if (logActions.has(pipelineStep.action) && pipelineStep.step >= step) {
      step = pipelineStep.step;
      label = pipelineStep.label;
    }
  }
  if (step === 1 && siteStatus !== 'building') {
    const statusMap: Record<string, { step: number; label: string }> = {
      collecting: { step: 2, label: 'Researching your business...' },
      imaging: { step: 3, label: 'Generating images and assets...' },
      generating: { step: 5, label: 'Generating pages...' },
      uploading: { step: 7, label: 'Uploading files...' },
      published: { step: 8, label: 'Your site is live!' },
    };
    const mapped = statusMap[siteStatus];
    if (mapped) {
      step = mapped.step;
      label = mapped.label;
    }
  }
  return { step, label };
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

  /**
   * The build-status poll could NEVER load the site (AL-827). Before this, a 401 (expired
   * session, or an unauth visitor on a shared /waiting?id= link) made the poll error handler
   * silently retry forever — the owner stared at a FAKE "Building your website" overlay + a
   * progress bar that never moved, with a 401 in the console and no way out. `/waiting` isn't in
   * ApiService's protected-route 401→/signin list, so nothing rescued them. When we can't even
   * load the build once, degrade to a graceful "session expired — sign in" card instead.
   */
  loadError = signal(false);
  /** True once ANY poll tick has loaded the site — so a mid-build transient blip never trips loadError. */
  private everLoaded = false;
  /** Consecutive poll failures with no successful load yet. */
  private consecutiveErrors = 0;

  /**
   * The most recent site record a poll tick loaded — the source of the business
   * name/address/place_id a {@link rebuildSite} re-build needs (the {@link ResetSitePayload}
   * requires them, and the owner never re-types what we already know). Null until the first
   * successful poll; a build that FAILS still populated this on the ticks before it failed.
   */
  private site = signal<Site | null>(null);

  /**
   * In-flight guard for the WAITING-RETRY rebuild (#27). When the owner's FIRST build FAILED at the
   * highest-emotion activation moment, the failed state offers a prominent "Try again" that
   * re-triggers the build via `resetSite` + RESUMES the cinematic poll — never a dead end. True
   * while that reset request is outstanding so the button disables (double-submit safe) and shows
   * a reassuring "Restarting…".
   */
  readonly retrying = signal(false);

  /** Raw build events, newest last — rendered live in the terminal widget. */
  logs = signal<LogEntry[]>([]);

  logScroll = viewChild<ElementRef<HTMLElement>>('logScroll');

  /**
   * Redacted, human/raw terminal lines for the live-logs widget. Claude Code
   * control-plane + provider-transport noise (isBuildLogNoise) is dropped so the
   * owner sees a clean build story, never `402 Insufficient Balance` or model-catalog
   * warnings — a real build error still renders (red) because the filter is specific.
   */
  logLines = computed<BuildLogLine[]>(() => buildTerminalLines(this.logs()));

  /**
   * MONOTONIC owner-facing phase index (0-3), the floor for {@link mapStatusToPhase}. Only ever
   * advances — a stale poll reporting an earlier status can never pull the cinematic arc backward.
   */
  readonly ownerPhaseIndex = signal(0);

  /**
   * The current OWNER-FACING phase — the human story the owner watches. Derived PURELY from the REAL
   * `status()` the backend reports (the honesty seam), carrying the monotonic floor so it never
   * regresses. This is what the redesigned /waiting screen renders — never a raw status token.
   */
  readonly ownerPhase = computed<OwnerPhase & { total: number }>(() =>
    mapStatusToPhase(this.status(), this.ownerPhaseIndex()),
  );

  /**
   * The four phases as owner-facing stepper rows with live state. `done` for cleared phases, `active`
   * (with motion) for the current one, `error` if the build failed on it, else `pending`.
   */
  readonly ownerPhases = computed<(OwnerPhase & { state: BuildPhaseState })[]>(() => {
    const cur = this.ownerPhase().index;
    const errored = this.status() === 'error';
    return OWNER_PHASES.map((p) => ({
      ...p,
      state: p.index < cur ? 'done' : p.index === cur ? (errored ? 'error' : 'active') : 'pending',
    }));
  });

  /**
   * Reassuring elapsed readout ("2m 14s elapsed") the owner sees beneath the active phase. Derived
   * from the REAL build-start time + the 1s ticker; clears to '' once terminal (published/error) so
   * a finished build never shows a live-ticking clock. Honest: the clock measures real wall time,
   * it does NOT drive the phase — the phase tracks backend status.
   */
  readonly elapsedReadout = computed<string>(() => {
    this.nowTick(); // recompute each tick so the clock breathes
    return formatElapsed(this.status(), this.buildStartedAt, Date.now());
  });

  /**
   * Whether the owner prefers reduced motion. When true the screen drops the decorative black+cyan
   * motion (shimmer/pulse/spinner) and shows a calm static current-phase + elapsed readout — the
   * `prefers-reduced-motion` mandate. Read once at construction (matchMedia is wrapped so SSR / old
   * browsers never throw); SCSS also hard-guards every animation behind the same media query.
   */
  readonly reducedMotion = signal(false);

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
    // Honor the owner's motion preference: drop the decorative black+cyan shimmer/pulse to a calm
    // static phase + elapsed readout. matchMedia is guarded so SSR / old browsers never throw.
    try {
      this.reducedMotion.set(
        typeof window !== 'undefined' &&
          typeof window.matchMedia === 'function' &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      );
    } catch {
      /* matchMedia unavailable (SSR / sandboxed) → keep motion default (false) */
    }

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
          }).pipe(
            // A poll error (401 expired session, unauth shared link, transport blip) must NOT kill
            // the stream — switchMap would propagate it to the outer timer and STOP polling entirely
            // (the pre-AL-827 bug: the bare error handler "retried" a dead stream → perpetual fake
            // overlay). Map errors to null so the timer keeps firing; the handler degrades or recovers.
            catchError(() => of(null)),
          ),
        ),
      )
      .subscribe((res) => {
        if (!res) {
          this.consecutiveErrors += 1;
          // NEVER loaded (401 / unauth shared link / bad id) → after 2 failed ticks (~6s) stop the
          // fake overlay and show the graceful sign-in card. A blip AFTER a successful load keeps
          // polling (the stream now survives) — never disrupts a live build.
          if (shouldDegradeToLoadError(this.everLoaded, this.consecutiveErrors)) {
            this.alive = false;
            this.loadError.set(true);
            // Structured observability: how often owners hit an unloadable /waiting (session expiry).
            console.warn(
              JSON.stringify({
                event: 'waiting_poll_load_failed',
                siteId: this.siteId,
                consecutiveErrors: this.consecutiveErrors,
              }),
            );
          }
          return;
        }

        this.everLoaded = true;
        this.consecutiveErrors = 0;
        const site = res.site.data;
        // Remember the loaded record so a rebuild (WAITING-RETRY) can reuse the business
        // name/address/place_id without the owner re-typing what we already know.
        this.site.set(site);
        this.status.set(site.status);
        // Advance the MONOTONIC owner-phase floor from the REAL status (the honesty seam). A stale
        // poll reporting an earlier status can never pull the cinematic arc backward — the floor only
        // ever climbs, and an unknown/between-status value holds the last real phase.
        this.ownerPhaseIndex.set(mapStatusToPhase(site.status, this.ownerPhaseIndex()).index);

        const logs = res.logs?.data ?? [];
        this.logs.set(logs);
        // Heartbeat activity marker — reset the idle timer whenever a new build line arrives.
        if (logs.length > this.lastLogCount) {
          this.lastLogCount = logs.length;
          this.lastActivityAt.set(Date.now());
        }
        this.updateStatusFromLogs(logs, site.status);

        // A published row is "live" ONLY once its build landed — a published + null-build row serves
        // a 503, so it's a FAILED build (lying-published), never announced as live.
        const outcome = resolveBuildOutcome(site.status, !!site.current_build_version);
        if (outcome === 'live') {
          this.alive = false;
          this.statusMessage.set('Your site is live!');
          this.currentStep.set(TOTAL_STEPS);
          this.ownerPhaseIndex.set(OWNER_PHASES.length - 1);
          this.status.set('published');
          this.toast.success('Your site is live!');
          return;
        }

        if (outcome === 'failed') {
          this.alive = false;
          this.statusMessage.set('Build failed. Please try again.');
          this.toast.error('Build failed.');
        }
      });
  }

  /** Graceful load-error recovery: re-authenticate, returning to THIS build after sign-in. */
  signIn(): void {
    const returnUrl = `/waiting?id=${encodeURIComponent(this.siteId)}${this.slug ? `&slug=${encodeURIComponent(this.slug)}` : ''}`;
    this.router.navigate(['/signin'], { queryParams: { returnUrl } });
  }

  /**
   * WAITING-RETRY (#27) — recover from a FAILED first build RIGHT HERE, instead of a dead end. A
   * non-technical owner whose very first site build errored is at the highest-emotion activation
   * moment; the failed state must let them recover without leaving, re-typing anything, or asking a
   * question (embarrassingly-easy-to-use). Re-triggers the build via `resetSite` (reusing the
   * business name/address/place_id we already loaded) then RESUMES the cinematic poll so the UI
   * re-enters the in-progress phase arc from the top.
   *
   * On the reset call's OWN error we stay on the failed state and re-enable the button — ApiService
   * has already surfaced the human-readable server message as a toast, so the owner can simply try
   * again. Double-submit-guarded via {@link retrying}.
   */
  rebuildSite(): void {
    if (this.retrying()) return;
    const site = this.site();
    if (!this.siteId || !site) {
      // We never loaded the record (so we lack the business details reset needs) — the most helpful
      // recovery is to send them to the dashboard where the site + its Rebuild control live.
      this.toast.error('We could not load your site details — opening your dashboard to retry.');
      this.goAdmin();
      return;
    }

    this.retrying.set(true);
    this.api
      .resetSite(this.siteId, {
        business: {
          name: site.business_name,
          address: site.business_address,
          place_id: site.place_id,
        },
      })
      .subscribe({
        next: () => {
          this.retrying.set(false);
          this.toast.success("Rebuilding your site — we'll pick straight back up.");
          this.resumePolling();
        },
        error: () => {
          // Stay on the failed state so the owner sees their options; re-enable the button. The
          // ApiService error pipe already toasted the server's human-readable reason.
          this.retrying.set(false);
        },
      });
  }

  /**
   * Re-enter the in-progress cinematic state after a successful rebuild: clear the terminal/failure
   * signals, reset the monotonic floors + heartbeat clocks to a fresh build, and restart the 3s
   * status poll + 1s heartbeat. Idempotent-safe because the prior poll/heartbeat timers already
   * completed when the build went terminal (`alive` was flipped false).
   */
  private resumePolling(): void {
    this.alive = true;
    this.status.set('building');
    this.statusMessage.set('Preparing your project...');
    this.currentStep.set(1);
    this.ownerPhaseIndex.set(0);
    this.logs.set([]);
    this.loadError.set(false);
    this.everLoaded = false;
    this.consecutiveErrors = 0;
    this.lastLogCount = 0;
    this.buildStartedAt = Date.now();
    this.lastActivityAt.set(Date.now());
    this.startPolling();
    this.startHeartbeat();
  }

  private updateStatusFromLogs(logs: LogEntry[], siteStatus: string): void {
    const derived = deriveBuildStep(logs, siteStatus);
    // MONOTONIC — a build only moves forward. When a heavy live build floods the DESC-ordered
    // 200-log window with claude.output lines, the early workflow.* events scroll OUT of it, so a
    // fresh derivation would REGRESS (e.g. back to "Starting…") and the progress bar would appear
    // to restart mid-build. Never let the visible step go backward; hold the last real label when
    // the window momentarily loses the phase events.
    if (derived.step >= this.currentStep()) {
      this.currentStep.set(derived.step);
      this.statusMessage.set(derived.label);
    }
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
