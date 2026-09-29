import { Component, type OnInit, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { RevealDirective } from '../../../directives/reveal.directive';
import { RollingCounterComponent } from '../../../components/rolling-counter/rolling-counter.component';
import { ApiService } from '../../../services/api.service';
import { ToastService } from '../../../services/toast.service';

/** A scanned lead row, mirroring the worker's `LeadSummary` (GET /api/admin/leads). */
interface LeadSummary {
  leadId: string;
  businessName: string;
  hasWebsite: boolean;
  leadScore: number;
  priority: boolean;
  email: string | null;
  emailStatus: string | null;
  source: string | null;
  createdAt: string;
  /** Deep-discovered contact fields (populated by the enrich endpoint). */
  phone: string | null;
  website: string | null;
  /** Social profile URLs keyed by network (facebook/instagram/x/…); only present keys are set.
   * Optional: an un-enriched lead (or a worker response that omits it) has NO `socials` object —
   * the template MUST read it null-safe (`lead.socials?.[network]`) or the whole section crashes
   * into its error boundary (real bug fixed AL-155; `bestOutreachChannel` already `?? {}`-guards). */
  socials?: Record<string, string>;
  /** ISO timestamp of the last successful enrich, or null if never enriched. */
  enrichedAt: string | null;
}

/** Display metadata for a social network icon — human label + brand color + single SVG glyph path. */
interface SocialMeta {
  readonly label: string;
  readonly color: string;
  readonly path: string;
}

/** The OSM auto-scan run summary (mirrors the worker's `ScanRunSummary`). */
interface OsmScanSummary {
  discovered: number;
  considered: number;
  upserted: number;
  skipped: number;
  errors: number;
}

/** A preset US-metro bounding box `[south, west, north, east]` for the OSM scan. */
interface MetroPreset {
  readonly label: string;
  readonly bbox: readonly [number, number, number, number];
}

/**
 * Curated metro bounding boxes so the operator picks a place, not raw coordinates.
 * Boxes are deliberately tight (~city core) to keep an OSM Overpass run bounded.
 */
const METROS: readonly MetroPreset[] = [
  { label: 'Newark, NJ', bbox: [40.69, -74.25, 40.79, -74.1] },
  { label: 'New York, NY', bbox: [40.7, -74.02, 40.82, -73.91] },
  { label: 'Los Angeles, CA', bbox: [33.99, -118.41, 34.15, -118.18] },
  { label: 'Chicago, IL', bbox: [41.82, -87.74, 41.98, -87.58] },
  { label: 'Houston, TX', bbox: [29.68, -95.51, 29.83, -95.27] },
  { label: 'Miami, FL', bbox: [25.71, -80.27, 25.86, -80.13] },
];

/** Fixed render order for social icons — matches the worker's `socials` key order. */
const SOCIAL_ORDER = [
  'facebook',
  'instagram',
  'x',
  'linkedin',
  'youtube',
  'tiktok',
  'yelp',
  'google',
] as const;

/**
 * Brand label + color + single-path SVG glyph per social network. Each `path` is a
 * simple recognizable glyph drawn in a `0 0 24 24` viewBox, filled with the brand color.
 */
const SOCIAL_META: Readonly<Record<string, SocialMeta>> = {
  facebook: {
    label: 'Facebook',
    color: '#1877F2',
    path: 'M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.96.93-1.96 1.89v2.25h3.33l-.53 3.49h-2.8V24C19.61 23.1 24 18.1 24 12.07z',
  },
  instagram: {
    label: 'Instagram',
    color: '#E4405F',
    path: 'M12 2.16c3.2 0 3.58.01 4.85.07 1.17.05 1.8.25 2.23.41.56.22.96.48 1.38.9.42.42.68.82.9 1.38.16.42.36 1.06.41 2.23.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.05 1.17-.25 1.8-.41 2.23-.22.56-.48.96-.9 1.38-.42.42-.82.68-1.38.9-.42.16-1.06.36-2.23.41-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-1.17-.05-1.8-.25-2.23-.41a3.72 3.72 0 0 1-1.38-.9 3.72 3.72 0 0 1-.9-1.38c-.16-.42-.36-1.06-.41-2.23-.06-1.27-.07-1.65-.07-4.85s.01-3.58.07-4.85c.05-1.17.25-1.8.41-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.42-.16 1.06-.36 2.23-.41C8.42 2.17 8.8 2.16 12 2.16zM12 0C8.74 0 8.33.01 7.05.07 5.78.13 4.9.33 4.14.63a5.88 5.88 0 0 0-2.13 1.38A5.88 5.88 0 0 0 .63 4.14C.33 4.9.13 5.78.07 7.05.01 8.33 0 8.74 0 12s.01 3.67.07 4.95c.06 1.27.26 2.15.56 2.91.31.79.72 1.46 1.38 2.13.67.66 1.34 1.07 2.13 1.38.76.3 1.64.5 2.91.56C8.33 23.99 8.74 24 12 24s3.67-.01 4.95-.07c1.27-.06 2.15-.26 2.91-.56a5.88 5.88 0 0 0 2.13-1.38 5.88 5.88 0 0 0 1.38-2.13c.3-.76.5-1.64.56-2.91.06-1.28.07-1.69.07-4.95s-.01-3.67-.07-4.95c-.06-1.27-.26-2.15-.56-2.91a5.88 5.88 0 0 0-1.38-2.13A5.88 5.88 0 0 0 19.86.63c-.76-.3-1.64-.5-2.91-.56C15.67.01 15.26 0 12 0zm0 5.84a6.16 6.16 0 1 0 0 12.32 6.16 6.16 0 0 0 0-12.32zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.41-11.85a1.44 1.44 0 1 0 0 2.88 1.44 1.44 0 0 0 0-2.88z',
  },
  x: {
    label: 'X',
    color: '#000000',
    path: 'M18.9 1.15h3.68l-8.04 9.19L24 22.85h-7.41l-5.8-7.58-6.64 7.58H.46l8.6-9.83L0 1.15h7.59l5.24 6.93 6.07-6.93zm-1.29 19.5h2.04L6.49 3.24H4.3l13.31 17.41z',
  },
  linkedin: {
    label: 'LinkedIn',
    color: '#0A66C2',
    path: 'M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.63-1.85 3.36-1.85 3.6 0 4.27 2.37 4.27 5.45v6.29zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.55V9h3.57v11.45zM22.22 0H1.77C.8 0 0 .78 0 1.75v20.5C0 23.2.8 24 1.77 24h20.45c.98 0 1.78-.8 1.78-1.75V1.75C24 .78 23.2 0 22.22 0z',
  },
  youtube: {
    label: 'YouTube',
    color: '#FF0000',
    path: 'M23.5 6.19a3.02 3.02 0 0 0-2.12-2.14C19.5 3.55 12 3.55 12 3.55s-7.5 0-9.38.5A3.02 3.02 0 0 0 .5 6.19C0 8.08 0 12 0 12s0 3.92.5 5.81a3.02 3.02 0 0 0 2.12 2.14c1.88.5 9.38.5 9.38.5s7.5 0 9.38-.5a3.02 3.02 0 0 0 2.12-2.14C24 15.92 24 12 24 12s0-3.92-.5-5.81zM9.6 15.6V8.4l6.24 3.6-6.24 3.6z',
  },
  tiktok: {
    label: 'TikTok',
    color: '#000000',
    path: 'M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64c.3 0 .58.05.85.13V9.4a6.34 6.34 0 0 0-1-.08 6.33 6.33 0 1 0 6.33 6.33V8.68a8.16 8.16 0 0 0 4.77 1.52V6.75a4.85 4.85 0 0 1-.84-.06z',
  },
  yelp: {
    label: 'Yelp',
    color: '#FF1A1A',
    path: 'M20.16 12.6c-.31-.24-.71-.36-2.35-.86-1.66-.5-1.7-.51-1.93-.5-.36.02-.68.24-.82.57-.09.2-.09.24-.09 1.86 0 1.7 0 1.74.13 1.96.19.34.6.5.98.4.18-.05 2.2-.87 3.29-1.35.35-.15.6-.28.72-.43a1.06 1.06 0 0 0 .06-1.32c-.06-.08-.06-.08-.09-.11zm-6.4 1.53c-.24-.17-.6-.16-1.94.04l-.02-6.06c0-2.09-.02-3.87-.04-3.96a1.06 1.06 0 0 0-.6-.72c-.3-.13-.5-.11-1.44.16-1.5.43-2.02.62-2.24.83a1.06 1.06 0 0 0-.29 1.06c.06.19.19.36 1.5 1.98 1.4 1.72 1.43 1.75 1.66 1.85.36.16.78.06 1.02-.24.02-.02.02-.02.03-.03zm.6 3.1c-.2-.3-.55-.42-1.98-.7l-.02.03c-.24.3-.24.72.02 1.02.13.16 1.72 1.55 2.05 1.8.35.26.6.35.94.28.35-.07.6-.29.98-.83.98-1.4 1.13-1.66 1.16-1.9a1.06 1.06 0 0 0-.5-1c-.18-.1-.22-.1-1.86-.36zm-3.5-.16c-.36.02-.6.24-1.5 1.4C7.5 20.86 7.42 21 7.4 21.23a1.06 1.06 0 0 0 .53 1.02c.16.09 1.9.65 2.28.72.4.08.75-.06.96-.4.13-.2.13-.24.15-1.88.02-1.66.02-1.7-.1-1.93a.87.87 0 0 0-.86-.6z',
  },
  google: {
    label: 'Google',
    color: '#4285F4',
    path: 'M23.52 12.27c0-.82-.07-1.6-.2-2.36H12v4.46h6.47a5.53 5.53 0 0 1-2.4 3.63v3.02h3.88c2.27-2.09 3.57-5.17 3.57-8.75zM12 24c3.24 0 5.96-1.07 7.95-2.9l-3.88-3.02c-1.08.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.28v3.12A12 12 0 0 0 12 24zM5.27 14.27a7.2 7.2 0 0 1 0-4.54V6.6H1.28a12 12 0 0 0 0 10.79zM12 4.76c1.76 0 3.35.61 4.6 1.8l3.44-3.45C17.95 1.18 15.24 0 12 0A12 12 0 0 0 1.28 6.6l3.99 3.13C6.22 6.87 8.87 4.76 12 4.76z',
  },
};

/** DM-able social networks in outreach-priority order — a siteless business active
 * on one of these is directly reachable there. Yelp/Google are LISTINGS (not DM
 * channels), so they're intentionally excluded. */
const OUTREACH_DM_ORDER = ['instagram', 'facebook', 'x', 'linkedin', 'tiktok', 'threads', 'youtube'] as const;

/** The recommended outreach channel for a lead, or null when no contact was captured. */
export interface OutreachChannel {
  kind: 'social' | 'email' | 'phone';
  /** Human label for the badge, e.g. "Instagram DM", "Email", "Phone". */
  label: string;
  /** Present when kind==='social' — the network key (for an icon). */
  network?: string;
}

/**
 * Pick the best outreach channel from a lead's captured contact data (AL-029) —
 * "reach them on the channel they use." Priority: an active social DM (proven
 * engaged surface for a no-website business) → email (direct) → phone. Pure +
 * honest — derived only from real captured fields; returns null when none exist.
 *
 * @example bestOutreachChannel({ socials: { instagram: 'u' }, email: null, phone: null })
 *   // → { kind: 'social', network: 'instagram', label: 'Instagram DM' }
 */
export function bestOutreachChannel(lead: {
  socials?: Record<string, string> | null;
  email?: string | null;
  phone?: string | null;
}): OutreachChannel | null {
  const socials = lead.socials ?? {};
  for (const n of OUTREACH_DM_ORDER) {
    if (socials[n]) return { kind: 'social', network: n, label: `${SOCIAL_META[n]?.label ?? n} DM` };
  }
  if (lead.email && lead.email.trim()) return { kind: 'email', label: 'Email' };
  if (lead.phone && lead.phone.trim()) return { kind: 'phone', label: 'Phone' };
  return null;
}

/**
 * Super-Admin lead scanner (#9). Runs a Google-Places no-website scan
 * (`POST /api/admin/leads/scan`), lists scanned leads (`GET /api/admin/leads`),
 * and mints an outreach claim link per lead (`POST /api/admin/leads/:id/claim-link`)
 * copied to the clipboard. The whole surface is flag-dark (`lead_scanner`) +
 * server-side super-admin gated — this UI is the operator console for it.
 *
 * @remarks Outreach SEND is never automated here — the operator copies the claim
 * link and reaches out deliberately (compliant by construction).
 */
@Component({
  selector: 'app-admin-leads',
  standalone: true,
  imports: [FormsModule, RevealDirective, RollingCounterComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="px-6 py-8 max-w-[1100px] mx-auto">
      <header appReveal class="mb-8">
        <h1 class="text-[clamp(1.4rem,3vw,2rem)] font-[800] tracking-tight text-white mb-2">
          Lead Scanner
        </h1>
        <p class="text-sm text-text-secondary max-w-[640px] [text-wrap:pretty]">
          Find local businesses with no website, then mint a claim link to invite them. Outreach is
          never automated — you copy the link and reach out deliberately.
        </p>
      </header>

      <!-- Scan form -->
      <form
        appReveal
        class="mb-8 flex flex-wrap items-end gap-3 rounded-2xl border border-primary/20 bg-primary/[0.04] p-4"
        (ngSubmit)="scan()"
      >
        <label class="flex-1 min-w-[260px]">
          <span
            class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-text-secondary"
            >Search query</span
          >
          <input
            id="leads-scan-query"
            class="w-full rounded-lg border border-white/[0.1] bg-black/30 px-3 py-2 text-sm text-white outline-none transition-colors focus-visible:border-primary/60 focus-visible:ring-1 focus-visible:ring-primary/40"
            [(ngModel)]="query"
            name="query"
            placeholder="e.g. roofers in Newark NJ"
            data-testid="leads-scan-query"
            autocomplete="off"
          />
        </label>
        <label class="flex items-center gap-2 pb-2 text-sm text-text-secondary">
          <input
            type="checkbox"
            [checked]="onlyNoWebsite()"
            (change)="onlyNoWebsite.set($any($event.target).checked)"
            data-testid="leads-only-no-website"
          />
          No-website only
        </label>
        <button
          type="submit"
          [disabled]="scanning() || query.trim().length < 2"
          class="rounded-full bg-primary px-5 py-2 text-sm font-semibold text-black transition-all hover:bg-primary/85 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#00E5FF] focus-visible:outline-offset-2"
          data-testid="leads-scan-submit"
        >
          <span class="inline-block min-w-[9ch] text-center">{{
            scanning() ? 'Scanning…' : 'Scan'
          }}</span>
        </button>
        @if (lastScan(); as s) {
          <span class="pb-2 text-xs text-text-secondary" role="status" aria-live="polite"
            >Scanned {{ s.scanned }} · added {{ s.created }}</span
          >
          @if (s.degraded) {
            <span class="pb-2 text-xs text-amber-300" role="alert">⚠ {{ s.degraded }}</span>
          }
        }
      </form>

      <!-- Auto-scan (OSM, US-wide siteless engine → crm.projectsites.dev) -->
      <form
        appReveal
        class="mb-8 flex flex-wrap items-end gap-3 rounded-2xl border border-secondary/25 bg-secondary/[0.05] p-4"
        (ngSubmit)="scanOsm()"
        data-testid="leads-osm-form"
      >
        <div class="w-full -mb-1">
          <span class="text-xs font-semibold uppercase tracking-wider text-secondary"
            >Automatic scan</span
          >
          <p class="mt-0.5 text-xs text-text-secondary [text-wrap:pretty]">
            Free OSM discovery of businesses with no website → ranked → synced to
            <a
              href="https://crm.projectsites.dev"
              target="_blank"
              rel="noopener"
              class="text-primary underline"
              >crm.projectsites.dev</a
            >. No outreach is sent.
          </p>
        </div>
        <label class="min-w-[200px]">
          <span
            class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-text-secondary"
            >Metro area</span
          >
          <select
            class="w-full rounded-lg border border-white/[0.1] bg-black/30 px-3 py-2 text-sm text-white outline-none transition-colors focus-visible:border-secondary/60 focus-visible:ring-1 focus-visible:ring-secondary/40"
            [value]="metroIdx()"
            (change)="metroIdx.set(+$any($event.target).value)"
            data-testid="leads-osm-metro"
          >
            @for (m of metros; track m.label; let i = $index) {
              <option [value]="i">{{ m.label }}</option>
            }
          </select>
        </label>
        <label class="w-[120px]">
          <span
            class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-text-secondary"
            >Max leads</span
          >
          <input
            type="number"
            min="1"
            max="500"
            class="w-full rounded-lg border border-white/[0.1] bg-black/30 px-3 py-2 text-sm text-white outline-none transition-colors focus-visible:border-secondary/60 focus-visible:ring-1 focus-visible:ring-secondary/40"
            [(ngModel)]="osmMaxLeads"
            name="osmMaxLeads"
            data-testid="leads-osm-max"
          />
        </label>
        <button
          type="submit"
          [disabled]="osmScanning()"
          class="rounded-full bg-secondary px-5 py-2 text-sm font-semibold text-black transition-all hover:bg-secondary/85 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#7C3AED] focus-visible:outline-offset-2"
          data-testid="leads-osm-submit"
        >
          <span class="inline-block min-w-[13ch] text-center">{{
            osmScanning() ? 'Scanning…' : 'Run auto-scan'
          }}</span>
        </button>
        @if (osmSummary(); as s) {
          <span class="pb-2 text-xs text-text-secondary" role="status" aria-live="polite"
            >Discovered {{ s.discovered }} · added {{ s.upserted }} to CRM · skipped
            {{ s.skipped }}</span
          >
        }
      </form>

      <!-- Lead count -->
      <div class="mb-4 flex items-center gap-2 text-sm text-text-secondary">
        <app-rolling-counter [value]="leads().length" />
        <span>{{ leads().length === 1 ? 'lead' : 'leads' }}</span>
      </div>

      <!-- States -->
      @if (loading()) {
        <p
          class="rounded-xl border border-white/[0.08] bg-white/[0.02] p-6 text-sm text-text-secondary"
        >
          Loading leads…
        </p>
      } @else if (loadError()) {
        <div
          class="flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.08] p-4 text-sm text-amber-200"
          role="alert"
        >
          Couldn't load leads.
          <button
            type="button"
            (click)="loadLeads()"
            class="rounded-full bg-amber-500/15 px-3 py-1 font-semibold text-amber-100 transition-all hover:bg-amber-500/25"
          >
            Retry
          </button>
        </div>
      } @else if (leads().length === 0) {
        <div
          class="flex flex-col items-start gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] p-6 text-sm text-text-secondary"
          data-testid="leads-empty"
        >
          <p class="[text-wrap:pretty]">
            No leads yet. Scan a query like
            <span class="font-mono text-text-primary">"roofers in Newark NJ"</span> to find local
            businesses without a website.
          </p>
          <button
            type="button"
            (click)="focusScanInput()"
            class="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-black transition-all hover:bg-primary/85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#00E5FF] focus-visible:outline-offset-2"
            data-testid="leads-empty-cta"
          >
            Start your first scan
            <span aria-hidden="true">&rarr;</span>
          </button>
        </div>
      } @else {
        <div class="overflow-x-auto rounded-xl border border-white/[0.08]">
          <table class="w-full text-left text-sm">
            <thead class="bg-white/[0.03] text-xs uppercase tracking-wider text-text-secondary">
              <tr>
                <th class="px-4 py-3">Business</th>
                <th class="px-4 py-3">Score</th>
                <th class="px-4 py-3">Signals</th>
                <th class="px-4 py-3">Contact</th>
                <th class="px-4 py-3">Social</th>
                <th class="px-4 py-3">Email</th>
                <th class="px-4 py-3 text-right">Claim link</th>
              </tr>
            </thead>
            <tbody>
              @for (lead of leads(); track lead.leadId) {
                <tr class="border-t border-white/[0.06]">
                  <td class="px-4 py-3 font-medium text-white" [attr.title]="lead.businessName">
                    {{ lead.businessName }}
                  </td>
                  <td class="px-4 py-3">
                    <span
                      class="inline-flex min-h-[24px] items-center rounded-full bg-primary/15 px-2.5 text-xs font-semibold text-primary"
                      >{{ lead.leadScore }}</span
                    >
                  </td>
                  <td class="px-4 py-3">
                    <span class="flex flex-wrap gap-1.5">
                      @if (!lead.hasWebsite) {
                        <span
                          class="inline-flex min-h-[24px] items-center rounded-full bg-green-500/15 px-2.5 text-xs font-medium text-green-300"
                          >No website</span
                        >
                      }
                      @if (lead.priority) {
                        <span
                          class="inline-flex min-h-[24px] items-center rounded-full bg-secondary/20 px-2.5 text-xs font-medium text-secondary"
                          >Priority</span
                        >
                      }
                      @if (reachVia(lead); as ch) {
                        <span
                          class="inline-flex min-h-[24px] items-center rounded-full bg-primary/10 px-2.5 text-xs font-medium text-primary/90"
                          [attr.title]="'Best outreach channel for ' + lead.businessName + ' (based on captured contact data)'"
                          data-testid="lead-reach-via"
                          >Reach via {{ ch.label }}</span
                        >
                      }
                    </span>
                  </td>
                  <td class="px-4 py-3">
                    @if (lead.phone || lead.email || lead.website) {
                      <span class="flex items-center gap-1">
                        @if (lead.phone) {
                          <a
                            [href]="'tel:' + lead.phone"
                            [attr.aria-label]="'Call ' + lead.businessName"
                            [attr.title]="lead.phone"
                            class="inline-flex h-6 min-w-[24px] items-center justify-center rounded text-sm leading-none text-primary transition-colors hover:bg-primary/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#00E5FF] focus-visible:outline-offset-1"
                            >☎</a
                          >
                        }
                        @if (lead.email) {
                          <a
                            [href]="'mailto:' + lead.email"
                            [attr.aria-label]="'Email ' + lead.businessName"
                            [attr.title]="lead.email"
                            class="inline-flex h-6 min-w-[24px] items-center justify-center rounded text-sm leading-none text-primary transition-colors hover:bg-primary/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#00E5FF] focus-visible:outline-offset-1"
                            >✉</a
                          >
                        }
                        @if (lead.website) {
                          <a
                            [href]="lead.website"
                            target="_blank"
                            rel="noopener"
                            [attr.aria-label]="'Visit website for ' + lead.businessName"
                            [attr.title]="lead.website"
                            class="inline-flex h-6 min-w-[24px] items-center justify-center rounded text-sm leading-none text-primary transition-colors hover:bg-primary/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#00E5FF] focus-visible:outline-offset-1"
                            >🌐</a
                          >
                        }
                      </span>
                    } @else {
                      <span class="text-text-secondary">—</span>
                    }
                  </td>
                  <td class="px-4 py-3">
                    <span class="flex flex-wrap items-center gap-1.5">
                      @for (network of socialOrder; track network) {
                        @if (lead.socials?.[network]; as url) {
                          <a
                            [href]="url"
                            target="_blank"
                            rel="noopener"
                            [attr.aria-label]="socialMeta[network].label + ' — ' + lead.businessName"
                            [attr.title]="socialMeta[network].label"
                            class="inline-flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-white/[0.08] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#00E5FF] focus-visible:outline-offset-1"
                          >
                            <svg
                              viewBox="0 0 24 24"
                              class="h-4 w-4"
                              [style.fill]="socialMeta[network].color"
                              aria-hidden="true"
                            >
                              <path [attr.d]="socialMeta[network].path" />
                            </svg>
                          </a>
                        }
                      }
                    </span>
                  </td>
                  <td class="px-4 py-3 text-text-secondary" [attr.title]="lead.email">
                    {{ lead.email ?? '—' }}
                  </td>
                  <td class="px-4 py-3 text-right">
                    <span class="inline-flex items-center gap-1.5">
                      <button
                        type="button"
                        (click)="enrich(lead)"
                        [disabled]="isEnriching(lead.leadId)"
                        title="Find website, phone, email & socials"
                        aria-label="Find website, phone, email & socials"
                        class="inline-flex h-6 min-w-[24px] items-center justify-center gap-1 rounded-full bg-secondary/15 px-2.5 text-xs font-semibold text-secondary transition-all hover:bg-secondary/25 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#7C3AED] focus-visible:outline-offset-2"
                        [attr.data-testid]="'leads-enrich-' + lead.leadId"
                      >
                        @if (isEnriching(lead.leadId)) {
                          <span class="ps-enrich-spinner" aria-hidden="true"></span>
                          <span>Enriching…</span>
                        } @else {
                          <span>Enrich</span>
                        }
                      </button>
                      @if (lead.enrichedAt) {
                        <span
                          class="text-xs text-green-400"
                          title="Contact info enriched"
                          aria-label="Enriched"
                          >✓</span
                        >
                      }
                      <button
                        type="button"
                        (click)="copyClaimLink(lead)"
                        [disabled]="isCopying(lead.leadId)"
                        class="inline-flex min-h-[24px] items-center rounded-full bg-primary/15 px-3 py-1 text-xs font-semibold text-primary transition-all hover:bg-primary/25 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#00E5FF] focus-visible:outline-offset-2"
                        [attr.data-testid]="'leads-copy-link-' + lead.leadId"
                      >
                        {{ isCopying(lead.leadId) ? 'Minting…' : 'Copy claim link' }}
                      </button>
                    </span>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </section>
  `,
  styles: [
    `
      .ps-enrich-spinner {
        display: inline-block;
        width: 10px;
        height: 10px;
        border: 2px solid currentColor;
        border-right-color: transparent;
        border-radius: 50%;
        animation: ps-enrich-spin 0.6s linear infinite;
      }
      @keyframes ps-enrich-spin {
        to {
          transform: rotate(360deg);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .ps-enrich-spinner {
          animation-duration: 1.5s;
        }
      }
    `,
  ],
})
export class AdminLeadsComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);

  /** Fixed social-icon render order + display metadata (template reads these). */
  readonly socialOrder = SOCIAL_ORDER;
  readonly socialMeta = SOCIAL_META;

  query = '';
  readonly onlyNoWebsite = signal(true);
  readonly scanning = signal(false);

  /** Metro presets for the OSM auto-scan + the operator's current selection. */
  readonly metros = METROS;
  readonly metroIdx = signal(0);
  osmMaxLeads = 50;
  readonly osmScanning = signal(false);
  readonly osmSummary = signal<OsmScanSummary | null>(null);

  readonly loading = signal(false);
  readonly loadError = signal(false);
  readonly leads = signal<LeadSummary[]>([]);
  readonly lastScan = signal<{
    scanned: number;
    created: number;
    degraded: string | null;
  } | null>(null);
  private readonly copyingIds = signal<ReadonlySet<string>>(new Set());
  /** Lead id currently being enriched (per-row in-flight guard), or null when idle. */
  private readonly enrichingId = signal<string | null>(null);

  /** True while this lead's claim link is being minted (per-row busy guard). */
  isCopying(id: string): boolean {
    return this.copyingIds().has(id);
  }

  /** True while this lead's contact info is being deep-discovered. */
  isEnriching(id: string): boolean {
    return this.enrichingId() === id;
  }

  /** Best outreach channel for this lead's captured contact data (template helper). */
  reachVia(lead: LeadSummary): OutreachChannel | null {
    return bestOutreachChannel(lead);
  }

  ngOnInit(): void {
    this.loadLeads();
  }

  /**
   * Empty-state launchpad action: scroll the scan query input into view and focus
   * it so a first-time operator's next keystroke starts a scan — no hunting for
   * the form (per embarrassingly-easy-to-use: empty states are first-action launchpads).
   */
  focusScanInput(): void {
    const input = document.getElementById('leads-scan-query') as HTMLInputElement | null;
    if (!input) return;
    input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    input.focus();
  }

  /** Load scanned leads (highest score first), honoring the no-website filter. */
  loadLeads(): void {
    this.loading.set(true);
    this.loadError.set(false);
    const query = this.onlyNoWebsite() ? '?onlyNoWebsite=true' : '';
    this.api.get<{ leads: LeadSummary[]; count: number }>(`/admin/leads${query}`).subscribe({
      next: (res) => {
        this.leads.set(res?.leads ?? []);
        this.loading.set(false);
      },
      error: () => {
        this.loadError.set(true);
        this.loading.set(false);
      },
    });
  }

  /**
   * Run the scan (Places first, free OSM/Nominatim fallback server-side), then
   * refresh the list. Double-submit guarded. `degraded` failures surface as an
   * honest amber note + error toast instead of a lying "Scanned 0 · added 0".
   */
  scan(): void {
    const query = this.query.trim();
    if (query.length < 2 || this.scanning()) return;
    this.scanning.set(true);
    this.api
      .post<{
        summary: { scanned: number; created: number };
        source?: 'google_places' | 'osm';
        degraded?: string | null;
      }>('/admin/leads/scan', {
        query,
        onlyNoWebsite: this.onlyNoWebsite(),
      })
      .subscribe({
        next: (res) => {
          this.scanning.set(false);
          this.lastScan.set({
            scanned: res?.summary?.scanned ?? 0,
            created: res?.summary?.created ?? 0,
            degraded: res?.degraded ?? null,
          });
          if ((res?.summary?.created ?? 0) > 0) {
            this.toast.success(
              `Scanned ${res?.summary?.scanned ?? 0} · added ${res?.summary?.created ?? 0} leads${
                res?.source === 'osm' ? ' (free OSM search)' : ''
              }.`,
            );
          } else if (res?.degraded) {
            this.toast.error(`No leads found — ${res.degraded}`);
          } else {
            this.toast.info('No new leads — try another query or a different area.');
          }
          this.loadLeads();
        },
        error: () => this.scanning.set(false),
      });
  }

  /**
   * Run the automatic OSM siteless scan for the selected metro. Discovered,
   * ranked leads sink to crm.projectsites.dev (not the D1 list), so the result is
   * the summary, not a table refresh. Double-submit guarded; never throws.
   */
  scanOsm(): void {
    if (this.osmScanning()) return;
    const metro = this.metros[this.metroIdx()];
    if (!metro) return;
    const maxLeads = Math.min(500, Math.max(1, Math.floor(this.osmMaxLeads) || 50));
    this.osmScanning.set(true);
    this.api
      .post<{ summary: OsmScanSummary }>('/admin/leads/scan-osm', {
        bbox: metro.bbox,
        maxLeads,
      })
      .subscribe({
        next: (res) => {
          this.osmScanning.set(false);
          this.osmSummary.set(res?.summary ?? null);
          this.toast.success(
            `Auto-scan: discovered ${res?.summary?.discovered ?? 0} · added ${res?.summary?.upserted ?? 0} to CRM.`,
          );
        },
        error: () => this.osmScanning.set(false),
      });
  }

  /** Mint a claim link for a lead and copy it to the clipboard. Per-row guarded. */
  copyClaimLink(lead: LeadSummary): void {
    if (this.isCopying(lead.leadId)) return;
    this.copyingIds.update((s) => new Set(s).add(lead.leadId));
    this.api
      .post<{
        token: string;
        claimUrl: string;
      }>(`/admin/leads/${encodeURIComponent(lead.leadId)}/claim-link`, {})
      .subscribe({
        next: (res) => {
          this.clearCopying(lead.leadId);
          if (!res?.claimUrl) return;
          void navigator.clipboard
            ?.writeText(res.claimUrl)
            .then(() => this.toast.success('Claim link copied to clipboard.'))
            .catch(() => this.toast.info(res.claimUrl));
        },
        error: () => this.clearCopying(lead.leadId),
      });
  }

  /**
   * Deep-discover a lead's contact info (website, phone, email, socials) via
   * `POST /api/admin/leads/:id/enrich`, then reload the list so the new Contact +
   * Social cells populate. Per-row in-flight guard; never throws.
   */
  enrich(lead: LeadSummary): void {
    if (this.isEnriching(lead.leadId)) return;
    this.enrichingId.set(lead.leadId);
    this.api
      .post<{ contact: unknown; updated: boolean }>(
        `/admin/leads/${encodeURIComponent(lead.leadId)}/enrich`,
        {},
      )
      .subscribe({
        next: (res) => {
          this.enrichingId.set(null);
          this.toast.success(
            res?.updated ? 'Contact info enriched.' : 'No new contact info found.',
          );
          this.loadLeads();
        },
        error: () => this.enrichingId.set(null),
      });
  }

  private clearCopying(id: string): void {
    this.copyingIds.update((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  }
}
