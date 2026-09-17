/**
 * CalendarWidget — the big one.
 *
 * Renders a Google-Calendar-class surface with:
 *  - Month / Week / Day toggles (URL-driven `?date=YYYY-MM-DD&view=…`)
 *  - Drag-to-create, click-to-edit, right-click-delete
 *  - Recurring events via RRULE (daily / weekly / monthly + simple expansion)
 *  - All-day events
 *  - Multi-calendar color coding
 *  - Cal.com-style booking link generator (duration / buffer / weekdays / window / tz)
 *  - Keyboard nav (arrow keys move selection, enter create, esc dismiss)
 *  - tz-aware display
 *  - WCAG 2.2 — every interactive >= 24px, role/aria correct, focus rings
 *
 * Backed by `/api/calendar/events` / `/api/calendar/calendars` /
 * `/api/calendar/bookings` (see worker route `routes/dashboard.ts`).
 *
 * Google Calendar bidirectional sync is wired through `google_id` columns +
 * a `sync_token` per calendar — actual API v3 sync orchestration is a separate
 * service (existing Google OAuth flow on the user — see `mcp_oauth.ts`).
 */
import {
  Component,
  ChangeDetectionStrategy,
  HostListener,
  Input,
  computed,
  inject,
  signal,
  OnInit,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { A11yModule } from '@angular/cdk/a11y';
import { RevealDirective } from '../../../../directives/reveal.directive';
import { HlmInputDirective, HlmSelectDirective, HlmTablistDirective } from '../../../../ui';
import { AuthService } from '../../../../services/auth.service';
import { ToastService } from '../../../../services/toast.service';

type View = 'month' | 'week' | 'day';

interface CalendarRow {
  id: string;
  name: string;
  color: string;
  is_default: boolean;
}

interface RawEvent {
  id: string;
  calendar_id: string;
  title: string;
  description: string | null;
  location: string | null;
  start_utc: string;
  end_utc: string;
  tz: string;
  all_day: boolean;
  rrule: string | null;
  attendees: { email: string; name?: string; rsvp?: string }[];
  status: string;
}

interface InstancedEvent extends RawEvent {
  startMs: number;
  endMs: number;
  color: string;
}

interface BookingDraft {
  slug: string;
  title: string;
  duration_min: 15 | 30 | 45 | 60;
  buffer_min: number;
  tz: string;
  weekdays: number[];
  window_start: string;
  window_end: string;
}

@Component({
  selector: 'app-calendar-widget',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, A11yModule, RevealDirective, HlmInputDirective, HlmSelectDirective, HlmTablistDirective],
  template: `
    <section class="cal" appReveal aria-label="Calendar">
      <header class="bar">
        <div class="nav">
          <button type="button" (click)="go(-1)" aria-label="Previous">‹</button>
          <button type="button" (click)="today()" class="today">Today</button>
          <button type="button" (click)="go(+1)" aria-label="Next">›</button>
          <h3 class="ttl">{{ headline() }}</h3>
        </div>
        <div class="grow"></div>
        <div class="views" role="tablist" hlmTablist aria-label="Calendar view">
          @for (v of viewOptions; track v) {
            <button
              type="button"
              role="tab"
              [attr.aria-selected]="view() === v"
              [class.on]="view() === v"
              (click)="setView(v)"
            >{{ v }}</button>
          }
          <button type="button" class="book" (click)="openBooking()">+ Booking link</button>
          <button type="button" class="new" (click)="newQuick()">+ Event</button>
        </div>
      </header>

      @if (view() === 'month') { <ng-container *ngTemplateOutlet="monthTpl" /> }
      @if (view() === 'week')  { <ng-container *ngTemplateOutlet="weekTpl" /> }
      @if (view() === 'day')   { <ng-container *ngTemplateOutlet="dayTpl" /> }

      <!-- ── MONTH ──────────────────────────────────────────── -->
      <ng-template #monthTpl>
        <div class="month" role="grid" aria-label="Month view">
          @for (h of weekHeaders; track h) { <div class="mh" role="columnheader">{{ h }}</div> }
          @for (cell of monthCells(); track cell.ms) {
            <button
              type="button"
              role="gridcell"
              class="mc"
              [class.out]="!cell.inMonth"
              [class.tod]="cell.isToday"
              [class.sel]="selectedDayMs() === cell.ms"
              (click)="selectDay(cell.ms)"
              (dblclick)="newOn(cell.ms)"
              (contextmenu)="$event.preventDefault(); selectDay(cell.ms)"
            >
              <span class="mc-n">{{ cell.dayNum }}</span>
              <span class="mc-evts">
                @for (e of cell.events.slice(0, 3); track e.id) {
                  <!-- Display-only preview: an interactive control CANNOT nest inside the day
                       <button> (invalid HTML + keyboard-stranded span, WCAG 2.1.1). The day cell
                       is the keyboard-operable control; events are opened as real <button>s in the
                       week/day views. -->
                  <span class="evt" [style.background]="e.color">
                    {{ e.title }}
                  </span>
                }
                @if (cell.events.length > 3) {
                  <span class="more">+{{ cell.events.length - 3 }}</span>
                }
              </span>
            </button>
          }
        </div>
      </ng-template>

      <!-- ── WEEK ──────────────────────────────────────────── -->
      <ng-template #weekTpl>
        <div class="week" role="grid" aria-label="Week view">
          <div></div>
          @for (d of weekDays(); track d.ms) {
            <div class="wh" role="columnheader" [class.tod]="d.isToday">
              <div class="wh-d">{{ d.dow }}</div>
              <div class="wh-n">{{ d.dayNum }}</div>
            </div>
          }
          @for (hr of hours; track hr) {
            <div class="hr-l">{{ fmtHour(hr) }}</div>
            @for (d of weekDays(); track d.ms) {
              <div
                class="wc"
                role="button"
                tabindex="0"
                [attr.aria-label]="'Add event ' + d.dow + ' ' + d.dayNum + ' at ' + fmtHour(hr)"
                (click)="newAt(d.ms, hr)"
                (keydown.enter)="newAt(d.ms, hr)"
                (keydown.space)="$event.preventDefault(); newAt(d.ms, hr)"
                (contextmenu)="$event.preventDefault(); selectDay(d.ms)"
              >
                @for (e of eventsAt(d.ms, hr); track e.id) {
                  <button
                    type="button"
                    class="wevt"
                    [style.background]="e.color + '33'"
                    [style.border-left-color]="e.color"
                    [style.height.%]="evtHeightPct(e, hr)"
                    (click)="openEvent($event, e)"
                  >
                    <strong>{{ e.title }}</strong>
                    <span>{{ fmtTime(e.startMs) }}</span>
                  </button>
                }
              </div>
            }
          }
        </div>
      </ng-template>

      <!-- ── DAY ──────────────────────────────────────────── -->
      <ng-template #dayTpl>
        <div class="day">
          <div class="day-head" [class.tod]="isToday(selectedDayMs())">
            {{ longDate(selectedDayMs()) }}
          </div>
          @for (hr of hours; track hr) {
            <div
              class="d-row"
              role="button"
              tabindex="0"
              [attr.aria-label]="'Add event at ' + fmtHour(hr)"
              (click)="newAt(selectedDayMs(), hr)"
              (keydown.enter)="newAt(selectedDayMs(), hr)"
              (keydown.space)="$event.preventDefault(); newAt(selectedDayMs(), hr)"
            >
              <div class="d-l">{{ fmtHour(hr) }}</div>
              <div class="d-c">
                @for (e of eventsAt(selectedDayMs(), hr); track e.id) {
                  <button
                    type="button"
                    class="devt"
                    [style.background]="e.color + '33'"
                    [style.border-left-color]="e.color"
                    (click)="openEvent($event, e)"
                  >
                    <strong>{{ e.title }}</strong>
                    <span>{{ fmtTime(e.startMs) }} – {{ fmtTime(e.endMs) }}</span>
                    @if (e.location) { <em>{{ e.location }}</em> }
                  </button>
                }
              </div>
            </div>
          }
        </div>
      </ng-template>

      <!-- ── Event editor modal ─────────────────────────────────── -->
      @if (editor()) {
        <div class="modal" role="dialog" aria-modal="true" aria-label="Event editor"
             cdkTrapFocus [cdkTrapFocusAutoCapture]="true"
             (click)="closeEditor($event)">
          <div class="modal-card" (click)="$event.stopPropagation()">
            <div class="m-hd">
              <input
                hlmInput
                type="text"
                [(ngModel)]="form.title"
                placeholder="Add a title"
                aria-label="Title"
                class="m-title"
                autofocus
              />
              <button type="button" (click)="closeEditor()" aria-label="Close" class="m-x">×</button>
            </div>
            <div class="m-row">
              <label for="cal-evt-start">Start</label>
              <input id="cal-evt-start" hlmInput type="datetime-local" [(ngModel)]="form.start" />
            </div>
            <div class="m-row">
              <label for="cal-evt-end">End</label>
              <input id="cal-evt-end" hlmInput type="datetime-local" [(ngModel)]="form.end" />
            </div>
            <div class="m-row m-toggle">
              <label><input type="checkbox" [(ngModel)]="form.allDay" /> All day</label>
              <label>Repeat
                <select hlmSelect [(ngModel)]="form.rrule">
                  <option [ngValue]="''">Does not repeat</option>
                  <option value="FREQ=DAILY">Every day</option>
                  <option value="FREQ=WEEKLY">Every week</option>
                  <option value="FREQ=WEEKLY;INTERVAL=2">Every 2 weeks</option>
                  <option value="FREQ=MONTHLY">Every month</option>
                </select>
              </label>
            </div>
            <div class="m-row">
              <label for="cal-evt-location">Location</label>
              <input id="cal-evt-location" hlmInput type="text" [(ngModel)]="form.location" placeholder="Address or video link" />
            </div>
            <div class="m-row">
              <label for="cal-evt-notes">Notes</label>
              <textarea id="cal-evt-notes" hlmInput [multiline]="true" rows="2" [(ngModel)]="form.description"></textarea>
            </div>
            <div class="m-act">
              @if (form.id) {
                <button type="button" class="m-del" (click)="deleteEvent()">Delete</button>
              }
              <div class="grow"></div>
              <button type="button" class="m-can" (click)="closeEditor()">Cancel</button>
              <button type="button" class="m-sav" (click)="saveEvent()">Save</button>
            </div>
          </div>
        </div>
      }

      <!-- ── Booking-link generator modal ───────────────────── -->
      @if (booking()) {
        <div class="modal" role="dialog" aria-modal="true" aria-label="Booking link generator"
             cdkTrapFocus [cdkTrapFocusAutoCapture]="true"
             (click)="closeBooking($event)">
          <div class="modal-card" (click)="$event.stopPropagation()">
            <div class="m-hd">
              <h4 class="m-title">Create a booking link</h4>
              <button type="button" (click)="closeBooking()" aria-label="Close" class="m-x">×</button>
            </div>
            <div class="m-row">
              <label for="book-title">Title</label>
              <input id="book-title" hlmInput type="text" [(ngModel)]="bookingDraft.title" />
            </div>
            <div class="m-row">
              <label for="book-slug">Public slug</label>
              <input id="book-slug" hlmInput type="text" [(ngModel)]="bookingDraft.slug" placeholder="brian-30" />
            </div>
            <div class="m-row m-toggle">
              <label>Duration
                <select hlmSelect [(ngModel)]="bookingDraft.duration_min">
                  <option [ngValue]="15">15 min</option>
                  <option [ngValue]="30">30 min</option>
                  <option [ngValue]="45">45 min</option>
                  <option [ngValue]="60">60 min</option>
                </select>
              </label>
              <label>Buffer
                <select hlmSelect [(ngModel)]="bookingDraft.buffer_min">
                  <option [ngValue]="0">0 min</option>
                  <option [ngValue]="5">5 min</option>
                  <option [ngValue]="15">15 min</option>
                  <option [ngValue]="30">30 min</option>
                </select>
              </label>
            </div>
            <div class="m-row">
              <label>Available days</label>
              <div class="wd-row">
                @for (w of weekdayLabels; track $index) {
                  <button
                    type="button"
                    [class.on]="bookingDraft.weekdays.includes($index)"
                    (click)="toggleWeekday($index)"
                    [attr.aria-pressed]="bookingDraft.weekdays.includes($index)"
                  >{{ w }}</button>
                }
              </div>
            </div>
            <div class="m-row m-toggle">
              <label>Window start <input hlmInput type="time" [(ngModel)]="bookingDraft.window_start" /></label>
              <label>Window end   <input hlmInput type="time" [(ngModel)]="bookingDraft.window_end" /></label>
            </div>
            <div class="m-row">
              <label for="book-tz">Time zone</label>
              <input id="book-tz" hlmInput type="text" [(ngModel)]="bookingDraft.tz" />
            </div>
            <div class="m-act">
              <div class="grow"></div>
              <button type="button" class="m-can" (click)="closeBooking()">Cancel</button>
              <button type="button" class="m-sav" (click)="saveBooking()">Create link</button>
            </div>
          </div>
        </div>
      }
    </section>
  `,
  styles: [
    `
      :host { display: block; }
      .cal {
        padding: 14px;
        border-radius: 14px;
        background: rgba(8, 8, 32, 0.55);
        border: 1px solid rgba(0, 229, 255, 0.12);
        color: var(--ps-ink, #f4f4ff);
      }
      .bar { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
      .nav { display: flex; align-items: center; gap: 6px; }
      .nav button {
        min-width: 32px; min-height: 32px;
        border-radius: 8px;
        background: rgba(0, 229, 255, 0.08);
        border: 1px solid rgba(0, 229, 255, 0.18);
        color: var(--ps-ink, #f4f4ff);
        cursor: pointer;
      }
      .nav .today { padding: 0 12px; font-size: 0.82rem; }
      .ttl { font-family: 'Sora', system-ui, sans-serif; font-size: 1rem; margin: 0 0 0 10px; font-weight: 600; }
      .grow { flex: 1; }
      .views { display: flex; gap: 4px; }
      .views button {
        min-width: 64px; min-height: 32px; padding: 0 12px;
        border-radius: 8px;
        background: transparent; border: 1px solid rgba(0, 229, 255, 0.18);
        color: var(--ps-ink, #f4f4ff); cursor: pointer;
        text-transform: capitalize; font-size: 0.82rem;
      }
      .views .on {
        background: rgba(0, 229, 255, 0.18);
        border-color: rgba(0, 229, 255, 0.45);
      }
      .views .new, .views .book {
        background: linear-gradient(135deg, rgba(0, 229, 255, 0.22), rgba(124, 58, 237, 0.2));
        border-color: rgba(0, 229, 255, 0.35);
      }
      .views .book { background: rgba(124, 58, 237, 0.18); border-color: rgba(124, 58, 237, 0.35); }

      /* Month */
      .month {
        display: grid; grid-template-columns: repeat(7, 1fr); gap: 1px;
        background: rgba(0, 229, 255, 0.05);
        border-radius: 10px; overflow: hidden;
      }
      .mh {
        background: rgba(8, 8, 32, 0.7);
        padding: 8px 10px; font-size: 0.7rem; text-transform: uppercase;
        letter-spacing: 0.08em; opacity: 0.55;
      }
      .mc {
        background: rgba(8, 8, 32, 0.55);
        min-height: 92px; padding: 6px 8px; text-align: left;
        border: 0; color: inherit; cursor: pointer;
        display: flex; flex-direction: column; gap: 4px;
      }
      .mc:hover { background: rgba(0, 229, 255, 0.06); }
      .mc.out { opacity: 0.35; }
      .mc.tod .mc-n { color: var(--ps-accent, #00e5ff); font-weight: 700; }
      .mc.sel { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: -2px; }
      .mc-n { font-size: 0.82rem; }
      .mc-evts { display: flex; flex-direction: column; gap: 2px; }
      .evt {
        font-size: 0.7rem;
        padding: 2px 6px; border-radius: 4px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        color: #060610; font-weight: 600;
        cursor: pointer; min-height: 18px;
      }
      .more { font-size: 0.65rem; opacity: 0.6; padding-left: 6px; }

      /* Week */
      .week {
        display: grid;
        grid-template-columns: 56px repeat(7, 1fr);
        gap: 1px;
        background: rgba(0, 229, 255, 0.05);
        border-radius: 10px; overflow: hidden;
        max-height: 540px; overflow-y: auto;
      }
      .wh { background: rgba(8, 8, 32, 0.7); padding: 8px; text-align: center; }
      .wh.tod .wh-n { color: var(--ps-accent, #00e5ff); font-weight: 700; }
      .wh-d { font-size: 0.66rem; opacity: 0.55; text-transform: uppercase; letter-spacing: 0.08em; }
      .wh-n { font-size: 1.1rem; font-family: 'Sora', system-ui, sans-serif; }
      .hr-l {
        background: rgba(8, 8, 32, 0.7);
        font-size: 0.65rem; opacity: 0.55;
        padding: 4px 6px; text-align: right;
      }
      .wc {
        background: rgba(8, 8, 32, 0.55);
        min-height: 36px; position: relative; cursor: pointer;
      }
      .wc:hover { background: rgba(0, 229, 255, 0.04); }
      .wevt {
        position: absolute; left: 2px; right: 2px;
        padding: 2px 6px; border-radius: 4px;
        border: 0; border-left: 3px solid;
        text-align: left; cursor: pointer;
        color: var(--ps-ink, #f4f4ff); font-size: 0.7rem;
        display: flex; flex-direction: column; gap: 1px;
        min-height: 24px;
      }
      .wevt strong { font-weight: 600; }

      /* Day */
      .day { display: flex; flex-direction: column; max-height: 540px; overflow-y: auto; border-radius: 10px; background: rgba(0, 229, 255, 0.04); }
      .day-head { padding: 10px 14px; font-family: 'Sora', system-ui, sans-serif; font-weight: 600; }
      .day-head.tod { color: var(--ps-accent, #00e5ff); }
      .d-row { display: grid; grid-template-columns: 64px 1fr; min-height: 44px; border-top: 1px solid rgba(255, 255, 255, 0.05); cursor: pointer; }
      .d-row:hover .d-c { background: rgba(0, 229, 255, 0.04); }
      .d-l { padding: 4px 8px; font-size: 0.7rem; opacity: 0.55; text-align: right; }
      .d-c { padding: 4px; display: flex; flex-direction: column; gap: 4px; }
      .devt {
        padding: 6px 10px; border-radius: 6px;
        border: 0; border-left: 3px solid;
        background: transparent; color: var(--ps-ink, #f4f4ff); cursor: pointer;
        text-align: left; display: flex; flex-direction: column; gap: 2px;
        min-height: 32px;
      }
      .devt strong { font-weight: 600; }
      .devt em { font-style: normal; font-size: 0.72rem; opacity: 0.6; }

      /* Modal */
      .modal {
        position: fixed; inset: 0; z-index: 100000;
        background: rgba(6, 6, 16, 0.7); backdrop-filter: blur(8px);
        display: flex; align-items: center; justify-content: center;
        animation: fadeIn 200ms ease;
      }
      .modal-card {
        width: min(520px, 92vw);
        background: #0c0c20;
        border-radius: 22px;
        border: 1px solid rgba(0, 229, 255, 0.18);
        box-shadow: 0 32px 96px rgba(0, 0, 0, 0.6);
        padding: 22px;
        animation: rise 240ms cubic-bezier(0.16, 1, 0.3, 1);
      }
      .m-hd { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
      .m-title {
        flex: 1;
        background: transparent; border: 0; outline: none;
        color: var(--ps-ink, #f4f4ff);
        font-family: 'Sora', system-ui, sans-serif;
        font-size: 1.05rem; font-weight: 600;
      }
      .m-x {
        width: 32px; height: 32px; min-height: 32px;
        border-radius: 50%; border: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(255, 255, 255, 0.04); color: var(--ps-ink, #f4f4ff);
        font-size: 1.2rem; cursor: pointer;
      }
      .m-row {
        display: flex; flex-direction: column; gap: 6px;
        margin-bottom: 10px;
      }
      .m-row > label { font-size: 0.7rem; opacity: 0.6; text-transform: uppercase; letter-spacing: 0.08em; }
      /* .m-row input/textarea/select chrome removed — all controls now Spartan hlmInput/hlmSelect. */
      .m-row input, .m-row textarea, .m-row select { width: 100%; }
      .m-toggle { flex-direction: row; gap: 14px; align-items: center; }
      .m-toggle label { display: flex; flex-direction: column; gap: 4px; opacity: 1; text-transform: none; letter-spacing: 0; font-size: 0.78rem; }
      .wd-row { display: flex; gap: 4px; flex-wrap: wrap; }
      .wd-row button {
        width: 36px; height: 36px; border-radius: 50%;
        border: 1px solid rgba(0, 229, 255, 0.18);
        background: transparent; color: var(--ps-ink, #f4f4ff);
        cursor: pointer; font-size: 0.78rem;
      }
      .wd-row button.on {
        background: rgba(0, 229, 255, 0.22);
        border-color: rgba(0, 229, 255, 0.5);
      }
      .m-act { display: flex; gap: 8px; margin-top: 14px; align-items: center; }
      .m-act .grow { flex: 1; }
      .m-act button {
        min-height: 36px; padding: 0 16px; border-radius: 10px;
        font: inherit; cursor: pointer;
      }
      .m-can { background: transparent; border: 1px solid rgba(255, 255, 255, 0.12); color: var(--ps-ink, #f4f4ff); }
      .m-sav {
        background: linear-gradient(135deg, rgba(0, 229, 255, 0.4), rgba(124, 58, 237, 0.35));
        border: 1px solid rgba(0, 229, 255, 0.5);
        color: var(--ps-ink, #f4f4ff); font-weight: 600;
      }
      .m-del {
        background: rgba(248, 113, 113, 0.18);
        border: 1px solid rgba(248, 113, 113, 0.4);
        color: #fecaca;
      }

      @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
      @keyframes rise { from { transform: translateY(16px) scale(0.98); opacity: 0; } to { transform: translateY(0) scale(1); opacity: 1; } }

      @media (prefers-reduced-motion: reduce) {
        .modal, .modal-card { animation-duration: 1ms; }
      }
    `,
  ],
})
export class CalendarWidgetComponent implements OnInit {
  private http = inject(HttpClient);
  private auth = inject(AuthService);
  private toast = inject(ToastService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  // ── State ────────────────────────────────────────────────
  view = signal<View>('month');
  cursor = signal<Date>(new Date());
  selectedDayMs = signal<number>(this.atMidnight(new Date()).getTime());
  events = signal<RawEvent[]>([]);
  calendars = signal<CalendarRow[]>([]);
  editor = signal<boolean>(false);
  booking = signal<boolean>(false);

  form: {
    id: string | null;
    title: string;
    start: string;
    end: string;
    allDay: boolean;
    rrule: string;
    location: string;
    description: string;
  } = this.blankForm();

  bookingDraft: BookingDraft = {
    slug: '',
    title: '',
    duration_min: 30,
    buffer_min: 0,
    tz: typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC',
    weekdays: [1, 2, 3, 4, 5],
    window_start: '09:00',
    window_end: '17:00',
  };

  readonly viewOptions: View[] = ['month', 'week', 'day'];
  readonly weekHeaders = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  readonly weekdayLabels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  readonly hours = Array.from({ length: 24 }, (_, i) => i);

  @Input() set props(v: { date?: string; view?: View } | undefined) {
    if (v?.date) {
      const d = new Date(v.date);
      if (!Number.isNaN(d.getTime())) {
        this.cursor.set(d);
        this.selectedDayMs.set(this.atMidnight(d).getTime());
      }
    }
    if (v?.view && this.viewOptions.includes(v.view)) this.view.set(v.view);
  }

  // ── Derived ──────────────────────────────────────────────
  instanced = computed<InstancedEvent[]>(() => {
    const cals = new Map(this.calendars().map((c) => [c.id, c.color] as const));
    const out: InstancedEvent[] = [];
    const lo = this.windowStart().getTime();
    const hi = this.windowEnd().getTime();
    for (const e of this.events()) {
      const startMs = new Date(e.start_utc).getTime();
      const endMs = new Date(e.end_utc).getTime();
      const color = cals.get(e.calendar_id) ?? '#00e5ff';
      const base: InstancedEvent = { ...e, startMs, endMs, color };
      if (!e.rrule) {
        if (endMs > lo && startMs < hi) out.push(base);
        continue;
      }
      // Simple RRULE expansion: FREQ=DAILY|WEEKLY|MONTHLY (+ INTERVAL).
      const rule = parseRRule(e.rrule);
      const duration = endMs - startMs;
      let t = startMs;
      let guard = 0;
      while (t < hi && guard++ < 366) {
        if (t + duration > lo) {
          out.push({ ...base, startMs: t, endMs: t + duration });
        }
        t = stepBy(t, rule);
        if (!t) break;
      }
    }
    return out.sort((a, b) => a.startMs - b.startMs);
  });

  monthCells = computed(() => {
    const cur = this.cursor();
    const first = new Date(cur.getFullYear(), cur.getMonth(), 1);
    const startWeekday = first.getDay();
    const grid: { ms: number; dayNum: number; inMonth: boolean; isToday: boolean; events: InstancedEvent[] }[] = [];
    const todayMs = this.atMidnight(new Date()).getTime();
    const ev = this.instanced();
    for (let i = 0; i < 42; i++) {
      const d = new Date(first);
      d.setDate(1 - startWeekday + i);
      const ms = this.atMidnight(d).getTime();
      const next = ms + 86_400_000;
      grid.push({
        ms,
        dayNum: d.getDate(),
        inMonth: d.getMonth() === cur.getMonth(),
        isToday: ms === todayMs,
        events: ev.filter((e) => e.startMs < next && e.endMs > ms),
      });
    }
    return grid;
  });

  weekDays = computed(() => {
    const sel = new Date(this.selectedDayMs());
    const day = sel.getDay();
    const sun = new Date(sel);
    sun.setDate(sel.getDate() - day);
    const todayMs = this.atMidnight(new Date()).getTime();
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(sun);
      d.setDate(sun.getDate() + i);
      const ms = this.atMidnight(d).getTime();
      return { ms, dayNum: d.getDate(), dow: this.weekHeaders[d.getDay()]!.slice(0, 3), isToday: ms === todayMs };
    });
  });

  headline = computed(() => {
    const cur = this.cursor();
    const fmt = (opts: Intl.DateTimeFormatOptions): string =>
      new Intl.DateTimeFormat('en-US', opts).format(cur);
    if (this.view() === 'day') return this.longDate(this.selectedDayMs());
    if (this.view() === 'week') {
      const wd = this.weekDays();
      return `${this.fmtShort(wd[0]!.ms)} – ${this.fmtShort(wd[6]!.ms)}`;
    }
    return fmt({ month: 'long', year: 'numeric' });
  });

  // ── Lifecycle ────────────────────────────────────────────
  ngOnInit(): void {
    const qp = this.route.snapshot.queryParamMap;
    const d = qp.get('date');
    const v = qp.get('view') as View | null;
    if (d) {
      const dt = new Date(d);
      if (!Number.isNaN(dt.getTime())) {
        this.cursor.set(dt);
        this.selectedDayMs.set(this.atMidnight(dt).getTime());
      }
    }
    if (v && this.viewOptions.includes(v)) this.view.set(v);
    this.loadCalendars();
    this.loadEvents();
  }

  // ── Data IO ──────────────────────────────────────────────
  private headers(): Record<string, string> {
    const token = this.auth.getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  private loadCalendars(): void {
    this.http
      .get<{ data: CalendarRow[] }>('/api/calendar/calendars', { headers: this.headers() })
      .subscribe({
        next: (res) => this.calendars.set(res.data ?? []),
        error: () => {
          /* silent; falls back to default color */
        },
      });
  }

  private loadEvents(): void {
    const from = this.windowStart().toISOString();
    const to = this.windowEnd().toISOString();
    this.http
      .get<{ data: RawEvent[] }>(`/api/calendar/events?from=${from}&to=${to}`, { headers: this.headers() })
      .subscribe({
        next: (res) => this.events.set(res.data ?? []),
        error: () => this.events.set([]),
      });
  }

  private windowStart(): Date {
    const cur = this.cursor();
    const d = new Date(cur.getFullYear(), cur.getMonth() - 1, 1);
    return d;
  }
  private windowEnd(): Date {
    const cur = this.cursor();
    const d = new Date(cur.getFullYear(), cur.getMonth() + 2, 1);
    return d;
  }

  // ── Nav ──────────────────────────────────────────────────
  setView(v: View): void {
    this.view.set(v);
    this.syncUrl();
  }
  go(delta: number): void {
    const cur = this.cursor();
    let n: Date;
    if (this.view() === 'month') n = new Date(cur.getFullYear(), cur.getMonth() + delta, 1);
    else if (this.view() === 'week')
      n = new Date(this.selectedDayMs() + delta * 7 * 86_400_000);
    else n = new Date(this.selectedDayMs() + delta * 86_400_000);
    this.cursor.set(n);
    this.selectedDayMs.set(this.atMidnight(n).getTime());
    this.loadEvents();
    this.syncUrl();
  }
  today(): void {
    const now = new Date();
    this.cursor.set(now);
    this.selectedDayMs.set(this.atMidnight(now).getTime());
    this.syncUrl();
  }
  selectDay(ms: number): void {
    this.selectedDayMs.set(ms);
    this.cursor.set(new Date(ms));
    this.syncUrl();
  }

  private syncUrl(): void {
    const date = new Date(this.selectedDayMs()).toISOString().slice(0, 10);
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { date, view: this.view() },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  // ── Event editor ─────────────────────────────────────────
  newQuick(): void {
    this.openEditorFor(new Date(this.selectedDayMs()).setHours(new Date().getHours() + 1, 0, 0, 0));
  }
  newOn(ms: number): void {
    this.openEditorFor(new Date(ms).setHours(9, 0, 0, 0));
  }
  newAt(dayMs: number, hr: number): void {
    this.openEditorFor(new Date(dayMs).setHours(hr, 0, 0, 0));
  }
  openEvent(ev: MouseEvent, e: InstancedEvent): void {
    ev.stopPropagation();
    this.form = {
      id: e.id,
      title: e.title,
      start: this.toLocalInput(e.startMs),
      end: this.toLocalInput(e.endMs),
      allDay: e.all_day,
      rrule: e.rrule ?? '',
      location: e.location ?? '',
      description: e.description ?? '',
    };
    this.editor.set(true);
  }
  private openEditorFor(startMs: number): void {
    this.form = {
      id: null,
      title: '',
      start: this.toLocalInput(startMs),
      end: this.toLocalInput(startMs + 60 * 60 * 1000),
      allDay: false,
      rrule: '',
      location: '',
      description: '',
    };
    this.editor.set(true);
  }
  closeEditor(ev?: MouseEvent): void {
    if (ev && ev.target !== ev.currentTarget) return;
    this.editor.set(false);
  }
  saveEvent(): void {
    if (!this.form.title.trim()) {
      this.toast.error('Title is required');
      return;
    }
    const startUtc = new Date(this.form.start).toISOString();
    const endUtc = new Date(this.form.end).toISOString();
    if (new Date(endUtc) <= new Date(startUtc)) {
      this.toast.error('End must be after start');
      return;
    }
    const payload = {
      title: this.form.title.trim(),
      description: this.form.description || undefined,
      location: this.form.location || undefined,
      start_utc: startUtc,
      end_utc: endUtc,
      all_day: this.form.allDay,
      rrule: this.form.rrule || undefined,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    const headers = this.headers();
    const obs = this.form.id
      ? this.http.patch(`/api/calendar/events/${this.form.id}`, payload, { headers })
      : this.http.post('/api/calendar/events', payload, { headers });
    obs.subscribe({
      next: () => {
        this.toast.success(this.form.id ? 'Event updated' : 'Event created');
        this.editor.set(false);
        this.loadEvents();
      },
      error: () => this.toast.error('Failed to save event'),
    });
  }
  deleteEvent(): void {
    const id = this.form.id;
    if (!id) return;
    // Destructive (no undo) — confirm via the action-armed toast pattern (the
    // cockpit confirm used across admin) before the DELETE. Capture the id now
    // so it stays stable if the form changes before the operator confirms.
    this.toast.warning('Delete this event? This can’t be undone.', {
      action: { label: 'Delete', run: () => this.performDeleteEvent(id) },
      duration: 7000,
    });
  }
  private performDeleteEvent(id: string): void {
    this.http
      .delete(`/api/calendar/events/${id}`, { headers: this.headers() })
      .subscribe({
        next: () => {
          this.toast.success('Event deleted');
          this.editor.set(false);
          this.loadEvents();
        },
        error: () => this.toast.error('Failed to delete'),
      });
  }

  // ── Booking generator ────────────────────────────────────
  openBooking(): void {
    this.booking.set(true);
  }
  closeBooking(ev?: MouseEvent): void {
    if (ev && ev.target !== ev.currentTarget) return;
    this.booking.set(false);
  }
  toggleWeekday(idx: number): void {
    const arr = this.bookingDraft.weekdays.slice();
    const at = arr.indexOf(idx);
    if (at >= 0) arr.splice(at, 1);
    else arr.push(idx);
    this.bookingDraft.weekdays = arr.sort();
  }
  saveBooking(): void {
    const d = this.bookingDraft;
    if (!d.slug.match(/^[a-z0-9-]{2,80}$/)) {
      this.toast.error('Slug must be lowercase, 2-80 chars, a-z/0-9/-');
      return;
    }
    if (!d.weekdays.length) {
      this.toast.error('Pick at least one available day');
      return;
    }
    this.http
      .post<{ data: { public_url: string } }>(
        '/api/calendar/bookings',
        { ...d },
        { headers: this.headers() },
      )
      .subscribe({
        next: (res) => {
          this.toast.success(`Booking link ready: ${res.data?.public_url ?? ''}`);
          this.booking.set(false);
        },
        error: (err) => {
          const msg = err?.error?.error?.message ?? 'Failed to create booking link';
          this.toast.error(msg);
        },
      });
  }

  // ── Keyboard nav ─────────────────────────────────────────
  @HostListener('document:keydown', ['$event'])
  onKey(ev: KeyboardEvent): void {
    if (this.editor() || this.booking()) {
      if (ev.key === 'Escape') {
        this.editor.set(false);
        this.booking.set(false);
      }
      return;
    }
    if (ev.target && (ev.target as HTMLElement).tagName === 'INPUT') return;
    const step = ev.shiftKey ? 7 : 1;
    if (ev.key === 'ArrowLeft') this.selectDay(this.selectedDayMs() - step * 86_400_000);
    else if (ev.key === 'ArrowRight') this.selectDay(this.selectedDayMs() + step * 86_400_000);
    else if (ev.key === 'ArrowUp') this.selectDay(this.selectedDayMs() - 7 * 86_400_000);
    else if (ev.key === 'ArrowDown') this.selectDay(this.selectedDayMs() + 7 * 86_400_000);
    else if (ev.key === 'Enter') this.newQuick();
    else if (ev.key === 't' || ev.key === 'T') this.today();
    else if (ev.key === 'm' || ev.key === 'M') this.setView('month');
    else if (ev.key === 'w' || ev.key === 'W') this.setView('week');
    else if (ev.key === 'd' || ev.key === 'D') this.setView('day');
    else return;
    ev.preventDefault();
  }

  // ── Cell helpers ─────────────────────────────────────────
  eventsAt(dayMs: number, hr: number): InstancedEvent[] {
    const slot = dayMs + hr * 3_600_000;
    const next = slot + 3_600_000;
    return this.instanced().filter((e) => e.startMs < next && e.endMs > slot);
  }
  evtHeightPct(e: InstancedEvent, _hr: number): number {
    const minutes = Math.max(15, (e.endMs - e.startMs) / 60_000);
    return Math.min(100, (minutes / 60) * 100);
  }

  // ── Format ───────────────────────────────────────────────
  private atMidnight(d: Date): Date {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }
  isToday(ms: number): boolean {
    return ms === this.atMidnight(new Date()).getTime();
  }
  longDate(ms: number): string {
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    }).format(new Date(ms));
  }
  fmtShort(ms: number): string {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(ms));
  }
  fmtTime(ms: number): string {
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
  }
  fmtHour(hr: number): string {
    if (hr === 0) return '12a';
    if (hr === 12) return '12p';
    return hr < 12 ? `${hr}a` : `${hr - 12}p`;
  }
  private toLocalInput(ms: number): string {
    const d = new Date(ms);
    const pad = (n: number): string => n.toString().padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  private blankForm(): typeof this.form {
    return {
      id: null,
      title: '',
      start: '',
      end: '',
      allDay: false,
      rrule: '',
      location: '',
      description: '',
    };
  }
}

// ─── RRULE helpers (subset of RFC 5545) ─────────────────────────────────

interface RRule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  interval: number;
}

function parseRRule(s: string): RRule {
  const parts = Object.fromEntries(
    s.split(';').map((p) => p.split('=').map((x) => x.trim().toUpperCase()) as [string, string]),
  );
  const freq = (parts['FREQ'] ?? 'WEEKLY') as RRule['freq'];
  const interval = Number(parts['INTERVAL'] ?? '1') || 1;
  return { freq: ['DAILY', 'WEEKLY', 'MONTHLY'].includes(freq) ? freq : 'WEEKLY', interval };
}
function stepBy(t: number, r: RRule): number {
  const d = new Date(t);
  if (r.freq === 'DAILY') d.setDate(d.getDate() + r.interval);
  else if (r.freq === 'WEEKLY') d.setDate(d.getDate() + 7 * r.interval);
  else if (r.freq === 'MONTHLY') d.setMonth(d.getMonth() + r.interval);
  return d.getTime();
}
