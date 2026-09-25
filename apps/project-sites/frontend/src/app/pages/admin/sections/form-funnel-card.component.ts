/**
 * Contact-form LEAD FUNNEL card — the "are my form leads getting through?" block of
 * `/admin/analytics`.
 *
 * Renders `traffic.formFunnel`: `form_start` (a VALIDATED submit attempt — name+email present,
 * message ≥10 chars) → `form_submit` (a server-CONFIRMED 200). So `starts` = serious attempts,
 * `submits` = delivered leads, and `starts − submits` = the owner's LOST leads (abandoned or
 * failed). `completionRatePercent` = submits/starts. Both events are beacon-emitted (app.js) on
 * every generated site. Focused, standalone, presentational (signals + `input()`, no fetching).
 *
 * DISTINCT from the "Conversions by kind" card (which counts form SUCCESSES as one conversion
 * kind): this funnel is the ONLY view that surfaces form ABANDONMENT — the drop-off between
 * attempt and delivery, the single most actionable lead-gen signal for a small-business owner.
 *
 * HONESTY: counts are real tracked events. `completionRatePercent` renders "—" (not 0%) when it
 * is null (submits with no tracked starts — a lost-start-beacon anomaly), and a site with no form
 * activity shows an explicit empty state, never a fabricated 0% or a phantom funnel. No drilldown
 * (the form key is not a server filter dimension — the card is purely presentational).
 */
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** One form's funnel over the window (`form` = the beacon's form id/name, or 'contact'). */
export interface FormFunnelForm {
  form: string;
  starts: number;
  submits: number;
  completionRatePercent: number | null;
}

/** The site-wide contact-form funnel: totals + per-form breakdown. */
export interface FormFunnel {
  starts: number;
  submits: number;
  completionRatePercent: number | null;
  byForm: FormFunnelForm[];
}

@Component({
  selector: 'app-form-funnel-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card ff" data-testid="an-form-funnel">
      <div class="ff-kicker">Lead funnel</div>
      <h3 class="ff-head">
        <span class="ff-title">Contact form</span>
        <span
          class="ff-sub"
          data-testid="an-form-funnel-source"
          title="Form starts (a validated submit attempt) vs submits (a server-confirmed success). A count of real tracked events, never an estimate. The gap is leads that didn't get through."
        >last {{ windowDays() }} {{ windowDays() === 1 ? 'day' : 'days' }} · started → submitted</span>
      </h3>

      @if (hasActivity()) {
        <div class="ff-headline">
          <span
            class="ff-rate"
            data-testid="an-form-funnel-rate"
            [attr.aria-label]="rateAria()"
          >{{ rateDisplay() }}</span>
          <span class="ff-rate-label">completion</span>
        </div>

        <div class="ff-bars" aria-hidden="true">
          <div class="ff-step">
            <div class="ff-step-head"><span>Started</span><span class="ff-num">{{ starts() }}</span></div>
            <div class="ff-bar"><div class="ff-bar-fill is-start" [style.width.%]="100"></div></div>
          </div>
          <div class="ff-step">
            <div class="ff-step-head"><span>Submitted</span><span class="ff-num">{{ submits() }}</span></div>
            <div class="ff-bar"><div class="ff-bar-fill is-submit" [style.width.%]="submitWidth()"></div></div>
          </div>
        </div>

        @if (abandoned() > 0) {
          <p class="ff-lost" data-testid="an-form-funnel-lost">
            <strong>{{ abandoned() }}</strong> {{ abandoned() === 1 ? 'lead' : 'leads' }} started but didn't get through — worth a look at your form.
          </p>
        }

        @if (forms().length > 1) {
          <ul class="ff-list">
            @for (f of forms(); track f.form) {
              <li class="ff-form-row" data-testid="an-form-funnel-form">
                <div class="ff-form-head">
                  <span class="ff-form-name" [attr.title]="f.form">{{ f.form }}</span>
                  <span class="ff-form-stat">
                    {{ f.submits }}/{{ f.starts }}
                    <span class="ff-form-pct">· {{ f.completionRatePercent === null ? '—' : f.completionRatePercent + '%' }}</span>
                  </span>
                </div>
                <div class="ff-bar sm"><div class="ff-bar-fill is-submit" [style.width.%]="formWidth(f)"></div></div>
              </li>
            }
          </ul>
        }
      } @else {
        <p class="ff-empty" data-testid="an-form-funnel-empty">
          No form activity yet. Once visitors start filling in your contact form, this shows how
          many attempts get through — a real starts-vs-submits funnel, never an estimate.
        </p>
      }
    </section>
  `,
  styles: [`
    :host { display: block; }
    .ff-kicker {
      font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.62rem; font-weight: 700;
      letter-spacing: 0.14em; text-transform: uppercase; color: var(--ps-accent, #00e5ff); opacity: 0.85;
    }
    .ff-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0.5rem; margin: 0.25rem 0 0.9rem; }
    .ff-title { font-family: 'Sora', system-ui, sans-serif; font-weight: 600; letter-spacing: -0.02em; font-size: 1rem; color: #fff; }
    .ff-sub { font-size: 0.62rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); cursor: help; }
    .ff-headline { display: flex; align-items: baseline; gap: 0.45rem; margin-bottom: 0.9rem; }
    .ff-rate { font-family: 'Sora', system-ui, sans-serif; font-weight: 700; font-size: 2rem; line-height: 1; color: var(--ps-accent, #00e5ff); font-variant-numeric: tabular-nums; }
    .ff-rate-label { font-size: 0.68rem; letter-spacing: 0.06em; text-transform: uppercase; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); }
    .ff-bars { display: grid; gap: 0.6rem; }
    .ff-step-head { display: flex; justify-content: space-between; gap: 0.6rem; margin-bottom: 0.2rem; font-size: 0.76rem; color: #fff; }
    .ff-num { font-weight: 600; color: var(--ps-accent, #00e5ff); font-variant-numeric: tabular-nums; }
    .ff-bar { height: 8px; border-radius: 999px; background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 8%, transparent); overflow: hidden; }
    .ff-bar.sm { height: 5px; }
    .ff-bar-fill { height: 100%; border-radius: 999px; }
    .ff-bar-fill.is-start { background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 30%, transparent); }
    .ff-bar-fill.is-submit { background: linear-gradient(90deg, color-mix(in oklch, var(--ps-accent, #00e5ff) 70%, transparent), var(--ps-accent, #00e5ff)); }
    .ff-lost { margin: 0.85rem 0 0; font-size: 0.72rem; line-height: 1.5; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 70%, transparent); }
    .ff-lost strong { color: #fff; }
    .ff-list { list-style: none; margin: 0.95rem 0 0; padding: 0.85rem 0 0; border-top: 1px solid color-mix(in oklch, var(--ps-ink, #f4f4ff) 10%, transparent); display: grid; gap: 0.55rem; }
    .ff-form-head { display: flex; justify-content: space-between; gap: 0.6rem; margin-bottom: 0.2rem; }
    .ff-form-name { font-size: 0.76rem; color: #fff; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ff-form-stat { font-size: 0.72rem; font-weight: 600; color: var(--ps-accent, #00e5ff); font-variant-numeric: tabular-nums; flex-shrink: 0; }
    .ff-form-pct { color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 45%, transparent); font-size: 0.9em; }
    .ff-empty { margin: 0; font-size: 0.72rem; line-height: 1.5; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); }
  `],
})
export class FormFunnelCardComponent {
  /** `traffic.formFunnel` — the contact-form lead funnel (null/absent → honest empty state). */
  readonly funnel = input<FormFunnel | null>(null);
  /** Window length, for the "last N days" freshness label. */
  readonly windowDays = input<number>(30);

  /** True when there's any tracked form activity (a start OR a submit) — else the empty state. */
  readonly hasActivity = computed(() => this.starts() > 0 || this.submits() > 0);

  readonly starts = computed(() => Math.max(0, this.funnel()?.starts ?? 0));
  readonly submits = computed(() => Math.max(0, this.funnel()?.submits ?? 0));

  /** Validated starts that never became a confirmed submit — the owner's lost leads. */
  readonly abandoned = computed(() => Math.max(0, this.starts() - this.submits()));

  /** Per-form rows with any activity, sorted by starts desc (only shown when >1 form). */
  readonly forms = computed<FormFunnelForm[]>(() =>
    [...(this.funnel()?.byForm ?? [])]
      .filter((f) => f.starts > 0 || f.submits > 0)
      .sort((a, b) => b.starts - a.starts),
  );

  /** Completion rate for display: "—" when null (submits w/o starts), else "N%". */
  rateDisplay(): string {
    const r = this.funnel()?.completionRatePercent ?? null;
    return r === null ? '—' : `${r}%`;
  }

  /** Accessible label for the headline stat — spells out the funnel in words. */
  rateAria(): string {
    const r = this.funnel()?.completionRatePercent ?? null;
    const base = `${this.submits()} of ${this.starts()} form attempts submitted`;
    return r === null ? `${base} (completion rate unavailable)` : `${base}, ${r}% completion`;
  }

  /** Submit-bar width relative to starts (the funnel's second step). */
  submitWidth(): number {
    const s = this.starts();
    if (s > 0) return Math.min(100, Math.round((this.submits() / s) * 100));
    return this.submits() > 0 ? 100 : 0;
  }

  /** Per-form submit-bar width relative to that form's starts. */
  formWidth(f: FormFunnelForm): number {
    if (f.starts > 0) return Math.min(100, Math.round((f.submits / f.starts) * 100));
    return f.submits > 0 ? 100 : 0;
  }
}
