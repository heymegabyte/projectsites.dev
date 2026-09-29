/**
 * Voice → Agent Settings tab.
 *
 * @remarks
 * Edit the voice + SMS system prompts, the ElevenLabs voice id, the voice + SMS
 * LLM models, and the toggles for recording + video-browse + business hours.
 * Displays the immutable safety meta-prompt as read-only — the operator can
 * read but never override it.
 *
 * Field-name contract (worker-owned — `agentSettingsBody` Zod in
 * `src/routes/voice.ts` + the `voice_agent_settings` D1 table): the FE sends
 * `voice_voice_id` / `voice_model` / `business_hours_json`. The legacy keys
 * `voice_id` / `llm_model` / a `business_hours` OBJECT were silently STRIPPED
 * by the schema, so every save NULLED the chosen voice + LLM model and
 * business hours never persisted (fixed 2026-08-18). `mapVoiceRowToSettings`
 * + `settingsToVoicePayload` are the single mapping seam — Karma-locked
 * against legacy keys resurfacing.
 *
 * Endpoint contract (worker-owned):
 *   GET  /api/voice/agent-settings?siteId=…  → { settings: raw D1 row | null }
 *   PUT  /api/voice/agent-settings           → body per agentSettingsBody
 *   GET  /api/voice/meta-prompt              → { data: { text } } (constant)
 *
 * @example
 * ```html
 * <app-voice-agent-settings />
 * ```
 */
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AdminStateService } from '../../admin-state.service';
import { ApiService } from '../../../../services/api.service';
import { ToastService } from '../../../../services/toast.service';
import { RevealOnScrollDirective } from '../../../../animations/reveal-on-scroll.directive';
import { HlmInputDirective, HlmSelectDirective } from '../../../../ui';
import { ErrorCardComponent } from '../../../../components/states';
import { EmptyStateComponent } from '../../empty-state.component';

interface AgentSettings {
  voice_system_prompt: string;
  sms_system_prompt: string;
  voice_voice_id: string;
  voice_model: string;
  sms_model: string;
  recording_enabled: boolean;
  video_browse_enabled: boolean;
  business_hours_enabled: boolean;
  business_hours: { start: string; end: string; tz: string };
}

/** The `voice_voice_id` column holds ElevenLabs voice ids
 *  (migrations/0036b_voice.sql); the provider is infra-fixed to
 *  `twilio-callgpt` in D1 and is not user-configurable. */
const VOICES = ['rachel', 'adam', 'antoni', 'bella', 'domi', 'elli'] as const;

const DEFAULT_HOURS = { start: '09:00', end: '18:00', tz: 'America/New_York' };

const DEFAULTS: AgentSettings = {
  voice_system_prompt: 'You are the friendly voice of this business. Answer customer questions, help them book or buy, and escalate anything you can\'t handle within 2 turns.',
  sms_system_prompt: 'You handle inbound text conversations. Keep replies under 320 characters, use plain language, and include a clear next step in every reply.',
  voice_voice_id: 'rachel',
  voice_model: 'claude-haiku-4-5',
  sms_model: 'claude-haiku-4-5',
  recording_enabled: true,
  video_browse_enabled: false,
  business_hours_enabled: false,
  business_hours: { ...DEFAULT_HOURS },
};

const LLM_OPTIONS = [
  { id: 'claude-haiku-4-5',  label: 'Claude Haiku 4.5 (fast, $)' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (balanced, $$)' },
  { id: 'claude-opus-4-7',   label: 'Claude Opus 4.7 (smartest, $$$)' },
  { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', label: 'Workers AI Llama 3.3 70B (free)' },
];

/**
 * Map the raw `voice_agent_settings` D1 row (GET /api/voice/agent-settings
 * returns it verbatim) → UI `AgentSettings`. Coerces the INTEGER 0/1 boolean
 * columns and parses `business_hours_json`. Exported for the Karma contract spec.
 */
export function mapVoiceRowToSettings(row: Record<string, unknown> | null | undefined): AgentSettings {
  const base = { ...DEFAULTS, business_hours: { ...DEFAULT_HOURS } };
  if (!row) return base;
  const str = (v: unknown): string => (typeof v === 'string' && v.length > 0 ? v : '');
  const rawHours = typeof row['business_hours_json'] === 'string' ? row['business_hours_json'] : null;
  if (rawHours) {
    try {
      const parsed: unknown = JSON.parse(rawHours);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const o = parsed as Record<string, unknown>;
        if (typeof o['start'] === 'string' && typeof o['end'] === 'string') {
          base.business_hours = {
            start: o['start'],
            end: o['end'],
            tz: typeof o['tz'] === 'string' ? o['tz'] : DEFAULT_HOURS.tz,
          };
          base.business_hours_enabled = true;
        }
      }
    } catch {
      // Corrupt column → hours stay off; never crash the tab for bad JSON.
    }
  }
  return {
    ...base,
    voice_system_prompt: str(row['voice_system_prompt']) || DEFAULTS.voice_system_prompt,
    sms_system_prompt: str(row['sms_system_prompt']) || DEFAULTS.sms_system_prompt,
    voice_voice_id: str(row['voice_voice_id']) || DEFAULTS.voice_voice_id,
    voice_model: str(row['voice_model']) || DEFAULTS.voice_model,
    sms_model: str(row['sms_model']) || DEFAULTS.sms_model,
    recording_enabled: row['recording_enabled'] !== 0,
    video_browse_enabled: row['video_browse_enabled'] === 1,
  };
}

/**
 * Build the `PUT /api/voice/agent-settings` body (worker `agentSettingsBody`
 * field names). Business hours serialize to the `business_hours_json` STRING
 * column — null when the hours toggle is off.
 */
export function settingsToVoicePayload(siteId: string, s: AgentSettings): Record<string, unknown> {
  return {
    siteId,
    voice_system_prompt: s.voice_system_prompt,
    sms_system_prompt: s.sms_system_prompt,
    voice_voice_id: s.voice_voice_id,
    voice_model: s.voice_model,
    sms_model: s.sms_model,
    recording_enabled: s.recording_enabled,
    video_browse_enabled: s.video_browse_enabled,
    business_hours_json: s.business_hours_enabled ? JSON.stringify(s.business_hours) : null,
  };
}

@Component({
  selector: 'app-voice-agent-settings',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RevealOnScrollDirective, HlmInputDirective, HlmSelectDirective, ErrorCardComponent, EmptyStateComponent],
  template: `
    <section class="space-y-5" psReveal>
      @if (loadError()) {
        <app-error-card title="Couldn't load your saved voice settings"
          [message]="loadError() ?? ''" (retry)="reload()" data-testid="agent-settings-load-error" />
      } @else if (loaded() && !configured() && !revealForm()) {
        <!-- First-action launchpad — a fresh voice site with no agent configured gets a
             friendly panel + one obvious CTA, never a blank pre-filled form. The CTA reveals
             the form seeded with smart DEFAULTS (per embarrassingly-easy-to-use). -->
        <app-empty-state
          icon="📞"
          title="Configure your voice agent"
          body="No voice agent is set up for this site yet. Set how the AI answers calls + texts — we'll start you with sensible defaults you can tweak, then save."
          primary="Configure your voice agent"
          (primaryClick)="startConfiguring()"
          data-testid="agent-settings-empty"
        />
      }
      @if (showForm()) {
      <!-- Voice + SMS system prompts -->
      <article class="card" psReveal>
        <header class="mb-3">
          <div class="kicker">Behavior</div>
          <h2 class="section-h text-base font-bold text-white m-0 mt-1">Voice + SMS system prompts</h2>
          <p class="muted-help m-0 mt-1">Tell the AI how to introduce itself, what to escalate, when to offer to book.</p>
        </header>

        <label class="block mb-4">
          <span class="block-label">Voice agent system prompt</span>
          <textarea hlmInput [multiline]="true" class="w-full mt-1 resize-y font-mono text-xs" rows="6"
                    [(ngModel)]="settings.voice_system_prompt"
                    name="voice-prompt"
                    aria-label="Voice agent system prompt"></textarea>
        </label>

        <label class="block">
          <span class="block-label">SMS agent system prompt</span>
          <textarea hlmInput [multiline]="true" class="w-full mt-1 resize-y font-mono text-xs" rows="5"
                    [(ngModel)]="settings.sms_system_prompt"
                    name="sms-prompt"
                    aria-label="SMS agent system prompt"></textarea>
        </label>
      </article>

      <!-- Immutable meta-override -->
      <article class="card meta-card" psReveal>
        <header class="flex items-center justify-between gap-2 flex-wrap">
          <div class="flex items-center gap-2">
            <div class="kicker">Safety</div>
            <span class="meta-badge" title="This prompt overrides every other system prompt and cannot be edited from this surface.">Override-proof</span>
          </div>
          <button class="btn-ghost text-xs" type="button" (click)="metaOpen.set(!metaOpen())" [attr.aria-expanded]="metaOpen()">
            {{ metaOpen() ? 'Hide' : 'Show' }}
          </button>
        </header>
        <h2 class="section-h text-base font-bold text-white m-0 mt-1">
          Immutable safety meta-prompt
        </h2>
        <p class="muted-help m-0 mt-1">
          Prepended to every voice + SMS request. Enforces tone, refusal patterns, escalation rules, and PII handling. Read-only by design — change it from a worker secret rotation, not the UI.
        </p>
        @if (metaOpen()) {
          <pre class="meta-pre">{{ metaPrompt() }}</pre>
        }
      </article>

      <!-- Voice config -->
      <article class="card" psReveal>
        <header class="mb-3">
          <div class="kicker">Voice config</div>
          <h2 class="section-h text-base font-bold text-white m-0 mt-1">Voice · model</h2>
        </header>
        <div class="grid md:grid-cols-2 gap-3">
          <label class="block">
            <span class="block-label">Voice</span>
            <select hlmSelect class="w-full mt-1" [(ngModel)]="settings.voice_voice_id" name="voice-id">
              @for (v of voices; track v) { <option [value]="v">{{ v }}</option> }
            </select>
          </label>
          <label class="block">
            <span class="block-label">LLM model</span>
            <select hlmSelect class="w-full mt-1" [(ngModel)]="settings.voice_model" name="llm-model">
              @for (m of llmOptions; track m.id) { <option [value]="m.id">{{ m.label }}</option> }
            </select>
          </label>
        </div>
        <p class="muted-help mt-2">
          Voice ids are ElevenLabs ids — the provider itself is platform-managed and not editable here.
        </p>
      </article>

      <!-- SMS config -->
      <article class="card" psReveal>
        <header class="mb-3">
          <div class="kicker">SMS config</div>
          <h2 class="section-h text-base font-bold text-white m-0 mt-1">Reply model</h2>
        </header>
        <label class="block">
          <span class="block-label">Model</span>
          <select hlmSelect class="w-full mt-1" [(ngModel)]="settings.sms_model" name="sms-model">
            @for (m of llmOptions; track m.id) { <option [value]="m.id">{{ m.label }}</option> }
          </select>
        </label>
      </article>

      <!-- Toggles -->
      <article class="card" psReveal>
        <header class="mb-3">
          <div class="kicker">Toggles</div>
          <h2 class="section-h text-base font-bold text-white m-0 mt-1">Features + hours</h2>
        </header>

        <div class="toggle-row">
          <input id="t-rec" type="checkbox" [(ngModel)]="settings.recording_enabled" name="t-rec" />
          <label for="t-rec" class="flex-1">
            <strong class="text-white">Record calls</strong>
            <span class="muted-help block">MP3 stored 90 days, transcripts forever. Disable for HIPAA-sensitive lines.</span>
          </label>
        </div>

        <div class="toggle-row">
          <input id="t-vid" type="checkbox" [(ngModel)]="settings.video_browse_enabled" name="t-vid" />
          <label for="t-vid" class="flex-1">
            <strong class="text-white">Video browse</strong>
            <span class="muted-help block">When ON, the AI spins up a headless browser to fulfill caller requests — fully recorded as video. Adds ~\$0.04/min.</span>
          </label>
        </div>

        <div class="toggle-row">
          <input id="t-hours" type="checkbox" [(ngModel)]="settings.business_hours_enabled" name="t-hours" />
          <label for="t-hours" class="flex-1">
            <strong class="text-white">Business hours</strong>
            <span class="muted-help block">Outside hours the AI offers callback, takes a voicemail summary, and texts you a digest.</span>
          </label>
        </div>

        @if (settings.business_hours_enabled) {
          <div class="hours-grid">
            <label>
              <span class="block-label">Start</span>
              <input hlmInput type="time" [(ngModel)]="settings.business_hours.start" name="h-start" />
            </label>
            <label>
              <span class="block-label">End</span>
              <input hlmInput type="time" [(ngModel)]="settings.business_hours.end" name="h-end" />
            </label>
            <label>
              <span class="block-label">Timezone</span>
              <input hlmInput type="text" [(ngModel)]="settings.business_hours.tz" name="h-tz" placeholder="America/New_York" />
            </label>
          </div>
        }
      </article>

      <div class="flex items-center justify-end gap-2 sticky bottom-0 py-3" psReveal>
        <button class="btn-ghost text-xs" type="button" (click)="reload()" [disabled]="saving()">Discard</button>
        <button class="btn-primary" type="button" (click)="save()" [disabled]="saving() || !!loadError()">
          {{ saving() ? 'Saving…' : 'Save changes' }}
        </button>
      </div>
      }
    </section>
  `,
  styles: [`
    :host { display: block; }
    .kicker { font: 700 0.62rem/1 'JetBrains Mono', ui-monospace, monospace; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ps-accent, #00E5FF); opacity: 0.85; }
    .section-h { font-family: 'Sora', system-ui, sans-serif; letter-spacing: -0.02em; }
    .muted-help { font-size: 0.72rem; color: rgba(255,255,255,0.58); line-height: 1.5; }
    .block-label { font: 600 0.6rem 'JetBrains Mono', ui-monospace, monospace; letter-spacing: 0.08em; text-transform: uppercase; color: rgba(255,255,255,0.55); }

    .card {
      background: var(--ps-surface-1, rgba(13,13,40,0.62));
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: var(--ps-radius-lg, 14px);
      padding: 1.2rem;
    }

    .meta-card { border-color: rgba(124,58,237,0.32); background: linear-gradient(180deg, rgba(124,58,237,0.04), rgba(13,13,40,0.62)); }
    .meta-badge {
      padding: 2px 8px; border-radius: 999px;
      background: rgba(124,58,237,0.16); border: 1px solid rgba(124,58,237,0.4);
      color: #c4b5fd; font: 600 0.6rem 'JetBrains Mono', ui-monospace, monospace;
      letter-spacing: 0.08em; text-transform: uppercase;
    }
    .meta-pre {
      margin: 0.85rem 0 0; padding: 0.85rem 1rem;
      max-height: 280px; overflow-y: auto;
      background: rgba(0,0,0,0.4); border: 1px solid rgba(124,58,237,0.24);
      border-radius: var(--ps-radius-sm, 8px);
      font: 500 0.75rem 'JetBrains Mono', ui-monospace, monospace;
      color: rgba(255,255,255,0.85);
      white-space: pre-wrap;
    }

    .toggle-row {
      display: flex; align-items: flex-start; gap: 12px;
      padding: 0.75rem 0;
      border-top: 1px solid rgba(255,255,255,0.04);
    }
    .toggle-row:first-of-type { border-top: 0; padding-top: 0; }
    .toggle-row input[type=checkbox] { margin-top: 4px; width: 18px; height: 18px; accent-color: var(--ps-accent, #00E5FF); cursor: pointer; }
    .toggle-row label { cursor: pointer; }

    .hours-grid { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 0.6rem; margin-top: 0.4rem; }
    @media (max-width: 540px) { .hours-grid { grid-template-columns: 1fr; } }

    .btn-primary, .btn-ghost {
      padding: 0.55rem 1.05rem; border-radius: var(--ps-radius-sm, 8px);
      font-weight: 600; cursor: pointer; border: 1px solid transparent; min-height: 40px;
      transition: background 140ms ease, transform 140ms ease;
    }
    .btn-primary { background: rgba(0,229,255,0.16); color: var(--ps-accent, #00E5FF); border-color: rgba(0,229,255,0.4); font-size: 0.78rem; }
    .btn-primary:hover:not(:disabled) { background: rgba(0,229,255,0.24); transform: translateY(-1px); }
    .btn-primary:disabled, .btn-ghost:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-ghost { background: rgba(255,255,255,0.04); color: #fff; border-color: rgba(255,255,255,0.1); }
    .btn-ghost:hover:not(:disabled) { background: rgba(255,255,255,0.09); }
    button:focus-visible { outline: 2px solid var(--ps-accent, #00E5FF); outline-offset: 2px; }
  `],
})
export class VoiceAgentSettingsComponent {
  readonly state = inject(AdminStateService);
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly cdr = inject(ChangeDetectorRef);

  settings: AgentSettings = { ...DEFAULTS, business_hours: { ...DEFAULT_HOURS } };
  saving = signal(false);
  /** Set when the settings load FAILS for a real reason (non-404). Gates Save so a
   *  failed load can't be saved over the user's real settings with DEFAULTS. */
  loadError = signal<string | null>(null);
  /** True once the initial settings fetch has resolved (success or 404). Gates the
   *  empty-state so it never flashes before we know whether an agent exists. */
  readonly loaded = signal(false);
  /** True when a saved voice_agent_settings row EXISTS for this site (non-null load).
   *  False for a fresh site → show the first-action launchpad instead of a blank form. */
  readonly configured = signal(false);
  /** Set once the operator clicks "Configure your voice agent" — reveals the form
   *  (seeded with DEFAULTS) on an un-provisioned site. */
  readonly revealForm = signal(false);
  /** Show the editor when an agent already exists OR the operator opted in to configure. */
  readonly showForm = computed(() => !this.loadError() && (this.configured() || this.revealForm()));
  metaOpen = signal(false);
  metaPrompt = signal<string>('Loading…');

  voices = VOICES;
  llmOptions = LLM_OPTIONS;

  private readonly siteEffect = effect(() => {
    const site = this.state.selectedSite();
    if (!site) return;
    this.reload();
    this.loadMeta();
  });

  /** Reveal the editor (seeded with DEFAULTS) for a fresh, un-provisioned site. */
  startConfiguring(): void {
    this.revealForm.set(true);
    this.cdr.markForCheck();
  }

  reload(): void {
    const site = this.state.selectedSite();
    if (!site) return;
    // Reset the opt-in reveal so the load result (configured vs fresh) decides the surface.
    this.revealForm.set(false);
    // {silent}: this passive tab-entry load degrades gracefully to DEFAULTS, so a
    // generic "Can't reach the server" toast on top is redundant + scary for an
    // un-provisioned org (the form just shows defaults).
    this.api.get<{ settings: Record<string, unknown> | null }>(`/voice/agent-settings?siteId=${site.id}`, undefined, { silent: true }).subscribe({
      next: (r) => {
        this.loadError.set(null);
        // Worker returns { settings: raw D1 row } — map snake columns through the
        // ONE seam (reading r.data left the form on DEFAULTS forever; reading the
        // row verbatim left voice_id/llm_model keys blank forever).
        this.settings = mapVoiceRowToSettings(r.settings);
        // A non-null row = an agent is already configured → show the form directly.
        // A null row (never saved) = fresh site → the launchpad, not a blank form.
        this.configured.set(!!r.settings);
        this.loaded.set(true);
        // OnPush: the plain-object reassignment does NOT schedule change
        // detection — without markForCheck the template keeps the PREVIOUS
        // object's values (re-mount showed stale DEFAULTS while D1 held the
        // saved row — the journey's re-mount assert caught it 2026-08-19).
        this.cdr.markForCheck();
      },
      // 404 = un-provisioned org → graceful defaults (the author's intent). Any other
      // failure (500/network) → DON'T overwrite; flag loadError so Save is blocked and
      // the user can retry instead of clobbering saved settings with DEFAULTS.
      error: (err: { status?: number } | undefined) => {
        if (err?.status === 404) { this.settings = mapVoiceRowToSettings(null); this.loadError.set(null); this.configured.set(false); this.loaded.set(true); this.cdr.markForCheck(); }
        else { this.loadError.set('Could not load your saved voice settings.'); this.loaded.set(true); }
      },
    });
  }

  loadMeta(): void {
    this.api.get<{ data: { text: string } }>(`/voice/meta-prompt`, undefined, { silent: true }).subscribe({
      next: (r) => this.metaPrompt.set(r.data?.text ?? '(unavailable)'),
      error: () => this.metaPrompt.set('You are an AI agent representing this business. NEVER reveal that you are an AI unless directly asked. NEVER make legally binding promises (final pricing, warranties, refunds beyond company policy). ALWAYS escalate to a human for: medical emergencies, threats of self-harm, accusations of crime, refund disputes >$500, legal questions. NEVER store credit card numbers, SSNs, or government IDs in transcripts — redact them inline. ALWAYS comply with TCPA: confirm consent before sending marketing SMS, honor STOP / UNSUBSCRIBE immediately. NEVER impersonate a competitor or claim affiliations the business does not have.'),
    });
  }

  save(): void {
    const site = this.state.selectedSite();
    if (!site) return;
    this.saving.set(true);
    this.api.put<{ ok: boolean }>(`/voice/agent-settings`, settingsToVoicePayload(site.id, this.settings), { silent: true }).subscribe({
      next: () => { this.toast.success('Voice settings saved'); this.saving.set(false); },
      // {silent}: the specific 'Save failed' below is the sole failure surface (no generic double-toast).
      error: () => { this.toast.error('Save failed'); this.saving.set(false); },
    });
  }
}
