/**
 * @module components/feature-dossier
 *
 * Full-screen "Spec Sheet" — a gorgeous, PDF-style markdown dossier that fully
 * documents a Feature Flag (Layer 1) or a Feature (Layer 2): overview, what-it-
 * does checklist, lifecycle, smoke test, automated coverage, a complete
 * integration guide, and sources. Surrounds the rendered markdown with advanced
 * chrome — an SVG coverage donut, a stage timeline, a request-flow diagram, a
 * metrics grid, a scroll-to table of contents, copy-markdown, and print/save-PDF.
 *
 * Markdown is rendered through the same safe pipeline as agent-message:
 * marked (GFM) → DOMPurify → external-link hardening → bypassSecurityTrustHtml.
 *
 * @example
 * ```html
 * <app-feature-dossier [model]="dossier()" [open]="dossierOpen()" (closed)="dossierOpen.set(false)" />
 * ```
 */

import { A11yModule } from '@angular/cdk/a11y';
import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  HostListener,
  inject,
  input,
  type OnDestroy,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { firstValueFrom } from 'rxjs';

import { ApiService } from '../../services/api.service';
import { ToastService } from '../../services/toast.service';
import { hardenExternalLinks } from '../agent-message/harden-links';
import { VisionQaComponent } from '../vision-qa/vision-qa.component';
import {
  buildDossierMarkdown,
  coverageSignal,
  type DossierModel,
  readMinutes,
  STAGES,
  tableOfContents,
  wordCount,
} from './dossier.model';

interface E2eSpec {
  path: string;
  status: 'idle' | 'queued' | 'running' | 'passed' | 'failed';
  durationMs?: number;
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, A11yModule, VisionQaComponent],
  selector: 'app-feature-dossier',
  standalone: true,
  styles: [`
    .fd-root { position: fixed; inset: 0; z-index: var(--ps-z-overlay-takeover, 100000); display: flex; flex-direction: column;
      background: color-mix(in oklch, var(--ps-bg, #060610) 97%, #000); color: var(--ps-ink, #f4f4ff); }
    .fd-bar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap;
      padding: .85rem 1.25rem; border-bottom: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 22%, transparent);
      background: color-mix(in oklch, var(--ps-bg, #060610) 80%, transparent); }
    .fd-bar-id { display: flex; align-items: baseline; gap: .65rem; flex-wrap: wrap; min-width: 0; }
    .fd-kind { font: 700 .6rem/1 'JetBrains Mono', ui-monospace, monospace; letter-spacing: .14em; text-transform: uppercase; color: var(--ps-accent, #00e5ff); }
    .fd-title { font-size: clamp(1.1rem, 2.4vw, 1.6rem); margin: 0; }
    .fd-key { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: .8rem; color: color-mix(in oklch, var(--ps-accent, #00e5ff) 80%, var(--ps-ink, #f4f4ff)); }
    .fd-bar-actions { display: flex; gap: .5rem; }
    .fd-btn { background: transparent; color: inherit; border: 1px solid color-mix(in oklch, currentColor 24%, transparent); padding: .4rem .75rem; border-radius: 8px; cursor: pointer; font: inherit; font-size: .82rem; min-height: 24px; transition: border-color .333s ease, background .333s ease; }
    .fd-btn:hover { border-color: var(--ps-accent, #00e5ff); background: color-mix(in oklch, var(--ps-accent, #00e5ff) 10%, transparent); }
    .fd-btn:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 2px; }
    .fd-btn-close { font-size: 1rem; line-height: 1; }
    .fd-scroll { flex: 1; overflow: auto; display: grid; grid-template-columns: 280px minmax(0, 1fr); gap: 1.5rem; padding: 1.5rem; max-width: 1240px; width: 100%; margin: 0 auto; box-sizing: border-box; }
    @media (max-width: 880px) { .fd-scroll { grid-template-columns: 1fr; } }
    .fd-rail { display: flex; flex-direction: column; gap: 1.1rem; position: sticky; top: 0; align-self: start; }
    @media (max-width: 880px) { .fd-rail { position: static; } }
    .fd-metric { background: color-mix(in oklch, var(--ps-bg, #060610) 55%, transparent); border: 1px solid color-mix(in oklch, currentColor 14%, transparent); border-radius: 14px; padding: 1rem; }
    .fd-cov { text-align: center; }
    /* A global svg display:block reset left-aligns the donut despite the
       text-align:center — margin:0 auto centers it in its panel (brief #2). */
    .fd-donut { width: 132px; height: 132px; display: block; margin: 0 auto; transform: rotate(-90deg); }
    .fd-donut-track { fill: none; stroke: color-mix(in oklch, var(--ps-ink, #f4f4ff) 12%, transparent); stroke-width: 10; }
    .fd-donut-fill { fill: none; stroke: var(--ps-accent, #00e5ff); stroke-width: 10; stroke-linecap: round; transition: stroke-dashoffset .8s ease; filter: drop-shadow(0 0 5px color-mix(in oklch, var(--ps-accent, #00e5ff) 55%, transparent)); }
    @media (prefers-reduced-motion: reduce) { .fd-donut-fill { transition: none; } }
    .fd-donut-num { transform: rotate(90deg); transform-origin: 60px 60px; fill: var(--ps-ink, #f4f4ff); font: 700 26px 'JetBrains Mono', ui-monospace, monospace; text-anchor: middle; }
    .fd-donut-unit { transform: rotate(90deg); transform-origin: 60px 60px; fill: color-mix(in oklch, var(--ps-ink, #f4f4ff) 50%, transparent); font: 600 11px 'JetBrains Mono', ui-monospace, monospace; text-anchor: middle; }
    .fd-cov-label { margin: .35rem 0 0; font-weight: 600; color: var(--ps-accent, #00e5ff); }
    .fd-cov-sub { margin: .1rem 0 0; font-size: .72rem; color: color-mix(in oklch, currentColor 55%, transparent); }
    .fd-chips { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: 1fr 1fr; gap: .5rem; }
    .fd-chips li { display: flex; flex-direction: column; gap: .1rem; background: color-mix(in oklch, var(--ps-bg, #060610) 55%, transparent); border: 1px solid color-mix(in oklch, currentColor 12%, transparent); border-radius: 10px; padding: .5rem .6rem; }
    .fd-chips span { font-size: .64rem; text-transform: uppercase; letter-spacing: .05em; color: color-mix(in oklch, currentColor 50%, transparent); }
    .fd-chips strong { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: .95rem; color: var(--ps-ink, #f4f4ff); }
    .fd-rail-h { margin: 0 0 .5rem; font-size: .68rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ps-accent, #00e5ff); font-weight: 700; }
    .fd-stages { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .35rem; }
    .fd-stage { display: flex; align-items: center; gap: .5rem; font-size: .82rem; color: color-mix(in oklch, currentColor 55%, transparent); }
    .fd-stage-dot { width: 9px; height: 9px; border-radius: 50%; background: color-mix(in oklch, currentColor 30%, transparent); flex: none; }
    .fd-stage-done { color: color-mix(in oklch, currentColor 80%, transparent); }
    .fd-stage-done .fd-stage-dot { background: color-mix(in oklch, var(--ps-accent, #00e5ff) 60%, transparent); }
    .fd-stage-now { color: var(--ps-accent, #00e5ff); font-weight: 700; }
    .fd-stage-now .fd-stage-dot { background: var(--ps-accent, #00e5ff); box-shadow: 0 0 8px color-mix(in oklch, var(--ps-accent, #00e5ff) 70%, transparent); }
    .fd-flow { width: 100%; height: auto; }
    .fd-flow-g rect { fill: color-mix(in oklch, var(--ps-bg, #060610) 40%, transparent); stroke: color-mix(in oklch, var(--ps-accent, #00e5ff) 35%, transparent); stroke-width: 1; }
    .fd-flow-g text { fill: var(--ps-ink, #f4f4ff); font: 600 10px 'JetBrains Mono', ui-monospace, monospace; text-anchor: middle; }
    .fd-flow-g line { stroke: color-mix(in oklch, var(--ps-accent, #00e5ff) 55%, transparent); stroke-width: 1.5; }
    .fd-flow-g polygon { fill: color-mix(in oklch, var(--ps-accent, #00e5ff) 70%, transparent); }
    .fd-flow-ok { stroke: color-mix(in oklch, #4ade80 55%, transparent) !important; }
    .fd-flow-no { stroke: color-mix(in oklch, #ff5555 55%, transparent) !important; }
    .fd-toc ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .15rem; }
    .fd-toc-link { background: none; border: 0; color: color-mix(in oklch, currentColor 70%, transparent); font: inherit; font-size: .82rem; text-align: left; padding: .25rem .35rem; border-radius: 6px; cursor: pointer; width: 100%; transition: color .333s ease, background .333s ease; }
    .fd-toc-link:hover { color: var(--ps-accent, #00e5ff); background: color-mix(in oklch, var(--ps-accent, #00e5ff) 8%, transparent); }
    .fd-toc-link:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 1px; }
    /* Scroll-spy: the section currently in view. */
    .fd-toc-link--active { color: var(--ps-accent, #00e5ff); font-weight: 700; background: color-mix(in oklch, var(--ps-accent, #00e5ff) 12%, transparent); box-shadow: inset 2px 0 0 var(--ps-accent, #00e5ff); }
    /* Paper — the gorgeous rendered markdown column. */
    .fd-paper { background: color-mix(in oklch, var(--ps-bg, #060610) 35%, #fff 2%); border: 1px solid color-mix(in oklch, currentColor 12%, transparent); border-radius: 16px; padding: clamp(1.25rem, 3vw, 2.75rem); box-shadow: var(--ps-shadow-modal, 0 16px 50px rgba(0,0,0,.5)); max-width: 860px; }
    .fd-paper :first-child { margin-top: 0; }
    .fd-paper h2 { font-size: 1.35rem; margin: 2rem 0 .75rem; padding-bottom: .35rem; border-bottom: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 22%, transparent); scroll-margin-top: 1rem; }
    .fd-paper h3 { font-size: 1.05rem; margin: 1.4rem 0 .5rem; color: var(--ps-accent, #00e5ff); }
    .fd-paper p { line-height: 1.7; margin: 0 0 1rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 90%, transparent); }
    .fd-paper ul, .fd-paper ol { line-height: 1.65; padding-left: 1.4rem; margin: 0 0 1rem; }
    .fd-paper li { margin: .25rem 0; }
    .fd-paper li input[type="checkbox"] { accent-color: var(--ps-accent, #00e5ff); margin-right: .4rem; }
    .fd-paper blockquote { margin: 0 0 1.25rem; padding: .5rem .9rem; border-left: 3px solid var(--ps-accent, #00e5ff); background: color-mix(in oklch, var(--ps-accent, #00e5ff) 7%, transparent); border-radius: 0 8px 8px 0; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 85%, transparent); }
    .fd-paper code { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: .85em; background: color-mix(in oklch, currentColor 10%, transparent); padding: .1rem .35rem; border-radius: 4px; }
    .fd-paper pre { background: color-mix(in oklch, var(--ps-bg, #060610) 85%, #000); border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 18%, transparent); border-radius: 10px; padding: 1rem; overflow: auto; margin: 0 0 1.25rem; }
    .fd-paper pre code { background: none; padding: 0; font-size: .82rem; line-height: 1.55; }
    .fd-paper table { border-collapse: collapse; width: 100%; margin: 0 0 1.25rem; font-size: .9rem; }
    .fd-paper th, .fd-paper td { text-align: left; padding: .5rem .75rem; border-bottom: 1px solid color-mix(in oklch, currentColor 14%, transparent); }
    .fd-paper th { color: var(--ps-accent, #00e5ff); font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; }
    .fd-paper a { color: var(--ps-accent, #00e5ff); text-decoration: underline; text-underline-offset: 2px; word-break: break-word; }
    .fd-paper a:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 2px; }
    /* Screenshots — captioned UI shots. Picture then italic caption (marked wraps the image + caption in one paragraph). */
    .fd-paper img { display: block; max-width: 100%; height: auto; margin: .9rem auto .25rem; border-radius: 12px; border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 22%, transparent); box-shadow: 0 10px 34px rgba(0,0,0,.45); }
    .fd-paper img ~ em, .fd-paper p:has(img) em { display: block; text-align: center; font-size: .8rem; font-style: normal; color: color-mix(in oklch, currentColor 58%, transparent); margin: 0 0 1.4rem; }
    /* On-this-page pinned to the top of the rail. */
    .fd-toc--top { padding-bottom: .9rem; margin-bottom: .2rem; border-bottom: 1px solid color-mix(in oklch, currentColor 12%, transparent); }
    .fd-main { min-width: 0; display: flex; flex-direction: column; gap: 1.5rem; }
    /* E2E coverage panel + parallel runner. */
    .fd-e2e { background: color-mix(in oklch, var(--ps-bg, #060610) 55%, transparent); border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 18%, transparent); border-radius: 16px; padding: 1.1rem 1.25rem; }
    .fd-e2e-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
    .fd-e2e-head h2 { margin: 0; font-size: 1.05rem; }
    .fd-run-btn { background: var(--ps-accent, #00e5ff); color: var(--ps-bg, #060610); border: 0; border-radius: 8px; padding: .5rem .9rem; font: inherit; font-weight: 700; font-size: .82rem; cursor: pointer; transition: filter .333s ease; }
    .fd-run-btn:hover:not(:disabled) { filter: brightness(1.08); }
    .fd-run-btn:disabled { opacity: .5; cursor: not-allowed; }
    .fd-run-btn:focus-visible { outline: 2px solid var(--ps-ink, #f4f4ff); outline-offset: 2px; }
    .fd-e2e-sub, .fd-e2e-note, .fd-e2e-empty { font-size: .82rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 65%, transparent); margin: .6rem 0 .4rem; }
    .fd-e2e-note { color: color-mix(in oklch, #fbbf24 85%, var(--ps-ink, #f4f4ff)); }
    .fd-e2e-table { width: 100%; border-collapse: collapse; font-size: .82rem; }
    .fd-e2e-table th { text-align: left; padding: .4rem .5rem; font-size: .68rem; text-transform: uppercase; letter-spacing: .04em; color: var(--ps-accent, #00e5ff); border-bottom: 1px solid color-mix(in oklch, currentColor 14%, transparent); }
    .fd-e2e-table td { padding: .45rem .5rem; border-bottom: 1px solid color-mix(in oklch, currentColor 8%, transparent); }
    .fd-e2e-table code { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: .76rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 88%, transparent); word-break: break-all; }
    .fd-e2e-dur { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); }
    .fd-e2e-status { font-size: .68rem; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; padding: .12rem .5rem; border-radius: 999px; white-space: nowrap;
      background: color-mix(in oklch, currentColor 14%, transparent); color: color-mix(in oklch, currentColor 70%, transparent); }
    .fd-e2e-status[data-st="running"], .fd-e2e-status[data-st="queued"] { background: color-mix(in oklch, var(--ps-accent, #00e5ff) 20%, transparent); color: var(--ps-accent, #00e5ff); }
    .fd-e2e-status[data-st="passed"] { background: #4ade80; color: #052e16; }
    .fd-e2e-status[data-st="failed"] { background: #f87171; color: #190606; }
    /* Entitlement lock banner — reason + one-click upgrade CTA (fire-69). */
    .fd-upgrade { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap;
      padding: 1rem 1.25rem; border-radius: 16px;
      border: 1px dashed color-mix(in oklch, var(--ps-accent, #00e5ff) 42%, transparent);
      background: color-mix(in oklch, var(--ps-accent, #00e5ff) 8%, transparent); }
    .fd-upgrade-copy { min-width: 0; }
    .fd-upgrade-h { margin: 0; font-weight: 700; color: var(--ps-ink, #f4f4ff); }
    .fd-upgrade-sub { margin: .2rem 0 0; font-size: .82rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 68%, transparent); }
    .fd-upgrade-link { flex: none; background: var(--ps-accent, #00e5ff); color: var(--ps-bg, #060610);
      font-weight: 700; font-size: .85rem; text-decoration: none; padding: .55rem 1rem; border-radius: 999px;
      transition: filter .15s ease; }
    .fd-upgrade-link:hover { filter: brightness(1.08); }
    .fd-upgrade-link:focus-visible { outline: 2px solid var(--ps-ink, #f4f4ff); outline-offset: 2px; }
    /* Print / Save-as-PDF — drop chrome, white paper, black ink. */
    @media print {
      .fd-bar, .fd-rail, .fd-e2e, app-vision-qa { display: none !important; }
      .fd-root { position: static; background: #fff; color: #111; }
      .fd-scroll { display: block; padding: 0; }
      .fd-paper { box-shadow: none; border: 0; background: #fff; color: #111; max-width: none; }
      .fd-paper h2 { border-color: #ccc; color: #111; }
      .fd-paper h3 { color: #0a6; }
      .fd-paper pre { background: #f4f4f4; border-color: #ddd; }
      .fd-paper code { background: #f0f0f0; }
      .fd-paper a { color: #06c; }
    }
  `],
  template: `
    @if (open() && model(); as m) {
      <div #root class="fd-root" role="dialog" aria-modal="true" [attr.aria-label]="'Spec sheet — ' + m.name"
           cdkTrapFocus [cdkTrapFocusAutoCapture]="true" data-testid="feature-dossier">
        <header class="fd-bar">
          <div class="fd-bar-id">
            <span class="fd-kind">{{ m.kind }}</span>
            <h1 class="fd-title">{{ m.name }}</h1>
            <code class="fd-key">{{ m.key }}</code>
          </div>
          <div class="fd-bar-actions">
            <button type="button" class="fd-btn" (click)="copyMarkdown()" data-testid="fd-copy" aria-label="Copy the full spec as Markdown">⧉ Copy MD</button>
            <button type="button" class="fd-btn" (click)="print()" data-testid="fd-print" aria-label="Print or save as PDF">⎙ Save PDF</button>
            <button type="button" class="fd-btn fd-btn-close" (click)="closed.emit()" data-testid="fd-close" aria-label="Close spec sheet">✕</button>
          </div>
        </header>

        <div class="fd-scroll">
          <aside class="fd-rail" aria-label="Spec metrics">
            <!-- Table of contents — pinned to the TOP of the rail so the section
                 jump-list is the first thing in view. -->
            <nav class="fd-toc fd-toc--top" aria-label="On this page">
              <p class="fd-rail-h">On this page</p>
              <ul>
                @for (t of toc(); track t.slug) {
                  <li><button type="button" class="fd-toc-link" [class.fd-toc-link--active]="activeToc() === t.slug" [attr.aria-current]="activeToc() === t.slug ? 'true' : null" (click)="goTo(t.slug)">{{ t.title }}</button></li>
                }
              </ul>
            </nav>

            <!-- Coverage donut -->
            <div class="fd-metric fd-cov">
              <svg viewBox="0 0 120 120" class="fd-donut" role="img" [attr.aria-label]="'Coverage signal ' + cov().score + ' out of 100, ' + cov().label">
                <circle class="fd-donut-track" cx="60" cy="60" r="52" />
                <circle class="fd-donut-fill" cx="60" cy="60" r="52"
                        [attr.stroke-dasharray]="circumference"
                        [attr.stroke-dashoffset]="dashOffset()" />
                <text x="60" y="56" class="fd-donut-num">{{ cov().score }}</text>
                <text x="60" y="74" class="fd-donut-unit">/ 100</text>
              </svg>
              <p class="fd-cov-label">{{ cov().label }}</p>
              <p class="fd-cov-sub">Documentation &amp; test coverage signal</p>
            </div>

            <!-- Metric chips -->
            <ul class="fd-chips" aria-label="Key facts">
              @if (m.stage) { <li><span>Stage</span><strong>{{ m.stage }}</strong></li> }
              @if (m.rolloutPercent !== undefined) { <li><span>Rollout</span><strong>{{ m.rolloutPercent }}%</strong></li> }
              @if (m.requiredPlan) { <li><span>Plan</span><strong>{{ m.requiredPlan }}</strong></li> }
              <li><span>Checkpoints</span><strong>{{ m.checklist?.length || 0 }}</strong></li>
              <li><span>E2E specs</span><strong>{{ m.e2eTests?.length || 0 }}</strong></li>
              <li><span>Read</span><strong>{{ readTime() }} min</strong></li>
            </ul>

            <!-- Stage timeline -->
            @if (m.kind === 'Feature Flag') {
              <div class="fd-metric">
                <p class="fd-rail-h">Lifecycle</p>
                <ol class="fd-stages">
                  @for (s of stages; track s) {
                    <li class="fd-stage" [class.fd-stage-now]="s === m.stage" [class.fd-stage-done]="stageIndex(m.stage) > stages.indexOf(s)">
                      <span class="fd-stage-dot" aria-hidden="true"></span>{{ s }}
                    </li>
                  }
                </ol>
              </div>
            }

            <!-- Request-flow diagram -->
            <div class="fd-metric">
              <p class="fd-rail-h">{{ m.kind === 'Feature Flag' ? 'Resolution flow' : 'Enablement flow' }}</p>
              <svg viewBox="0 0 220 132" class="fd-flow" role="img" [attr.aria-label]="m.kind === 'Feature Flag' ? 'Request to flag resolve to on route or off 404' : 'Owner toggle to entitlement check to live on site'">
                @if (m.kind === 'Feature Flag') {
                  <g class="fd-flow-g">
                    <rect x="6" y="10" width="92" height="26" rx="6"/><text x="52" y="27">Request</text>
                    <line x1="98" y1="23" x2="122" y2="23"/><polygon points="122,19 130,23 122,27"/>
                    <rect x="130" y="10" width="84" height="26" rx="6"/><text x="172" y="27">isFlagOn()</text>
                    <line x1="172" y1="36" x2="172" y2="56"/><polygon points="168,56 172,64 176,56"/>
                    <rect x="118" y="64" width="96" height="26" rx="6" class="fd-flow-ok"/><text x="166" y="81">on → serve</text>
                    <line x1="118" y1="77" x2="100" y2="77"/><polygon points="100,73 92,77 100,81"/>
                    <rect x="6" y="64" width="86" height="26" rx="6" class="fd-flow-no"/><text x="49" y="81">off → 404</text>
                  </g>
                } @else {
                  <g class="fd-flow-g">
                    <rect x="6" y="10" width="100" height="26" rx="6"/><text x="56" y="27">Owner toggle</text>
                    <line x1="106" y1="23" x2="128" y2="23"/><polygon points="128,19 136,23 128,27"/>
                    <rect x="120" y="10" width="94" height="26" rx="6"/><text x="167" y="27">entitlement</text>
                    <line x1="167" y1="36" x2="167" y2="56"/><polygon points="163,56 167,64 171,56"/>
                    <rect x="118" y="64" width="96" height="26" rx="6" class="fd-flow-ok"/><text x="166" y="81">live on site</text>
                  </g>
                }
              </svg>
            </div>
          </aside>

          <div class="fd-main">
            <!-- Entitlement lock banner — when this owner feature isn't on the
                 current plan, say WHY + offer a one-click upgrade CTA so the spec
                 sheet is never a documented-but-unreachable dead end (fire-69). -->
            @if (isLocked(m)) {
              <section class="fd-upgrade" data-testid="fd-upgrade-cta" role="note"
                       aria-label="This feature isn't included on your current plan">
                <div class="fd-upgrade-copy">
                  <p class="fd-upgrade-h">{{ lockReason(m) }}</p>
                  <p class="fd-upgrade-sub">Unlock it in one click — your live site updates the moment it's on.</p>
                </div>
                <a class="fd-upgrade-link" data-testid="fd-upgrade-link"
                   [attr.href]="'/admin/billing?spec=' + m.key"
                   [attr.aria-label]="lockCtaLabel(m) + ' — ' + m.name">{{ lockCtaLabel(m) }} →</a>
              </section>
            }

            <!-- E2E coverage table + parallel runner (Cloudflare-backed) -->
            <section class="fd-e2e" data-testid="fd-e2e" aria-label="End-to-end test coverage">
              <header class="fd-e2e-head">
                <h2>E2E coverage</h2>
                <button type="button" class="fd-run-btn" data-testid="fd-run-e2e"
                        (click)="runE2e()" [disabled]="e2eSpecs().length === 0 || e2eRunning()"
                        [attr.aria-label]="'Run all ' + e2eSpecs().length + ' E2E tests for ' + m.name + ' in parallel'">
                  {{ e2eRunning() ? 'Running…' : 'Run all in parallel ▶' }}
                </button>
              </header>
              @if (e2eError(); as err) {
                <p class="fd-e2e-note" role="status">{{ err }}</p>
              }
              @if (e2eSpecs().length === 0) {
                <p class="fd-e2e-empty">No E2E specs linked yet. A flag must carry at least one before it reaches <code>beta</code>.</p>
              } @else {
                <p class="fd-e2e-sub">{{ e2eSpecs().length }} spec{{ e2eSpecs().length === 1 ? '' : 's' }} cover this {{ m.kind === 'Feature Flag' ? 'flag' : 'feature' }}. They run concurrently on Cloudflare — status updates live.</p>
                <table class="fd-e2e-table">
                  <thead><tr><th>Spec</th><th>Status</th><th class="fd-e2e-dur">Time</th></tr></thead>
                  <tbody>
                    @for (s of e2eSpecs(); track s.path) {
                      <tr>
                        <td><code [attr.title]="s.path">{{ s.path }}</code></td>
                        <td><span class="fd-e2e-status" [attr.data-st]="s.status">{{ s.status }}</span></td>
                        <td class="fd-e2e-dur">{{ s.durationMs ? (s.durationMs + 'ms') : '—' }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              }
            </section>

            @if (m.previewUrl) {
              <app-vision-qa [url]="m.previewUrl" />
            }

            <article #body class="fd-paper" data-testid="fd-body" [innerHTML]="html()"></article>
          </div>
        </div>
      </div>
    }
  `,
})
export class FeatureDossierComponent implements OnDestroy {
  private readonly sanitizer = inject(DomSanitizer);
  private readonly toast = inject(ToastService);
  private readonly api = inject(ApiService);

  readonly model = input<DossierModel | null>(null);
  readonly open = input(false);
  readonly closed = output<void>();

  private readonly body = viewChild<ElementRef<HTMLElement>>('body');

  /** The fixed full-screen overlay root. Re-parented to <body> on open so its
   *  z-index (`--ps-z-overlay-takeover`) is not trapped by a stacking-context
   *  ancestor in the admin shell (the sidebar otherwise paints over it). */
  private readonly rootEl = viewChild<ElementRef<HTMLElement>>('root');
  private reparentedRoot: HTMLElement | null = null;

  readonly stages = STAGES;
  readonly circumference = 2 * Math.PI * 52;

  /** Scroll-spy: the slug of the section currently in view (highlights the TOC). */
  readonly activeToc = signal('');
  private tocObserver?: IntersectionObserver;
  private readonly tocVisible = new Set<string>();

  /** Body scroll-lock bookkeeping — restore the page's prior overflow on close. */
  private prevBodyOverflow: string | null = null;

  constructor() {
    // Re-wire the scroll-spy whenever the dossier opens or its rendered content
    // changes (html() depends on the model). setTimeout lets the innerHTML paint.
    effect(() => {
      const isOpen = this.open();
      this.html(); // dependency: re-run when the rendered body changes
      this.teardownTocSpy();
      if (isOpen) setTimeout(() => this.setupTocSpy(), 60);
    });

    // §17: lock background page scroll while the full-screen takeover is open.
    // The `.fd-root` is `position:fixed inset:0`, so without this a trackpad
    // swipe at the dossier's scroll boundary bleeds to the admin page behind.
    effect(() => {
      if (this.open()) this.lockBodyScroll();
      else this.unlockBodyScroll();
    });

    // Stacking-context fix (per gorgeous-by-default § the z-index trap): the
    // dossier is declared inside an admin section that lives under transformed
    // / contained ancestors, so `z-index:100000` is confined to that ancestor's
    // stacking level — the sidebar (a higher body-level sibling) paints OVER
    // it. Move the `.fd-root` node up to <body> on open so its z-index competes
    // at the document level. `position:fixed` stays viewport-relative once no
    // transformed ancestor remains. Angular still owns the node (the `@if`
    // removes it from <body> on close), and ngOnDestroy detaches any stray.
    effect(() => {
      const el = this.open() ? this.rootEl()?.nativeElement : undefined;
      if (el && typeof document !== 'undefined' && el.parentElement !== document.body) {
        document.body.appendChild(el);
        this.reparentedRoot = el;
      }
    });
  }

  private lockBodyScroll(): void {
    if (typeof document === 'undefined' || this.prevBodyOverflow !== null) return;
    this.prevBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }

  private unlockBodyScroll(): void {
    if (typeof document === 'undefined' || this.prevBodyOverflow === null) return;
    document.body.style.overflow = this.prevBodyOverflow;
    this.prevBodyOverflow = null;
  }

  private setupTocSpy(): void {
    const el = this.body()?.nativeElement;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const heads = Array.from(el.querySelectorAll<HTMLElement>('h2[id]'));
    if (!heads.length) return;
    const order = heads.map((h) => h.id);
    this.tocVisible.clear();
    this.tocObserver = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).id;
          if (e.isIntersecting) this.tocVisible.add(id);
          else this.tocVisible.delete(id);
        }
        const active = order.find((id) => this.tocVisible.has(id));
        if (active) this.activeToc.set(active);
      },
      { root: el.closest('.fd-scroll'), rootMargin: '0px 0px -70% 0px', threshold: 0 },
    );
    for (const h of heads) this.tocObserver.observe(h);
    this.activeToc.set(order[0]);
  }

  private teardownTocSpy(): void {
    this.tocObserver?.disconnect();
    this.tocObserver = undefined;
    this.tocVisible.clear();
  }

  /** Assembled GFM dossier. */
  readonly markdown = computed(() => {
    const m = this.model();
    return m ? buildDossierMarkdown(m) : '';
  });

  readonly cov = computed(() => {
    const m = this.model();
    return m ? coverageSignal(m) : { label: '', parts: [], score: 0 };
  });

  readonly toc = computed(() => tableOfContents(this.markdown()));
  readonly readTime = computed(() => readMinutes(wordCount(this.markdown())));
  readonly dashOffset = computed(() => this.circumference * (1 - this.cov().score / 100));

  // ── E2E coverage table + Cloudflare-backed (Browser Rendering) parallel runner ──
  /** The runner's returned checks once a run starts (null = show the static spec list). */
  private readonly runSpecs = signal<E2eSpec[] | null>(null);
  readonly e2eRunning = signal(false);
  readonly e2eError = signal<string | null>(null);
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  readonly e2eSpecs = computed<E2eSpec[]>(() => {
    const live = this.runSpecs();
    if (live) return live;
    return (this.model()?.e2eTests ?? []).map((p) => ({ path: p, status: 'idle' as const }));
  });

  /**
   * Kick off this feature's checks in parallel on Cloudflare Browser Rendering
   * (no Docker). The worker fans HTTP + Playwright checks concurrently; we poll
   * the run for live per-check status (streaming-equivalent). The runner returns
   * its own check list (HTTP smokes + browser assertions), which replaces the
   * static spec list once a run starts. Degrades gracefully if not yet deployed.
   */
  async runE2e(): Promise<void> {
    const m = this.model();
    if (!m || this.e2eRunning()) return;
    if (this.e2eSpecs().length === 0) return;
    this.e2eError.set(null);
    this.e2eRunning.set(true);
    try {
      const res = await firstValueFrom(
        this.api.post<{ runId?: string; specs?: E2eSpec[] }>(`/feature-e2e/${encodeURIComponent(m.key)}/run`, {}),
      );
      if (!res?.runId) throw new Error('no runId');
      if (res.specs?.length) this.runSpecs.set(res.specs);
      this.startPolling(res.runId);
    } catch (e) {
      this.stopPolling();
      this.e2eRunning.set(false);
      const status = (e as { status?: number })?.status;
      this.e2eError.set(
        status === 404 || status === 501
          ? 'Live E2E runner is provisioning — the checks above run once it’s deployed.'
          : 'Couldn’t start the E2E run. Try again in a moment.',
      );
    }
  }

  private startPolling(runId: string): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => void this.poll(runId), 1200);
    void this.poll(runId);
  }

  private async poll(runId: string): Promise<void> {
    try {
      const res = await firstValueFrom(
        this.api.get<{ status?: string; specs?: E2eSpec[] }>(`/feature-e2e/runs/${encodeURIComponent(runId)}`),
      );
      if (res?.specs?.length) this.runSpecs.set(res.specs);
      const done = res?.status && res.status !== 'running' && res.status !== 'queued';
      if (done) { this.stopPolling(); this.e2eRunning.set(false); }
    } catch {
      this.stopPolling();
      this.e2eRunning.set(false);
      this.e2eError.set('Lost contact with the E2E runner. Partial results shown.');
    }
  }

  private stopPolling(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  ngOnDestroy(): void {
    this.stopPolling();
    this.teardownTocSpy();
    this.unlockBodyScroll();
    // If we re-parented the overlay to <body> (stacking-context fix) and the
    // component is destroyed (route change) while it's still mounted there,
    // remove the orphan ourselves — Angular's `@if` can't reach a node we moved.
    if (this.reparentedRoot?.parentElement === document.body) {
      this.reparentedRoot.remove();
    }
    this.reparentedRoot = null;
  }

  /** Safe rendered HTML — same pipeline as agent-message, plus heading anchors. */
  readonly html = computed<SafeHtml>(() => {
    const md = this.markdown();
    if (!md) return this.sanitizer.bypassSecurityTrustHtml('');
    const parsed = marked.parse(md, { async: false, breaks: true, gfm: true }) as string;
    // Inject slug ids on <h2> so the TOC can scroll to sections.
    const anchored = parsed.replace(/<h2>(.*?)<\/h2>/g, (_m, inner: string) => {
      const slug = inner.replace(/<[^>]+>/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      return `<h2 id="${slug}">${inner}</h2>`;
    });
    const cleaned = DOMPurify.sanitize(anchored, { ADD_ATTR: ['id', 'class'] });
    return this.sanitizer.bypassSecurityTrustHtml(hardenExternalLinks(cleaned));
  });

  stageIndex(stage: string | undefined): number {
    const i = STAGES.indexOf((stage ?? '') as (typeof STAGES)[number]);
    return i < 0 ? -1 : i;
  }

  /**
   * True when this owner feature is gated off the current plan (a real lock
   * state), so the spec sheet should surface the reason + an upgrade CTA. A
   * plain flag, an available feature, or an unset entitlement is NOT locked.
   */
  isLocked(m: DossierModel): boolean {
    return m.kind === 'Feature' && (m.entitled === 'upgrade-required' || m.entitled === 'addon-required');
  }

  /** Plain-English reason the control is locked, naming the exact required plan. */
  lockReason(m: DossierModel): string {
    return m.entitled === 'addon-required'
      ? `${m.name} is available as an add-on — it isn't on your current plan yet.`
      : `${m.name} is included on the ${m.requiredPlan ?? 'higher'} plan and above — your current plan doesn't include it.`;
  }

  /** Per-entitlement upgrade CTA label (add-on vs the exact plan tier). */
  lockCtaLabel(m: DossierModel): string {
    return m.entitled === 'addon-required' ? 'Add as an add-on' : `Upgrade to ${m.requiredPlan ?? 'unlock'}`;
  }

  goTo(slug: string): void {
    this.body()?.nativeElement.querySelector('#' + CSS.escape(slug))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  print(): void {
    try { window.print(); } catch { /* print unavailable */ }
  }

  async copyMarkdown(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.markdown());
      this.toast.success('Spec copied as Markdown');
    } catch {
      this.toast.error('Copy failed — clipboard unavailable');
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.open()) this.closed.emit();
  }
}
