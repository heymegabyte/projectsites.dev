import { NgTemplateOutlet } from '@angular/common';
/**
 * Admin top-bar domain picker — conversion-optimized for one-click
 * domain ownership.
 *
 * @remarks
 * - Default state: cyan home glyph routes to `/admin`; dropdown trigger
 *   shows the active hostname (custom domain when present, else the
 *   `{slug}.projectsites.dev` fallback).
 * - On open, fires {@link ApiService.getDomainSuggestions} immediately
 *   (sibling agent #99) so the user sees 10 AI-curated unregistered
 *   domains tailored to their business — no typing required.
 * - Live search (≥2 chars) flips into RDAP availability mode: bare
 *   queries fan out across the top 10 TLDs; `query.tld` literals check
 *   just that one. Each row morphs spinner → green ✓ / red ✗ → register.
 * - Wallet status strip at the top — auto-refreshes every 60s while open.
 *   Three CTA states: no wallet (start subscription), active wallet with
 *   balance (one-click buy), insufficient balance (auto-topup + buy).
 * - Purchase flow delegates to {@link BillingService.purchaseDomain},
 *   branching on a discriminated union for cinematic-punchline error
 *   toasts (`taken` / `tld_unsupported` / `registrar_error` /
 *   `wallet_insufficient`). No generic "purchase failed" strings.
 * - Successful purchase plays a 3-sparkle cyan particle effect (gated
 *   by `prefers-reduced-motion`) and morphs the row into "✓ Yours".
 * - Telemetry: every meaningful event fires through {@link TelemetryService}
 *   (`domain.suggestions_shown`, `domain.suggestion_hovered`,
 *   `domain.register_clicked`, `domain.register_succeeded`,
 *   `domain.register_failed`).
 * - Keyboard: arrow keys move selection within sections, Tab moves
 *   between sections, Enter selects the highlighted row, Esc closes
 *   and returns focus to the trigger.
 * - `prefers-reduced-motion` honoured on every animation (enter, hover
 *   lift, sparkle, stagger).
 *
 * @example
 * ```html
 * <app-domain-picker></app-domain-picker>
 * ```
 */
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  HostListener,
  inject,
  signal,
  ViewChild,
  type OnDestroy,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { of, Subject } from 'rxjs';
import { catchError, debounceTime, distinctUntilChanged, switchMap } from 'rxjs/operators';

import { AdminStateService } from '../../pages/admin/admin-state.service';
import { ApiService, type DomainSuggestion, type Hostname } from '../../services/api.service';
import { BillingService, type PurchaseResult, type WalletState } from '../../services/billing.service';
import { TelemetryService } from '../../services/telemetry.service';
import { ToastService } from '../../services/toast.service';

interface PickerHostname extends Hostname {
  /** Convenience flag — `true` for the row that matches `site.primary_hostname`. */
  isActive: boolean;
  /**
   * `true` for the site's permanent `{slug}.projectsites.dev` default subdomain —
   * always present (synthesized when the API returns no real row for it) and never
   * removable/deactivatable, so a site can never be left with zero domains.
   */
  isDefault?: boolean;
}

/** Stable track id for the synthesized default-subdomain row (no real hostname record). */
const SYNTHETIC_DEFAULT_ID = '__default_subdomain__';

/**
 * Per-row state for the live-availability search results. Layered on top
 * of {@link DomainSuggestion} with a UI-only `checking` flag so the row
 * can render a spinner while RDAP is still in flight.
 */
interface LiveDomainRow extends DomainSuggestion {
  /** True while RDAP availability is still resolving for this row. */
  checking: boolean;
}

/**
 * The TLDs we fan availability checks across when the user types a bare
 * query (no dot). Ordered by ProjectSites conversion data — `.com` first,
 * then the modern-startup TLDs, then the cheaper alternatives.
 */
const SEARCH_TLDS: readonly string[] = [
  'com', 'app', 'io', 'dev', 'co', 'ai', 'me', 'xyz', 'studio', 'biz',
];

const AI_SUGGESTION_COUNT = 10;

const LOW_BALANCE_CENTS = 500;

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, NgTemplateOutlet, RouterLink],
  selector: 'app-domain-picker',
  standalone: true,
  styles: [
    `
      :host {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        position: relative;
        font: inherit;
      }
      .dp-root {
        position: relative;
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .dp-home {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border: 1px solid rgba(255, 255, 255, 0.06);
        border-radius: var(--ps-radius-sm, 8px);
        background: transparent;
        color: var(--ps-accent, #00e5ff);
        cursor: pointer;
        transition: border-color 0.18s, background 0.18s, transform 0.18s;
      }
      .dp-home:hover {
        border-color: color-mix(in oklch, var(--ps-accent, #00e5ff) 35%, transparent);
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 8%, transparent);
      }
      .dp-home:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
      }
      .dp-trigger {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 4px 10px 4px 12px;
        height: 28px;
        /* Viewport-aware cap: desktop keeps the 340px cap (min() picks it on wide
           screens); on a narrow admin top-bar the trigger shrinks so the picker
           (home glyph + trigger) never forces the header past the viewport — the
           ~42px horizontal overflow every /admin page showed at ≤390px when a real
           site's long {slug}.projectsites.dev host filled the trigger. */
        max-width: min(340px, 62vw);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: var(--ps-radius-md, 12px);
        background: rgba(13, 13, 40, 0.55);
        color: var(--ps-ink, #f4f4ff);
        cursor: pointer;
        font: inherit;
        font-size: 0.82rem;
        transition: border-color 0.18s, background 0.18s, box-shadow 0.18s;
      }
      .dp-trigger:hover {
        border-color: color-mix(in oklch, var(--ps-accent, #00e5ff) 40%, transparent);
        box-shadow: 0 0 0 1px color-mix(in oklch, var(--ps-accent, #00e5ff) 20%, transparent),
          0 6px 18px -10px color-mix(in oklch, var(--ps-accent, #00e5ff) 60%, transparent);
      }
      .dp-trigger--open {
        border-color: color-mix(in oklch, var(--ps-accent, #00e5ff) 55%, transparent);
        box-shadow: 0 0 0 1px color-mix(in oklch, var(--ps-accent, #00e5ff) 30%, transparent);
      }
      .dp-trigger:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
      }
      .dp-host {
        font-family: var(--ps-font-mono, 'JetBrains Mono', ui-monospace, monospace);
        font-size: 0.78rem;
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        /* Pairs with .dp-trigger's viewport cap — the hostname ellipsis-truncates
           to fit narrow screens instead of widening the trigger past the viewport. */
        max-width: min(280px, 42vw);
      }
      .dp-caret {
        opacity: 0.55;
        flex-shrink: 0;
        transition: transform 0.18s;
      }
      .dp-trigger--open .dp-caret {
        transform: rotate(180deg);
        opacity: 0.85;
      }
      .dp-backdrop {
        position: fixed;
        inset: 0;
        z-index: calc(var(--ps-z-dropdown, 1000) - 1);
        background: transparent;
      }
      .dp-panel {
        position: absolute;
        top: calc(100% + 8px);
        left: 0;
        z-index: var(--ps-z-dropdown, 1000);
        width: min(560px, calc(100vw - 32px));
        max-height: min(76vh, 720px);
        overflow-y: auto;
        padding: 14px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        /* Near-opaque (NOT the shared 0.62 --ps-surface-glass token): this panel
           pops OVER arbitrary page content (incl. the bright page H1), so a 0.62
           glass let that content bleed through + hurt the picker's own legibility
           (text-contrast standard: an actively-read panel needs ≥0.9 alpha). The
           blur keeps the cockpit glass edge; the opacity stops the bleed. The 0.62
           token stays correct for on-page cards (analytics) that sit on the dark bg. */
        background: rgba(11, 11, 32, 0.97);
        backdrop-filter: blur(22px) saturate(140%);
        -webkit-backdrop-filter: blur(22px) saturate(140%);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: var(--ps-radius-lg, 16px);
        box-shadow: var(
          --ps-shadow-modal,
          0 24px 64px rgba(0, 0, 0, 0.55),
          0 0 80px rgba(0, 229, 255, 0.06)
        );
        animation: dp-in 0.22s cubic-bezier(0.16, 1, 0.3, 1) both;
      }
      .dp-panel::before {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: inherit;
        padding: 1px;
        background: linear-gradient(
          135deg,
          color-mix(in oklch, var(--ps-accent, #00e5ff) 30%, transparent),
          transparent 40%,
          transparent 60%,
          color-mix(in oklch, var(--ps-accent, #00e5ff) 12%, transparent)
        );
        -webkit-mask:
          linear-gradient(#000 0 0) content-box,
          linear-gradient(#000 0 0);
        -webkit-mask-composite: xor;
        mask-composite: exclude;
        pointer-events: none;
      }
      @keyframes dp-in {
        from { opacity: 0; transform: translateY(-6px) scale(0.985); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      .dp-search {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        background: rgba(0, 0, 0, 0.28);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: var(--ps-radius-md, 12px);
        color: var(--ps-ink, #f4f4ff);
      }
      .dp-search:focus-within {
        border-color: color-mix(in oklch, var(--ps-accent, #00e5ff) 50%, transparent);
        box-shadow: 0 0 0 3px color-mix(in oklch, var(--ps-accent, #00e5ff) 14%, transparent);
      }
      .dp-search input {
        flex: 1;
        background: transparent;
        border: none;
        outline: none;
        box-shadow: none;
        color: inherit;
        font: inherit;
        font-size: 0.86rem;
      }
      /* No focus highlight on the INPUT — the wrapper (.dp-search:focus-within)
         owns the ring. Beats the global input:focus-visible rule in _polish.scss. */
      .dp-search input:focus,
      .dp-search input:focus-visible {
        outline: none;
        box-shadow: none;
        border: none;
      }
      .dp-search input::placeholder {
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 65%, transparent);
      }
      .dp-spinner {
        width: 12px;
        height: 12px;
        border: 2px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 25%, transparent);
        border-top-color: var(--ps-accent, #00e5ff);
        border-radius: 50%;
        animation: dp-spin 0.85s linear infinite;
        display: inline-block;
      }
      .dp-spinner--mini {
        width: 10px;
        height: 10px;
        border-width: 1.5px;
        vertical-align: middle;
        margin-right: 4px;
      }
      .dp-spinner--ink {
        border-color: color-mix(in oklch, var(--ps-bg, #060610) 25%, transparent);
        border-top-color: var(--ps-bg, #060610);
      }
      @keyframes dp-spin {
        to { transform: rotate(360deg); }
      }
      .dp-section {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .dp-section-label {
        font-family: var(--ps-font-mono, 'JetBrains Mono', ui-monospace, monospace);
        font-size: 0.62rem;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent);
        padding: 0 2px;
      }
      .dp-section-label--ai {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: var(--ps-accent, #00e5ff);
      }
      .dp-ai-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--ps-accent, #00e5ff);
        box-shadow: 0 0 6px var(--ps-accent, #00e5ff);
        animation: dp-pulse 1.8s ease-in-out infinite;
      }
      @keyframes dp-pulse {
        0%, 100% { opacity: 0.5; }
        50% { opacity: 1; }
      }
      .dp-empty {
        padding: 12px;
        font-size: 0.78rem;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 50%, transparent);
        background: rgba(0, 0, 0, 0.18);
        border-radius: var(--ps-radius-sm, 8px);
      }
      .dp-row {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 6px 10px;
        border-radius: var(--ps-radius-sm, 8px);
        background: rgba(255, 255, 255, 0.02);
        border: 1px solid transparent;
        transition: background 0.14s, border-color 0.14s, transform 0.14s, box-shadow 0.14s;
        position: relative;
      }
      .dp-row--host {
        flex-direction: row;
        align-items: center;
        gap: 10px;
      }
      .dp-row--focused,
      .dp-row:hover {
        background: rgba(255, 255, 255, 0.04);
        border-color: rgba(255, 255, 255, 0.08);
      }
      .dp-row--reg:hover {
        transform: translateY(-2px);
        border-color: color-mix(in oklch, var(--ps-accent, #00e5ff) 28%, transparent);
        box-shadow: 0 6px 18px -10px color-mix(in oklch, var(--ps-accent, #00e5ff) 55%, transparent);
      }
      .dp-row--purchased {
        border-color: color-mix(in oklch, var(--ps-accent, #00e5ff) 55%, transparent);
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 9%, transparent);
        box-shadow: 0 0 24px -4px color-mix(in oklch, var(--ps-accent, #00e5ff) 50%, transparent);
      }
      .dp-row--active {
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 8%, transparent);
        border-left: 2px solid var(--ps-accent, #00e5ff);
      }
      .dp-row--inactive .dp-mono {
        text-decoration: line-through;
        opacity: 0.6;
      }
      .dp-row-main {
        flex: 1;
        display: flex;
        align-items: center;
        gap: 10px;
        background: transparent;
        border: none;
        padding: 0;
        text-align: left;
        cursor: pointer;
        color: inherit;
        font: inherit;
      }
      .dp-row-main:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
        border-radius: 4px;
      }
      .dp-mono {
        /* Consolas-first comes from the global --ps-font-mono token (_polish.scss). */
        font-family: var(--ps-font-mono, Consolas, 'JetBrains Mono', ui-monospace, monospace);
        font-size: 0.78rem;
        color: var(--ps-ink, #f4f4ff);
      }
      .dp-mono--accent {
        color: var(--ps-accent, #00e5ff);
      }
      /* Availability symbol shown right beside each domain URL: green = available,
         red = taken. Decorative ● — the adjacent badge carries the accessible text. */
      .dp-avail {
        font-size: 0.7rem;
        line-height: 1;
        flex: 0 0 auto;
      }
      .dp-avail--ok { color: #34d399; }
      .dp-avail--no { color: #f87171; }
      .dp-avail--unknown { color: #9ca3af; }
      .dp-pill {
        display: inline-block;
        padding: 1px 6px;
        font-size: 0.58rem;
        letter-spacing: 0.08em;
        font-weight: 600;
        border-radius: 4px;
        font-family: var(--ps-font-mono, 'JetBrains Mono', ui-monospace, monospace);
      }
      .dp-pill--primary {
        color: var(--ps-bg, #060610);
        background: var(--ps-accent, #00e5ff);
      }
      .dp-pill--live {
        color: var(--ps-accent, #00e5ff);
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 12%, transparent);
      }
      .dp-pill--pending {
        color: #f59e0b;
        background: rgba(245, 158, 11, 0.12);
      }
      .dp-pill--mute {
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 65%, transparent);
        background: rgba(255, 255, 255, 0.04);
      }
      .dp-row-actions {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .dp-act {
        padding: 3px 8px;
        font-size: 0.7rem;
        background: transparent;
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 4px;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 75%, transparent);
        cursor: pointer;
        transition: border-color 0.14s, color 0.14s, background 0.14s;
      }
      .dp-act:hover {
        border-color: color-mix(in oklch, var(--ps-accent, #00e5ff) 40%, transparent);
        color: var(--ps-ink, #f4f4ff);
      }
      .dp-act:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 1px;
      }
      .dp-act--accent {
        color: var(--ps-accent, #00e5ff);
        border-color: color-mix(in oklch, var(--ps-accent, #00e5ff) 40%, transparent);
      }
      .dp-act--mute {
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 50%, transparent);
      }
      .dp-row--reg { gap: 4px; }
      .dp-row-head {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .dp-status {
        font-size: 0.66rem;
        font-family: var(--ps-font-mono, 'JetBrains Mono', ui-monospace, monospace);
        padding: 1px 6px;
        border-radius: 4px;
        display: inline-flex;
        align-items: center;
      }
      .dp-status--ok {
        color: #34d399;
        background: rgba(52, 211, 153, 0.1);
      }
      .dp-status--no {
        color: #f87171;
        background: rgba(248, 113, 113, 0.1);
      }
      .dp-status--load {
        color: #f59e0b;
        background: rgba(245, 158, 11, 0.12);
      }
      .dp-status--unknown {
        color: #9ca3af;
        background: rgba(156, 163, 175, 0.12);
      }
      /* Taken domains: a single compact, calmly-grayed line (no reason/pitch/CTA,
         no hover-lift — it isn't actionable). Keeps the dropdown tight. */
      .dp-row--taken {
        padding: 5px 10px;
        background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 1.5%, transparent);
        opacity: 0.82;
      }
      .dp-row--taken:hover {
        transform: none;
        border-color: rgba(255, 255, 255, 0.06);
        box-shadow: none;
        background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 3%, transparent);
      }
      .dp-row--taken .dp-mono {
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 48%, transparent);
        text-decoration: line-through;
        text-decoration-color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 24%, transparent);
      }
      .dp-price {
        margin-left: auto;
        font-size: 0.72rem;
        font-weight: 600;
        color: var(--ps-ink, #f4f4ff);
        font-variant-numeric: tabular-nums;
        padding: 2px 8px;
        border-radius: 4px;
        background: linear-gradient(
          135deg,
          color-mix(in oklch, var(--ps-accent, #00e5ff) 14%, transparent),
          color-mix(in oklch, #7c3aed 14%, transparent)
        );
        border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 25%, transparent);
      }
      /* Unavailable (taken / couldn't-check) domains: the price is NOT actionable,
         so it recedes into the row — light, struck-through, borderless (no gradient
         chip). The eye skips it and lands on the available options. The chip stays
         on AVAILABLE rows where the price is a genuine buy signal. (Brian, 2026-09-20.) */
      .dp-price--muted {
        background: none;
        border: none;
        padding: 2px 0;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 42%, transparent);
        text-decoration: line-through;
        text-decoration-color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 28%, transparent);
        font-weight: 500;
      }
      /* "Recommended" pill on every AI-suggested URL — short descriptor that the
         name was auto-determined as a recommendable URL for the business. */
      .dp-rec-pill {
        flex: 0 0 auto;
        padding: 1px 8px;
        border-radius: 999px;
        font-size: 0.6rem;
        font-weight: 700;
        letter-spacing: 0.02em;
        text-transform: uppercase;
        color: var(--ps-accent, #00e5ff);
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 14%, transparent);
        border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 30%, transparent);
        transition: background 0.333s, border-color 0.333s;
      }
      .dp-reason {
        font-size: 0.76rem;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 88%, transparent);
        line-height: 1.4;
        font-style: italic;
      }
      .dp-pitch {
        font-size: 0.7rem;
        color: color-mix(in oklch, var(--ps-accent, #00e5ff) 70%, transparent);
        line-height: 1.35;
      }
      .dp-register {
        align-self: flex-end;
        margin-top: 6px;
        padding: 6px 14px;
        font-size: 0.74rem;
        font-weight: 600;
        color: var(--ps-bg, #060610);
        background: linear-gradient(135deg, var(--ps-accent, #00e5ff), #7c3aed);
        border: none;
        border-radius: 6px;
        cursor: pointer;
        transition: filter 0.14s, transform 0.14s, box-shadow 0.14s;
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      .dp-register:not(:disabled):hover {
        filter: brightness(1.12);
        transform: translateY(-1px);
        box-shadow: 0 6px 16px -6px color-mix(in oklch, var(--ps-accent, #00e5ff) 60%, transparent);
      }
      .dp-register:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
      }
      .dp-register:disabled {
        cursor: not-allowed;
        opacity: 0.55;
        background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 18%, transparent);
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent);
      }
      .dp-register--purchased {
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 22%, transparent);
        color: var(--ps-accent, #00e5ff);
        opacity: 1;
      }
      .dp-register--porkbun {
        text-decoration: none;
        background: transparent;
        color: var(--ps-accent, #00e5ff);
        border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 45%, transparent);
      }
      .dp-register--porkbun:hover {
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 12%, transparent);
        filter: none;
        box-shadow: none;
      }
      .dp-refine {
        align-self: center;
        margin-top: 4px;
        padding: 6px 14px;
        font-size: 0.7rem;
        background: transparent;
        color: color-mix(in oklch, var(--ps-accent, #00e5ff) 80%, transparent);
        border: 1px dashed color-mix(in oklch, var(--ps-accent, #00e5ff) 35%, transparent);
        border-radius: 6px;
        cursor: pointer;
        transition: background 0.14s, color 0.14s, border-color 0.14s;
      }
      .dp-refine:hover:not(:disabled) {
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 10%, transparent);
        color: var(--ps-accent, #00e5ff);
        border-color: var(--ps-accent, #00e5ff);
      }
      .dp-refine:disabled { opacity: 0.5; cursor: progress; }
      .dp-row--skeleton {
        background: rgba(255, 255, 255, 0.025);
        pointer-events: none;
      }
      .dp-skel {
        height: 10px;
        border-radius: 4px;
        background: linear-gradient(
          90deg,
          rgba(255, 255, 255, 0.05) 0%,
          rgba(255, 255, 255, 0.12) 50%,
          rgba(255, 255, 255, 0.05) 100%
        );
        background-size: 200% 100%;
        animation: dp-shimmer 1.4s linear infinite;
      }
      .dp-skel--head { width: 45%; height: 12px; }
      .dp-skel--reason { width: 80%; }
      .dp-skel--pitch { width: 60%; }
      .dp-loading-hint { margin: 0 0 0.5rem; padding: 0 0.15rem; font-size: 0.72rem; line-height: 1.35; color: var(--ps-text-muted, #9aa0aa); }
      @keyframes dp-shimmer {
        from { background-position: 200% 0; }
        to { background-position: -200% 0; }
      }
      .dp-sparkles {
        position: absolute;
        inset: 0;
        pointer-events: none;
        overflow: hidden;
        border-radius: inherit;
      }
      .dp-sparkle {
        position: absolute;
        font-size: 14px;
        color: var(--ps-accent, #00e5ff);
        text-shadow: 0 0 8px var(--ps-accent, #00e5ff);
        animation: dp-sparkle 1.2s ease-out both;
        opacity: 0;
      }
      .dp-sparkle--a { left: 12%; top: 20%; animation-delay: 0s; }
      .dp-sparkle--b { left: 50%; top: 60%; animation-delay: 0.15s; font-size: 18px; }
      .dp-sparkle--c { right: 14%; top: 30%; animation-delay: 0.3s; }
      @keyframes dp-sparkle {
        0% { opacity: 0; transform: scale(0.4) rotate(0); }
        40% { opacity: 1; transform: scale(1.2) rotate(40deg); }
        100% { opacity: 0; transform: scale(0.6) translateY(-12px) rotate(80deg); }
      }
      .dp-footer {
        margin-top: 4px;
        padding-top: 10px;
        border-top: 1px solid rgba(255, 255, 255, 0.06);
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .dp-foot-line {
        font-size: 0.7rem;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 65%, transparent);
        display: inline-flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }
      .dp-foot-sub {
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 65%, transparent);
      }
      .dp-copy {
        padding: 2px 8px;
        font-size: 0.66rem;
        background: transparent;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 4px;
        color: var(--ps-accent, #00e5ff);
        cursor: pointer;
      }
      .dp-copy:hover { border-color: var(--ps-accent, #00e5ff); }

      /* Stagger reveal on suggestion rows. */
      .dp-row--reg {
        animation: dp-reveal 0.32s cubic-bezier(0.16, 1, 0.3, 1) both;
      }
      .dp-row--reg:nth-child(1) { animation-delay: 0ms; }
      .dp-row--reg:nth-child(2) { animation-delay: 80ms; }
      .dp-row--reg:nth-child(3) { animation-delay: 160ms; }
      .dp-row--reg:nth-child(4) { animation-delay: 240ms; }
      .dp-row--reg:nth-child(5) { animation-delay: 320ms; }
      .dp-row--reg:nth-child(6) { animation-delay: 400ms; }
      .dp-row--reg:nth-child(7) { animation-delay: 480ms; }
      .dp-row--reg:nth-child(8) { animation-delay: 560ms; }
      .dp-row--reg:nth-child(9) { animation-delay: 640ms; }
      .dp-row--reg:nth-child(n+10) { animation-delay: 720ms; }
      @keyframes dp-reveal {
        from { opacity: 0; transform: translateY(6px); }
        to { opacity: 1; transform: translateY(0); }
      }

      @media (prefers-reduced-motion: reduce) {
        .dp-panel { animation: dp-fade 0.14s ease both; }
        .dp-row--reg { animation: none; }
        .dp-row--reg:hover { transform: none; }
        .dp-register:not(:disabled):hover { transform: none; }
        .dp-sparkle { animation: none; opacity: 0; }
        .dp-ai-dot { animation: none; opacity: 0.85; }
        .dp-skel { animation: none; }
        @keyframes dp-fade {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      }
    `,
  ],
  template: `
    <div class="dp-root">
      <!-- Home button — left of the trigger, always routes to /admin. -->
      <button
        type="button"
        class="dp-home"
        (click)="goHome()"
        title="Admin home"
        aria-label="Go to admin home"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
          <polyline points="9 22 9 12 15 12 15 22"/>
        </svg>
      </button>

      <!-- Trigger — collapses the first two breadcrumbs into one widget. -->
      <button
        #trigger
        type="button"
        class="dp-trigger"
        [class.dp-trigger--open]="open()"
        (click)="toggle()"
        [attr.aria-expanded]="open()"
        aria-haspopup="dialog"
        [attr.aria-label]="'Active domain: ' + activeHost() + '. Click to change.'"
      >
        <span class="dp-host">{{ activeHost() }}</span>
        <svg class="dp-caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      @if (open()) {
        <!-- Click-outside backdrop. Transparent — the panel itself is the visible surface. -->
        <div class="dp-backdrop" (click)="close()" aria-hidden="true"></div>

        <div
          #panel
          class="dp-panel"
          role="dialog"
          aria-label="Domain picker"
          (keydown)="onPanelKeydown($event)"
        >
          <!-- 1. Auto-focused search input. -->
          <div class="dp-search">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input
              #searchInput
              type="text"
              data-testid="domain-picker-search"
              [(ngModel)]="queryModel"
              (ngModelChange)="onQueryChange($event)"
              (keydown.enter)="onSearchEnter($event)"
              placeholder="Find a specific domain or pick from AI suggestions…"
              aria-label="Search domains"
              autocomplete="off"
              spellcheck="false"
            />
            @if (availabilityChecking()) {
              <span class="dp-spinner" aria-label="Checking availability"></span>
            }
          </div>

          <!-- 2. YOUR DOMAINS — every hostname bound to the current site. -->
          <div class="dp-section">
            <div class="dp-section-label">Your domains</div>
            @if (filteredAssigned().length === 0) {
              <div class="dp-empty">
                @if (query().length > 0) {
                  No assigned domains match "{{ query() }}".
                } @else {
                  No domains assigned to this site yet — pick one below.
                }
              </div>
            }
            @for (h of filteredAssigned(); track h.id; let i = $index) {
              <div
                class="dp-row dp-row--host"
                [class.dp-row--active]="h.isActive"
                [class.dp-row--inactive]="h.status === 'deactivated'"
                [class.dp-row--focused]="focusedSection() === 'assigned' && focusedIndex() === i"
                (mouseenter)="setFocus('assigned', i)"
              >
                <button
                  type="button"
                  class="dp-row-main"
                  (click)="selectHost(h)"
                  [title]="'Switch to ' + h.hostname"
                >
                  <span class="dp-mono">{{ h.hostname }}</span>
                  @if (h.isActive) {
                    <span class="dp-pill dp-pill--primary">PRIMARY</span>
                  } @else if (h.status === 'active') {
                    <span class="dp-pill dp-pill--live">LIVE</span>
                  } @else if (h.status === 'deactivated') {
                    <span class="dp-pill dp-pill--mute">DEACTIVATED</span>
                  } @else {
                    <span class="dp-pill dp-pill--pending">{{ statusLabel(h.status) }}</span>
                  }
                </button>
                <div class="dp-row-actions">
                  @if (h.status === 'deactivated') {
                    <button type="button" class="dp-act dp-act--accent" (click)="reactivate(h)" title="Reactivate hostname">
                      Reactivate
                    </button>
                  } @else {
                    @if (!h.isActive) {
                      <button type="button" class="dp-act" (click)="setDefault(h)" title="Set as primary">
                        Set as default
                      </button>
                    }
                    @if (!h.isDefault) {
                      <button type="button" class="dp-act dp-act--mute" (click)="deactivate(h)" title="Stop serving traffic on this hostname">
                        Deactivate
                      </button>
                    }
                  }
                </div>
              </div>
            }
          </div>

          <!-- 3a. LIVE-SEARCH AVAILABILITY — visible when user is typing ≥2 chars. -->
          @if (query().length >= 2 && liveResults().length > 0) {
            <div class="dp-section">
              <div class="dp-section-label">Live availability</div>
              @for (s of liveResults(); track s.domain; let i = $index) {
                <ng-container [ngTemplateOutlet]="suggestionRow" [ngTemplateOutletContext]="{ s, i, section: 'live' }"></ng-container>
              }
            </div>
          }

          <!-- 3b. AI-SUGGESTIONS — brand-perfect available names. Shown when idle
               AND below live results during a search (recommendations the AI
               thinks fit the brand, not just TLD swaps). -->
          @if (suggestionsLoading() || suggestions().length > 0) {
            <div class="dp-section">
              <div class="dp-section-label dp-section-label--ai">
                <span class="dp-ai-dot" aria-hidden="true"></span>
                {{ query().length >= 2 ? 'More ideas perfect for ' : 'AI picks for ' }}{{ businessLabel() }}
              </div>

              @if (suggestionsLoading()) {
                <!-- The cold AI pipeline (candidate-gen → live RDAP availability → reason
                     enrichment) runs ~15s on first open; the 5-min cache makes repeats
                     instant. Without this, a real user + screen readers (the skeletons are
                     aria-hidden) see a silent 15s blank — say what's happening. -->
                <p class="dp-loading-hint" aria-live="polite">
                  Generating fresh AI domain ideas — checking live availability. This can take a few seconds.
                </p>
                @for (n of skeletonRange; track n) {
                  <div class="dp-row dp-row--reg dp-row--skeleton" aria-hidden="true">
                    <div class="dp-skel dp-skel--head"></div>
                    <div class="dp-skel dp-skel--reason"></div>
                    <div class="dp-skel dp-skel--pitch"></div>
                  </div>
                }
              } @else {
                @for (s of suggestions(); track s.domain; let i = $index) {
                  <ng-container [ngTemplateOutlet]="suggestionRow" [ngTemplateOutletContext]="{ s, i, section: 'register' }"></ng-container>
                }
                @if (suggestions().length > 0) {
                  <button
                    type="button"
                    class="dp-refine"
                    [disabled]="refining()"
                    (click)="refineSuggestions()"
                  >
                    @if (refining()) {
                      Finding fresh picks…
                    } @else {
                      Show me different ones ↻
                    }
                  </button>
                }
              }
            </div>
          }

          <!-- 4. Bottom — DNS instruction + CNAME copy. -->
          <div class="dp-footer">
            <div class="dp-foot-line">
              Manage your own DNS? Point a CNAME to
              <code class="dp-mono">{{ cnameTarget() }}</code>
              <button type="button" class="dp-copy" (click)="copyCname()" title="Copy CNAME target">
                Copy
              </button>
              <span class="dp-foot-sub">— we'll auto-issue SSL.</span>
            </div>
          </div>
        </div>
      }

      <!-- Reusable suggestion-row template — shared by live + AI sections. -->
      <ng-template #suggestionRow let-s="s" let-i="i" let-section="section">
        <div
          class="dp-row dp-row--reg"
          [class.dp-row--focused]="focusedSection() === section && focusedIndex() === i"
          [class.dp-row--purchased]="purchasedDomains().has(s.domain)"
          [class.dp-row--checking]="s.checking"
          [class.dp-row--taken]="s.status === 'taken' && !purchasedDomains().has(s.domain)"
          (mouseenter)="onSuggestionHover(section, i, s)"
        >
          <div class="dp-row-head">
            @if (!s.checking) {
              @if (s.status === 'available' || purchasedDomains().has(s.domain)) {
                <span class="dp-avail dp-avail--ok" title="Available" aria-hidden="true">●</span>
              } @else if (s.status === 'taken') {
                <span class="dp-avail dp-avail--no" title="Taken" aria-hidden="true">●</span>
              } @else if (s.status === 'unknown') {
                <span class="dp-avail dp-avail--unknown" title="Availability couldn't be checked" aria-hidden="true">●</span>
              }
            }
            <span class="dp-mono" [class.dp-mono--accent]="s.status === 'available' && !purchasedDomains().has(s.domain)">{{ s.domain }}</span>
            @if (section === 'register' && !purchasedDomains().has(s.domain)) {
              <span class="dp-rec-pill" title="Automatically determined as a recommendable URL for your business">Recommended</span>
            }
            @if (s.checking) {
              <span class="dp-status dp-status--load" title="Checking…">
                <span class="dp-spinner dp-spinner--mini" aria-hidden="true"></span>
                checking
              </span>
            } @else if (purchasedDomains().has(s.domain)) {
              <span class="dp-status dp-status--ok">✓ yours · SSL pending</span>
            } @else if (s.status === 'available') {
              <span class="dp-status dp-status--ok">✓ available</span>
            } @else if (s.status === 'taken') {
              <span class="dp-status dp-status--no">✗ taken</span>
            } @else if (s.status === 'unknown') {
              <span
                class="dp-status dp-status--unknown"
                data-testid="domain-status-unknown"
                title="The availability lookup (RDAP) didn't respond — verify on the registrar"
                >? couldn't check</span
              >
            }
            @if (s.price_usd_yr && !purchasedDomains().has(s.domain)) {
              <span class="dp-price" [class.dp-price--muted]="s.status !== 'available'">\${{ s.price_usd_yr }}/yr</span>
            }
          </div>
          <!-- Reason/pitch + register CTA only for non-taken rows — a taken
               domain stays a single compact, grayed line (the badge says it all). -->
          @if (s.status !== 'taken' || purchasedDomains().has(s.domain)) {
            @if (s.reason) {
              <div class="dp-reason"><em>{{ s.reason }}</em></div>
            }
            @if (s.pitch) {
              <div class="dp-pitch">{{ s.pitch }}</div>
            }
            @if (purchasedDomains().has(s.domain)) {
              <button type="button" class="dp-register dp-register--purchased" disabled>
                ✓ Yours. SSL pending.
              </button>
              <div class="dp-sparkles" aria-hidden="true">
                <span class="dp-sparkle dp-sparkle--a">✦</span>
                <span class="dp-sparkle dp-sparkle--b">✧</span>
                <span class="dp-sparkle dp-sparkle--c">✦</span>
              </div>
            } @else if (s.can_register_inline) {
              <button
                type="button"
                class="dp-register"
                [disabled]="registering() === s.domain"
                (click)="register(s)"
              >
                @if (registering() === s.domain) {
                  <span class="dp-spinner dp-spinner--mini dp-spinner--ink" aria-hidden="true"></span>
                  Buying…
                } @else {
                  {{ registerCtaLabel(s) }}
                }
              </button>
            } @else if (s.available && s.fallback_url) {
              <a
                class="dp-register dp-register--porkbun"
                [href]="s.fallback_url"
                target="_blank"
                rel="noopener noreferrer"
                title="CF Registrar doesn't carry this TLD — buy at Porkbun, then add via the custom-domain wizard."
              >
                Buy at Porkbun ↗
              </a>
            }
          }
        </div>
      </ng-template>
    </div>
  `,
})
export class DomainPickerComponent implements OnDestroy {
  state = inject(AdminStateService);
  private api = inject(ApiService);
  private billing = inject(BillingService);
  private telemetry = inject(TelemetryService);
  private toast = inject(ToastService);
  private router = inject(Router);

  /** Clears the in-flight wallet-checkout popup poll + listener, if any. Set by startWalletViaCheckout. */
  private walletPopupCleanup: (() => void) | null = null;

  @ViewChild('trigger', { static: false }) trigger?: ElementRef<HTMLButtonElement>;
  @ViewChild('searchInput', { static: false }) searchInput?: ElementRef<HTMLInputElement>;
  @ViewChild('panel', { static: false }) panel?: ElementRef<HTMLDivElement>;

  /** Skeleton-row range — 10 placeholders while AI suggestions load. */
  readonly skeletonRange = Array.from({ length: AI_SUGGESTION_COUNT }, (_, i) => i);

  // Picker state.
  open = signal(false);
  query = signal('');
  /** Two-way bound to the input — `query` shadow tracks committed value. */
  queryModel = '';
  availabilityChecking = signal(false);
  suggestionsLoading = signal(false);
  refining = signal(false);
  registering = signal<string | null>(null);

  hostnames = signal<Hostname[]>([]);
  suggestions = signal<DomainSuggestion[]>([]);
  liveResults = signal<LiveDomainRow[]>([]);
  /** Set of just-purchased domains so rows can morph into "✓ Yours". */
  purchasedDomains = signal<Set<string>>(new Set());

  focusedSection = signal<'assigned' | 'register' | 'live' | null>('assigned');
  focusedIndex = signal(0);

  /** Wallet state — proxied from {@link BillingService.walletState}. */
  wallet = computed<WalletState>(() => this.billing.walletState());

  // Active hostname display in the trigger.
  activeHost = computed<string>(() => {
    const site = this.state.selectedSite();
    if (!site) return 'projectsites.dev';
    if (site.primary_hostname) return site.primary_hostname;
    if (site.slug) return `${site.slug}.projectsites.dev`;
    return 'projectsites.dev';
  });

  /**
   * CNAME target for "manage your own DNS". Point at the site's OWN
   * `{slug}.projectsites.dev` subdomain, not the apex — the subdomain already
   * resolves the tenant at the edge (no apex host-resolution hop), so it's the
   * faster CNAME target. Falls back to the apex when there's no slug yet.
   */
  cnameTarget = computed<string>(() => {
    const slug = this.state.selectedSite()?.slug;
    return slug ? `${slug}.projectsites.dev` : 'projectsites.dev';
  });

  /** Human label for "AI picks for {biz}" header — falls back to "your site". */
  businessLabel = computed<string>(() => {
    const site = this.state.selectedSite();
    return site?.business_name?.trim() || 'your site';
  });

  filteredAssigned = computed<PickerHostname[]>(() => {
    const site = this.state.selectedSite();
    const primary = site?.primary_hostname || '';
    const hasSlug = !!site?.slug;
    const defaultHost = this.cnameTarget(); // {slug}.projectsites.dev (apex only when no slug)
    const rows: PickerHostname[] = this.hostnames().map((h) => ({
      ...h,
      isActive: !!primary && h.hostname === primary,
      isDefault: hasSlug && h.hostname === defaultHost,
    }));
    // Every site permanently resolves on its {slug}.projectsites.dev subdomain. If the API
    // returned no hostname row for it, synthesize one so the list is never empty and the site
    // is never strandable — the default is non-removable / non-deactivatable.
    if (hasSlug && !rows.some((r) => r.hostname === defaultHost)) {
      rows.unshift({
        id: SYNTHETIC_DEFAULT_ID,
        hostname: defaultHost,
        status: 'active',
        is_primary: !primary || primary === defaultHost,
        isActive: !primary || primary === defaultHost,
        isDefault: true,
      });
    }
    const q = this.query().trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.hostname.toLowerCase().includes(q));
  });

  private searchSubject = new Subject<string>();

  constructor() {
    // Debounced live-availability search — 300ms keeps RDAP off the hot path.
    this.searchSubject
      .pipe(
        debounceTime(300),
        distinctUntilChanged(),
        switchMap((q) => {
          const trimmed = q.trim();
          if (trimmed.length < 2) {
            this.liveResults.set([]);
            this.availabilityChecking.set(false);
            return of(null);
          }
          // Skip if exact assigned-domain match.
          const assignedMatch = this.hostnames().some(
            (h) => h.hostname.toLowerCase() === trimmed.toLowerCase(),
          );
          if (assignedMatch) {
            this.liveResults.set([]);
            this.availabilityChecking.set(false);
            return of(null);
          }
          // Seed per-TLD spinner rows so the UI feels alive even before RDAP returns.
          // For a full domain ("heyo.com"), search by the ROOT so the typed domain
          // shows alongside query-weighted sibling-TLD alternatives — a taken exact
          // match then surfaces available options right below it. Plain text works
          // the same way (any text → root.{tld} options).
          const looksLikeDomain = /^[a-z0-9-]+\.[a-z]{2,}$/i.test(trimmed);
          const root = looksLikeDomain ? trimmed.split('.')[0] : trimmed;
          const typedTld = looksLikeDomain ? trimmed.slice(root.length + 1).toLowerCase() : '';
          // Typed TLD leads (so the user's exact domain is first), then the rest.
          const tldOrder = typedTld && SEARCH_TLDS.includes(typedTld)
            ? [typedTld, ...SEARCH_TLDS.filter((t) => t !== typedTld)]
            : SEARCH_TLDS;
          const seen = new Set<string>();
          const seedRows: LiveDomainRow[] = tldOrder
            .map((tld) => `${root}.${tld}`)
            .filter((d) => { const k = d.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
            .map((d) => this.makeCheckingRow(d));
          this.liveResults.set(seedRows);
          this.availabilityChecking.set(true);
          const business = this.state.selectedSite()?.business_name || '';
          return this.api.searchDomainsEnriched(root, business).pipe(
            catchError((err) => {
              console.warn('domain-picker availability check failed', err);
              return of({ results: [] as DomainSuggestion[] });
            }),
          );
        }),
      )
      .subscribe((res) => {
        this.availabilityChecking.set(false);
        if (!res) return;
        // Merge RDAP results onto the seeded spinner rows so any domain not
        // returned by the backend still resolves (defaults to taken).
        const byDomain = new Map(res.results.map((r) => [r.domain.toLowerCase(), r]));
        const merged = this.liveResults().map((row) => {
          const hit = byDomain.get(row.domain.toLowerCase());
          if (!hit) return { ...row, available: false, checking: false, status: 'taken' as const };
          return { ...hit, checking: false };
        });
        this.liveResults.set(merged);
      });

    // Refresh hostnames when the selected site changes or panel opens.
    effect(() => {
      const site = this.state.selectedSite();
      if (site && this.open()) {
        this.refreshHostnames(site.id);
      }
    });
  }

  /**
   * Lifecycle: release long-lived handles on route nav. `close()` normally
   * pairs `billing.stop()` with `openPanel()`'s `billing.start()` — but a
   * destroy while the panel is open would leave the ref-counted 60s wallet
   * poll running forever. Also stops any in-flight checkout-popup poll.
   */
  ngOnDestroy(): void {
    if (this.open()) this.billing.stop();
    this.walletPopupCleanup?.();
    this.walletPopupCleanup = null;
  }

  // ---------- Panel lifecycle ----------

  goHome(): void {
    this.router.navigateByUrl('/admin');
  }

  toggle(): void {
    if (this.open()) this.close();
    else this.openPanel();
  }

  openPanel(): void {
    this.open.set(true);
    this.billing.start();
    const site = this.state.selectedSite();
    if (site) {
      this.refreshHostnames(site.id);
      void this.loadAiSuggestions(site.id);
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = this.searchInput?.nativeElement;
        if (el) {
          el.focus({ preventScroll: true });
          el.select();
        }
      });
    });
  }

  close(): void {
    this.open.set(false);
    this.query.set('');
    this.queryModel = '';
    this.liveResults.set([]);
    this.suggestions.set([]);
    this.purchasedDomains.set(new Set());
    this.focusedSection.set('assigned');
    this.focusedIndex.set(0);
    this.billing.stop();
    requestAnimationFrame(() => this.trigger?.nativeElement?.focus({ preventScroll: true }));
  }

  // ---------- AI suggestions ----------

  /**
   * Fetch the initial 10 AI-curated domain suggestions for the current site.
   * Owned by sibling agent #99 — endpoint:
   * `GET /api/domains/suggest?site_id=X&count=10`
   */
  private async loadAiSuggestions(siteId: string): Promise<void> {
    this.suggestionsLoading.set(true);
    try {
      const res = await this.fetchSuggestEndpoint(`/domains/suggest?site_id=${encodeURIComponent(siteId)}&count=${AI_SUGGESTION_COUNT}`, 'GET');
      // Worker contract is `{ suggestions }` — a `{ results }` read here
      // silently swallowed every real suggestion and made "Show me different
      // ones" look dead (response-key-mismatch lying-empty, fixed 2026-08-20).
      const suggestions = (res?.suggestions ?? []) as DomainSuggestion[];
      // Never show an empty dropdown — fall back to brand-derived idea fillers so
      // there are always 8-12 starting options before the user types anything.
      this.suggestions.set(suggestions.length ? suggestions.slice(0, AI_SUGGESTION_COUNT) : this.brandFallbackSuggestions());
      this.telemetry.track('domain.suggestions_shown', { count: this.suggestions().length, fallback: suggestions.length === 0 });
    } catch (err) {
      console.warn('domain-picker AI suggestions failed', err);
      this.suggestions.set(this.brandFallbackSuggestions());
    } finally {
      this.suggestionsLoading.set(false);
    }
  }

  /**
   * Deterministic brand-derived idea fillers (no network). Used when the AI
   * suggest endpoint returns nothing, so the dropdown always opens with 8-12
   * on-brand starting options. These are IDEAS — no availability is claimed
   * (no status badge); typing one into the search checks it live.
   */
  private brandFallbackSuggestions(): DomainSuggestion[] {
    const raw = (this.state.selectedSite()?.business_name || this.state.selectedSite()?.slug || 'yourbrand').toLowerCase();
    const root = raw.replace(/[^a-z0-9]/g, '').slice(0, 24) || 'yourbrand';
    const candidates = [
      `${root}.com`, `${root}.io`, `${root}.app`, `${root}.co`, `${root}.ai`,
      `get${root}.com`, `try${root}.com`, `${root}hq.com`, `use${root}.com`, `${root}.studio`,
      `join${root}.com`, `${root}.dev`,
    ];
    const seen = new Set<string>();
    return candidates
      .filter((d) => { const k = d.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, AI_SUGGESTION_COUNT)
      // No reason copy — the "Recommended" pill (rendered on every AI row) says it.
      .map((domain) => ({ domain } as DomainSuggestion));
  }

  /** "Show me different ones" — POST refine endpoint with current 10 excluded. */
  async refineSuggestions(): Promise<void> {
    const site = this.state.selectedSite();
    if (!site || this.refining()) return;
    this.refining.set(true);
    try {
      const exclude = this.suggestions().map((s) => s.domain);
      const res = await this.fetchSuggestEndpoint(`/domains/suggest/refine`, 'POST', {
        count: AI_SUGGESTION_COUNT,
        exclude_domains: exclude,
        site_id: site.id,
      });
      const suggestions = (res?.suggestions ?? []) as DomainSuggestion[];
      this.suggestions.set(suggestions.slice(0, AI_SUGGESTION_COUNT));
      this.telemetry.track('domain.suggestions_shown', { count: suggestions.length, refined: true });
    } catch (err) {
      console.warn('domain-picker refine failed', err);
      this.toast.error("Couldn't fetch fresh picks — give it a moment.");
    } finally {
      this.refining.set(false);
    }
  }

  /**
   * Thin shim around ApiService for the suggest endpoints owned by sibling
   * agent #99. Wrapped here (rather than threaded through ApiService) so we
   * don't merge-conflict with #99's own api.service edits.
   */
  private async fetchSuggestEndpoint(
    path: string,
    method: 'GET' | 'POST',
    body?: unknown,
  ): Promise<{ suggestions: DomainSuggestion[] } | null> {
    const { firstValueFrom } = await import('rxjs');
    if (method === 'GET') {
      return firstValueFrom(this.api.get<{ suggestions: DomainSuggestion[] }>(path));
    }
    return firstValueFrom(this.api.post<{ suggestions: DomainSuggestion[] }>(path, body));
  }

  // ---------- Search ----------

  onQueryChange(v: string): void {
    this.query.set(v);
    this.searchSubject.next(v);
  }

  /** Build a placeholder row that renders the per-TLD spinner during RDAP. */
  private makeCheckingRow(domain: string): LiveDomainRow {
    return {
      available: false,
      can_register_inline: false,
      checking: true,
      domain,
      pitch: '',
      price_usd_yr: null,
      reason: '',
      status: 'unknown',
    };
  }

  // ---------- Focus / keyboard ----------

  setFocus(section: 'assigned' | 'register' | 'live', index: number): void {
    this.focusedSection.set(section);
    this.focusedIndex.set(index);
  }

  onSuggestionHover(section: 'register' | 'live', index: number, s: DomainSuggestion): void {
    this.setFocus(section, index);
    if (s.status === 'available') {
      const tld = s.domain.split('.').slice(-1)[0];
      this.telemetry.track('domain.suggestion_hovered', {
        domain: s.domain,
        price_cents: s.price_usd_yr != null ? Math.round(s.price_usd_yr * 100) : null,
        tld,
      });
    }
  }

  onPanelKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
      return;
    }
    if (e.key === 'Enter') {
      const section = this.focusedSection();
      const idx = this.focusedIndex();
      if (section === 'assigned') {
        const row = this.filteredAssigned()[idx];
        if (row) { e.preventDefault(); this.selectHost(row); }
      } else if (section === 'register' || section === 'live') {
        const rows = section === 'live' ? this.liveResults() : this.suggestions();
        const row = rows[idx];
        if (row && row.can_register_inline) {
          e.preventDefault();
          void this.register(row);
        } else if (row && row.available && row.fallback_url) {
          e.preventDefault();
          window.open(row.fallback_url, '_blank', 'noopener,noreferrer');
        }
      }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const section = this.focusedSection() || 'assigned';
      const max =
        section === 'assigned' ? this.filteredAssigned().length
          : section === 'live' ? this.liveResults().length
          : this.suggestions().length;
      if (max === 0) return;
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      this.focusedIndex.set((this.focusedIndex() + dir + max) % max);
      return;
    }
    if (e.key === 'Tab') {
      const sections: ('assigned' | 'register' | 'live')[] = ['assigned'];
      if (this.liveResults().length > 0) sections.push('live');
      if (this.suggestions().length > 0) sections.push('register');
      if (sections.length > 1) {
        e.preventDefault();
        const current = this.focusedSection() ?? 'assigned';
        const idx = sections.indexOf(current);
        const next = sections[(idx + 1) % sections.length];
        this.focusedSection.set(next);
        this.focusedIndex.set(0);
      }
    }
  }

  @HostListener('document:keydown.escape')
  onEsc(): void {
    if (this.open()) this.close();
  }

  /**
   * Enter inside the search input. Empty + Enter = keep current URL,
   * close. Non-empty = pick top available result (assigned → live → AI).
   */
  onSearchEnter(ev: Event): void {
    ev.preventDefault();
    const q = this.query().trim();
    if (q.length === 0) { this.close(); return; }
    const assigned = this.filteredAssigned();
    if (assigned.length > 0) { this.setDefault(assigned[0]); return; }
    const live = this.liveResults().find((s) => s.can_register_inline && !s.checking);
    if (live) { void this.register(live); return; }
    const inlineTop = this.suggestions().find((s) => s.can_register_inline);
    if (inlineTop) { void this.register(inlineTop); return; }
    const porkbunTop =
      this.liveResults().find((s) => s.available && s.fallback_url) ??
      this.suggestions().find((s) => s.available && s.fallback_url);
    if (porkbunTop?.fallback_url) {
      window.open(porkbunTop.fallback_url, '_blank', 'noopener,noreferrer');
    }
  }

  // ---------- Hostname management (preserved from previous build) ----------

  private refreshHostnames(siteId: string): void {
    this.api.getHostnames(siteId).subscribe({
      error: () => this.hostnames.set([]),
      next: (res) => this.hostnames.set(res.data || []),
    });
  }

  selectHost(h: PickerHostname): void {
    const site = this.state.selectedSite();
    if (!site) return;
    if (h.status === 'deactivated') {
      this.toast.error('Reactivate this hostname before switching to it.');
      return;
    }
    const updated = { ...site, primary_hostname: h.hostname };
    this.state.sites.update((list) => list.map((s) => (s.id === site.id ? updated : s)));
    this.toast.success(`Active domain switched to ${h.hostname}`);
    this.close();
  }

  setDefault(h: PickerHostname): void {
    const site = this.state.selectedSite();
    if (!site) return;
    // The synthesized default-subdomain row has no real hostname record — making it
    // primary means reverting the site to its {slug}.projectsites.dev home.
    const req =
      h.id === SYNTHETIC_DEFAULT_ID
        ? this.api.resetPrimaryHostname(site.id)
        : this.api.setPrimaryHostname(site.id, h.id);
    req.subscribe({
      error: () => this.toast.error('Failed to set primary domain.'),
      next: () => {
        this.toast.success(`${h.hostname} is now the primary domain.`);
        this.state.sites.update((list) =>
          list.map((s) => (s.id === site.id ? { ...s, primary_hostname: h.hostname } : s)),
        );
        this.refreshHostnames(site.id);
      },
    });
  }

  deactivate(h: PickerHostname): void {
    const site = this.state.selectedSite();
    if (!site) return;
    if (h.isDefault) {
      this.toast.error(`${h.hostname} is your permanent address — it can't be deactivated.`);
      return;
    }
    this.api.unsubscribeHostname(site.id, h.id).subscribe({
      error: () => this.toast.error('Failed to deactivate hostname.'),
      next: () => {
        this.toast.success(`${h.hostname} deactivated.`);
        this.refreshHostnames(site.id);
      },
    });
  }

  reactivate(h: PickerHostname): void {
    const site = this.state.selectedSite();
    if (!site) return;
    this.api.addHostname(site.id, h.hostname).subscribe({
      error: () => this.toast.error('Reactivation failed.'),
      next: () => {
        this.toast.success(`${h.hostname} reactivated.`);
        this.refreshHostnames(site.id);
      },
    });
  }

  // ---------- Purchase flow ----------

  /**
   * Wallet-aware one-click buy. Branches by wallet state, attempts auto-topup
   * on insufficient balance, falls through to Stripe popup when no wallet
   * exists and the user clicks the all-in-one CTA.
   */
  async register(s: DomainSuggestion): Promise<void> {
    const site = this.state.selectedSite();
    if (!site || !s.available || !s.can_register_inline) return;

    const tld = s.domain.split('.').slice(-1)[0];
    const priceCents = s.price_usd_yr != null ? Math.round(s.price_usd_yr * 100) : 0;
    const flowState = this.computeFlowState(priceCents);

    this.telemetry.track('domain.register_clicked', {
      domain: s.domain,
      flow_state: flowState,
      price_cents: priceCents,
      tld,
    });

    // No wallet path: open Stripe checkout popup first, then retry purchase.
    if (flowState === 'no_wallet') {
      const completed = await this.startWalletViaCheckout();
      if (!completed) return;
    }

    this.registering.set(s.domain);
    try {
      let result = await this.billing.purchaseDomain(site.id, s.domain);
      // Auto-topup chain on insufficient balance — single click, no friction.
      if (result.kind === 'wallet_insufficient') {
        const topped = await this.billing.topupWallet();
        if (topped) {
          result = await this.billing.purchaseDomain(site.id, s.domain);
        }
      }
      this.handlePurchaseResult(s, result, priceCents);
    } finally {
      this.registering.set(null);
    }
  }

  /** Compute which CTA path the row should take based on wallet + price. */
  private computeFlowState(priceCents: number): 'active_wallet' | 'insufficient_balance' | 'no_wallet' {
    const w = this.wallet();
    if (!w.has_wallet) return 'no_wallet';
    if (w.balance_cents >= priceCents) return 'active_wallet';
    return 'insufficient_balance';
  }

  /** Cinematic CTA label varies by wallet state + price tier. */
  registerCtaLabel(s: DomainSuggestion): string {
    if (!s.price_usd_yr) return 'Buy';
    const flow = this.computeFlowState(Math.round(s.price_usd_yr * 100));
    if (flow === 'active_wallet') return `Buy · $${s.price_usd_yr}/yr`;
    if (flow === 'insufficient_balance') return `Buy · $${s.price_usd_yr}/yr · top up`;
    return `Buy · $${s.price_usd_yr}/yr · start wallet`;
  }

  /** Render the result-discriminated-union into UI: success effect or punchline toast. */
  private handlePurchaseResult(s: DomainSuggestion, result: PurchaseResult, priceCents: number): void {
    const site = this.state.selectedSite();
    if (!site) return;

    if (result.kind === 'purchased') {
      const purchased = new Set(this.purchasedDomains());
      purchased.add(result.domain);
      this.purchasedDomains.set(purchased);
      this.toast.success(`${result.domain} is yours. SSL provisioning now.`);
      this.telemetry.track('domain.register_succeeded', {
        charged_cents: result.charged_cents,
        domain: result.domain,
        price_cents: priceCents,
      });
      this.refreshHostnames(site.id);
      // Auto-promote to primary for instant gratification.
      if (result.hostname_id) {
        this.api.setPrimaryHostname(site.id, result.hostname_id).subscribe({
          error: () => { /* non-fatal — user can switch manually */ },
          next: () => {
            this.state.sites.update((list) =>
              list.map((x) => (x.id === site.id ? { ...x, primary_hostname: result.domain } : x)),
            );
          },
        });
      }
      // Low-balance proactive nudge — non-blocking.
      const newBalance = this.wallet().balance_cents;
      if (newBalance < LOW_BALANCE_CENTS && this.wallet().has_wallet) {
        this.toast.info("Wallet's running low — auto-topup will fire next charge.");
      }
      return;
    }

    // All failure paths surface cinematic-punchline toasts.
    this.telemetry.track('domain.register_failed', { domain: s.domain, error_code: result.kind });

    if (result.kind === 'taken') {
      this.toast.error('Someone got there first. Pick another.');
      // Mark the row as taken so it greys out immediately.
      const updated = this.suggestions().map((row) =>
        row.domain === s.domain ? { ...row, available: false, can_register_inline: false, status: 'taken' as const } : row,
      );
      this.suggestions.set(updated);
      return;
    }
    if (result.kind === 'tld_unsupported') {
      this.toast.error(
        `CF doesn't carry .${result.tld}. Buy it at Porkbun, then point a CNAME at projectsites.dev.`,
        {
          action: { label: 'Open Porkbun', run: () => window.open(result.fallback_url, '_blank', 'noopener,noreferrer') },
          duration: 0,
        },
      );
      return;
    }
    if (result.kind === 'registrar_error') {
      this.toast.error("Registrar choked. Your wallet's refunded. Try again in a minute.");
      return;
    }
    if (result.kind === 'wallet_insufficient') {
      this.toast.error('Top-up failed. Open billing to fix it.', {
        action: {
          label: 'Open billing',
          run: () => { void this.router.navigateByUrl('/admin/billing'); this.close(); },
        },
        duration: 0,
      });
      return;
    }
    if (result.kind === 'no_wallet') {
      this.toast.error("Wallet isn't set up — start the subscription to enable one-click buys.");
      return;
    }
    this.toast.error(result.message || 'Purchase failed.');
  }

  /**
   * Open the Stripe Checkout popup for wallet subscription. Resolves `true`
   * once the popup posts back `stripe-checkout-complete`, `false` if the
   * user dismissed it.
   */
  private async startWalletViaCheckout(): Promise<boolean> {
    try {
      const checkoutUrl = await this.billing.startWalletCheckout();
      const popup = window.open(checkoutUrl, 'stripe-wallet', 'width=500,height=700');
      if (!popup) {
        this.toast.error('Popup blocked. Allow popups and try again.');
        return false;
      }
      return await new Promise<boolean>((resolve) => {
        // stop() tears down ALL popup-flow handles: previously the success
        // (message) path never cleared `closedPoll`, so it kept ticking until
        // the popup was manually closed — and a component destroy mid-checkout
        // leaked it entirely. ngOnDestroy invokes `walletPopupCleanup`.
        const stop = (): void => {
          clearInterval(closedPoll);
          window.clearTimeout(capTimer);
          window.removeEventListener('message', handler);
          if (this.walletPopupCleanup === stop) this.walletPopupCleanup = null;
        };
        const handler = (e: MessageEvent) => {
          if (typeof e.data === 'string' && e.data === 'stripe-checkout-complete') {
            stop();
            void this.billing.refreshWallet();
            this.telemetry.track('wallet.subscription_started', {});
            resolve(true);
          }
        };
        window.addEventListener('message', handler);
        const closedPoll = setInterval(() => {
          if (popup.closed) {
            stop();
            void this.billing.refreshWallet();
            resolve(this.wallet().has_wallet);
          }
        }, 600);
        // Abandonment cap: popup left open >10 min → stop polling, resolve current state.
        const capTimer = window.setTimeout(() => { stop(); resolve(this.wallet().has_wallet); }, 600_000);
        this.walletPopupCleanup = stop;
      });
    } catch (err) {
      console.warn('domain-picker startWalletViaCheckout failed', err);
      this.toast.error("Couldn't open billing — try again in a moment.");
      return false;
    }
  }

  // ---------- Misc ----------

  statusLabel(s: string): string {
    return (s || 'unknown').toUpperCase();
  }

  copyCname(): void {
    const target = this.cnameTarget();
    navigator.clipboard?.writeText(target).then(
      () => this.toast.success(`CNAME target copied — ${target}`),
      () => this.toast.error('Copy failed.'),
    );
  }
}
