import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
  output,
  signal,
  type OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DialogShellComponent } from '../../../components/dialog-shell/dialog-shell.component';
import { HlmInputDirective, HlmSelectDirective } from '../../../ui';
import { ApiService } from '../../../services/api.service';
import { ToastService } from '../../../services/toast.service';

/**
 * The Auto-Pilot prompt editor — extracted from the 3.2k-line
 * `social.component.ts` god component (split slice 2). Owns ONLY the
 * config dialog:
 *
 * - Draft state (prompt/cadence/networks) is LOCAL — seeded from the
 *   inputs on open, discarded on cancel.
 * - `preview` POSTs `/social/auto-pilot/preview`; `save` POSTs
 *   `/social/auto-pilot/config` and emits the server response via
 *   `saved` so the PARENT applies it to its live signals.
 * - The enable/disable toggle stays in the parent — this dialog only
 *   edits the config.
 */

/** Platform view shape the chips + preview selector need. */
interface PlatformDefView {
  id: string;
  label: string;
  color: string;
  glyph: string;
}

/** The server-returned config the parent applies. */
export interface AutoPilotSavedPayload {
  prompt: string;
  cadence_hours: number;
  target_networks: string[];
}

const CADENCE_OPTIONS = [6, 12, 24, 48, 168] as const;
const CADENCE_LABELS: Record<number, string> = {
  6: 'Every 6 hours',
  12: 'Every 12 hours',
  24: 'Every 24 hours',
  48: 'Every 48 hours',
  168: 'Weekly',
};

@Component({
  selector: 'app-social-auto-pilot-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, DialogShellComponent, HlmInputDirective, HlmSelectDirective],
  template: `
    <app-dialog-shell (closed)="closed.emit()">
      <span dialogIcon class="ap-dlg-icon" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
        </svg>
      </span>
      <span dialogTitle>Auto-Pilot prompt</span>
      <span dialogBadge class="ap-dlg-badge">Drafts only</span>

      <div class="ap-dlg-body">
        <p class="ap-dlg-blurb">
          Auto-Pilot autonomously composes posts on a cadence using this system prompt and your business context. Output is saved as a <strong>draft</strong> — you still review and publish manually.
        </p>

        <label class="ap-dlg-lbl" for="ap-prompt">System prompt</label>
        <textarea
          hlmInput
          [multiline]="true"
          id="ap-prompt"
          class="w-full resize-y"
          rows="8"
          [ngModel]="promptDraft()"
          (ngModelChange)="promptDraft.set($event)"
          [attr.aria-label]="'Auto-Pilot system prompt'"
          placeholder="You are an autonomous social media composer for {{ '{{business_name}}' }}…"></textarea>
        <div class="ap-dlg-help">
          Variables: <code>{{ '{{business_name}}' }}</code>, <code>{{ '{{business_type}}' }}</code>, <code>{{ '{{brand_voice}}' }}</code>, <code>{{ '{{recent_news}}' }}</code>, <code>{{ '{{target_networks}}' }}</code>.
          <button type="button" class="ap-dlg-link" (click)="resetToDefault()">Reset to default</button>
        </div>

        <div class="ap-dlg-grid">
          <div>
            <label class="ap-dlg-lbl" for="ap-cadence">Cadence</label>
            <select
              hlmSelect
              id="ap-cadence"
              class="w-full"
              [ngModel]="cadenceDraft()"
              (ngModelChange)="cadenceDraft.set(+$event)"
              aria-label="Auto-Pilot cadence">
              @for (opt of cadenceOptions; track opt) {
                <option [ngValue]="opt">{{ cadenceLabel(opt) }}</option>
              }
            </select>
          </div>
          <div>
            <label class="ap-dlg-lbl" for="ap-preview-net">Preview network</label>
            <select
              hlmSelect
              id="ap-preview-net"
              class="w-full"
              [ngModel]="previewNetwork()"
              (ngModelChange)="previewNetwork.set($event)"
              aria-label="Preview network">
              @for (p of platforms(); track p.id) {
                <option [ngValue]="p.id">{{ p.label }}</option>
              }
            </select>
          </div>
        </div>

        <label class="ap-dlg-lbl">Target networks</label>
        <div class="ap-dlg-chips" role="group" aria-label="Target networks for Auto-Pilot">
          @for (p of platforms(); track p.id) {
            <button
              type="button"
              class="ap-dlg-chip"
              [class.is-on]="networksDraft().includes(p.id)"
              [style.--brand]="p.color"
              [attr.aria-pressed]="networksDraft().includes(p.id)"
              (click)="toggleNetwork(p.id)">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path [attr.d]="p.glyph"/></svg>
              <span>{{ p.label }}</span>
            </button>
          }
        </div>

        <div class="ap-dlg-preview">
          <div class="ap-dlg-preview__h">
            <span>Sample output</span>
            <button
              type="button"
              class="ap-dlg-btn ghost"
              (click)="previewPost()"
              [disabled]="previewing()">
              {{ previewing() ? 'Drafting…' : 'Generate preview' }}
            </button>
          </div>
          @if (previewText()) {
            <pre class="ap-dlg-preview__body">{{ previewText() }}</pre>
            @if (previewMedia()) {
              <div class="ap-dlg-preview__media">Suggested media: {{ previewMedia() }}</div>
            }
          } @else {
            <div class="ap-dlg-preview__empty">Click "Generate preview" to see one sample for {{ defLabel(previewNetwork()) }}.</div>
          }
        </div>
      </div>

      <div dialogFooter class="ap-dlg-footer">
        <button type="button" class="ap-dlg-btn ghost" (click)="closed.emit()">Cancel</button>
        <button
          type="button"
          class="ap-dlg-btn primary"
          (click)="save()"
          [disabled]="saving()">
          {{ saving() ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </app-dialog-shell>
  `,
  styles: [
    `
      .ap-dlg-icon { color: var(--ps-accent, #00e5ff); display: inline-flex; }
      .ap-dlg-badge {
        padding: 2px 10px; border-radius: 999px;
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 12%, transparent);
        border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 35%, transparent);
        color: var(--ps-accent, #00e5ff);
        font: 600 0.62rem 'JetBrains Mono', ui-monospace, monospace;
        letter-spacing: 0.08em; text-transform: uppercase;
      }
      .ap-dlg-body { padding: 18px 22px; display: flex; flex-direction: column; gap: 14px; }
      .ap-dlg-blurb { margin: 0; font-size: 0.82rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 70%, transparent); }
      .ap-dlg-blurb strong { color: var(--ps-accent, #00e5ff); }
      .ap-dlg-lbl {
        font-size: 0.72rem; font-weight: 600; letter-spacing: 0.04em;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 75%, transparent);
      }
      .ap-dlg-help {
        font-size: 0.66rem;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent);
        display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
      }
      .ap-dlg-help code {
        font-family: var(--ps-font-code, 'Fira Code', ui-monospace, monospace);
        background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 6%, transparent);
        border: 1px solid color-mix(in oklch, var(--ps-ink, #f4f4ff) 10%, transparent);
        border-radius: 4px; padding: 1px 5px;
      }
      .ap-dlg-link {
        background: none; border: none; cursor: pointer; padding: 0;
        color: var(--ps-accent, #00e5ff); font-size: 0.66rem;
        text-decoration: underline; text-underline-offset: 3px;
      }
      .ap-dlg-link:hover { color: color-mix(in oklch, var(--ps-accent, #00e5ff) 75%, #fff); }
      .ap-dlg-link:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 2px; }
      .ap-dlg-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
      .ap-dlg-chips { display: flex; flex-wrap: wrap; gap: 6px; }
      .ap-dlg-chip {
        --brand: var(--ps-accent, #00e5ff);
        border: 1px solid color-mix(in oklch, var(--ps-ink, #f4f4ff) 14%, transparent);
        background: transparent; cursor: pointer; border-radius: 999px;
        padding: 4px 10px; display: inline-flex; align-items: center; gap: 6px;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 60%, transparent);
        font-size: 0.72rem; font-family: inherit;
        transition: border-color 160ms ease, color 160ms ease, background 160ms ease;
      }
      .ap-dlg-chip:hover { color: var(--ps-ink, #f4f4ff); }
      .ap-dlg-chip.is-on {
        border-color: color-mix(in oklch, var(--brand) 45%, transparent);
        background: color-mix(in oklch, var(--brand) 12%, transparent);
        color: var(--brand);
      }
      .ap-dlg-chip:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
      .ap-dlg-preview {
        border: 1px solid color-mix(in oklch, var(--ps-ink, #f4f4ff) 10%, transparent);
        border-radius: 12px; padding: 12px; display: flex; flex-direction: column; gap: 8px;
      }
      .ap-dlg-preview__h { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
      .ap-dlg-preview__h span { font-size: 0.72rem; font-weight: 600; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 70%, transparent); }
      .ap-dlg-preview__body {
        margin: 0; white-space: pre-wrap; font-family: inherit;
        font-size: 0.76rem; color: var(--ps-ink, #f4f4ff);
      }
      .ap-dlg-preview__media { font-size: 0.66rem; color: var(--ps-accent, #00e5ff); }
      .ap-dlg-preview__empty { font-size: 0.68rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 78%, var(--ps-bg, #060610)); }
      .ap-dlg-footer { display: flex; justify-content: flex-end; gap: 10px; }
      .ap-dlg-btn {
        border-radius: 10px; padding: 8px 16px; font-size: 0.78rem; font-weight: 600;
        cursor: pointer; font-family: inherit;
        transition: border-color 160ms ease, color 160ms ease, background 160ms ease;
      }
      .ap-dlg-btn.ghost {
        background: transparent; border: 1px solid color-mix(in oklch, var(--ps-ink, #f4f4ff) 16%, transparent);
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 75%, transparent);
      }
      .ap-dlg-btn.ghost:hover { color: var(--ps-ink, #f4f4ff); border-color: color-mix(in oklch, var(--ps-accent, #00e5ff) 35%, transparent); }
      .ap-dlg-btn.primary {
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 18%, transparent);
        border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 40%, transparent);
        color: var(--ps-accent, #00e5ff);
      }
      .ap-dlg-btn.primary:hover { background: color-mix(in oklch, var(--ps-accent, #00e5ff) 28%, transparent); }
      .ap-dlg-btn:disabled { opacity: 0.6; cursor: not-allowed; }
    `,
  ],
})
export class SocialAutoPilotDialogComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);

  /** Live config (parent-owned) — seeds the drafts on open. */
  readonly prompt = input.required<string>();
  readonly cadenceHours = input.required<number>();
  readonly targetNetworks = input.required<string[]>();
  readonly defaultPrompt = input.required<string>();
  readonly platforms = input.required<readonly PlatformDefView[]>();

  /** Parent applies the server-returned config to its live signals. */
  readonly saved = output<AutoPilotSavedPayload>();
  /** User cancelled / backdrop closed. */
  readonly closed = output<void>();

  readonly promptDraft = signal('');
  readonly cadenceDraft = signal(24);
  readonly networksDraft = signal<string[]>([]);
  readonly previewNetwork = signal<string>('twitter');
  readonly previewing = signal(false);
  readonly previewText = signal('');
  readonly previewMedia = signal('');
  readonly saving = signal(false);

  readonly cadenceOptions = CADENCE_OPTIONS;

  ngOnInit(): void {
    this.promptDraft.set(this.prompt() || this.defaultPrompt());
    this.cadenceDraft.set(this.cadenceHours());
    this.networksDraft.set([...this.targetNetworks()]);
    const first = this.targetNetworks()[0];
    if (first) this.previewNetwork.set(first);
    this.previewText.set('');
    this.previewMedia.set('');
  }

  cadenceLabel(hours: number): string {
    return CADENCE_LABELS[hours] ?? `Every ${hours} hours`;
  }

  defLabel(pid: string | undefined): string {
    return this.platforms().find((p) => p.id === pid)?.label ?? 'the selected network';
  }

  resetToDefault(): void {
    this.promptDraft.set(this.defaultPrompt());
  }

  toggleNetwork(pid: string): void {
    this.networksDraft.update((nets) =>
      nets.includes(pid) ? nets.filter((n) => n !== pid) : [...nets, pid],
    );
    if (!this.networksDraft().includes(this.previewNetwork())) {
      const first = this.networksDraft()[0];
      if (first) this.previewNetwork.set(first);
    }
  }

  previewPost(): void {
    if (this.previewing()) return;
    this.previewing.set(true);
    this.previewText.set('');
    this.previewMedia.set('');
    this.api
      .post<{ data: { text: string; mediaSuggestion?: string } }>('/social/auto-pilot/preview', {
        network: this.previewNetwork(),
        prompt: this.promptDraft(),
      })
      .subscribe({
        next: (r) => {
          this.previewText.set(r?.data?.text ?? '');
          this.previewMedia.set(r?.data?.mediaSuggestion ?? '');
          this.previewing.set(false);
        },
        error: () => {
          this.previewing.set(false);
          this.toast.error('Preview failed — check that an AI provider is configured.');
        },
      });
  }

  save(): void {
    if (this.saving()) return;
    this.saving.set(true);
    this.api
      .post<{ data: AutoPilotSavedPayload }>('/social/auto-pilot/config', {
        prompt: this.promptDraft(),
        cadence_hours: this.cadenceDraft(),
        target_networks: this.networksDraft(),
      })
      .subscribe({
        next: (r) => {
          this.saving.set(false);
          if (r?.data) this.saved.emit(r.data);
        },
        error: () => {
          this.saving.set(false);
          this.toast.error('Save failed');
        },
      });
  }
}
