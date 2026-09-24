/**
 * /admin/feature-flags — LAYER 1 of the two-layer feature-flag control plane:
 * the **Feature Flags** surface. Platform-ops flags for the super-admin
 * (the operator), fed by `/api/super-admin/feature-flags` merged onto the
 * `/api/feature-flags` registry.
 *
 * Sibling layer: `/admin/site-features` (Layer 2 — owner-facing, plan-aware
 * features a site owner enables for their hosted site).
 *
 * Progressive disclosure (persisted per-layer in `localStorage['ff.mode.system']`):
 *   - Simple   — cards + toggles + status/scope/risk badges + plain "why".
 *   - Advanced — targeting (rollout %) + scheduling/expiry controls.
 *   - Expert   — raw key, JSON view, evaluation trace, JSON payload editor.
 *
 * Dangerous changes (kill switch, global-enable, ≥25-point rollout jumps) route
 * through a confirm panel that demands a typed reason + shows blast radius +
 * rollback plan before the mutation is sent (the reason is persisted in the
 * audit trail). Non-dangerous nudges apply directly with optimistic UI.
 *
 * Mutations: `POST /api/super-admin/feature-flags` (super-admin guarded — the
 * only flag mutation route the worker serves). `stage` is registry/code-managed
 * (no column) so it is read-only here.
 */

import { A11yModule } from '@angular/cdk/a11y';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, computed, HostListener, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { type DossierModel, englishSmoke } from '../../../components/feature-dossier/dossier.model';
import { FeatureDossierComponent } from '../../../components/feature-dossier/feature-dossier.component';
import { RollingCounterComponent } from '../../../components/rolling-counter/rolling-counter.component';
import { EmptyStateComponent, ErrorCardComponent } from '../../../components/states';
import { RevealDirective } from '../../../directives/reveal.directive';
import { AuthService } from '../../../services/auth.service';
import { FeatureFlagService } from '../../../services/feature-flag.service';
import { ToastService } from '../../../services/toast.service';
import { HlmInputDirective, HlmTablistDirective } from '../../../ui';
import { AdminStateService } from '../admin-state.service';
import { type AuditEntry, FlagAuditTimelineComponent } from './feature-flags/audit-timeline.component';
import { type FlagBadge, FlagBadgeRowComponent } from './feature-flags/badge-row.component';
import {
  bucketFor,
  type ChangeRisk,
  classifyChange,
  type EvalStep,
  evaluationTrace,
  type FlagConstraint,
  validateConstraints,
} from './feature-flags/flag-logic';
import { type DisclosureMode } from './feature-flags/disclosure-mode';

interface FlagDefinition {
  key: string;
  description: string;
  default_enabled: boolean;
  default_rollout_percent: number;
  stage: 'experimental' | 'beta' | 'stable' | 'deprecated' | 'killswitch';
  owner_email: string;
  kill_switch?: boolean;
}

interface ResolvedFlag {
  enabled: boolean;
  rollout_percent: number;
  stage: string;
  source: 'registry' | 'global' | 'org' | 'tenant';
}

interface FlagDocs {
  /** 3-6 short "what this does" checkpoints — rendered as a ✓ list. */
  checklist?: string[];
  explanation: string;
  smoke_test: string[];
  e2e_tests?: string[];
  screenshots?: { url: string; caption: string; alt?: string }[];
  references?: string[];
}

type StageFilter = 'all' | FlagDefinition['stage'];

/** Pending dangerous-change request awaiting a typed reason + confirmation. */
interface PendingDangerous {
  flag: FlagDefinition;
  patch: { enabled_globally?: boolean; rollout_pct?: number; kill_switch?: boolean };
  label: string;
  optimistic: (f: FlagDefinition) => FlagDefinition;
  /** Human "what this affects" blast-radius line. */
  blast: string;
  /** Human rollback line. */
  rollback: string;
}

/**
 * Dependency / incompatibility constraints between platform flags. Drives the
 * Advanced-mode coherence warnings + blocks incoherent enables.
 */
const FLAG_CONSTRAINTS: FlagConstraint[] = [
  { key: 'crdt_coedit', requires: ['tenant_hot_state'] },
];

@Component({
  imports: [
    CommonModule, FormsModule, RouterLink, RevealDirective, A11yModule,
    HlmInputDirective, HlmTablistDirective,
    EmptyStateComponent, ErrorCardComponent, RollingCounterComponent,
    FlagBadgeRowComponent, FlagAuditTimelineComponent,
    FeatureDossierComponent,
  ],
  selector: 'app-admin-feature-flags',
  standalone: true,
  styles: [`
    :host { display: block; box-sizing: border-box; width: 100%; min-width: 0; padding: 1.5rem; max-width: 1280px; margin: 0 auto; }
    .ff-page { color: var(--ps-ink, #f4f4ff); }
    .ff-header { display: flex; flex-wrap: wrap; align-items: start; justify-content: space-between; gap: 1rem; margin-bottom: 1.5rem; }
    .ff-head-left { min-width: 0; }
    .ff-head-right { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
    .ff-kicker { margin: 0 0 .25rem; font: 700 0.62rem/1 'JetBrains Mono', ui-monospace, monospace; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ps-accent, #00e5ff); opacity: 0.85; }
    .ff-header h1 { font-size: clamp(1.5rem, 3vw, 2.25rem); margin: 0 0 .25rem; }
    .ff-sub { color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 72%, transparent); max-width: 66ch; }
    .ff-sub strong { color: var(--ps-accent, #00e5ff); font-family: var(--ps-mono, ui-monospace, monospace); }
    .ff-stat-dots { opacity: 0.5; letter-spacing: 0.1em; }
    .ff-cross-link { color: var(--ps-accent, #00e5ff); text-decoration: underline; text-underline-offset: 2px; }
    .ff-cross-link:hover { color: var(--ps-ink, #f4f4ff); }
    .ff-cross-link:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 2px; border-radius: 4px; }
    .ff-refresh, .ff-emergency { background: transparent; border: 1px solid color-mix(in oklch, currentColor 30%, transparent); color: inherit; padding: .5rem 1rem; border-radius: 8px; cursor: pointer; font: inherit; min-height: 24px; }
    .ff-refresh:hover { background: color-mix(in oklch, currentColor 10%, transparent); }
    .ff-refresh:disabled { opacity: .5; cursor: not-allowed; }
    .ff-emergency { border-color: color-mix(in oklch, #ff5555 45%, transparent); color: #ff8888; }
    .ff-ic { display: inline-flex; vertical-align: -0.15em; margin-right: .4rem; }
    .ff-ic svg { width: 1em; height: 1em; display: block; }
    .ff-emergency:hover { background: color-mix(in oklch, #ff5555 12%, transparent); }
    .ff-refresh:focus-visible, .ff-emergency:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 2px; }
    .ff-blocked { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 1.25rem; padding: 0.7rem 0.9rem; border-radius: 12px;
      border: 1px solid color-mix(in oklch, var(--ps-accent, #00E5FF) 35%, transparent);
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 8%, transparent); }
    .ff-blocked-icon { display: inline-flex; align-items: center; line-height: 1; flex: none; }
    .ff-blocked-text { flex: 1; font-size: 0.78rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 88%, transparent); }
    .ff-blocked-text code { font-family: 'JetBrains Mono', monospace; color: var(--ps-accent, #00E5FF); font-size: 0.74rem; }
    .ff-blocked-dismiss { background: none; border: 0; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); cursor: pointer; font-size: 0.85rem; padding: 0.2rem 0.35rem; border-radius: 6px; min-height: 24px; min-width: 24px; }
    .ff-blocked-dismiss:hover { color: var(--ps-ink, #f4f4ff); }
    .ff-blocked-dismiss:focus-visible { outline: 2px solid var(--ps-accent, #00E5FF); outline-offset: 1px; }
    .ff-coherence { margin-bottom: 1.25rem; padding: .7rem .9rem; border-radius: 12px;
      border: 1px solid color-mix(in oklch, #fbbf24 40%, transparent); background: color-mix(in oklch, #fbbf24 8%, transparent); font-size: .82rem; }
    .ff-coherence ul { margin: .35rem 0 0; padding-left: 1.2rem; }
    .ff-toolbar { display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; margin-bottom: 1.5rem; }
    .ff-stages { display: flex; gap: .375rem; flex-wrap: wrap; min-width: 0; }
    .ff-stage-chip { background: transparent; color: inherit; border: 1px solid color-mix(in oklch, currentColor 18%, transparent); border-radius: 999px; padding: .375rem .75rem; cursor: pointer; font: inherit; font-size: .875rem; display: inline-flex; align-items: center; gap: .375rem; min-height: 24px; }
    .ff-stage-chip:hover { border-color: color-mix(in oklch, currentColor 40%, transparent); }
    .ff-stage-chip:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 2px; }
    .ff-stage-chip-active { background: var(--ps-accent, #00e5ff); color: var(--ps-bg, #060610); border-color: var(--ps-accent, #00e5ff); }
    .ff-stage-count { background: color-mix(in oklch, currentColor 18%, transparent); padding: .05rem .4rem; border-radius: 999px; font-size: .75rem; }
    .ff-stage-chip-active .ff-stage-count { background: color-mix(in oklch, currentColor 25%, transparent); }
    .ff-grid { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(360px, 100%), 1fr)); gap: 1rem; }
    .ff-card { background: color-mix(in oklch, var(--ps-bg, #060610) 55%, transparent); border: 1px solid color-mix(in oklch, currentColor 14%, transparent); border-radius: 14px; padding: 1.25rem; display: flex; flex-direction: column; gap: .65rem; transition: border-color .15s ease; }
    .ff-card:hover { border-color: color-mix(in oklch, var(--ps-accent, #00e5ff) 30%, transparent); }
    .ff-card[data-stage="killswitch"] { border-color: #ff5555; }
    .ff-card[data-stage="stable"] { border-color: color-mix(in oklch, #4ade80 40%, transparent); }
    .ff-card-on { border-color: color-mix(in oklch, #4ade80 38%, transparent); box-shadow: inset 0 0 0 1px color-mix(in oklch, #4ade80 18%, transparent); }
    .ff-card-killed { border-color: #ff5555 !important; background: color-mix(in oklch, #ff5555 7%, color-mix(in oklch, var(--ps-bg, #060610) 55%, transparent)); }
    .ff-card-killed .ff-key, .ff-card-killed .ff-desc { opacity: .7; }
    .ff-card-head { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
    .ff-key { font-family: var(--ps-mono, ui-monospace, monospace); font-size: 1rem; margin: 0; word-break: break-all; }
    .ff-key-btn { background: none; border: none; color: inherit; font: inherit; cursor: pointer; padding: 0; display: inline-flex; align-items: baseline; gap: .4em; word-break: break-all; text-align: left; border-radius: 4px; }
    .ff-key-btn:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 3px; }
    .ff-key-copy { font-size: .8em; opacity: .35; transition: opacity .12s, color .12s; }
    .ff-key-btn:hover .ff-key-copy, .ff-key-btn:focus-visible .ff-key-copy { opacity: 1; color: var(--ps-accent, #00e5ff); }
    .ff-desc { color: color-mix(in oklch, currentColor 70%, transparent); margin: 0; font-size: .9rem; line-height: 1.45; }
    .ff-why { color: color-mix(in oklch, currentColor 58%, transparent); margin: 0; font-size: .8rem; font-style: italic; }
    .ff-state-badge { font-weight: 600; font-size: .8rem; padding: .15rem .5rem; border-radius: 6px; font-family: var(--ps-mono, ui-monospace, monospace); }
    .ff-state-on { background: #4ade80; color: #052e16; }
    .ff-state-off { background: color-mix(in oklch, currentColor 18%, transparent); }
    .ff-rollout { font-family: var(--ps-mono, ui-monospace, monospace); font-size: .85rem; color: color-mix(in oklch, currentColor 65%, transparent); }
    /* At-a-glance rollout progress on each flag card. */
    .ff-rollout-bar { height: 4px; border-radius: 999px; overflow: hidden; margin: -.15rem 0 .1rem;
      background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 10%, transparent); }
    .ff-rollout-fill { display: block; height: 100%; border-radius: 999px; background: var(--ps-accent, #00e5ff); transition: width .35s ease; }
    .ff-rollout-fill--off { background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 28%, transparent); }
    @media (prefers-reduced-motion: reduce) { .ff-rollout-fill { transition: none; } }
    .ff-owner { font-size: .75rem; color: color-mix(in oklch, currentColor 50%, transparent); }
    /* Owner email → mailto (in-text link needs a default underline per WCAG 1.4.1). */
    .ff-owner-link { color: var(--ps-accent, #00e5ff); text-decoration: underline; text-underline-offset: 2px; }
    .ff-owner-link:hover { color: var(--ps-ink, #f4f4ff); }
    .ff-owner-link:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 2px; border-radius: 3px; }
    .ff-resolved { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
    .ff-resolved-source { font-size: .72rem; color: color-mix(in oklch, currentColor 60%, transparent); font-style: italic; }
    .ff-actions { display: flex; gap: .5rem; flex-wrap: wrap; margin-top: auto; }
    .ff-btn { background: transparent; color: inherit; border: 1px solid color-mix(in oklch, currentColor 22%, transparent); padding: .4rem .75rem; border-radius: 8px; cursor: pointer; font: inherit; font-size: .85rem; min-height: 24px; }
    .ff-btn:hover { border-color: color-mix(in oklch, currentColor 50%, transparent); }
    .ff-btn:disabled { opacity: .5; cursor: progress; }
    .ff-btn:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 2px; }
    .ff-btn-primary { background: var(--ps-accent, #00e5ff); color: var(--ps-bg, #060610); border-color: var(--ps-accent, #00e5ff); }
    .ff-btn-danger:hover { border-color: #ff5555; color: #ff5555; }
    .ff-btn-danger-solid { background: #ff5555; color: #190606; border-color: #ff5555; font-weight: 600; }
    .ff-btn-danger-solid:hover { filter: brightness(1.08); }
    .ff-btn-danger-solid:disabled { opacity: .5; }
    .ff-btn-restore { border-color: color-mix(in oklch, #4ade80 50%, transparent); color: #4ade80; }
    .ff-btn-restore:hover { border-color: #4ade80; background: color-mix(in oklch, #4ade80 12%, transparent); }
    .ff-detail { background: color-mix(in oklch, var(--ps-bg, #060610) 70%, transparent); border-radius: 8px; padding: .85rem 1rem; margin-top: .5rem; }
    .ff-detail h3 { font-size: .75rem; text-transform: uppercase; letter-spacing: .06em; margin: 1rem 0 .5rem; color: var(--ps-accent, #00e5ff); font-weight: 600; }
    .ff-detail h3:first-child { margin-top: 0; }
    .ff-explanation { line-height: 1.55; margin: 0; color: color-mix(in oklch, currentColor 85%, transparent); font-size: .9rem; }
    .ff-smoke { padding-left: 1.25rem; margin: 0; display: flex; flex-direction: column; gap: .35rem; }
    .ff-smoke li { line-height: 1.45; font-size: .85rem; }
    /* "What it does" checkpoint list — the scannable contract above the prose. */
    .ff-checklist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .3rem; }
    .ff-check { display: flex; align-items: flex-start; gap: .45rem; font-size: .85rem; line-height: 1.4; color: color-mix(in oklch, currentColor 82%, transparent); }
    .ff-check-ic { flex: none; margin-top: .12rem; color: var(--ps-accent, #00e5ff); }
    .ff-step { font-family: var(--ps-mono, ui-monospace, monospace); font-size: .82rem; background: color-mix(in oklch, currentColor 8%, transparent); padding: .15rem .4rem; border-radius: 4px; word-break: break-word; }
    .ff-e2e, .ff-refs { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: .3rem; }
    .ff-e2e li, .ff-refs li { font-size: .8rem; }
    .ff-refs a { color: var(--ps-accent, #00e5ff); word-break: break-all; }
    .ff-ctl { display: flex; flex-direction: column; gap: .35rem; margin-bottom: .65rem; }
    .ff-ctl-label { font-size: .8rem; color: color-mix(in oklch, currentColor 80%, transparent); }
    .ff-ctl-label strong { color: var(--ps-accent, #00e5ff); font-family: var(--ps-mono, ui-monospace, monospace); }
    .ff-range { width: 100%; max-width: 320px; accent-color: var(--ps-accent, #00e5ff); cursor: pointer; }
    .ff-range:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 4px; border-radius: 4px; }
    .ff-sched { max-width: 320px; background: color-mix(in oklch, var(--ps-bg, #060610) 60%, transparent); color: inherit; border: 1px solid color-mix(in oklch, currentColor 20%, transparent); border-radius: 8px; padding: .35rem .5rem; font: inherit; font-size: .82rem; }
    .ff-sched:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 1px; }
    .ff-ctl-hint { font-size: .72rem; color: color-mix(in oklch, currentColor 50%, transparent); margin: 0; line-height: 1.4; }
    .ff-trace-ctx { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; margin: 0 0 .55rem; }
    .ff-trace-ctx-label { font-size: .72rem; letter-spacing: .02em; text-transform: uppercase; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); }
    .ff-trace-input {
      flex: 1 1 9rem; min-width: 7rem; font: inherit; font-size: .8rem;
      color: var(--ps-ink, #f4f4ff); background: color-mix(in oklch, var(--ps-accent, #00e5ff) 5%, transparent);
      border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 24%, transparent);
      border-radius: 7px; padding: .3rem .55rem; font-family: 'JetBrains Mono', ui-monospace, monospace;
    }
    .ff-trace-input:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 1px; border-color: var(--ps-accent, #00e5ff); }
    .ff-trace-input::placeholder { color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 40%, transparent); }
    .ff-trace-bucket {
      font-size: .72rem; font-family: 'JetBrains Mono', ui-monospace, monospace; white-space: nowrap;
      color: var(--ps-accent, #00e5ff); padding: .25rem .5rem; border-radius: 6px;
      background: color-mix(in oklch, var(--ps-accent, #00e5ff) 10%, transparent);
      border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 22%, transparent);
    }
    .ff-eval-trace { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: .3rem; }
    .ff-eval-trace li { display: flex; gap: .5rem; align-items: baseline; font-size: .8rem; padding: .25rem .5rem; border-radius: 6px; background: color-mix(in oklch, currentColor 5%, transparent); }
    .ff-eval-trace li[data-outcome="block"], .ff-eval-trace li[data-outcome="final-off"] { background: color-mix(in oklch, #f87171 14%, transparent); }
    .ff-eval-trace li[data-outcome="pass"], .ff-eval-trace li[data-outcome="final-on"] { background: color-mix(in oklch, #4ade80 12%, transparent); }
    .ff-eval-label { font-weight: 600; min-width: 92px; flex: none; }
    .ff-eval-detail { color: color-mix(in oklch, currentColor 72%, transparent); }
    .ff-json { font-family: var(--ps-mono, ui-monospace, monospace); font-size: .78rem; margin: 0; overflow: auto; max-height: 200px; background: color-mix(in oklch, var(--ps-bg, #060610) 80%, transparent); padding: .6rem; border-radius: 6px; }
    .ff-json-editor { width: 100%; box-sizing: border-box; font-family: var(--ps-mono, ui-monospace, monospace); font-size: .78rem; background: color-mix(in oklch, var(--ps-bg, #060610) 80%, transparent); color: inherit; border: 1px solid color-mix(in oklch, currentColor 20%, transparent); border-radius: 6px; padding: .55rem; resize: vertical; }
    .ff-json-editor:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 1px; }
    .ff-json-error { color: #fca5a5; font-size: .78rem; margin: .4rem 0 0; }
    .ff-json-diff { margin: .5rem 0 .2rem; padding: .5rem .65rem; border-radius: 6px; background: color-mix(in oklch, var(--ps-accent, #00e5ff) 6%, transparent); border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 22%, transparent); }
    .ff-diff-label { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: var(--ps-accent, #00e5ff); font-weight: 600; }
    .ff-diff-list { list-style: none; margin: .35rem 0 0; padding: 0; display: flex; flex-direction: column; gap: .25rem; font-family: var(--ps-mono, ui-monospace, monospace); font-size: .76rem; }
    .ff-diff-list code { color: var(--ps-ink, #f4f4ff); }
    .ff-diff-from { color: color-mix(in oklch, #fca5a5 90%, transparent); text-decoration: line-through; }
    .ff-diff-arrow { color: color-mix(in oklch, currentColor 50%, transparent); }
    .ff-diff-to { color: #6ee7b7; }
    .ff-expert-actions { margin-top: .6rem; }
    .ff-danger-overlay { position: fixed; inset: 0; z-index: var(--ps-z-overlay-takeover, 100000); display: grid; place-items: center; padding: 1rem;
      background: color-mix(in oklch, #000 72%, transparent); backdrop-filter: blur(4px); }
    .ff-danger { width: min(560px, 100%); background: color-mix(in oklch, var(--ps-bg, #060610) 96%, #ff5555 4%); border: 1px solid color-mix(in oklch, #ff5555 45%, transparent); border-radius: var(--ps-radius-xl, 18px); padding: 1.5rem; box-shadow: var(--ps-shadow-modal, 0 24px 60px rgba(0,0,0,.6)); color: var(--ps-ink, #f4f4ff); }
    .ff-danger h2 { margin: 0 0 .5rem; font-size: 1.25rem; color: #ff8888; }
    .ff-danger-flag { margin: 0 0 1rem; font-size: .9rem; }
    .ff-danger-flag code { font-family: var(--ps-mono, ui-monospace, monospace); color: var(--ps-accent, #00e5ff); }
    .ff-danger-section { margin-bottom: 1rem; }
    .ff-danger-section h3 { font-size: .72rem; text-transform: uppercase; letter-spacing: .06em; margin: 0 0 .25rem; color: color-mix(in oklch, currentColor 60%, transparent); }
    .ff-danger-section p { margin: 0; font-size: .85rem; line-height: 1.45; }
    .ff-danger-reason-label { display: block; font-size: .78rem; margin-bottom: .35rem; color: color-mix(in oklch, currentColor 75%, transparent); }
    .ff-danger-reason { width: 100%; box-sizing: border-box; background: color-mix(in oklch, var(--ps-bg, #060610) 70%, transparent); color: inherit; border: 1px solid color-mix(in oklch, currentColor 22%, transparent); border-radius: 8px; padding: .55rem; font: inherit; font-size: .85rem; resize: vertical; }
    .ff-danger-reason:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 1px; }
    .ff-danger-actions { display: flex; justify-content: flex-end; gap: .6rem; margin-top: 1rem; }
    .ff-emergency-count { font-size: .9rem; }
    .ff-emergency-count strong { color: #ff8888; font-family: var(--ps-mono, ui-monospace, monospace); }
    @media (prefers-reduced-motion: reduce) {
      .ff-card { transition: none; }
      .ff-danger-overlay { backdrop-filter: none; }
    }
  `],
  template: `
    <section class="ff-page" appReveal>
      <header class="ff-header">
        <div class="ff-head-left">
          <p class="ff-kicker">Control plane · Layer 1</p>
          <h1 data-testid="ff-layer-heading">Feature Flags</h1>
          <p class="ff-sub">
            Platform-ops flags for the operator.
            <strong>@if (statsLoading()) { <span class="ff-stat-dots" aria-label="Loading">…</span> } @else { <app-rolling-counter [value]="flagCount()" /> }</strong> registered ·
            <strong>@if (statsLoading()) { <span class="ff-stat-dots" aria-label="Loading">…</span> } @else { <app-rolling-counter [value]="enabledCount()" /> }</strong> on.
            Site owners manage their own features under
            <a routerLink="/admin/site-features" data-testid="ff-nav-site-features" class="ff-cross-link">Features →</a>.
          </p>
        </div>
      </header>

      @if (blockedFeature(); as key) {
        <div class="ff-blocked" role="status" data-testid="ff-blocked-banner">
          <span class="ff-blocked-icon" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>
          <span class="ff-blocked-text">
            The <code>{{ key }}</code> feature is currently <strong>disabled</strong>, so that page isn't available yet. Enable it below to access it.
          </span>
          <button type="button" class="ff-blocked-dismiss" (click)="dismissBlockedBanner()" aria-label="Dismiss">✕</button>
        </div>
      }

      @if (coherenceWarnings().length) {
        <div class="ff-coherence" role="status" data-testid="ff-coherence">
          <strong>Dependency check:</strong>
          <ul>
            @for (w of coherenceWarnings(); track w.key + w.other) {
              <li>{{ w.message }}</li>
            }
          </ul>
        </div>
      }

      <div class="ff-toolbar">
        <input
          hlmInput
          class="flex-1 min-w-0 basis-[240px]"
          type="search"
          placeholder="Search by key or description…"
          [ngModel]="search()"
          (ngModelChange)="search.set($event)"
          aria-label="Search feature flags"
        />
        <div class="ff-stages" role="tablist" hlmTablist aria-label="Filter by stage">
          @for (s of stages; track s) {
            <button
              class="ff-stage-chip"
              [class.ff-stage-chip-active]="stage() === s"
              (click)="stage.set(s)"
              role="tab"
              [attr.aria-selected]="stage() === s"
            >
              {{ s }}
              <span class="ff-stage-count">{{ countForStage(s) }}</span>
            </button>
          }
        </div>
        <span class="sr-only" role="status" aria-live="polite" data-testid="ff-filter-status">{{ filterAnnouncement() }}</span>
      </div>

      @if (error()) {
        <app-error-card
          title="Couldn't load feature flags"
          [message]="error()!"
          [correlationId]="loadErrorRef()"
          hint="The flag registry lives behind GET /api/feature-flags. Retry, or check you're signed in as a super-admin."
          (retry)="reload()" />
      } @else if (flags().length === 0) {
        <app-empty-state
          icon="⚑"
          title="No feature flags registered"
          message="Every new feature ships behind a flag (enabled=false, rollout=0%, stage='experimental'). Flags appear here once seeded in the worker registry." />
      } @else if (filtered().length === 0) {
        <app-empty-state
          icon="⊘"
          title="No flags match this filter"
          [message]="emptyFilterHint()"
          ctaLabel="Clear filters"
          (ctaClick)="clearFilters()" />
      } @else {
        <ul class="ff-grid">
          @for (flag of filtered(); track flag.key) {
            <li class="ff-card" [attr.data-stage]="flag.stage" [class.ff-card-killed]="flag.kill_switch" [class.ff-card-on]="resolvedOn(flag)">
              <header class="ff-card-head">
                <h2 class="ff-key">
                  <button type="button" class="ff-key-btn" (click)="copyKey(flag.key)"
                          [attr.aria-label]="'Copy flag key ' + flag.key" title="Copy key to clipboard">
                    {{ flag.key }}
                    <span class="ff-key-copy" aria-hidden="true">⧉</span>
                  </button>
                </h2>
              </header>
              <app-flag-badge-row [badges]="badgesFor(flag)" />
              <!-- At-a-glance rollout: a thin cyan progress bar (dimmed when the flag is off). -->
              <div class="ff-rollout-bar" role="progressbar"
                   [attr.aria-valuenow]="flag.default_rollout_percent" aria-valuemin="0" aria-valuemax="100"
                   [attr.aria-label]="'Rollout ' + flag.default_rollout_percent + '%' + (resolvedOn(flag) ? '' : ' (flag off)')">
                <span class="ff-rollout-fill" [class.ff-rollout-fill--off]="!resolvedOn(flag)" [style.width.%]="flag.default_rollout_percent"></span>
              </div>
              <p class="ff-desc">{{ flag.description }}</p>
              <p class="ff-why" data-testid="ff-why">{{ whyFor(flag) }}</p>
              <div class="ff-owner">Owner: <a class="ff-owner-link" [href]="'mailto:' + flag.owner_email" [attr.aria-label]="'Email the owner of ' + flag.key + ', ' + flag.owner_email">{{ flag.owner_email }}</a></div>
              <div class="ff-actions">
                <button class="ff-btn ff-btn-primary" (click)="toggle(flag)" [disabled]="busy()[flag.key] || isSentinel(flag)"
                        [attr.aria-label]="isSentinel(flag) ? flag.key + ' is a core platform flag — always on, cannot be disabled' : (flag.default_enabled ? 'Disable ' : 'Enable ') + flag.key + ' globally'"
                        [title]="isSentinel(flag) ? 'Core platform flag — always on, cannot be disabled' : null">
                  {{ isSentinel(flag) ? 'Always on' : (flag.default_enabled ? 'Disable globally' : 'Enable globally') }}
                </button>
                <button class="ff-btn" (click)="openDetail(flag)"
                        [attr.aria-expanded]="detailKey() === flag.key" [attr.aria-label]="'Inspect ' + flag.key">Inspect</button>
                <button class="ff-btn" (click)="openDossier(flag)" data-testid="ff-spec"
                        [disabled]="dossierBusy()[flag.key]"
                        [attr.aria-label]="'Open the full spec sheet for ' + flag.key" title="Full-screen spec sheet — docs, metrics, integration guide">Spec ↗</button>
                @if (flag.kill_switch || flag.stage === 'killswitch') {
                  <button class="ff-btn ff-btn-restore" (click)="restore(flag)" [disabled]="busy()[flag.key]"
                          [attr.aria-label]="'Restore ' + flag.key + ' from killswitch'"
                          title="Lift the kill switch — flag returns to its prior enabled/rollout state">
                    Restore
                  </button>
                } @else {
                  <button class="ff-btn ff-btn-danger" (click)="killswitch(flag)" [disabled]="busy()[flag.key] || isSentinel(flag)"
                          [attr.aria-label]="isSentinel(flag) ? flag.key + ' is a core platform flag — protected from killswitch' : 'Killswitch ' + flag.key"
                          [title]="isSentinel(flag) ? 'Core platform flag — protected from killswitch' : 'Instant disable for all users — no redeploy'">
                    Killswitch
                  </button>
                }
              </div>

              @if (detailKey() === flag.key) {
                @if (docsDetail(); as docs) {
                  <div class="ff-detail">
                    @if (docs.checklist?.length) {
                      <h3>Checklist — what it does</h3>
                      <ul class="ff-checklist" data-testid="ff-checklist" [attr.aria-label]="'What ' + flag.key + ' does'">
                        @for (item of docs.checklist; track item) {
                          <li class="ff-check">
                            <svg class="ff-check-ic" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
                            <span>{{ item }}</span>
                          </li>
                        }
                      </ul>
                    }
                    <h3>What this does</h3>
                    <p class="ff-explanation">{{ docs.explanation }}</p>
                    <h3>Smoke test</h3>
                    <ol class="ff-smoke">
                      @for (step of englishSmoke(docs.smoke_test, flag.key, 'Feature Flag'); track $index) { <li>{{ step }}</li> }
                    </ol>
                    @if (docs.e2e_tests && docs.e2e_tests.length) {
                      <h3>Automated coverage</h3>
                      <ul class="ff-e2e">
                        @for (spec of docs.e2e_tests; track spec) { <li><code class="ff-step">{{ spec }}</code></li> }
                      </ul>
                    }
                    @if (docs.references && docs.references.length) {
                      <h3>References</h3>
                      <ul class="ff-refs">
                        @for (ref of docs.references; track ref) { <li><a [href]="ref" target="_blank" rel="noopener noreferrer">{{ ref }}</a></li> }
                      </ul>
                    }
                  </div>
                }

                @if (resolvedDetail(); as r) {
                  <div class="ff-detail">
                    <h3>Resolved state for this scope</h3>
                    <div class="ff-resolved">
                      <span class="ff-state-badge" [class.ff-state-on]="r.enabled" [class.ff-state-off]="!r.enabled">{{ r.enabled ? 'ON' : 'OFF' }}</span>
                      <span class="ff-rollout">rollout: {{ r.rollout_percent }}%</span>
                      <span class="ff-resolved-source">resolved via {{ r.source }}</span>
                    </div>
                  </div>
                }

                <!-- ADVANCED: targeting + rollout + scheduling -->
                @if (mode() === 'advanced' || mode() === 'expert') {
                  <div class="ff-detail ff-advanced-controls" data-testid="ff-advanced">
                    <h3>Targeting &amp; rollout</h3>
                    <label class="ff-ctl">
                      <span class="ff-ctl-label">Rollout <strong>{{ displayRollout(flag) }}%</strong></span>
                      <input type="range" min="0" max="100" step="5" class="ff-range"
                             [value]="flag.default_rollout_percent"
                             (input)="rolloutDraft.set({ key: flag.key, pct: $any($event.target).valueAsNumber })"
                             (change)="setRollout(flag, $any($event.target).valueAsNumber); rolloutDraft.set(null)"
                             [attr.aria-label]="'Set rollout percent for ' + flag.key"
                             [attr.aria-valuetext]="displayRollout(flag) + ' percent'" />
                    </label>
                    <label class="ff-ctl">
                      <span class="ff-ctl-label">Expires (optional)</span>
                      <input type="datetime-local" class="ff-sched" [ngModel]="expiryDraft()[flag.key] || ''"
                             (ngModelChange)="setExpiryDraft(flag.key, $event)"
                             [attr.aria-label]="'Expiry for ' + flag.key" />
                    </label>
                    <p class="ff-ctl-hint">Stage is registry/code-managed (<code>{{ flag.stage }}</code>). Promotion path: experimental → beta (5-25%) → stable (100%). Scheduling is captured locally for the next mutation.</p>
                  </div>
                }

                <!-- EXPERT: raw key + JSON + eval trace + payload editor -->
                @if (mode() === 'expert') {
                  <div class="ff-detail ff-expert" data-testid="ff-expert">
                    <h3>Evaluation trace</h3>
                    <!-- Test context builder: trace this flag as ANY subject
                         (user / site / anon id). Rollout bucketing is subject-
                         keyed, so the decision below re-evaluates as you type. -->
                    <div class="ff-trace-ctx" data-testid="ff-trace-ctx">
                      <label class="ff-trace-ctx-label" [attr.for]="'ff-trace-subj-' + flag.key">Trace as subject</label>
                      <input class="ff-trace-input" type="text" [id]="'ff-trace-subj-' + flag.key"
                             [ngModel]="traceSubject()" (ngModelChange)="traceSubject.set($event)"
                             [placeholder]="resolvedSubject()" autocomplete="off" spellcheck="false"
                             data-testid="ff-trace-subject"
                             [attr.aria-label]="'Evaluate ' + flag.key + ' as a test subject — user id, site id, or anon id'" />
                      <span class="ff-trace-bucket" data-testid="ff-trace-bucket"
                            [attr.title]="'FNV-1a rollout bucket for ' + resolvedSubject()">bucket {{ bucketOf(flag) }}/99</span>
                    </div>
                    <ol class="ff-eval-trace" data-testid="ff-eval-trace">
                      @for (st of traceFor(flag); track $index) {
                        <li [attr.data-outcome]="st.outcome">
                          <span class="ff-eval-label">{{ st.label }}</span>
                          <span class="ff-eval-detail">{{ st.detail }}</span>
                        </li>
                      }
                    </ol>
                    <h3>Raw key</h3>
                    <code class="ff-step">{{ flag.key }}</code>
                    <h3>JSON view</h3>
                    <pre class="ff-json" data-testid="ff-json">{{ jsonFor(flag) }}</pre>
                    <h3>Edit payload (POST /api/super-admin/feature-flags)</h3>
                    <textarea class="ff-json-editor" data-testid="ff-json-editor" rows="5"
                              [ngModel]="jsonEditorDraft()[flag.key] ?? jsonPayloadFor(flag)"
                              (ngModelChange)="setJsonDraft(flag.key, $event)"
                              [attr.aria-label]="'Raw JSON payload editor for ' + flag.key"></textarea>
                    @if (jsonError()[flag.key]) {
                      <p class="ff-json-error" data-testid="ff-json-error" role="alert">{{ jsonError()[flag.key] }}</p>
                    }
                    @if (jsonDiff(flag); as changes) {
                      @if (changes.length > 0) {
                        <!-- Pre-Apply impact preview: exactly what this payload changes. -->
                        <div class="ff-json-diff" data-testid="ff-json-diff">
                          <span class="ff-diff-label">{{ changes.length }} pending change{{ changes.length === 1 ? '' : 's' }}</span>
                          <ul class="ff-diff-list">
                            @for (ch of changes; track ch.field) {
                              <li><code>{{ ch.field }}</code> <span class="ff-diff-from">{{ ch.from }}</span> <span class="ff-diff-arrow" aria-hidden="true">→</span> <span class="ff-diff-to">{{ ch.to }}</span></li>
                            }
                          </ul>
                        </div>
                      }
                    }
                    <div class="ff-expert-actions">
                      <button class="ff-btn ff-btn-primary" data-testid="ff-json-apply" (click)="applyJson(flag)" [disabled]="busy()[flag.key]">Apply payload</button>
                    </div>
                    <h3>API payload (curl)</h3>
                    <pre class="ff-json" data-testid="ff-curl">{{ curlFor(flag) }}</pre>
                    <div class="ff-expert-actions">
                      <button class="ff-btn" type="button" data-testid="ff-curl-copy" (click)="copyCurl(flag)"
                              [attr.aria-label]="'Copy the reproduce-this-change curl for ' + flag.key">Copy curl</button>
                    </div>
                  </div>
                }

                <div class="ff-detail">
                  <h3>Change history</h3>
                  <app-flag-audit-timeline [entries]="auditDetail()" />
                </div>
              }
            </li>
          }
        </ul>
      }

      <!-- Dangerous-change confirm panel (kill switch / enable / large jump) -->
      @if (pending(); as p) {
        <div class="ff-danger-overlay" role="dialog" aria-modal="true" aria-labelledby="ff-danger-title" data-testid="ff-danger-panel"
             cdkTrapFocus [cdkTrapFocusAutoCapture]="true">
          <div class="ff-danger">
            <h2 id="ff-danger-title"><span class="ff-ic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg></span>Confirm dangerous change</h2>
            <p class="ff-danger-flag"><code>{{ p.flag.key }}</code> — {{ p.label }}</p>
            <div class="ff-danger-section" data-testid="ff-blast-radius">
              <h3>Blast radius</h3>
              <p>{{ p.blast }}</p>
            </div>
            <div class="ff-danger-section">
              <h3>Rollback plan</h3>
              <p>{{ p.rollback }}</p>
            </div>
            <label class="ff-danger-reason-label" for="ff-danger-reason">Reason (required — saved to the audit trail)</label>
            <textarea id="ff-danger-reason" class="ff-danger-reason" data-testid="ff-danger-reason" rows="3"
                      [ngModel]="dangerReason()" (ngModelChange)="dangerReason.set($event)"
                      placeholder="e.g. Sev-1: feature throwing in prod; killing while we patch."></textarea>
            <div class="ff-danger-actions">
              <button class="ff-btn" (click)="cancelDangerous()" data-testid="ff-danger-cancel">Cancel</button>
              <button class="ff-btn ff-btn-danger-solid" (click)="confirmDangerous()"
                      data-testid="ff-danger-confirm" [disabled]="dangerReason().trim().length < 4">
                {{ p.label }}
              </button>
            </div>
          </div>
        </div>
      }

      <!-- Emergency kill-switch console -->
      @if (emergencyOpen()) {
        <div class="ff-danger-overlay" role="dialog" aria-modal="true" aria-labelledby="ff-emergency-title" data-testid="ff-emergency-panel"
             cdkTrapFocus [cdkTrapFocusAutoCapture]="true">
          <div class="ff-danger ff-emergency-console">
            <h2 id="ff-emergency-title"><span class="ff-ic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg></span>Emergency console</h2>
            <p>Instantly disable experimental + beta features platform-wide. Stable + sentinel core flags are never touched.</p>
            <p class="ff-emergency-count"><strong>{{ emergencyTargets().length }}</strong> non-stable flags would be killed.</p>
            <label class="ff-danger-reason-label" for="ff-emergency-reason">Reason (required)</label>
            <textarea id="ff-emergency-reason" class="ff-danger-reason" data-testid="ff-emergency-reason" rows="2"
                      [ngModel]="dangerReason()" (ngModelChange)="dangerReason.set($event)"
                      placeholder="e.g. Platform incident — killing all experimental surfaces."></textarea>
            <div class="ff-danger-actions">
              <button class="ff-btn" (click)="emergencyOpen.set(false)" data-testid="ff-emergency-cancel">Cancel</button>
              <button class="ff-btn ff-btn-danger-solid" (click)="killAllNonStable()"
                      data-testid="ff-emergency-confirm" [disabled]="dangerReason().trim().length < 4 || emergencyBusy() || emergencyTargets().length === 0">
                Kill all non-stable
              </button>
            </div>
          </div>
        </div>
      }

      <!-- Full-screen spec sheet (docs + metrics + integration guide) -->
      <app-feature-dossier [model]="dossier()" [open]="dossierOpen()" (closed)="closeDossier()" />
    </section>
  `,
})
export class AdminFeatureFlagsComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly toast = inject(ToastService);
  private readonly state = inject(AdminStateService);
  private readonly flagSvc = inject(FeatureFlagService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);

  /**
   * Bearer header for the super-admin (`/api/super-admin/*`) calls. This
   * component uses raw HttpClient (not ApiService, to avoid ApiService's
   * 401→/signin redirect on a fail-soft call), so it must attach the token
   * itself — otherwise the operator-gated endpoints 401 (the console error on
   * the Feature Flags page). The public `/api/feature-flags` reads need none.
   */
  private superAdminHeaders(): Record<string, string> {
    const t = this.auth.getToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  }

  private static readonly MODE_KEY = 'ff.mode.system';

  readonly blockedFeature = signal<string | null>(null);
  /** Exposed for the template — renders the smoke test as plain English (no curl/HTTP). */
  protected readonly englishSmoke = englishSmoke;
  readonly stages: StageFilter[] = ['all', 'experimental', 'beta', 'stable', 'deprecated', 'killswitch'];
  readonly stage = signal<StageFilter>('all');
  readonly search = signal('');
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  /** Worker request_id from a failed flag-registry load → copyable support reference on the error card. */
  readonly loadErrorRef = signal('');
  readonly flags = signal<FlagDefinition[]>([]);
  readonly detailKey = signal<string | null>(null);
  readonly resolvedDetail = signal<ResolvedFlag | null>(null);
  readonly docsDetail = signal<FlagDocs | null>(null);
  readonly auditDetail = signal<AuditEntry[]>([]);
  readonly rolloutDraft = signal<{ key: string; pct: number } | null>(null);
  readonly busy = signal<Record<string, boolean>>({});

  /** Full-screen spec-sheet (feature-dossier) state. */
  readonly dossier = signal<DossierModel | null>(null);
  readonly dossierOpen = signal(false);
  /** Per-flag "loading the spec docs" guard so the Spec button can't double-fire. */
  readonly dossierBusy = signal<Record<string, boolean>>({});

  readonly mode = signal<DisclosureMode>(this.readMode());
  readonly expiryDraft = signal<Record<string, string>>({});
  readonly jsonEditorDraft = signal<Record<string, string>>({});
  readonly jsonError = signal<Record<string, string>>({});

  // Dangerous-change confirm flow.
  readonly pending = signal<PendingDangerous | null>(null);
  readonly dangerReason = signal('');
  readonly emergencyOpen = signal(false);
  readonly emergencyBusy = signal(false);

  readonly flagCount = computed(() => this.flags().length);
  readonly enabledCount = computed(() => this.flags().filter((f) => this.resolvedOn(f)).length);
  /** True only during the initial flag load (no data yet) — gates the header subtitle counts so they never assert a false "0 registered · 0 on" over the loading skeleton. Refresh-with-data keeps the live counts. */
  readonly statsLoading = computed(() => this.loading() && this.flags().length === 0);

  readonly coherenceWarnings = computed(() => {
    const enabledByKey: Record<string, boolean> = {};
    for (const f of this.flags()) enabledByKey[f.key] = this.resolvedOn(f);
    return validateConstraints(enabledByKey, FLAG_CONSTRAINTS);
  });

  readonly emergencyTargets = computed(() =>
    this.flags().filter((f) => f.stage !== 'stable' && !f.key.startsWith('core_') && (f.default_enabled || !f.kill_switch) && f.stage !== 'killswitch'),
  );

  resolvedOn(flag: FlagDefinition): boolean {
    return !flag.kill_switch && flag.default_enabled;
  }

  badgesFor(flag: FlagDefinition): FlagBadge[] {
    const on = this.resolvedOn(flag);
    const badges: FlagBadge[] = [
      { label: on ? 'ON' : 'OFF', title: `${flag.key} is ${on ? 'on' : 'off'}`, tone: on ? 'on' : 'off' },
      { label: flag.stage, title: `Lifecycle stage: ${flag.stage}`, tone: 'stage' },
      { label: `${flag.default_rollout_percent}%`, title: 'Rollout percent', tone: 'neutral' },
      { label: 'platform', title: 'Platform-ops scope (operator-managed)', tone: 'scope' },
    ];
    if (flag.kill_switch) badges.push({ label: 'killswitch', title: 'Hard kill switch active', tone: 'risk' });
    if (flag.stage === 'experimental') badges.push({ label: 'high risk', title: 'Experimental — rollout-gated', tone: 'risk' });
    return badges;
  }

  whyFor(flag: FlagDefinition): string {
    if (flag.kill_switch) return 'Off — hard kill switch is active for everyone.';
    if (!flag.default_enabled) return 'Off — disabled globally. Enable to start a rollout.';
    if (flag.default_rollout_percent >= 100) return 'On for everyone (100% rollout).';
    if (flag.default_rollout_percent <= 0) return 'Enabled but rollout is 0% — nobody sees it yet.';
    return `On for ~${flag.default_rollout_percent}% of the audience (stable rollout bucket).`;
  }

  /**
   * Expert-mode "test context builder" — the subject the eval trace runs for.
   * Empty → the selected site (or 'platform'). Typed → trace any user/site/anon
   * id, so an operator can debug "why does X see this flag but Y doesn't" (the
   * rollout bucket is FNV-1a(flagKey+subject), so the decision genuinely moves).
   */
  readonly traceSubject = signal('');

  /** The subject the trace evaluates against right now (typed value wins). */
  resolvedSubject(): string {
    return this.traceSubject().trim() || this.state.selectedSite()?.id || 'platform';
  }

  /** Stable 0-99 rollout bucket for a flag at the current trace subject. */
  bucketOf(flag: FlagDefinition): number {
    return bucketFor(flag.key, this.resolvedSubject());
  }

  traceFor(flag: FlagDefinition): EvalStep[] {
    return evaluationTrace({
      enabled: flag.default_enabled,
      flagKey: flag.key,
      killSwitch: !!flag.kill_switch,
      rolloutPercent: flag.default_rollout_percent,
      subject: this.resolvedSubject(),
    });
  }

  jsonFor(flag: FlagDefinition): string {
    return JSON.stringify(
      { enabled: flag.default_enabled, key: flag.key, kill_switch: !!flag.kill_switch, owner: flag.owner_email, rollout_percent: flag.default_rollout_percent, stage: flag.stage },
      null, 2,
    );
  }

  jsonPayloadFor(flag: FlagDefinition): string {
    const payload: Record<string, unknown> = {
      enabled_globally: flag.default_enabled,
      key: flag.key,
      kill_switch: !!flag.kill_switch,
      rollout_pct: flag.default_rollout_percent,
    };
    // Carry the Advanced-mode "Expires (optional)" intent into the payload so it
    // rides in the JSON view + curl + the next POST (was a dead input). The
    // worker decides persistence; omitted entirely when no expiry is set.
    const expiry = (this.expiryDraft()[flag.key] ?? '').trim();
    if (expiry) payload['expires_at'] = expiry;
    return JSON.stringify(payload, null, 2);
  }

  readonly emptyFilterHint = computed(() => {
    const q = this.search().trim();
    const s = this.stage();
    if (q && s !== 'all') return `No "${q}" flags in the ${s} stage.`;
    if (q) return `No flags match "${q}".`;
    return `No flags in the ${s} stage.`;
  });

  clearFilters(): void {
    this.search.set('');
    this.stage.set('all');
  }

  readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    const s = this.stage();
    return this.flags().filter((f) => {
      if (s !== 'all' && f.stage !== s) return false;
      if (!q) return true;
      return f.key.toLowerCase().includes(q) || f.description.toLowerCase().includes(q);
    });
  });

  readonly filterAnnouncement = computed<string>(() => {
    const n = this.filtered().length;
    const noun = n === 1 ? 'flag' : 'flags';
    const s = this.stage();
    return s === 'all' ? `Showing ${n} ${noun}` : `${n} ${noun} in ${s}`;
  });

  private readMode(): DisclosureMode {
    try {
      const v = localStorage.getItem(AdminFeatureFlagsComponent.MODE_KEY);
      return v === 'advanced' || v === 'expert' ? v : 'simple';
    } catch {
      return 'simple';
    }
  }

  setMode(m: DisclosureMode): void {
    this.mode.set(m);
    try { localStorage.setItem(AdminFeatureFlagsComponent.MODE_KEY, m); } catch { /* private mode */ }
  }

  setExpiryDraft(key: string, value: string): void {
    this.expiryDraft.update((d) => ({ ...d, [key]: value }));
  }

  setJsonDraft(key: string, value: string): void {
    this.jsonEditorDraft.update((d) => ({ ...d, [key]: value }));
    this.jsonError.update((e) => ({ ...e, [key]: '' }));
  }

  /**
   * Expert "diff": the fields the edited JSON payload would change vs the
   * committed flag — a pre-Apply impact preview. Returns [] when there's no
   * draft, the draft is invalid JSON (the error path owns that), or nothing
   * actually changed.
   */
  jsonDiff(flag: FlagDefinition): Array<{ field: string; from: string; to: string }> {
    const draftRaw = this.jsonEditorDraft()[flag.key];
    if (draftRaw === undefined) return [];
    let draft: Record<string, unknown>;
    try {
      draft = JSON.parse(draftRaw) as Record<string, unknown>;
    } catch {
      return [];
    }
    const current = JSON.parse(this.jsonPayloadFor(flag)) as Record<string, unknown>;
    const out: Array<{ field: string; from: string; to: string }> = [];
    for (const field of ['key', 'enabled_globally', 'rollout_pct', 'kill_switch']) {
      const to = draft[field];
      if (to !== undefined && JSON.stringify(current[field]) !== JSON.stringify(to)) {
        out.push({ field, from: String(current[field]), to: String(to) });
      }
    }
    return out;
  }

  async copyKey(key: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(key);
      this.toast.success(`Copied "${key}"`);
    } catch {
      this.toast.error('Copy failed — clipboard unavailable');
    }
  }

  /**
   * Expert "API payload": the exact curl to reproduce this flag's mutation via
   * the super-admin API — uses the edited draft when it's valid JSON, else the
   * committed payload. The bearer is a `<YOUR_TOKEN>` PLACEHOLDER (never leak a
   * real session token into a copyable snippet).
   */
  curlFor(flag: FlagDefinition): string {
    const draft = this.jsonEditorDraft()[flag.key];
    let body: string;
    try {
      body = JSON.stringify(JSON.parse(draft !== undefined ? draft : this.jsonPayloadFor(flag)));
    } catch {
      body = JSON.stringify(JSON.parse(this.jsonPayloadFor(flag)));
    }
    return [
      `curl -X POST 'https://projectsites.dev/api/super-admin/feature-flags' \\`,
      `  -H 'content-type: application/json' \\`,
      `  -H 'authorization: Bearer <YOUR_TOKEN>' \\`,
      `  -d '${body.replace(/'/g, `'\\''`)}'`,
    ].join('\n');
  }

  async copyCurl(flag: FlagDefinition): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.curlFor(flag));
      this.toast.success('Copied curl');
    } catch {
      this.toast.error('Copy failed — clipboard unavailable');
    }
  }

  displayRollout(flag: FlagDefinition): number {
    const d = this.rolloutDraft();
    return d && d.key === flag.key ? d.pct : flag.default_rollout_percent;
  }

  countForStage(s: StageFilter): number {
    if (s === 'all') return this.flags().length;
    return this.flags().filter((f) => f.stage === s).length;
  }

  async ngOnInit(): Promise<void> {
    const blocked = this.route.snapshot.queryParamMap.get('disabled');
    if (blocked) {
      this.blockedFeature.set(blocked);
      this.search.set(blocked);
    }
    await this.reload();
    // Deep link: `?spec=<flag_key>` opens that flag's spec sheet directly, so the
    // Features spec page is a navigable + shareable URL (brief #4).
    const spec = this.route.snapshot.queryParamMap.get('spec');
    if (spec) {
      const flag = this.flags().find((f) => f.key === spec);
      if (flag) void this.openDossier(flag);
    }
  }

  dismissBlockedBanner(): void {
    this.blockedFeature.set(null);
  }

  async reload(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.loadErrorRef.set('');
    try {
      const res = await firstValueFrom(this.http.get<{ flags: FlagDefinition[]; count: number }>('/api/feature-flags'));
      let flags = res.flags ?? [];
      if (this.state.isSuperAdmin()) {
        try {
          const ov = await firstValueFrom(
            this.http.get<{ flags: { key: string; enabled_globally: number | boolean; rollout_pct: number; kill_switch: number | boolean }[] }>('/api/super-admin/feature-flags', { headers: this.superAdminHeaders() }),
          );
          const byKey = new Map((ov.flags ?? []).map((o) => [o.key, o] as const));
          flags = flags.map((f) => {
            const o = byKey.get(f.key);
            if (!o) return f;
            return { ...f, default_enabled: !!o.enabled_globally, default_rollout_percent: Number(o.rollout_pct ?? f.default_rollout_percent), kill_switch: !!o.kill_switch };
          });
        } catch {
          /* registry defaults stand */
        }
      }
      this.flags.set(flags);
    } catch (e) {
      this.error.set((e as Error).message ?? 'unknown error');
      this.loadErrorRef.set(this.requestIdFrom(e));
    } finally {
      this.loading.set(false);
    }
  }

  /** Pull the worker request_id from a failed response ({ error: { request_id } }) for the support reference. */
  private requestIdFrom(e: unknown): string {
    return ((e as { error?: { error?: { request_id?: string } } } | undefined)?.error?.error?.request_id) ?? '';
  }

  async openDetail(flag: FlagDefinition): Promise<void> {
    if (this.detailKey() === flag.key) {
      this.detailKey.set(null);
      this.resolvedDetail.set(null);
      this.docsDetail.set(null);
      this.auditDetail.set([]);
      return;
    }
    this.detailKey.set(flag.key);
    this.docsDetail.set(null);
    this.auditDetail.set([]);
    try {
      const res = await firstValueFrom(
        this.http.get<{ definition: FlagDefinition; resolved: ResolvedFlag; docs: FlagDocs | null }>(`/api/feature-flags/${flag.key}`),
      );
      this.resolvedDetail.set(res.resolved);
      this.docsDetail.set(res.docs ?? null);
    } catch {
      this.resolvedDetail.set({ enabled: flag.default_enabled, rollout_percent: flag.default_rollout_percent, source: 'registry', stage: flag.stage });
    }
    // Per-flag audit history (super-admin only; fail-soft to empty).
    try {
      const a = await firstValueFrom(this.http.get<{ entries: AuditEntry[] }>(`/api/super-admin/feature-flags/${flag.key}/audit`, { headers: this.superAdminHeaders() }));
      this.auditDetail.set(a.entries ?? []);
    } catch {
      this.auditDetail.set([]);
    }
  }

  /**
   * Open the full-screen spec sheet for a flag — fetches its docs (checklist /
   * explanation / smoke_test / e2e_tests) so the dossier is complete, then
   * builds the normalized model and opens the takeover. Falls back to the
   * registry-only summary if the docs fetch fails.
   */
  async openDossier(flag: FlagDefinition): Promise<void> {
    if (this.dossierBusy()[flag.key]) return;
    this.dossierBusy.update((b) => ({ ...b, [flag.key]: true }));
    let docs: FlagDocs | null = null;
    let resolved: ResolvedFlag | null = null;
    try {
      const res = await firstValueFrom(
        this.http.get<{ definition: FlagDefinition; resolved: ResolvedFlag; docs: FlagDocs | null }>(`/api/feature-flags/${flag.key}`),
      );
      docs = res.docs;
      resolved = res.resolved;
    } catch {
      /* registry-only fallback */
    } finally {
      this.dossierBusy.update((b) => ({ ...b, [flag.key]: false }));
    }
    this.dossier.set({
      checklist: docs?.checklist,
      e2eTests: docs?.e2e_tests,
      enabled: this.resolvedOn(flag),
      explanation: docs?.explanation,
      key: flag.key,
      kind: 'Feature Flag',
      name: flag.key,
      owner: flag.owner_email,
      references: docs?.references,
      rolloutPercent: resolved?.rollout_percent ?? flag.default_rollout_percent,
      screenshots: docs?.screenshots,
      smokeTest: docs?.smoke_test,
      stage: resolved?.stage ?? flag.stage,
      summary: flag.description,
    });
    this.dossierOpen.set(true);
    // Reflect the open spec sheet in the URL so it's shareable/bookmarkable.
    void this.router.navigate([], {
      queryParams: { spec: flag.key },
      queryParamsHandling: 'merge',
      relativeTo: this.route,
      replaceUrl: true,
    });
  }

  /** Close the spec sheet + drop the `?spec=` deep link from the URL. */
  closeDossier(): void {
    this.dossierOpen.set(false);
    void this.router.navigate([], {
      queryParams: { spec: null },
      queryParamsHandling: 'merge',
      relativeTo: this.route,
      replaceUrl: true,
    });
  }

  /**
   * Apply a flag override. Safe/review changes apply directly with optimistic UI;
   * dangerous changes (classifyChange === 'dangerous') open the confirm panel
   * first and only fire after a typed reason + confirmation.
   */
  private requestOverride(
    flag: FlagDefinition,
    patch: { enabled_globally?: boolean; rollout_pct?: number; kill_switch?: boolean },
    label: string,
    optimistic: (f: FlagDefinition) => FlagDefinition,
    blast: string,
    rollback: string,
  ): void {
    const risk: ChangeRisk = classifyChange(
      { enabled: flag.default_enabled, killSwitch: !!flag.kill_switch, rolloutPercent: flag.default_rollout_percent },
      { enabled: patch.enabled_globally, killSwitch: patch.kill_switch, rolloutPercent: patch.rollout_pct },
    );
    if (risk === 'dangerous') {
      this.pending.set({ blast, flag, label, optimistic, patch, rollback });
      this.dangerReason.set('');
      return;
    }
    void this.applyOverride(flag, patch, label, optimistic);
  }

  /**
   * Esc dismisses whichever destructive overlay is open (the dangerous-change
   * confirm panel or the emergency console). These are hand-rolled
   * `role="dialog"` surfaces, so — unlike the shared DialogShell — they need
   * explicit keyboard dismissal (WCAG 2.1.1). The CDK `cdkTrapFocusAutoCapture`
   * on each overlay traps Tab inside the dialog + restores focus to the trigger
   * on close; this adds the missing Esc affordance. No-op when neither is open.
   */
  @HostListener('document:keydown.escape')
  onEscapeKey(): void {
    if (this.pending()) {
      this.cancelDangerous();
    } else if (this.emergencyOpen()) {
      this.emergencyOpen.set(false);
      this.dangerReason.set('');
    }
  }

  cancelDangerous(): void {
    this.pending.set(null);
    this.dangerReason.set('');
  }

  async confirmDangerous(): Promise<void> {
    const p = this.pending();
    if (!p) return;
    const reason = this.dangerReason().trim();
    if (reason.length < 4) return;
    this.pending.set(null);
    this.dangerReason.set('');
    await this.applyOverride(p.flag, p.patch, p.label, p.optimistic, reason);
  }

  private async applyOverride(
    flag: FlagDefinition,
    patch: { enabled_globally?: boolean; rollout_pct?: number; kill_switch?: boolean },
    label: string,
    optimistic: (f: FlagDefinition) => FlagDefinition,
    reason?: string,
  ): Promise<void> {
    if (this.busy()[flag.key]) return;
    const before = this.flags().find((f) => f.key === flag.key);
    if (!before) return;
    this.flags.update((flags) => flags.map((f) => (f.key === flag.key ? optimistic(f) : f)));
    this.busy.update((b) => ({ ...b, [flag.key]: true }));
    try {
      await firstValueFrom(this.http.post('/api/super-admin/feature-flags', { key: flag.key, ...patch, ...(reason ? { reason } : {}) }, { headers: this.superAdminHeaders() }));
      this.flagSvc.invalidate(flag.key);
      this.toast.success(`${flag.key}: ${label}`);
      if (this.detailKey() === flag.key) {
        try {
          const a = await firstValueFrom(this.http.get<{ entries: AuditEntry[] }>(`/api/super-admin/feature-flags/${flag.key}/audit`, { headers: this.superAdminHeaders() }));
          this.auditDetail.set(a.entries ?? []);
        } catch { /* keep prior */ }
      }
    } catch (e) {
      this.flags.update((flags) => flags.map((f) => (f.key === flag.key ? before : f)));
      const status = (e as { status?: number }).status ?? 'error';
      const hint = status === 403 ? ' — super-admin only' : status === 401 ? ' — sign in again' : '';
      this.toast.error(`Couldn't update ${flag.key} (HTTP ${status}${hint}). Reverted.`, 7000);
    } finally {
      this.busy.update((b) => ({ ...b, [flag.key]: false }));
    }
  }

  /**
   * `core_*` flags are load-bearing platform sentinels (auth, admin, site-create).
   * The Emergency console + blast-radius already exclude them; this guards the
   * per-card Disable/Killswitch buttons so an operator can never disable platform
   * auth from a flag card (catastrophic if the worker accepts, dead button if it
   * rejects). Mirrors the `key.startsWith('core_')` predicate used in blast-radius.
   */
  isSentinel(flag: FlagDefinition): boolean {
    return flag.key.startsWith('core_');
  }

  toggle(flag: FlagDefinition): void {
    if (this.isSentinel(flag)) return; // protected — see isSentinel()
    const next = !flag.default_enabled;
    this.requestOverride(
      flag,
      { enabled_globally: next, rollout_pct: next ? 100 : 0 },
      next ? 'enabled globally' : 'disabled globally',
      (f) => ({ ...f, default_enabled: next, default_rollout_percent: next ? 100 : 0 }),
      next ? `Exposes ${flag.key} to 100% of the audience immediately.` : `Hides ${flag.key} from everyone.`,
      next ? `Re-disable from this card, or run Restore — no redeploy needed.` : `Re-enable from this card — prior rollout is not auto-restored.`,
    );
  }

  setRollout(flag: FlagDefinition, pct: number): void {
    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    this.requestOverride(
      flag,
      { enabled_globally: clamped > 0, rollout_pct: clamped },
      `rollout → ${clamped}%`,
      (f) => ({ ...f, default_enabled: clamped > 0, default_rollout_percent: clamped }),
      `Changes the audience size to ~${clamped}% for ${flag.key}.`,
      `Slide rollout back down — bucketing is stable so the same users keep/lose access predictably.`,
    );
  }

  killswitch(flag: FlagDefinition): void {
    if (this.isSentinel(flag)) return; // protected — see isSentinel()
    this.requestOverride(
      flag,
      { enabled_globally: false, kill_switch: true, rollout_pct: 0 },
      'KILLSWITCH — disabled for all users',
      (f) => ({ ...f, default_enabled: false, default_rollout_percent: 0, kill_switch: true, stage: 'killswitch' }),
      `Instantly disables ${flag.key} for EVERY user platform-wide, ignoring rollout.`,
      `Click Restore on this card to lift the kill switch and return the flag to experimental/off.`,
    );
  }

  restore(flag: FlagDefinition): void {
    // Restore is review-tier, not dangerous — applies directly.
    void this.applyOverride(
      flag,
      { kill_switch: false },
      'killswitch lifted',
      (f) => ({ ...f, kill_switch: false, stage: f.stage === 'killswitch' ? 'experimental' : f.stage }),
    );
  }

  /** Expert-mode raw JSON payload editor. Rejects invalid JSON; never POSTs garbage. */
  applyJson(flag: FlagDefinition): void {
    const raw = this.jsonEditorDraft()[flag.key] ?? this.jsonPayloadFor(flag);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.jsonError.update((e) => ({ ...e, [flag.key]: 'Invalid JSON — fix the syntax before applying.' }));
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      this.jsonError.update((e) => ({ ...e, [flag.key]: 'Payload must be a JSON object.' }));
      return;
    }
    const obj = parsed as Record<string, unknown>;
    const enabledGlobally = obj['enabled_globally'];
    const rolloutPct = obj['rollout_pct'];
    const killSwitch = obj['kill_switch'];
    const patch: { enabled_globally?: boolean; rollout_pct?: number; kill_switch?: boolean } = {};
    if (typeof enabledGlobally === 'boolean') patch.enabled_globally = enabledGlobally;
    if (typeof rolloutPct === 'number') patch.rollout_pct = Math.max(0, Math.min(100, rolloutPct));
    if (typeof killSwitch === 'boolean') patch.kill_switch = killSwitch;
    if (Object.keys(patch).length === 0) {
      this.jsonError.update((e) => ({ ...e, [flag.key]: 'No recognized fields (enabled_globally / rollout_pct / kill_switch).' }));
      return;
    }
    this.jsonError.update((e) => ({ ...e, [flag.key]: '' }));
    this.requestOverride(
      flag, patch, 'applied JSON payload',
      (f) => ({
        ...f,
        default_enabled: patch.enabled_globally ?? f.default_enabled,
        default_rollout_percent: patch.rollout_pct ?? f.default_rollout_percent,
        kill_switch: patch.kill_switch ?? f.kill_switch,
      }),
      `Applies the raw payload to ${flag.key}.`,
      `Edit the JSON again and re-apply, or use Restore.`,
    );
  }

  openEmergency(): void {
    this.emergencyOpen.set(true);
    this.dangerReason.set('');
  }

  /** Emergency console — kill every non-stable, non-core flag in one sweep. */
  async killAllNonStable(): Promise<void> {
    const reason = this.dangerReason().trim();
    if (reason.length < 4 || this.emergencyBusy()) return;
    const targets = this.emergencyTargets();
    // Nothing to kill (all flags stable / core / already killswitched) → don't fire
    // a no-op sweep or flash a misleading "Killed 0" success. Tell the operator why,
    // leave the console open. The confirm button is also disabled in this state.
    if (targets.length === 0) {
      this.toast.error('No non-stable flags to kill — everything is stable or already disabled.');
      return;
    }
    this.emergencyBusy.set(true);
    let ok = 0;
    let fail = 0;
    for (const f of targets) {
      try {
        await firstValueFrom(this.http.post('/api/super-admin/feature-flags', { enabled_globally: false, key: f.key, kill_switch: true, reason, rollout_pct: 0 }, { headers: this.superAdminHeaders() }));
        this.flagSvc.invalidate(f.key);
        ok += 1;
      } catch {
        fail += 1;
      }
    }
    this.emergencyBusy.set(false);
    this.emergencyOpen.set(false);
    this.dangerReason.set('');
    if (fail === 0) this.toast.success(`Killed ${ok} non-stable flag${ok === 1 ? '' : 's'}.`);
    else this.toast.error(`Killed ${ok}, ${fail} failed (check super-admin access).`, 7000);
    await this.reload();
  }
}
