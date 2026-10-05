/**
 * `/admin/hosting` — WfP site-hosting owner surface (Unit 6 of the
 * `site_wfp_hosting` loop; spec `docs/wfp-site-hosting.md`).
 *
 * Shows, for the SELECTED site, WHERE it is served from:
 *   - a **status pill** — `R2 static` (the default byte-identical path) vs
 *     `WfP dispatch` (a per-site Worker on the shared `project-sites-endpoints`
 *     dispatch namespace), plus a provisioning state while a slot spins up;
 *   - the **preview URL** (`{branch}--{slug}.projectsites.dev` semantics) + the
 *     **production URL** (custom hostname or `{slug}.projectsites.dev`), each with
 *     a one-click copy button;
 *   - ONE obvious primary action — **Publish / Promote** — that pushes the
 *     latest build to the site's WfP slots (fail-soft to R2; never a dead
 *     control — disabled WITH the reason when a precondition is unmet);
 *   - all FOUR states: empty (→ launchpad), loading (skeleton), error
 *     (coherent, retryable — never a dead-end), success (live URLs + pill).
 *
 * Real-time: reads the ALREADY-loaded, visibility-aware-polled
 * `AdminStateService.selectedSite()` / `.sites()` (the shell calls `loadData()`
 * + `startPolling()` and refreshes every 30s, pausing on `document.hidden`), so
 * there is NO manual Refresh/Reconcile button here (per the real-time-data
 * rule) — the surface updates itself.
 *
 * Flag: gated on `site_wfp_hosting` (default OFF via the registry floor read
 * through `ApiService.getFeatureFlags()`). When OFF, this renders an HONEST
 * gated card ("Preview hosting — coming soon" + a disabled CTA WITH the reason)
 * — never `null`, never a broken button. When the flag arrives ON, the live
 * hosting surface renders. Reachable from the sidebar (Capabilities → Hosting)
 * and registered in `app.routes.ts` — no orphan.
 *
 * A11y: exactly one `<h1>`; the primary action is a real `<button>` with an
 * `aria-label`; copy buttons announce success via a polite live region; the
 * status pill carries its meaning in text, not colour alone.
 */
import {
  ChangeDetectionStrategy,
  Component,
  type OnDestroy,
  type OnInit,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { AdminStateService } from '../admin-state.service';
import { ApiService, type LiveCheckResult, type Site } from '../../../services/api.service';
import { ToastService } from '../../../services/toast.service';
import { RevealDirective } from '../../../directives/reveal.directive';
import { CmdGlyphComponent } from '../../../components/cmd-glyph/cmd-glyph.component';

/** The feature-flag key this surface is gated behind (Unit 1 reserved it DARK). */
const WFP_FLAG_KEY = 'site_wfp_hosting';

/**
 * PUBLISH-1 poll cadence — the money-path propagation guard. After a publish/deploy
 * the production card shows a calm "finishing deployment…" state (never a doomed link)
 * until the Worker's `GET /api/sites/:id/live-check` reports `live:true` (HTTP 200).
 * We poll ~every 12s, at most 5× (~60s) — the `host:{slug}` KV cache (60s TTL) + CF
 * edge warm-up almost always resolve inside that window. Visibility-gated (mirrors
 * `AdminStateService`): paused while `document.hidden`, resumes + fires an immediate
 * check on foreground. The link reveals on live:true; polling stops on live:true or
 * after the cap. A **404 sentinel** (flag off) means the feature is unavailable → we
 * keep the CURRENT always-shown link behaviour (zero regression).
 */
const LIVE_POLL_INTERVAL_MS = 12_000;
const LIVE_POLL_MAX_ATTEMPTS = 5;

/**
 * Propagation state for the production URL card.
 * - `off`        — the 404 sentinel (flag off / unavailable) OR site not published →
 *                  keep the always-shown link (no poll, no gating).
 * - `checking`   — a published site, probe available, not yet `live:true` →
 *                  "finishing deployment…", NO clickable link.
 * - `live`       — probe reported `live:true` (HTTP 200) → reveal the "open" link.
 */
type LiveState = 'off' | 'checking' | 'live';

/** Where the selected site is (or will be) served from. */
type ServeMode = 'r2' | 'wfp' | 'provisioning';

interface CopyTarget {
  readonly id: 'preview' | 'production';
  readonly label: string;
  readonly url: string;
  readonly hint: string;
}

@Component({
  selector: 'app-admin-hosting',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RevealDirective, CmdGlyphComponent],
  template: `
    <section class="host" aria-labelledby="host-h1">
      <!-- Section chrome — crumb + single H1 + live affordance, matching siblings. -->
      <header class="host-head" appReveal>
        <div class="head-copy">
          <p class="crumb">
            <a routerLink="/admin">Admin</a> <span class="sep" aria-hidden="true">/</span>
            <span aria-current="page">Hosting</span>
          </p>
          <h1 id="host-h1" class="head-title">
            <app-cmd-glyph name="rocket" aria-hidden="true" /> Hosting
          </h1>
          <p class="head-sub">
            Where your site is served from — preview and production, always live.
            <span class="live-dot" aria-hidden="true"></span>
            <span class="live-copy">Live · auto-refreshed</span>
          </p>
        </div>
      </header>

      @if (flagLoading()) {
        <!-- Loading: skeleton while the flag + site resolve (height-neutral). -->
        <div class="skeleton" aria-hidden="true" data-testid="hosting-skeleton">
          <div class="skel-pill"></div>
          <div class="skel-row"></div>
          <div class="skel-row"></div>
          <div class="skel-cta"></div>
        </div>
        <p class="sr-only" role="status" aria-live="polite">Loading hosting…</p>
      } @else if (flagError()) {
        <!-- Error: coherent, actionable, never a dead-end. -->
        <div class="panel panel--err" role="alert" data-testid="hosting-error">
          <span class="panel-glyph panel-glyph--err" aria-hidden="true">
            <app-cmd-glyph name="shield" />
          </span>
          <p class="panel-title">We couldn’t load hosting</p>
          <p class="panel-sub">This is usually a brief network hiccup. Try again.</p>
          <button class="cta cta-primary" type="button" (click)="retry()" data-testid="hosting-retry">
            Retry
          </button>
        </div>
      } @else if (!flagOn()) {
        <!-- Flag OFF → HONEST gated card. NOT null, NOT a broken button. -->
        <div class="panel panel--gate" appReveal data-testid="hosting-gated">
          <span class="panel-glyph" aria-hidden="true"><app-cmd-glyph name="rocket" /></span>
          <p class="panel-title">Preview hosting — coming soon</p>
          <p class="panel-sub">
            Soon every site gets an instant preview URL and one-click publish, served on
            Cloudflare’s edge. Today your site is live and hosted — this upgrade adds a
            dedicated preview slot you can share before you publish.
          </p>
          <button
            class="cta cta-primary"
            type="button"
            disabled
            aria-disabled="true"
            title="Preview hosting isn’t enabled for your account yet."
            data-testid="hosting-gated-cta"
          >
            <app-cmd-glyph name="rocket" aria-hidden="true" /> Publish to preview
          </button>
          <p class="gate-reason">Not enabled for your account yet — nothing you need to do.</p>
        </div>
      } @else if (!site()) {
        <!-- No site selected → launchpad (matches the dashboard "Create Site" CTA). -->
        <div class="panel panel--empty" appReveal data-testid="hosting-empty">
          <span class="panel-glyph" aria-hidden="true"><app-cmd-glyph name="grid" /></span>
          <p class="panel-title">No site selected</p>
          <p class="panel-sub">
            Pick a site to see its preview and production hosting — or create your first one.
          </p>
          <div class="empty-actions">
            <a class="cta cta-ghost" routerLink="/admin/sites" data-testid="hosting-empty-pick">
              <app-cmd-glyph name="grid" aria-hidden="true" /> Choose a site
            </a>
            <button
              class="cta cta-primary"
              type="button"
              (click)="createSite()"
              data-testid="hosting-empty-cta"
            >
              <app-cmd-glyph name="rocket" aria-hidden="true" /> Create your first site
            </button>
          </div>
        </div>
      } @else {
        <!-- Success: status pill + preview/prod URLs + Publish/Promote CTA. -->
        <div class="live" appReveal data-testid="hosting-live">
          <!-- ── Status pill ── -->
          <div class="statusbar">
            <span
              class="pill"
              [class]="'pill-' + serveMode()"
              data-testid="hosting-status-pill"
              [attr.aria-label]="'Serving from ' + serveLabel()"
            >
              <span class="pill-dot" [class.is-live]="serveMode() === 'provisioning'" aria-hidden="true"></span>
              <span class="pill-text">{{ serveLabel() }}</span>
            </span>
            <span class="site-name" data-testid="hosting-site-name">{{ site()!.business_name }}</span>
          </div>

          <p class="serve-hint">{{ serveHint() }}</p>

          <!-- ── URL cards: preview + production ── -->
          <ul class="urls" role="list">
            @for (t of urlTargets(); track t.id) {
              <li class="url-card" [attr.data-testid]="'hosting-url-' + t.id">
                <div class="url-meta">
                  <span class="url-label">{{ t.label }}</span>
                  <span class="url-hint">{{ t.hint }}</span>
                </div>
                <!--
                  PUBLISH-1 propagation guard: ONLY the production card gates on the live
                  probe. While a just-published site is still propagating (liveState ===
                  'checking') we show a calm "finishing deployment…" strip + a DISABLED copy
                  button instead of a doomed "open" link — the link reveals the moment the
                  Worker reports live:true. The preview card, and ANY card when the feature is
                  off/unavailable (liveState === 'off'), keeps the always-shown link.
                -->
                @if (t.id === 'production' && liveState() === 'checking') {
                  <div class="url-row">
                    <span
                      class="url-link url-link--pending"
                      [attr.data-testid]="'hosting-pending-' + t.id"
                    >
                      <span class="pending-dot" aria-hidden="true"></span>
                      <span class="url-text">Finishing deployment…</span>
                    </span>
                    <button
                      class="copy-btn"
                      type="button"
                      disabled
                      aria-disabled="true"
                      title="Your site goes live the moment deployment finishes."
                      [attr.aria-label]="'Copy ' + t.label + ' URL (available once live)'"
                      [attr.data-testid]="'hosting-copy-' + t.id"
                    >
                      <span class="copy-inner">Copy</span>
                    </button>
                  </div>
                } @else {
                  <div class="url-row">
                    <a
                      class="url-link"
                      [href]="'https://' + t.url"
                      target="_blank"
                      rel="noopener noreferrer"
                      [attr.data-testid]="'hosting-open-' + t.id"
                    >
                      <app-cmd-glyph name="globe" aria-hidden="true" />
                      <span class="url-text">{{ t.url }}</span>
                    </a>
                    <button
                      class="copy-btn"
                      type="button"
                      (click)="copy(t)"
                      [attr.aria-label]="'Copy ' + t.label + ' URL'"
                      [attr.data-testid]="'hosting-copy-' + t.id"
                    >
                      <span class="copy-inner">{{ copied() === t.id ? 'Copied!' : 'Copy' }}</span>
                    </button>
                  </div>
                }
              </li>
            }
          </ul>

          <!-- Polite status for the propagation guard — announced only while checking. -->
          @if (liveState() === 'checking') {
            <p class="sr-only" role="status" aria-live="polite" data-testid="hosting-live-status">
              Your production site is finishing deployment. The live link appears the moment it
              responds.
            </p>
          }

          <!-- ── Primary action: Publish / Promote (ONE obvious CTA) ── -->
          <!--
            The real publish/build surface is the editor (it owns the build +
            the publish that fires the WfP slot deploy, Unit 4). So the CTA is a
            routerLink INTO the editor for this site — an honest, reachable
            action, never a faked in-place fetch. When the site can't be
            published yet (building / no build) we render a disabled button WITH
            the reason instead of a link — never a doomed control.
          -->
          <div class="action-bar">
            @if (canPublish()) {
              <a
                class="cta cta-primary cta-lg"
                [routerLink]="['/admin/editor', site()!.id]"
                data-testid="hosting-publish"
              >
                <app-cmd-glyph name="rocket" aria-hidden="true" />
                <span class="cta-label">{{ publishLabel() }}</span>
              </a>
              <p class="action-hint">
                {{
                  promoteMode()
                    ? 'Promotes your preview to production in the editor — visitors see it live.'
                    : 'Opens the editor to build a shareable preview, then promote it live.'
                }}
              </p>
            } @else {
              <button
                class="cta cta-primary cta-lg"
                type="button"
                disabled
                aria-disabled="true"
                [attr.title]="publishBlockReason()"
                data-testid="hosting-publish"
              >
                <app-cmd-glyph name="rocket" aria-hidden="true" />
                <span class="cta-label">{{ publishLabel() }}</span>
              </button>
              <p class="action-hint">{{ publishBlockReason() }}</p>
            }
          </div>

          <p class="sr-only" role="status" aria-live="polite">{{ liveAnnounce() }}</p>
        </div>
      }
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
        min-height: calc(100vh - 64px);
      }
      .host {
        padding: 28px 24px 96px;
        max-width: 900px;
        margin: 0 auto;
        color: var(--ps-ink, #f4f4ff);
      }
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }

      /* section head */
      .host-head {
        margin-bottom: 26px;
      }
      .crumb {
        margin: 0 0 6px;
        font-family: var(--ps-font-code, 'Fira Code', ui-monospace, monospace);
        font-size: 0.68rem;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        color: rgba(255, 255, 255, 0.6);
      }
      .crumb a {
        color: inherit;
        text-decoration: none;
        transition: color 0.333s ease;
      }
      .crumb a:hover {
        color: var(--ps-accent, #00e5ff);
      }
      .crumb a:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
        border-radius: 3px;
      }
      .crumb .sep {
        opacity: 0.4;
        margin: 0 4px;
      }
      .head-title {
        display: flex;
        align-items: center;
        gap: 10px;
        margin: 0;
        font-family: 'Sora', system-ui, sans-serif;
        font-size: 1.7rem;
        font-weight: 700;
        letter-spacing: -0.02em;
      }
      .head-title app-cmd-glyph {
        color: var(--ps-accent, #00e5ff);
        font-size: 1.4rem;
      }
      .head-sub {
        margin: 8px 0 0;
        font-size: 0.9rem;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 62%, transparent);
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .live-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--ps-success, #4dffb5);
        animation: pulse 2.4s ease-out infinite;
      }
      .live-copy {
        font-family: var(--ps-font-code, 'Fira Code', ui-monospace, monospace);
        font-size: 0.62rem;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: rgba(255, 255, 255, 0.66);
      }
      @keyframes pulse {
        0% {
          box-shadow: 0 0 0 0 rgba(77, 255, 181, 0.45);
        }
        70% {
          box-shadow: 0 0 0 6px rgba(77, 255, 181, 0);
        }
        100% {
          box-shadow: 0 0 0 0 rgba(77, 255, 181, 0);
        }
      }

      /* status bar + pill */
      .statusbar {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
        margin-bottom: 8px;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-height: 30px;
        padding: 0 14px;
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.14);
        background: rgba(8, 8, 32, 0.5);
        font-size: 0.76rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .pill-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.5);
        flex-shrink: 0;
      }
      .pill-dot.is-live {
        animation: pulse 2.4s ease-out infinite;
      }
      .pill-wfp {
        border-color: var(--ps-accent, #00e5ff);
        background: rgba(0, 229, 255, 0.1);
        color: var(--ps-accent, #00e5ff);
      }
      .pill-wfp .pill-dot {
        background: var(--ps-accent, #00e5ff);
      }
      .pill-r2 {
        border-color: rgba(124, 58, 237, 0.5);
        background: rgba(124, 58, 237, 0.12);
        color: #c4a5ff;
      }
      .pill-r2 .pill-dot {
        background: #7c3aed;
      }
      .pill-provisioning {
        border-color: rgba(255, 196, 77, 0.5);
        background: rgba(255, 196, 77, 0.1);
        color: #ffd27a;
      }
      .pill-provisioning .pill-dot {
        background: #ffc44d;
      }
      .site-name {
        font-family: 'Sora', system-ui, sans-serif;
        font-size: 1rem;
        font-weight: 600;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 88%, transparent);
      }
      .serve-hint {
        margin: 0 0 22px;
        font-size: 0.9rem;
        line-height: 1.5;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 62%, transparent);
        text-wrap: pretty;
      }

      /* url cards */
      .urls {
        list-style: none;
        margin: 0 0 26px;
        padding: 0;
        display: grid;
        gap: 12px;
      }
      .url-card {
        padding: 15px 16px;
        border-radius: var(--ps-radius-lg, 16px);
        border: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(8, 8, 32, 0.45);
      }
      .url-meta {
        display: flex;
        align-items: baseline;
        gap: 10px;
        margin-bottom: 8px;
        flex-wrap: wrap;
      }
      .url-label {
        font-size: 0.82rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--ps-ink, #f4f4ff);
      }
      .url-hint {
        font-size: 0.76rem;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 52%, transparent);
      }
      .url-row {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .url-link {
        flex: 1;
        min-width: 0;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 9px 12px;
        border-radius: 10px;
        border: 1px solid rgba(0, 229, 255, 0.18);
        background: color-mix(in oklch, var(--ps-bg, #060610) 76%, transparent);
        text-decoration: none;
        color: color-mix(in oklch, var(--ps-accent, #00e5ff) 82%, var(--ps-ink) 18%);
        font-family: var(--ps-font-code, 'Fira Code', ui-monospace, monospace);
        font-size: 0.84rem;
        transition:
          border-color 0.333s ease,
          background 0.333s ease;
      }
      .url-link app-cmd-glyph {
        flex-shrink: 0;
        opacity: 0.8;
      }
      .url-text {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .url-link:hover {
        border-color: rgba(0, 229, 255, 0.5);
        background: rgba(0, 229, 255, 0.05);
      }
      .url-link:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
      }
      /* PUBLISH-1 propagating state — a calm, NON-interactive strip (no href, no hover-lift). */
      .url-link--pending {
        cursor: default;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 64%, transparent);
        border-color: rgba(255, 196, 77, 0.32);
        background: color-mix(in oklch, var(--ps-bg, #060610) 76%, transparent);
      }
      .url-link--pending:hover {
        border-color: rgba(255, 196, 77, 0.32);
        background: color-mix(in oklch, var(--ps-bg, #060610) 76%, transparent);
      }
      .pending-dot {
        width: 8px;
        height: 8px;
        flex-shrink: 0;
        border-radius: 50%;
        background: #ffc44d;
        animation: pulse 2.4s ease-out infinite;
      }
      .copy-btn {
        flex-shrink: 0;
        min-height: 38px;
        padding: 0 12px;
        border-radius: 10px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(255, 255, 255, 0.04);
        color: var(--ps-ink, #f4f4ff);
        font: inherit;
        font-size: 0.82rem;
        font-weight: 600;
        cursor: pointer;
        transition:
          border-color 0.333s ease,
          transform 0.333s ease,
          background 0.333s ease;
      }
      /* Size the copy button for its widest label ("Copied!") so it never resizes. */
      .copy-inner {
        display: inline-block;
        min-width: 7ch;
        text-align: center;
      }
      .copy-btn:hover {
        border-color: rgba(0, 229, 255, 0.5);
        transform: translateY(-1px);
      }
      .copy-btn:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
      }

      /* primary action bar */
      .action-bar {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 20px;
        border-radius: var(--ps-radius-lg, 16px);
        border: 1px solid rgba(0, 229, 255, 0.18);
        background: linear-gradient(135deg, rgba(0, 229, 255, 0.06), rgba(124, 58, 237, 0.05));
      }
      .action-hint {
        margin: 0;
        font-size: 0.84rem;
        line-height: 1.5;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 62%, transparent);
        text-wrap: pretty;
      }

      /* state panels */
      .panel {
        text-align: center;
        padding: 60px 22px;
        max-width: 520px;
        margin: 30px auto;
        border-radius: var(--ps-radius-xl, 22px);
        border: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(8, 8, 32, 0.4);
      }
      .panel--gate {
        border-color: rgba(0, 229, 255, 0.2);
        background: linear-gradient(135deg, rgba(0, 229, 255, 0.05), rgba(8, 8, 32, 0.4));
      }
      .panel-glyph {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 60px;
        height: 60px;
        border-radius: 18px;
        font-size: 1.6rem;
        color: var(--ps-accent, #00e5ff);
        background: rgba(0, 229, 255, 0.08);
        border: 1px solid rgba(0, 229, 255, 0.2);
        margin-bottom: 18px;
      }
      .panel-glyph--err {
        color: #ff8095;
        background: rgba(255, 77, 109, 0.08);
        border-color: rgba(255, 77, 109, 0.28);
      }
      .panel-title {
        font-family: 'Sora', system-ui, sans-serif;
        font-size: 1.2rem;
        font-weight: 600;
        margin: 0 0 8px;
      }
      .panel-sub {
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 62%, transparent);
        font-size: 0.92rem;
        line-height: 1.55;
        margin: 0 0 20px;
        text-wrap: pretty;
      }
      .gate-reason {
        margin: 14px 0 0;
        font-size: 0.78rem;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 78%, var(--ps-bg, #060610));
      }
      .empty-actions {
        display: flex;
        gap: 12px;
        justify-content: center;
        flex-wrap: wrap;
      }

      /* skeleton */
      .skeleton {
        max-width: 900px;
        margin: 10px auto;
        display: grid;
        gap: 14px;
      }
      .skel-pill {
        width: 150px;
        height: 30px;
        border-radius: 999px;
      }
      .skel-row {
        height: 72px;
        border-radius: var(--ps-radius-lg, 16px);
      }
      .skel-cta {
        height: 96px;
        border-radius: var(--ps-radius-lg, 16px);
      }
      .skel-pill,
      .skel-row,
      .skel-cta {
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.06);
        animation: cc-pulse 1.4s ease-in-out infinite;
      }
      @keyframes cc-pulse {
        0%,
        100% {
          opacity: 0.5;
        }
        50% {
          opacity: 0.85;
        }
      }

      /* CTAs */
      .cta {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-height: 44px;
        padding: 0 20px;
        border-radius: 999px;
        font: inherit;
        font-weight: 600;
        font-size: 0.92rem;
        cursor: pointer;
        text-decoration: none;
        border: 1px solid transparent;
        transition:
          transform 0.333s ease,
          border-color 0.333s ease,
          box-shadow 0.333s ease,
          background 0.333s ease,
          opacity 0.2s ease;
      }
      .cta app-cmd-glyph {
        font-size: 1rem;
      }
      .cta-lg {
        min-height: 50px;
        padding: 0 26px;
        font-size: 1rem;
      }
      .cta-label {
        display: inline-block;
        min-width: 15ch;
        text-align: center;
      }
      .cta-primary {
        background: linear-gradient(135deg, var(--ps-accent, #00e5ff), #50aae3);
        color: #041016;
        box-shadow: 0 16px 40px -22px rgba(0, 229, 255, 0.7);
      }
      .cta-primary:hover:not(:disabled) {
        transform: translateY(-2px);
        box-shadow: 0 22px 52px -20px rgba(0, 229, 255, 0.8);
      }
      .cta-ghost {
        background: rgba(0, 229, 255, 0.05);
        border-color: rgba(0, 229, 255, 0.22);
        color: var(--ps-ink, #f4f4ff);
      }
      .cta-ghost:hover {
        transform: translateY(-1px);
        border-color: rgba(0, 229, 255, 0.5);
      }
      .cta:disabled,
      .cta[aria-disabled='true'] {
        opacity: 0.5;
        cursor: not-allowed;
        box-shadow: none;
        transform: none;
      }
      .cta:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
      }

      @media (max-width: 720px) {
        .host {
          padding: 18px 14px 72px;
        }
        .head-title {
          font-size: 1.4rem;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .live-dot,
        .pill-dot.is-live,
        .pending-dot,
        .skel-pill,
        .skel-row,
        .skel-cta,
        .cta,
        .copy-btn,
        .url-link {
          animation: none !important;
          transition: none !important;
        }
      }
    `,
  ],
})
export class AdminHostingComponent implements OnInit, OnDestroy {
  private readonly state = inject(AdminStateService);
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);

  /** Live, visibility-aware-polled selected site from the shared shell state. */
  readonly site = this.state.selectedSite;

  /** Flag gate — resolved once from the registry floor (`getFeatureFlags()`). */
  readonly flagLoading = signal(true);
  readonly flagError = signal(false);
  readonly flagOn = signal(false);

  /** UI-only transient state. */
  readonly copied = signal<'preview' | 'production' | null>(null);
  private copyTimer: ReturnType<typeof setTimeout> | null = null;

  // ── PUBLISH-1 money-path propagation guard ──────────────────────────────────
  /**
   * The latest `liveCheck` probe result for the current published site:
   * - `undefined` — not probed yet (no verdict → keep the link shown, no flicker);
   * - `null`      — the 404 **sentinel** (flag off / unavailable) → feature off;
   * - `{...}`     — a real probe (`live === (status === 200)`).
   */
  private readonly liveProbe = signal<LiveCheckResult | null | undefined>(undefined);
  /** True once a 404 sentinel proves the feature is unavailable (freezes `off`, no re-poll). */
  private readonly liveUnavailable = signal(false);
  /** Poll bookkeeping (≤5 attempts / ~60s), visibility-gated like `AdminStateService`. */
  private liveAttempts = 0;
  private livePollTimer: ReturnType<typeof setInterval> | null = null;
  private liveSiteId: string | null = null;
  private liveListenerBound = false;
  /** Bound so `removeEventListener` matches on teardown (mirrors AdminStateService). */
  private readonly liveVisibilityHandler = (): void => {
    if (typeof document === 'undefined') return;
    if (document.hidden) {
      this.pauseLivePoll();
    } else {
      // Resume + fire one immediate check so the owner sees the link reveal on tab-return.
      this.resumeLivePoll();
    }
  };

  /**
   * Production-card propagation state (drives the "finishing deployment…" vs live link):
   * - `off`      — feature unavailable (404 sentinel), not published, or no verdict yet →
   *                keep the CURRENT always-shown link (zero regression);
   * - `checking` — published + feature available + probe not yet `live:true`;
   * - `live`     — probe reported `live:true` (HTTP 200) → reveal the open link.
   */
  readonly liveState = computed<LiveState>(() => {
    if (this.liveUnavailable()) return 'off';
    const probe = this.liveProbe();
    if (probe === null) return 'off'; // sentinel — feature off / unavailable
    if (probe === undefined) return 'off'; // no verdict yet → never hide an otherwise-live link
    return probe.live ? 'live' : 'checking';
  });

  constructor() {
    // Start / restart the propagation poll whenever the SELECTED PUBLISHED site changes
    // (site switch, or a draft finishing its first build). Reactive to the shared shell signal.
    effect(() => {
      const s = this.site();
      const target = s && s.status === 'published' ? s.id : null;
      if (target === this.liveSiteId) return; // same target — poll already running/settled
      this.resetLivePoll();
      this.liveSiteId = target;
      if (target) this.startLivePoll(target);
    });
  }

  ngOnInit(): void {
    void this.loadFlag();
  }

  ngOnDestroy(): void {
    this.resetLivePoll();
    if (this.copyTimer) clearTimeout(this.copyTimer);
  }

  // ── Live-poll lifecycle ─────────────────────────────────────────────────────

  /**
   * Begin the propagation poll for a published site: an immediate probe, then at most
   * {@link LIVE_POLL_MAX_ATTEMPTS} checks every {@link LIVE_POLL_INTERVAL_MS}. Stops on
   * `live:true`, on the 404 sentinel (feature off), or after the cap. Visibility-gated.
   */
  private startLivePoll(siteId: string): void {
    this.liveAttempts = 0;
    this.liveProbe.set(undefined);
    this.liveUnavailable.set(false);
    if (typeof document !== 'undefined' && !this.liveListenerBound) {
      document.addEventListener('visibilitychange', this.liveVisibilityHandler);
      this.liveListenerBound = true;
    }
    // Immediate first check (unless the tab is already backgrounded).
    if (typeof document === 'undefined' || !document.hidden) {
      this.probeLiveOnce(siteId);
      this.armLiveInterval(siteId);
    }
  }

  /** (Re)arm the repeating interval — guarded so we never stack two timers. */
  private armLiveInterval(siteId: string): void {
    this.clearLiveInterval();
    this.livePollTimer = setInterval(() => this.probeLiveOnce(siteId), LIVE_POLL_INTERVAL_MS);
  }

  /** One probe + the stop conditions (live / sentinel / attempt cap). */
  private probeLiveOnce(siteId: string): void {
    if (this.liveAttempts >= LIVE_POLL_MAX_ATTEMPTS) {
      this.clearLiveInterval();
      return;
    }
    this.liveAttempts += 1;
    this.api.liveCheck(siteId).subscribe((res) => {
      // Guard against a late response after the site switched away.
      if (this.liveSiteId !== siteId) return;
      if (res === null) {
        // 404 sentinel — feature off/unavailable. Freeze `off` (current link stays) + stop.
        this.liveUnavailable.set(true);
        this.clearLiveInterval();
        return;
      }
      this.liveProbe.set(res);
      if (res.live || this.liveAttempts >= LIVE_POLL_MAX_ATTEMPTS) {
        this.clearLiveInterval(); // revealed, or out of attempts — stop polling
      }
    });
  }

  /** Pause on `document.hidden` — stop the interval but keep the current verdict. */
  private pauseLivePoll(): void {
    this.clearLiveInterval();
  }

  /** Resume on foreground — immediate check + re-arm, if still unsettled. */
  private resumeLivePoll(): void {
    const siteId = this.liveSiteId;
    if (!siteId) return;
    if (this.liveUnavailable()) return; // feature off — nothing to resume
    if (this.liveProbe()?.live) return; // already live — settled
    if (this.liveAttempts >= LIVE_POLL_MAX_ATTEMPTS) return; // out of attempts
    this.probeLiveOnce(siteId);
    this.armLiveInterval(siteId);
  }

  private clearLiveInterval(): void {
    if (this.livePollTimer) {
      clearInterval(this.livePollTimer);
      this.livePollTimer = null;
    }
  }

  /** Full teardown — interval + visibility listener + verdict (for site switch / destroy). */
  private resetLivePoll(): void {
    this.clearLiveInterval();
    this.liveAttempts = 0;
    this.liveProbe.set(undefined);
    this.liveUnavailable.set(false);
    if (this.liveListenerBound && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.liveVisibilityHandler);
      this.liveListenerBound = false;
    }
  }

  /**
   * Read the `site_wfp_hosting` flag from the org-wide registry. The registry
   * row IS the default floor (Unit 1) — `default_enabled` is the live gate for
   * this owner surface; `flag_overrides` (admin toggles) layer on the worker
   * side. Absent row → treated as OFF (honest gated card).
   */
  private async loadFlag(): Promise<void> {
    this.flagLoading.set(true);
    this.flagError.set(false);
    try {
      const res = await firstValueFrom(this.api.getFeatureFlags());
      const row = res.flags.find((f) => f.key === WFP_FLAG_KEY);
      this.flagOn.set(row?.default_enabled === true && row?.stage !== 'killswitch');
    } catch {
      this.flagError.set(true);
    } finally {
      this.flagLoading.set(false);
    }
  }

  retry(): void {
    void this.loadFlag();
  }

  /** Prefer the custom hostname; fall back to the default subdomain. */
  private prodHost(s: Site): string {
    return s.primary_hostname || `${s.slug}.projectsites.dev`;
  }

  /** Preview host mirrors the WfP `-preview` slot's `preview--{slug}` semantics. */
  private previewHost(s: Site): string {
    return `preview--${s.slug}.projectsites.dev`;
  }

  /**
   * Serve mode for the pill. A published site with a build is on the WfP
   * dispatch path (Unit 3 prefers it when the flag + a live slot resolve);
   * a building/collecting site is provisioning; otherwise the byte-identical
   * R2 static path. We can't see the worker's per-request `x-ps-serve` header
   * from here, so we derive an owner-legible status from the site's lifecycle.
   */
  readonly serveMode = computed<ServeMode>(() => {
    const s = this.site();
    if (!s) return 'r2';
    if (this.state.isBuilding(s)) return 'provisioning';
    if (s.status === 'published' && s.current_build_version) return 'wfp';
    return 'r2';
  });

  readonly serveLabel = computed(() => {
    switch (this.serveMode()) {
      case 'wfp':
        return 'WfP dispatch';
      case 'provisioning':
        return 'Provisioning';
      default:
        return 'R2 static';
    }
  });

  readonly serveHint = computed(() => {
    switch (this.serveMode()) {
      case 'wfp':
        return 'Served from a dedicated Worker on Cloudflare’s edge — your site’s own preview and production slots.';
      case 'provisioning':
        return 'Your site is building. Its preview and production slots come online the moment the build finishes.';
      default:
        return 'Served as static files from Cloudflare R2 — fast and global. Publish to spin up a shareable preview slot.';
    }
  });

  readonly urlTargets = computed<CopyTarget[]>(() => {
    const s = this.site();
    if (!s) return [];
    return [
      {
        id: 'preview',
        label: 'Preview',
        url: this.previewHost(s),
        hint: 'Share before you publish',
      },
      {
        id: 'production',
        label: 'Production',
        url: this.prodHost(s),
        hint: s.primary_hostname ? 'Your custom domain' : 'Your live address',
      },
    ];
  });

  /** True when the selected site already has a production build to promote. */
  readonly promoteMode = computed(() => {
    const s = this.site();
    return !!s && s.status === 'published' && !!s.current_build_version;
  });

  readonly publishLabel = computed(() =>
    this.promoteMode() ? 'Promote to production' : 'Publish to preview',
  );

  /**
   * Never a doomed control: publish is disabled (with a reason) while the site
   * is building or has no build yet. A live build → enabled.
   */
  readonly canPublish = computed(() => {
    const s = this.site();
    if (!s) return false;
    if (this.state.isBuilding(s)) return false;
    return !!s.current_build_version;
  });

  readonly publishBlockReason = computed(() => {
    const s = this.site();
    if (!s) return 'Select a site first.';
    if (this.state.isBuilding(s)) return 'Your site is still building — publish unlocks when it finishes.';
    if (!s.current_build_version) return 'This site has no build yet. Open the editor to build it first.';
    return '';
  });

  readonly liveAnnounce = computed(
    () => `${this.site()?.business_name ?? 'Site'} — serving from ${this.serveLabel()}.`,
  );

  createSite(): void {
    this.state.newSite();
  }

  async copy(t: CopyTarget): Promise<void> {
    const url = `https://${t.url}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Older/blocked clipboard: fall through to the toast so the URL is still surfaced.
    }
    this.copied.set(t.id);
    if (this.copyTimer) clearTimeout(this.copyTimer);
    this.copyTimer = setTimeout(() => this.copied.set(null), 1800);
    this.toast.show(`${t.label} URL copied`, 'success');
  }
}
