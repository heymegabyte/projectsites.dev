/**
 * Admin → Social — Pulse Social composer + scheduler.
 *
 * 3-pane layout:
 *   LEFT 220px : Connected accounts (per-platform card + connect/disconnect)
 *   CENTER 1fr : Tabs (Compose / Drafts / Queue / Sent / Calendar) + composer
 *   RIGHT 320px: Live previews per selected platform
 *
 * Wires to sibling-agent backend:
 *   GET    /api/social/accounts?site_id=:id
 *   GET    /api/social/:platform/connect?site_id=:id     -> popup OAuth flow
 *   POST   /api/social/:platform/disconnect
 *   GET    /api/social/posts?site_id=:id&status=draft|scheduled|published
 *   POST   /api/social/posts
 *   PATCH  /api/social/posts/:id
 *   DELETE /api/social/posts/:id
 *   POST   /api/social/posts/:id/publish-now
 *   GET    /api/social/posts/:id/analytics
 *   POST   /api/social/generate
 *   POST   /api/social/media                              -> R2 upload
 *   POST   /api/social/og-preview                         -> OG fetch
 *   GET    /api/social/mentions?platform=:p&q=:q
 *   GET    /api/social/best-times?platforms=:list
 *   POST   /api/social/import-rss
 */
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
  type AfterViewInit,
  type OnInit,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { RevealDirective } from '../../../directives/reveal.directive';
import { RollingCounterComponent } from '../../../components/rolling-counter/rolling-counter.component';
import { HlmInputDirective, HlmSelectDirective, HlmTablistDirective } from '../../../ui';
import { AdminStateService } from '../admin-state.service';
import { ApiService } from '../../../services/api.service';
import { ToastService } from '../../../services/toast.service';
import { SocialCalendarComponent } from './social-calendar.component';
import { SocialAutoPilotDialogComponent } from './social-auto-pilot-dialog.component';
import { SocialPasteConnectDialogComponent, isValidPublicHttpsUrl } from './social-paste-connect-dialog.component';
// Connected-accounts LEFT pane — split out (presentational). Owns the platform
// TYPES; PLATFORMS catalog stays here and is passed down via [platforms].
import { SocialAccountsComponent, type PlatformId, type PlatformDef, type SocialAccount } from './social-accounts.component';

interface MediaItem {
  id: string;
  url: string;
  thumb_url?: string;
  alt: string;
  bytes: number;
  type: 'image' | 'video' | 'gif';
}

type PostStatus = 'draft' | 'scheduled' | 'published' | 'partial' | 'failed';

interface SocialPost {
  id: string;
  content: string;
  per_platform_content?: Partial<Record<PlatformId, string>>;
  platforms: PlatformId[];
  media: MediaItem[];
  hashtags: string[];
  link?: string;
  og?: { title: string; description: string; image: string; site_name: string };
  scheduled_at?: string;
  published_at?: string;
  status: PostStatus;
  per_platform_status?: Partial<Record<PlatformId, 'ok' | 'pending' | 'failed'>>;
  per_platform_url?: Partial<Record<PlatformId, string>>;
}

interface AnalyticsRow {
  platform: PlatformId;
  impressions: number;
  likes: number;
  shares: number;
  clicks: number;
}

interface OgData {
  title: string;
  description: string;
  image: string;
  site_name: string;
}

type Tab = 'compose' | 'drafts' | 'queue' | 'sent' | 'calendar';
/** Valid `?tab=` deep-link values. */
const SOCIAL_TABS: readonly Tab[] = ['compose', 'drafts', 'queue', 'sent', 'calendar'];

const PLATFORMS: readonly PlatformDef[] = [
  {
    id: 'twitter',
    label: 'X / Twitter',
    charLimit: 280,
    color: '#1d9bf0',
    glyph:
      'M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.25 2.25h6.83l4.713 6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117Z',
  },
  {
    id: 'linkedin',
    label: 'LinkedIn',
    charLimit: 3000,
    color: '#0a66c2',
    glyph:
      'M20.45 20.45h-3.55v-5.57c0-1.33-.03-3.04-1.86-3.04-1.86 0-2.14 1.45-2.14 2.95v5.66H9.35V9h3.41v1.56h.05c.47-.9 1.63-1.86 3.36-1.86 3.6 0 4.27 2.37 4.27 5.45v6.3ZM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12ZM7.12 20.45H3.56V9h3.56v11.45Z',
  },
  {
    id: 'facebook',
    label: 'Facebook',
    charLimit: 63206,
    color: '#1877f2',
    glyph:
      'M22 12a10 10 0 1 0-11.56 9.88v-6.99H7.9V12h2.54V9.8c0-2.5 1.49-3.89 3.78-3.89 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56V12h2.78l-.45 2.89h-2.34v6.99A10 10 0 0 0 22 12Z',
  },
  {
    id: 'instagram',
    label: 'Instagram',
    charLimit: 2200,
    color: '#e1306c',
    glyph:
      'M12 2.16c3.2 0 3.58.01 4.85.07 1.17.05 1.8.25 2.23.41.56.22.96.48 1.38.9.42.42.68.82.9 1.38.16.42.36 1.06.41 2.23.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.05 1.17-.25 1.8-.41 2.23a3.7 3.7 0 0 1-.9 1.38c-.42.42-.82.68-1.38.9-.42.16-1.06.36-2.23.41-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-1.17-.05-1.8-.25-2.23-.41a3.7 3.7 0 0 1-1.38-.9 3.7 3.7 0 0 1-.9-1.38c-.16-.42-.36-1.06-.41-2.23-.06-1.27-.07-1.65-.07-4.85s.01-3.58.07-4.85c.05-1.17.25-1.8.41-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.42-.16 1.06-.36 2.23-.41 1.27-.06 1.65-.07 4.85-.07M12 0C8.74 0 8.33.01 7.05.07 5.78.13 4.9.33 4.14.63a5.92 5.92 0 0 0-2.13 1.39A5.92 5.92 0 0 0 .62 4.15c-.3.76-.5 1.64-.56 2.91C.01 8.33 0 8.74 0 12s.01 3.67.07 4.95c.06 1.27.26 2.15.56 2.91.31.79.73 1.46 1.39 2.13a5.92 5.92 0 0 0 2.13 1.39c.76.3 1.64.5 2.91.56C8.33 23.99 8.74 24 12 24s3.67-.01 4.95-.07c1.27-.06 2.15-.26 2.91-.56a5.92 5.92 0 0 0 2.13-1.39 5.92 5.92 0 0 0 1.39-2.13c.3-.76.5-1.64.56-2.91.06-1.28.07-1.69.07-4.95s-.01-3.67-.07-4.95c-.06-1.27-.26-2.15-.56-2.91a5.92 5.92 0 0 0-1.39-2.13A5.92 5.92 0 0 0 19.86.63c-.76-.3-1.64-.5-2.91-.56C15.67.01 15.26 0 12 0Zm0 5.84a6.16 6.16 0 1 0 0 12.32 6.16 6.16 0 0 0 0-12.32M12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm6.4-11.85a1.44 1.44 0 1 0 0 2.88 1.44 1.44 0 0 0 0-2.88Z',
  },
  {
    id: 'threads',
    label: 'Threads',
    charLimit: 500,
    color: '#a78bfa',
    glyph:
      'M12.18 24h-.02c-3.32-.02-5.87-1.12-7.58-3.26C3.06 18.85 2.25 16.13 2.21 12.74v-.01l-.01-.1.01-.13c.04-3.4.85-6.11 2.37-8 1.71-2.14 4.26-3.23 7.58-3.26h.02c2.55.02 4.7.66 6.39 1.92 1.58 1.17 2.7 2.85 3.32 4.97l-2.07.59c-1.05-3.6-3.5-5.39-7.65-5.42-2.66.02-4.68.85-5.99 2.46-1.22 1.51-1.84 3.71-1.86 6.54.02 2.83.64 5.03 1.86 6.54 1.31 1.61 3.33 2.44 5.99 2.46 2.38-.02 3.96-.59 5.28-1.91 1.5-1.5 1.47-3.34.99-4.45-.28-.66-.78-1.21-1.46-1.62-.16 1.16-.51 2.12-1.07 2.85-.74.99-1.81 1.53-3.16 1.61-1.02.06-2-.18-2.76-.67-.91-.59-1.43-1.5-1.49-2.57-.06-1.04.36-2 1.17-2.69.78-.66 1.88-1.05 3.18-1.12.96-.05 1.86.01 2.69.18-.11-.66-.34-1.18-.66-1.57-.46-.55-1.17-.83-2.11-.83h-.03c-.76 0-1.78.21-2.43 1.19l-1.75-1.18c.87-1.32 2.29-2.04 4.18-2.04h.04c3.18.02 5.07 1.96 5.26 5.34.11.05.21.09.32.14 1.46.69 2.53 1.73 3.09 3.02.79 1.79.86 4.7-1.51 7.07-1.81 1.81-4.01 2.63-7.13 2.65Zm1.06-9.86c-.21 0-.43 0-.65.02-1.62.09-2.62.83-2.55 1.89.06 1.11 1.29 1.62 2.47 1.55 1.09-.06 2.51-.49 2.75-3.37-.61-.06-1.28-.09-2.01-.09Z',
  },
  {
    id: 'bluesky',
    label: 'Bluesky',
    charLimit: 300,
    pasteKey: true,
    color: '#1185fe',
    glyph:
      'M5.95 4.13C8.65 6.18 11.55 10.34 12 12.55c.45-2.21 3.35-6.37 6.05-8.42 1.95-1.47 5.1-2.61 5.1.99 0 .72-.41 6.04-.65 6.9-.83 3-3.88 3.77-6.6 3.3 4.74.81 5.95 3.5 3.35 6.18-4.95 5.1-7.11-1.27-7.66-2.9-.1-.3-.15-.44-.15-.32 0-.12-.05.02-.15.32-.55 1.63-2.71 8-7.66 2.9-2.6-2.68-1.39-5.37 3.35-6.18-2.72.47-5.77-.3-6.6-3.3C.14 11.16-.27 5.84-.27 5.12c0-3.6 3.15-2.46 5.1-.99h1.12Z',
  },
  {
    id: 'reddit',
    label: 'Reddit',
    charLimit: 40000,
    color: '#ff4500',
    glyph:
      'M12 0a12 12 0 1 0 12 12A12 12 0 0 0 12 0Zm6.67 13.13c.03.19.04.39.04.59 0 3.01-3.5 5.45-7.81 5.45s-7.81-2.44-7.81-5.45c0-.2.01-.4.04-.59-.61-.27-1.04-.88-1.04-1.59 0-.96.78-1.74 1.74-1.74.47 0 .9.19 1.21.49 1.19-.86 2.84-1.41 4.67-1.47l.88-4.13 2.87.61a1.22 1.22 0 1 1-.04.55l-2.57-.55-.79 3.71c1.8.07 3.42.62 4.6 1.48.31-.31.74-.5 1.22-.5.96 0 1.74.78 1.74 1.74 0 .71-.43 1.32-1.04 1.59h.09Zm-10.91-.62a1.31 1.31 0 1 0 2.61 0 1.31 1.31 0 0 0-2.61 0Zm6.31 3.43c.16.16.16.42 0 .58a4.07 4.07 0 0 1-2.93 1.02h-.01a4.06 4.06 0 0 1-2.93-1.02.41.41 0 0 1 0-.58.41.41 0 0 1 .58 0c.59.59 1.46.88 2.35.88h.01c.89 0 1.76-.29 2.35-.88a.41.41 0 0 1 .58 0Zm-.17-2.12a1.31 1.31 0 1 1 0-2.62 1.31 1.31 0 0 1 0 2.62Z',
  },
  {
    id: 'mastodon',
    label: 'Mastodon',
    charLimit: 500,
    pasteKey: true,
    color: '#6364ff',
    glyph:
      'M23.27 5.36C22.91 2.7 20.58.6 17.81.19 17.35.12 15.58 0 11.49 0h-.03c-4.1 0-4.97.13-5.42.2C3.34.6.88 2.49.29 5.18.0 6.5 0 7.97 0 9.32.07 11.25.08 13.18.26 15.1.38 16.38.59 17.65.89 18.9c.55 2.3 2.83 4.21 5.07 5 2.39.82 4.97.96 7.43.4.27-.06.54-.13.81-.21.59-.19 1.29-.4 1.8-.78.01 0 .02-.01.03-.03v-1.92s-.01-.02-.02-.02-.02 0-.02 0c-2.05.49-4.16.74-6.27.74-3.63 0-4.6-1.72-4.88-2.44-.22-.62-.36-1.27-.42-1.92 0-.01 0-.02.01-.02s.02 0 .02 0c2.02.49 4.09.74 6.16.74.5 0 1-.01 1.49-.03 2.09-.06 4.28-.16 6.33-.56.05-.01.1-.03.15-.04 3.24-.62 6.32-2.57 6.63-7.5.01-.19.04-2.04.04-2.24.01-.69-.21-4.88-.27-5.21ZM19.58 15.4h-2.86V8.42c0-1.47-.62-2.22-1.85-2.22-1.36 0-2.05.88-2.05 2.62v3.79H10c0-3.6-.01-3.95 0-4.97 0-.99-.7-2.61-1.97-2.61-1.36 0-1.85.95-1.85 2.31v6.06H3.32C3.31 12.07 3.3 8.45 3.31 7.62c0-1.55.79-2.79 1.92-3.6.81-.58 1.78-.88 2.78-.83 2.17.04 3.5 1.59 3.92 2.43 0 .01.02.01.02 0 .42-.83 1.74-2.39 3.92-2.43 1.0-.04 1.97.25 2.78.83 1.13.81 1.92 2.05 1.92 3.6.01.83.01 4.41 0 7.78Z',
  },
  {
    id: 'discord',
    label: 'Discord',
    charLimit: 2000,
    pasteKey: true,
    color: '#5865f2',
    glyph:
      'M20.32 4.37A19.79 19.79 0 0 0 15.43 2.9a.07.07 0 0 0-.08.04c-.21.37-.44.86-.6 1.24a18.27 18.27 0 0 0-5.5 0c-.16-.39-.4-.87-.62-1.24A.08.08 0 0 0 8.55 2.9a19.74 19.74 0 0 0-4.89 1.47.07.07 0 0 0-.03.03C.53 9.05-.32 13.58.1 18.06a.08.08 0 0 0 .03.06 19.9 19.9 0 0 0 6 3.03.08.08 0 0 0 .09-.03c.46-.63.87-1.3 1.23-2.01a.08.08 0 0 0-.04-.11 13.13 13.13 0 0 1-1.87-.89.08.08 0 0 1 0-.13c.13-.1.25-.2.37-.3a.07.07 0 0 1 .08-.01c3.93 1.79 8.18 1.79 12.06 0a.07.07 0 0 1 .08.01c.12.1.24.2.37.3a.08.08 0 0 1 0 .13c-.6.35-1.22.65-1.87.89a.08.08 0 0 0-.04.11c.36.71.77 1.38 1.23 2.01a.08.08 0 0 0 .09.03 19.85 19.85 0 0 0 6-3.03.08.08 0 0 0 .03-.06c.5-5.18-.83-9.67-3.55-13.66a.06.06 0 0 0-.03-.03ZM8.02 15.33c-1.18 0-2.16-1.09-2.16-2.42 0-1.33.96-2.42 2.16-2.42 1.21 0 2.18 1.1 2.16 2.42 0 1.33-.96 2.42-2.16 2.42Zm7.97 0c-1.18 0-2.16-1.09-2.16-2.42 0-1.33.96-2.42 2.16-2.42 1.21 0 2.18 1.1 2.16 2.42 0 1.33-.95 2.42-2.16 2.42Z',
  },
  {
    id: 'slack',
    label: 'Slack',
    charLimit: 40000,
    color: '#4a154b',
    glyph:
      'M5.04 15.16a2.52 2.52 0 0 1-2.52 2.52A2.52 2.52 0 0 1 0 15.16a2.52 2.52 0 0 1 2.52-2.52h2.52v2.52ZM6.32 15.16a2.52 2.52 0 0 1 2.52-2.52 2.52 2.52 0 0 1 2.52 2.52v6.32A2.52 2.52 0 0 1 8.84 24a2.52 2.52 0 0 1-2.52-2.52v-6.32ZM8.84 5.04A2.52 2.52 0 0 1 6.32 2.52 2.52 2.52 0 0 1 8.84 0a2.52 2.52 0 0 1 2.52 2.52v2.52H8.84ZM8.84 6.32a2.52 2.52 0 0 1 2.52 2.52 2.52 2.52 0 0 1-2.52 2.52H2.52A2.52 2.52 0 0 1 0 8.84a2.52 2.52 0 0 1 2.52-2.52h6.32ZM18.96 8.84a2.52 2.52 0 0 1 2.52-2.52A2.52 2.52 0 0 1 24 8.84a2.52 2.52 0 0 1-2.52 2.52h-2.52V8.84ZM17.68 8.84a2.52 2.52 0 0 1-2.52 2.52 2.52 2.52 0 0 1-2.52-2.52V2.52A2.52 2.52 0 0 1 15.16 0a2.52 2.52 0 0 1 2.52 2.52v6.32ZM15.16 18.96a2.52 2.52 0 0 1 2.52 2.52A2.52 2.52 0 0 1 15.16 24a2.52 2.52 0 0 1-2.52-2.52v-2.52h2.52ZM15.16 17.68a2.52 2.52 0 0 1-2.52-2.52 2.52 2.52 0 0 1 2.52-2.52h6.32A2.52 2.52 0 0 1 24 15.16a2.52 2.52 0 0 1-2.52 2.52h-6.32Z',
  },
  {
    id: 'telegram',
    label: 'Telegram',
    charLimit: 4096,
    pasteKey: true,
    color: '#229ed9',
    glyph:
      'M12 0a12 12 0 1 0 12 12A12 12 0 0 0 12 0Zm5.94 8.2-1.98 9.35c-.15.66-.54.82-1.1.51l-3.04-2.24-1.47 1.42c-.16.16-.3.3-.62.3l.22-3.13 5.71-5.16c.25-.22-.05-.34-.39-.13L8.21 13.6 4.96 12.6c-.71-.22-.72-.71.15-1.05l12.7-4.9c.59-.22 1.1.14.9 1.55Z',
  },
] as const;

/* ──────────────────────────────────────────────────────────────────── */
/*  Component                                                           */
/* ──────────────────────────────────────────────────────────────────── */

@Component({
  selector: 'app-admin-social',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, RevealDirective, RollingCounterComponent, HlmInputDirective, HlmSelectDirective, HlmTablistDirective, SocialAccountsComponent, SocialCalendarComponent, SocialAutoPilotDialogComponent, SocialPasteConnectDialogComponent],
  template: `
<div class="social-wrap" [class.is-loading]="loading()">

  <!-- ═══════════════════════ HEADER ═══════════════════════ -->
  <header class="social-header" appReveal>
    <div class="hdr-left">
      <div class="kicker">Pulse Social</div>
      <h1 class="social-h1">
        <svg class="hdr-glyph" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 11l18-8v18l-18-8z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>
        </svg>
        Social
        <span class="hdr-pill">
          <span class="hdr-pill-dot"></span>
          @if (loading() && accounts().length === 0) {
            <span aria-hidden="true">…</span>&nbsp;connected
          } @else if (accountsError() && accounts().length === 0) {
            <!-- Connection states failed to load → the count is UNKNOWN, not 0.
                 Show "—" (mirrors the loading "…"), never a false "0 connected". -->
            <span aria-hidden="true">—</span>&nbsp;connected
          } @else {
            <app-rolling-counter [value]="connectedCount()" />&nbsp;connected
          }
        </span>
      </h1>
      <p class="hdr-sub">Compose once. Tailor per network. Schedule, queue, measure.</p>
      <div class="auto-pilot-row" role="group" aria-label="Auto-Pilot controls">
        <label class="auto-pilot-toggle" [class.is-on]="autoPilotEnabled()" [class.is-busy]="autoPilotSaving()">
          <input
            type="checkbox"
            [checked]="autoPilotEnabled()"
            (change)="setAutoPilot($any($event.target).checked)"
            [disabled]="autoPilotSaving()"
            aria-label="Toggle Auto-Pilot" />
          <span class="auto-pilot-toggle__track">
            <span class="auto-pilot-toggle__dot"></span>
          </span>
          <span class="auto-pilot-toggle__label">Auto-Pilot</span>
          @if (autoPilotEnabled()) {
            <span class="auto-pilot-toggle__hint">drafts every {{ autoPilotCadenceHours() }}h</span>
          }
        </label>
        <button
          type="button"
          class="auto-pilot-btn"
          (click)="openAutoPilotPrompt()"
          aria-label="Configure Auto-Pilot prompt"
          data-testid="social-auto-pilot-prompt-btn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
          </svg>
          Auto-Pilot prompt
        </button>
      </div>
    </div>
    <nav class="tab-row" role="tablist" hlmTablist aria-label="Pulse Social tabs">
      <button class="tab" role="tab" [class.is-active]="tab() === 'compose'" [attr.aria-selected]="tab() === 'compose'" (click)="selectTab('compose')">Compose</button>
      <button class="tab" role="tab" [class.is-active]="tab() === 'drafts'" [attr.aria-selected]="tab() === 'drafts'" (click)="selectTab('drafts')">
        Drafts <span class="tab-count">{{ draftsCount() }}</span>
      </button>
      <button class="tab" role="tab" [class.is-active]="tab() === 'queue'" [attr.aria-selected]="tab() === 'queue'" (click)="selectTab('queue')">
        Queue <span class="tab-count">{{ scheduledCount() }}</span>
      </button>
      <button class="tab" role="tab" [class.is-active]="tab() === 'sent'" [attr.aria-selected]="tab() === 'sent'" (click)="selectTab('sent')">
        Sent <span class="tab-count">{{ publishedCount() }}</span>
      </button>
      <button class="tab" role="tab" [class.is-active]="tab() === 'calendar'" [attr.aria-selected]="tab() === 'calendar'" (click)="selectTab('calendar')">Calendar</button>
    </nav>
  </header>

  <!-- ═══════════════════════ 3-PANE BODY ═══════════════════════ -->
  <div class="three-pane">

    <!-- ─────────── LEFT: ACCOUNTS ─────────── -->
    <app-social-accounts
      [platforms]="platforms"
      [accounts]="accounts()"
      [accountsError]="accountsError()"
      [disconnectingPids]="disconnectingPids()"
      (connect)="connect($event)"
      (disconnect)="disconnect($event)"
      (retry)="retryAccounts()" />

    <!-- ─────────── CENTER: TAB CONTENT ─────────── -->
    <section class="pane-main">

      <!-- ============ COMPOSER ============ -->
      @if (tab() === 'compose') {
        <div class="composer" appReveal>

          <!-- Platform toggle chips -->
          <div class="chip-row" role="group" aria-label="Select platforms">
            @for (p of platforms; track p.id) {
              @let on = isPlatformSelected(p.id);
              @let conn = isConnected(p.id);
              <button
                type="button"
                class="chip"
                [class.is-on]="on"
                [class.is-override]="hasOverride(p.id)"
                [class.is-off]="!conn"
                [style.--brand]="p.color"
                [disabled]="!conn"
                [attr.aria-pressed]="on"
                [title]="on ? (hasOverride(p.id) ? 'Tap again to remove per-platform copy' : 'Tap again to customize copy for ' + p.label) : 'Add ' + p.label"
                (click)="togglePlatform(p.id)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path [attr.d]="p.glyph"/></svg>
                <span>{{ p.label }}</span>
                @if (on) {
                  <span class="chip-ct" [class.near]="ctState(charsFor(p.id), p.charLimit) === 'near'" [class.over]="ctState(charsFor(p.id), p.charLimit) === 'over'">{{ charsFor(p.id) }}/{{ p.charLimit }}</span>
                }
              </button>
            }
          </div>

          <!-- S31 — platform cost advisory (X is pay-per-use since 2026) -->
          @if (xCostNotice(); as note) {
            <div class="x-cost-note" role="note">
              <span>{{ note }}</span>
              <button type="button" (click)="dismissXNotice()" aria-label="Dismiss X pricing notice">Got it</button>
            </div>
          }

          <!-- S44 — autosaved-draft restored hint -->
          @if (draftRestored()) {
            <div class="draft-hint" role="status">
              <span>Restored your unsaved draft.</span>
              <button type="button" (click)="dismissDraftHint()" aria-label="Dismiss restored-draft notice">Dismiss</button>
            </div>
          }

          <!-- Main textarea -->
          <textarea
            #mainTa
            hlmInput
            [multiline]="true"
            class="w-full min-h-[90px] resize-y leading-relaxed"
            rows="4"
            [(ngModel)]="content"
            (ngModelChange)="onContentChange($event)"
            (keydown)="onContentKeydown($event)"
            placeholder="What are you sharing today?"
            aria-label="Post content"
            data-testid="social-composer-textarea"></textarea>

          <!-- Mention autocomplete dropdown -->
          @if (mentionOpen() && mentionResults().length > 0) {
            <div class="mention-pop" role="listbox" aria-label="Mention suggestions">
              @for (m of mentionResults(); track m.handle; let i = $index) {
                <button
                  type="button"
                  role="option"
                  class="mention-row"
                  [class.is-active]="i === mentionIdx()"
                  (mousedown)="insertMention(m, $event)">
                  <span class="mention-handle">&#64;{{ m.handle }}</span>
                  @if (m.name) { <span class="mention-name">{{ m.name }}</span> }
                </button>
              }
            </div>
          }

          <!-- Live composer counter — count against the tightest selected
               platform that uses the main copy. The platform chips show each
               platform; this is the at-cursor summary (Buffer/Typefully style).
               Cyan-muted → amber (≥90%) → red (over). Tailwind only (social is
               over its SCSS budget). -->
          @if (composerLimit(); as cl) {
            <div class="flex justify-end mt-1">
              <span [class]="composerCtClass()" data-testid="composer-counter" role="status" aria-live="polite"
                    [attr.aria-label]="content().length + ' of ' + cl.limit + ' characters; tightest limit is ' + cl.platform">
                {{ content().length }}/{{ cl.limit }}@if (composerCharState() === 'over') {&nbsp;· over {{ cl.platform }}}
              </span>
            </div>
          }

          <!-- Per-platform override surfaces -->
          @for (p of platforms; track p.id) {
            @if (hasOverride(p.id)) {
              <div class="override-row" [style.--brand]="p.color">
                <div class="override-h">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path [attr.d]="p.glyph"/></svg>
                  <span>{{ p.label }} override</span>
                  <span class="override-ct" [class.near]="ctState(perPlatform()[p.id]?.length || 0, p.charLimit) === 'near'" [class.over]="ctState(perPlatform()[p.id]?.length || 0, p.charLimit) === 'over'">
                    {{ perPlatform()[p.id]?.length || 0 }}/{{ p.charLimit }}
                  </span>
                  <button type="button" class="override-x" (click)="removeOverride(p.id)" aria-label="Remove override">&times;</button>
                </div>
                <textarea
                  hlmInput
                  [multiline]="true"
                  class="w-full min-h-[60px] resize-y text-[0.82rem]"
                  rows="3"
                  [ngModel]="perPlatform()[p.id]"
                  (ngModelChange)="setOverride(p.id, $event)"
                  [placeholder]="'Tailored copy for ' + p.label"
                  [attr.aria-label]="p.label + ' tailored content'"></textarea>
              </div>
            }
          }

          <!-- Media uploader -->
          <div class="media-zone"
               [class.is-drag]="dragOver()"
               (dragover)="onDragOver($event)"
               (dragleave)="dragOver.set(false)"
               (drop)="onDrop($event)"
               (click)="fileInput.click()"
               (keydown.enter)="fileInput.click()"
               role="button"
               tabindex="0"
               aria-label="Drop or click to upload media">
            <input #fileInput type="file" accept="image/*,video/*" multiple hidden (change)="onFiles($event)" />
            @if (media().length === 0) {
              <div class="media-empty">
                <svg class="media-empty__icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/></svg>
                <div class="media-empty__body">
                  <span class="media-empty__copy">Add a photo or video to make this post pop.</span>
                  <button
                    type="button"
                    class="media-empty__cta"
                    (click)="fileInput.click(); $event.stopPropagation()"
                    aria-label="Upload media from your device">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                    Upload media
                  </button>
                  <span class="media-empty__hint">or drag &amp; drop anywhere here</span>
                </div>
              </div>
            } @else {
              <div class="media-grid">
                @for (m of media(); track m.id) {
                  <figure class="media-tile" (click)="$event.stopPropagation()">
                    @if (m.type === 'video') {
                      <video [src]="m.url" muted></video>
                    } @else {
                      <img [src]="m.thumb_url || m.url" [alt]="m.alt || ''" loading="lazy" />
                    }
                    <input
                      class="media-alt"
                      type="text"
                      [value]="m.alt"
                      (input)="updateAlt(m.id, $any($event.target).value)"
                      placeholder="Alt text"
                      [attr.aria-label]="'Alt text for ' + (m.type || 'media')" />
                    <button type="button" class="media-x" (click)="removeMedia(m.id); $event.stopPropagation()" aria-label="Remove media">&times;</button>
                  </figure>
                }
                <button type="button" class="media-add" (click)="fileInput.click(); $event.stopPropagation()" aria-label="Add more media">+</button>
              </div>
            }
          </div>

          <!-- S27 — saved templates (localStorage): insert a snippet or save the current draft -->
          @if (templates().length > 0 || content().trim().length > 0) {
            <div class="tmpl-row">
              @for (t of templates(); track t.id) {
                <span class="tmpl-chip">
                  <button type="button" class="tmpl-use" (click)="useTemplate(t)" [title]="t.content">{{ t.name }}</button>
                  <button type="button" class="tmpl-del" (click)="deleteTemplate(t.id)" [attr.aria-label]="'Delete template ' + t.name">&times;</button>
                </span>
              }
              @if (content().trim().length > 0) {
                <button type="button" class="tmpl-save" (click)="saveTemplate()">+ Save as template</button>
              }
            </div>
          }

          <!-- Hashtags + link + AI/mention helpers -->
          <div class="meta-grid">

            <div class="meta-col">
              <label class="meta-lbl" for="ps-tags">Hashtags <span class="meta-aux">{{ hashtags().length }}/30</span></label>
              <div class="tag-input">
                @for (t of hashtags(); track t; let i = $index) {
                  <span class="tag-chip">#{{ t }} <button type="button" (click)="removeHashtag(i)" aria-label="Remove tag">&times;</button></span>
                }
                <input
                  hlmInput
                  id="ps-tags"
                  class="flex-1"
                  type="text"
                  [(ngModel)]="hashtagDraft"
                  (keydown)="onHashtagKeydown($event)"
                  placeholder="Type, then space or comma" />
              </div>
            </div>

            <div class="meta-col">
              <label class="meta-lbl" for="ps-link">Link</label>
              <input
                hlmInput
                id="ps-link"
                class="w-full"
                type="url"
                [(ngModel)]="link"
                (blur)="fetchOg()"
                placeholder="https://…" />
              @if (og(); as o) {
                <div class="og-card" data-testid="og-card">
                  @if (o.image) { <img [src]="o.image" [alt]="o.title" /> }
                  <div class="og-meta">
                    <div class="og-site">{{ o.site_name }}</div>
                    <div class="og-title">{{ o.title }}</div>
                    <div class="og-desc">{{ o.description }}</div>
                  </div>
                </div>
              } @else if (linkHost()) {
                <div class="og-card og-card--fallback" data-testid="link-fallback-card">
                  <div class="og-meta">
                    <div class="og-site">{{ linkHost() }}</div>
                    <div class="og-title">{{ link() }}</div>
                    <div class="og-desc">Preview unavailable — the link still posts with your message.</div>
                  </div>
                </div>
              }
            </div>

          </div>

          <!-- AI assist row -->
          <div class="ai-row">
            <select hlmSelect [(ngModel)]="aiTone" aria-label="AI tone">
              <option value="punchy">Punchy</option>
              <option value="warm">Warm</option>
              <option value="authoritative">Authoritative</option>
              <option value="playful">Playful</option>
              <option value="story">Story-driven</option>
            </select>
            <button type="button" class="btn-ai" (click)="generate()" [disabled]="aiLoading() || selected().length === 0" [attr.aria-busy]="aiLoading()">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
              {{ aiLoading() ? 'Drafting…' : 'AI assist' }}
            </button>
            @if (aiVariants().length > 0) {
              <div class="ai-variants" role="group" aria-label="AI variant carousel">
                <button type="button" class="ai-nav" (click)="prevVariant()" aria-label="Previous variant">‹</button>
                <span class="ai-vidx">{{ variantIdx() + 1 }} / {{ aiVariants().length }}</span>
                <button type="button" class="ai-nav" (click)="nextVariant()" aria-label="Next variant">›</button>
                <button type="button" class="ai-use" (click)="useVariant()">Use</button>
              </div>
            }
          </div>

          <!-- S15 — live per-platform preview (the right-pane preview the layout always promised) -->
          @if (previewCards().length > 0) {
            <div class="preview-block" aria-label="Per-platform preview">
              <div class="preview-h">Preview</div>
              <div class="preview-cards">
                @for (pc of previewCards(); track pc.id) {
                  <div class="preview-card" [style.--brand]="pc.color">
                    <div class="pc-head">
                      <span class="pc-glyph"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path [attr.d]="pc.glyph"/></svg></span>
                      <span class="pc-label">{{ pc.label }}</span>
                      <span class="pc-ct" [class.over]="pc.over">{{ pc.chars }}/{{ pc.limit }}</span>
                    </div>
                    <p class="pc-body" [class.is-empty]="!pc.text">{{ pc.text || 'Nothing to post yet…' }}</p>
                    @if (media().length > 0) {
                      <div class="pc-media">
                        @for (m of media().slice(0, 4); track m.id) {
                          <img [src]="m.thumb_url || m.url" [alt]="m.alt || ''" loading="lazy" />
                        }
                      </div>
                    }
                    @if (og(); as o) {
                      <div class="pc-og"><span class="pc-og-site">{{ o.site_name || linkHost() }}</span><span class="pc-og-title">{{ o.title }}</span></div>
                    } @else if (link().trim()) {
                      <div class="pc-og"><span class="pc-og-site">{{ linkHost() }}</span></div>
                    }
                  </div>
                }
              </div>
            </div>
          }

          <!-- Schedule + best-times -->
          <div class="sched-row">
            <label class="meta-lbl">When</label>
            <div class="sched-btns">
              <button type="button" class="sched-btn" [class.is-on]="!scheduleAt()" (click)="scheduleAt.set(null)">Post now</button>
              <button type="button" class="sched-btn" [class.is-on]="!!scheduleAt()" (click)="openScheduler()">Schedule</button>
              @if (scheduleAt()) {
                <input hlmInput type="datetime-local" [(ngModel)]="scheduleAt" [min]="minSchedule" [attr.aria-invalid]="scheduledInPast() || null" aria-label="Scheduled time" />
                <select hlmSelect [(ngModel)]="scheduleTz" aria-label="Time zone">
                  <option value="America/Los_Angeles">Los Angeles</option>
                  <option value="America/New_York">New York</option>
                  <option value="America/Chicago">Chicago</option>
                  <option value="UTC">UTC</option>
                  <option value="Europe/London">London</option>
                  <option value="Europe/Berlin">Berlin</option>
                  <option value="Asia/Tokyo">Tokyo</option>
                </select>
              }
            </div>
            @if (bestTimes().length > 0) {
              <div class="best-times">
                <span class="best-h">Best for {{ selected().length }} platforms:</span>
                @for (b of bestTimes(); track b) {
                  <button type="button" class="best-chip" (click)="applyBestTime(b)">{{ b }}</button>
                }
              </div>
            }
          </div>

          <!-- Status line -->
          <div class="status-line" [attr.aria-live]="'polite'">
            <span>{{ selected().length }} platform{{ selected().length === 1 ? '' : 's' }}</span>
            <span>·</span>
            <span>{{ mediaSummary() }}</span>
            <span>·</span>
            <span>{{ scheduleSummary() }}</span>
          </div>

          <!-- Actions -->
          <div class="action-row">
            <button type="button" class="btn-ghost" (click)="discard()">Discard</button>
            <button type="button" class="btn-ghost" (click)="saveDraft()" [disabled]="saving()">Save draft</button>
            <button type="button" class="btn-primary" (click)="publish()" [disabled]="!canPublish() || saving()"
              [attr.aria-describedby]="publishBlockReason() ? 'publish-hint' : null">
              {{ scheduleAt() ? 'Schedule post' : 'Publish now' }}
            </button>
          </div>
          @if (publishBlockReason(); as reason) {
            <p class="publish-hint" id="publish-hint" role="status" aria-live="polite" data-testid="publish-hint">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              {{ reason }}
            </p>
          }

          <!-- Bulk import (RSS) -->
          <div class="rss-row">
            <details>
              <summary>Bulk import from RSS</summary>
              <div class="rss-body">
                <input hlmInput class="flex-1" type="url" [(ngModel)]="rssUrl" placeholder="https://example.com/feed.xml" aria-label="RSS feed URL"
                  [attr.aria-invalid]="rssUrlInvalid()" [attr.aria-describedby]="rssUrlInvalid() ? 'rss-url-hint' : null" />
                <button type="button" class="btn-ghost" (click)="rssPreview()" [disabled]="!rssUrlValid()">Preview</button>
                @if (rssUrlInvalid()) {
                  <span id="rss-url-hint" data-testid="rss-url-hint" class="rss-hint">Must be a valid https:// feed URL.</span>
                }
                @if (rssItems().length > 0) {
                  <ul class="rss-list">
                    @for (it of rssItems(); track it.url) {
                      <li><strong>{{ it.title }}</strong> · <a [href]="it.url" target="_blank" rel="noopener noreferrer">{{ it.url }}</a></li>
                    }
                  </ul>
                  <div class="rss-actions">
                    <button type="button" class="btn-primary" (click)="importRssDrafts()" [disabled]="importingRss()" data-testid="rss-import-drafts">
                      {{ importingRss() ? 'Importing…' : 'Import ' + rssItems().length + ' as drafts' }}
                    </button>
                    <button type="button" class="btn-ghost" (click)="copyRssLinks()" data-testid="rss-copy-links">Copy links</button>
                    <span class="rss-hint">Drafts land in your Drafts tab — assign accounts + schedule there.</span>
                  </div>
                }
              </div>
            </details>
          </div>
        </div>
      }

      <!-- ============ DRAFTS / QUEUE / SENT lists ============ -->
      @if (tab() === 'drafts' || tab() === 'queue' || tab() === 'sent') {
        <div class="list-pane" appReveal>
          @if (bulkSelected().size > 0) {
            <div class="bulk-bar" role="region" aria-label="Bulk actions">
              <span class="bulk-ct">{{ bulkSelected().size }} selected</span>
              <button type="button" class="btn-ghost sm danger" (click)="bulkDelete()">Delete selected</button>
              <button type="button" class="btn-ghost sm" (click)="clearBulk()">Clear</button>
            </div>
          }
          @if (filteredPosts().length === 0) {
            <div class="empty-state">
              <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/></svg>
              <h3>Nothing here yet</h3>
              <p>{{ tab() === 'drafts' ? 'Save a draft from the composer to see it here.' : tab() === 'queue' ? 'Schedule a post to fill the queue.' : 'Published posts will appear here with analytics.' }}</p>
              <button type="button" class="btn-primary" (click)="selectTab('compose')">Open composer</button>
            </div>
          } @else {
            @for (post of filteredPosts(); track post.id) {
              <article class="post-card" appReveal [revealDelay]="$index * 60" [class.is-bulk-selected]="isBulkSelected(post.id)">
                <header class="post-h">
                  <input type="checkbox" class="post-sel" [checked]="isBulkSelected(post.id)" (change)="toggleBulk(post.id)" [attr.aria-label]="'Select this post for bulk actions'" />
                  <div class="post-platforms">
                    @for (p of post.platforms; track p) {
                      @let pd = defOf(p);
                      <span class="post-pglyph" [style.--brand]="pd?.color" [title]="pd?.label || p">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path [attr.d]="pd?.glyph || ''"/></svg>
                      </span>
                    }
                  </div>
                  <span class="post-status" [class]="'is-' + post.status">{{ post.status }}</span>
                  <span class="post-time">{{ post.scheduled_at || post.published_at | date:'short' }}</span>
                </header>
                <p class="post-body">{{ post.content }}</p>
                @if (post.media.length) {
                  <div class="post-thumbs">
                    @for (m of post.media; track m.id) {
                      <img [src]="m.thumb_url || m.url" [alt]="m.alt" loading="lazy" />
                    }
                  </div>
                }

                @if (tab() === 'sent') {
                  <div class="post-stats">
                    @for (row of analyticsFor(post.id); track row.platform) {
                      @let pd = defOf(row.platform);
                      <div class="stat-tile" [style.--brand]="pd?.color">
                        <div class="stat-h"><span class="stat-glyph"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path [attr.d]="pd?.glyph || ''"/></svg></span> {{ pd?.label }}</div>
                        <div class="stat-grid">
                          <div><span class="stat-k">Impressions</span><app-rolling-counter [value]="row.impressions" /></div>
                          <div><span class="stat-k">Likes</span><app-rolling-counter [value]="row.likes" /></div>
                          <div><span class="stat-k">Shares</span><app-rolling-counter [value]="row.shares" /></div>
                          <div><span class="stat-k">Clicks</span><app-rolling-counter [value]="row.clicks" /></div>
                        </div>
                      </div>
                    }
                  </div>
                  <div class="post-links">
                    @for (p of post.platforms; track p) {
                      @if (post.per_platform_url?.[p]) {
                        <a [href]="post.per_platform_url![p]!" target="_blank" rel="noopener noreferrer">View on {{ defOf(p)?.label }}<svg class="inline-block align-[-2px] ml-[3px]" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>
                      }
                    }
                  </div>
                }

                <div class="post-actions">
                  @if (tab() === 'drafts') {
                    <button type="button" class="btn-ghost sm" (click)="editPost(post)">Edit</button>
                    <button type="button" class="btn-ghost sm danger" [disabled]="isDeletingPost(post.id)" [attr.aria-busy]="isDeletingPost(post.id)" (click)="deletePost(post)">{{ isDeletingPost(post.id) ? 'Deleting…' : 'Delete' }}</button>
                    <button type="button" class="btn-primary sm" [class.is-busy]="isPublishing(post.id)" [disabled]="isPublishing(post.id)" (click)="publishNow(post)">{{ isPublishing(post.id) ? 'Publishing…' : 'Publish' }}</button>
                  }
                  @if (tab() === 'queue') {
                    <button type="button" class="btn-ghost sm" (click)="editPost(post)">Edit time</button>
                    <button type="button" class="btn-ghost sm danger" [disabled]="isDeletingPost(post.id)" [attr.aria-busy]="isDeletingPost(post.id)" (click)="deletePost(post)">{{ isDeletingPost(post.id) ? 'Cancelling…' : 'Cancel' }}</button>
                    <button type="button" class="btn-primary sm" [class.is-busy]="isPublishing(post.id)" [disabled]="isPublishing(post.id)" (click)="publishNow(post)">{{ isPublishing(post.id) ? 'Publishing…' : 'Send now' }}</button>
                  }
                  @if (tab() === 'sent') {
                    <button type="button" class="btn-ghost sm" (click)="duplicatePost(post)">Duplicate</button>
                  }
                </div>
              </article>
            }
          }
        </div>
      }

      <!-- ============ CALENDAR ============ -->
      @if (tab() === 'calendar') {
        <app-social-calendar
          [posts]="posts()"
          [platforms]="platforms"
          (edit)="editCalendarPost($event.id)"
          (rescheduled)="loadPosts()" />
      }
    </section>


  </div>

  <!-- ═══════════════════════ AUTO-PILOT PROMPT DIALOG ═══════════════════════ -->
  @if (autoPilotDialogOpen()) {
    <app-social-auto-pilot-dialog
      [prompt]="autoPilotPrompt()"
      [cadenceHours]="autoPilotCadenceHours()"
      [targetNetworks]="autoPilotTargetNetworks()"
      [defaultPrompt]="autoPilotDefaultPrompt()"
      [platforms]="platforms"
      (saved)="applyAutoPilotSaved($event)"
      (closed)="closeAutoPilotDialog()" />
  }

  <!-- ═══════════════════════ PASTE-KEY CONNECT DIALOG ═══════════════════════ -->
  @if (pasteOpen(); as pid) {
    <app-social-paste-connect-dialog
      [platform]="pid"
      [platformLabel]="defOf(pid)?.label || ''"
      (connected)="onPasteConnected()"
      (closed)="closePaste()" />
  }
</div>
`,
  styles: [
    `
      :host {
        display: block;
        --brand: var(--ps-accent, #00e5ff);
      }

      .social-wrap {
        padding: 28px;
        display: flex;
        flex-direction: column;
        gap: 18px;
        min-height: calc(100vh - 49px);
        animation: fadeIn 0.3s ease;
      }
      @media (max-width: 900px) { .social-wrap { padding: 14px; } }

      /* ── Header ── */
      .social-header { display: flex; justify-content: space-between; gap: 18px; flex-wrap: wrap; }
      .hdr-left { min-width: 0; }
      .kicker {
        text-transform: uppercase; letter-spacing: 0.14em; font-size: 0.62rem;
        color: color-mix(in oklch, var(--ps-accent, #00e5ff) 90%, var(--ps-ink, #f4f4ff) 10%);
        font-weight: 700;
      }
      .social-h1 {
        margin: 4px 0 6px; font-size: 1.4rem; font-weight: 800;
        color: var(--ps-ink, #f4f4ff); display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      }
      .hdr-glyph { color: var(--ps-accent, #00e5ff); }
      .hdr-pill {
        display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px;
        border-radius: 999px; font-size: 0.7rem; font-weight: 600;
        color: var(--ps-accent, #00e5ff);
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 8%, transparent);
        border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 30%, transparent);
      }
      .hdr-pill-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ps-accent, #00e5ff); box-shadow: 0 0 8px var(--ps-accent, #00e5ff); }
      .hdr-sub { color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 82%, transparent); font-size: 0.82rem; margin: 0; }
      /* View tabs (Compose/Drafts/Queue/Sent/Calendar) — pill row mirroring the settings +
         voice tablists. Without these rules the buttons rendered as unstyled inline text
         jammed together ("ComposeDrafts 0Queue 0Sent 0Calendar") — .tab-row/.tab had no CSS. */
      .tab-row { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; margin-top: 0.9rem; }
      .tab {
        display: inline-flex; align-items: center; gap: 0.4rem;
        padding: 0.4rem 0.95rem; border-radius: 999px;
        background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 62%, transparent);
        cursor: pointer; font-size: 0.74rem; font-weight: 600; min-height: 34px;
        transition: color 120ms ease, background 120ms ease, border-color 120ms ease;
      }
      .tab:hover { color: var(--ps-ink, #f4f4ff); border-color: color-mix(in oklch, var(--ps-accent, #00e5ff) 25%, transparent); }
      .tab.is-active {
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 12%, transparent);
        color: var(--ps-accent, #00e5ff);
        border-color: color-mix(in oklch, var(--ps-accent, #00e5ff) 35%, transparent);
      }
      .tab:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 2px; }
      .tab-count {
        font-size: 0.62rem; font-weight: 700; font-variant-numeric: tabular-nums;
        padding: 1px 7px; border-radius: 999px;
        background: rgba(255,255,255,0.08); color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 70%, transparent);
      }
      .tab.is-active .tab-count { background: color-mix(in oklch, var(--ps-accent, #00e5ff) 22%, transparent); color: var(--ps-accent, #00e5ff); }
      @media (prefers-reduced-motion: reduce) { .tab { transition: none; } }

      /* ── Auto-Pilot header controls ── */
      .auto-pilot-row {
        display: inline-flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 10px;
      }
      .auto-pilot-toggle {
        display: inline-flex; align-items: center; gap: 8px;
        padding: 6px 12px; border-radius: 999px; cursor: pointer;
        background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 4%, transparent);
        border: 1px solid color-mix(in oklch, var(--ps-ink, #f4f4ff) 10%, transparent);
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 80%, transparent);
        font-size: 0.78rem; font-weight: 600;
        transition: background 0.18s ease, border-color 0.18s ease, color 0.18s ease;
      }
      .auto-pilot-toggle:hover {
        border-color: color-mix(in oklch, var(--ps-accent, #00e5ff) 30%, transparent);
        color: var(--ps-ink, #f4f4ff);
      }
      .auto-pilot-toggle.is-on {
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 14%, transparent);
        border-color: color-mix(in oklch, var(--ps-accent, #00e5ff) 40%, transparent);
        color: var(--ps-accent, #00e5ff);
      }
      .auto-pilot-toggle.is-busy { opacity: 0.6; cursor: progress; }
      .btn-primary.is-busy { opacity: 0.65; cursor: progress; }
      .auto-pilot-toggle input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
      .auto-pilot-toggle__track {
        position: relative; width: 28px; height: 16px; border-radius: 999px;
        background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 18%, transparent);
        transition: background 0.18s ease;
      }
      .auto-pilot-toggle.is-on .auto-pilot-toggle__track { background: var(--ps-accent, #00e5ff); }
      .auto-pilot-toggle__dot {
        position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%;
        background: var(--ps-bg, #060610);
        transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .auto-pilot-toggle.is-on .auto-pilot-toggle__dot { transform: translateX(12px); }
      .auto-pilot-toggle__hint {
        font-size: 0.66rem; font-weight: 500;
        color: color-mix(in oklch, var(--ps-accent, #00e5ff) 70%, var(--ps-ink, #f4f4ff) 30%);
      }
      .auto-pilot-toggle input:focus-visible + .auto-pilot-toggle__track {
        outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 2px;
      }
      .auto-pilot-btn {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 6px 12px; border-radius: 999px; cursor: pointer; font-family: inherit;
        font-size: 0.74rem; font-weight: 600;
        background: transparent;
        border: 1px solid color-mix(in oklch, var(--ps-ink, #f4f4ff) 12%, transparent);
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 78%, transparent);
        transition: all 0.18s ease;
      }
      .auto-pilot-btn:hover {
        color: var(--ps-ink, #f4f4ff);
        border-color: color-mix(in oklch, var(--ps-accent, #00e5ff) 40%, transparent);
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 8%, transparent);
      }
      .auto-pilot-btn:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 2px; }
      @media (prefers-reduced-motion: reduce) {
        .auto-pilot-toggle, .auto-pilot-toggle__track, .auto-pilot-toggle__dot, .auto-pilot-btn { transition: none !important; }
      }

      /* Connected-accounts (.acct-*) CSS moved to social-accounts.component.ts. */

      /* ── Center / composer ── */
      .pane-main { min-width: 0; display: flex; flex-direction: column; gap: 12px; }
      .composer {
        background: color-mix(in oklch, var(--ps-bg, #060610) 60%, transparent);
        border: 1px solid color-mix(in oklch, var(--ps-ink, #f4f4ff) 8%, transparent);
        border-radius: var(--ps-radius-xl, 22px);
        padding: 18px;
        backdrop-filter: blur(14px);
        display: flex; flex-direction: column; gap: 14px;
        box-shadow: 0 8px 28px rgba(0, 0, 0, 0.25),
                    0 0 0 1px color-mix(in oklch, var(--ps-accent, #00e5ff) 5%, transparent);
        position: relative;
      }

      .chip-row { display: flex; flex-wrap: wrap; gap: 6px; }
      .chip {
        --brand: var(--ps-accent, #00e5ff);
        display: inline-flex; align-items: center; gap: 6px;
        padding: 5px 10px; border-radius: 999px; cursor: pointer;
        background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 4%, transparent);
        border: 1px solid color-mix(in oklch, var(--ps-ink, #f4f4ff) 10%, transparent);
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 70%, transparent);
        font-size: 0.74rem; font-weight: 600; font-family: inherit; transition: all 0.16s ease;
      }
      .chip:hover:not(:disabled) { transform: translateY(-1px); border-color: color-mix(in oklch, var(--brand) 40%, transparent); color: var(--ps-ink, #f4f4ff); }
      .chip.is-on { background: color-mix(in oklch, var(--brand) 16%, transparent); border-color: color-mix(in oklch, var(--brand) 45%, transparent); color: var(--brand); }
      .chip.is-override { box-shadow: 0 0 0 2px color-mix(in oklch, var(--brand) 24%, transparent); }
      .chip.is-off { opacity: 0.45; cursor: not-allowed; }
      .chip-ct { font-size: 0.62rem; opacity: 0.85; padding-left: 4px; border-left: 1px solid currentColor; margin-left: 2px; }
      .chip-ct.near { color: #fbbf24; font-weight: 700; }
      .chip-ct.over { color: #ff6b8a; font-weight: 700; }
      .draft-hint { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.5rem; padding: 0.4rem 0.6rem; border-radius: 0.5rem; border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 35%, transparent); background: color-mix(in oklch, var(--ps-accent, #00e5ff) 8%, transparent); color: var(--ps-ink, #f4f4ff); font-size: 0.74rem; }
      .draft-hint button { font-size: 0.7rem; font-weight: 600; color: var(--ps-accent, #00e5ff); background: none; border: 0; cursor: pointer; padding: 0.1rem 0.3rem; }
      .tmpl-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 0.4rem 0 0.6rem; }
      .tmpl-chip { display: inline-flex; align-items: center; gap: 2px; max-width: 220px; border-radius: 999px; border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 28%, transparent); background: color-mix(in oklch, var(--ps-accent, #00e5ff) 7%, transparent); }
      .tmpl-use { font-size: 0.7rem; color: var(--ps-ink, #f4f4ff); background: none; border: 0; cursor: pointer; padding: 0.2rem 0.4rem 0.2rem 0.6rem; max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .tmpl-del { font-size: 0.85rem; line-height: 1; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); background: none; border: 0; cursor: pointer; padding: 0 0.45rem 0 0.1rem; }
      .tmpl-del:hover { color: #ff6b8a; }
      .tmpl-save { font-size: 0.7rem; font-weight: 600; color: var(--ps-accent, #00e5ff); background: none; border: 1px dashed color-mix(in oklch, var(--ps-accent, #00e5ff) 35%, transparent); border-radius: 999px; cursor: pointer; padding: 0.2rem 0.6rem; }
      .bulk-bar { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.6rem; padding: 0.5rem 0.75rem; border-radius: 0.6rem; border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 30%, transparent); background: color-mix(in oklch, var(--ps-bg, #060610) 80%, var(--ps-accent, #00e5ff) 10%); backdrop-filter: blur(6px); }
      .bulk-ct { font-size: 0.78rem; font-weight: 700; color: var(--ps-ink, #f4f4ff); margin-right: auto; }
      .post-sel { width: 15px; height: 15px; accent-color: var(--ps-accent, #00e5ff); cursor: pointer; flex: none; }
      .post-card.is-bulk-selected { outline: 1.5px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 55%, transparent); outline-offset: 1px; }
      .x-cost-note { display: flex; align-items: center; gap: 0.6rem; margin: 0.5rem 0; padding: 0.45rem 0.7rem; border-radius: 0.5rem; border: 1px solid color-mix(in oklch, #fbbf24 40%, transparent); background: color-mix(in oklch, #fbbf24 9%, transparent); color: var(--ps-ink, #f4f4ff); font-size: 0.74rem; line-height: 1.35; }
      .x-cost-note span { flex: 1; }
      .x-cost-note button { flex: none; font-size: 0.7rem; font-weight: 600; color: #fbbf24; background: none; border: 0; cursor: pointer; padding: 0.1rem 0.3rem; }
      .preview-block { margin: 0.2rem 0 0.4rem; }
      .preview-h { font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 82%, transparent); margin-bottom: 0.4rem; }
      .preview-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 8px; }
      .preview-card { border: 1px solid color-mix(in oklch, var(--brand, #00e5ff) 30%, transparent); border-left: 2px solid var(--brand, #00e5ff); border-radius: 0.55rem; background: color-mix(in oklch, var(--ps-bg, #060610) 70%, transparent); padding: 0.5rem 0.6rem; min-width: 0; }
      .pc-head { display: flex; align-items: center; gap: 6px; margin-bottom: 0.35rem; }
      .pc-glyph { color: var(--brand, #00e5ff); display: inline-flex; }
      .pc-label { font-size: 0.72rem; font-weight: 700; color: var(--ps-ink, #f4f4ff); }
      .pc-ct { margin-left: auto; font-size: 0.62rem; opacity: 0.8; }
      .pc-ct.over { color: #ff6b8a; font-weight: 700; opacity: 1; }
      .pc-body { font-size: 0.74rem; line-height: 1.4; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 90%, transparent); white-space: pre-wrap; word-break: break-word; margin: 0; max-height: 7.5rem; overflow: hidden; }
      .pc-body.is-empty { opacity: 0.45; font-style: italic; }
      .pc-media { display: flex; gap: 4px; margin-top: 0.4rem; }
      .pc-media img { width: 38px; height: 38px; object-fit: cover; border-radius: 0.3rem; }
      .pc-og { margin-top: 0.4rem; display: flex; flex-direction: column; gap: 1px; padding: 0.3rem 0.4rem; border-radius: 0.35rem; background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 6%, transparent); }
      .pc-og-site { font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.7; }
      .pc-og-title { font-size: 0.7rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

      /* .composer-ta removed — composer textareas now Spartan hlmInput [multiline] (min-h via Tailwind). */

      .mention-pop {
        position: absolute; left: 18px; right: 18px; max-width: 320px; z-index: 50;
        background: color-mix(in oklch, var(--ps-bg, #060610) 95%, black);
        border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 24%, transparent);
        border-radius: 10px; padding: 6px; display: flex; flex-direction: column; gap: 2px;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
      }
      .mention-row {
        display: flex; gap: 8px; padding: 6px 8px; border-radius: 6px; border: none; background: transparent;
        text-align: left; cursor: pointer; color: var(--ps-ink, #f4f4ff); font-family: inherit; font-size: 0.78rem;
      }
      .mention-row.is-active, .mention-row:hover { background: color-mix(in oklch, var(--ps-accent, #00e5ff) 14%, transparent); }
      .mention-handle { color: var(--ps-accent, #00e5ff); font-weight: 700; }
      .mention-name { color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); }

      .override-row {
        --brand: var(--ps-accent, #00e5ff);
        padding: 10px; border-radius: 12px;
        background: color-mix(in oklch, var(--brand) 5%, transparent);
        border: 1px solid color-mix(in oklch, var(--brand) 28%, transparent);
        display: flex; flex-direction: column; gap: 8px;
      }
      .override-h {
        display: flex; align-items: center; gap: 8px; font-size: 0.74rem; font-weight: 700; color: var(--brand);
      }
      .override-ct { margin-left: auto; font-size: 0.62rem; opacity: 0.85; }
      .override-ct.near { color: #fbbf24; }
      .override-ct.over { color: #ff6b8a; }
      .override-x { border: none; background: transparent; color: inherit; cursor: pointer; font-size: 1.1rem; line-height: 1; }

      /* ── Media zone ── */
      .media-zone {
        border: 1.5px dashed color-mix(in oklch, var(--ps-ink, #f4f4ff) 16%, transparent);
        border-radius: 12px; padding: 14px; cursor: pointer; transition: all 0.18s ease;
        background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 2%, transparent);
      }
      .media-zone:hover, .media-zone.is-drag {
        border-color: color-mix(in oklch, var(--ps-accent, #00e5ff) 50%, transparent);
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 4%, transparent);
      }
      .media-zone:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 2px; }
      .media-empty { display: flex; align-items: center; gap: 12px; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 82%, transparent); font-size: 0.82rem; }
      .media-empty__icon { color: color-mix(in oklch, var(--ps-accent, #00e5ff) 70%, var(--ps-ink, #f4f4ff) 30%); flex-shrink: 0; }
      .media-empty__body { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; min-width: 0; }
      .media-empty__copy { font-weight: 600; color: var(--ps-ink, #f4f4ff); }
      .media-empty__cta {
        display: inline-flex; align-items: center; gap: 7px; cursor: pointer; font-family: inherit;
        padding: 7px 14px; border-radius: 999px; font-size: 0.78rem; font-weight: 700;
        color: var(--ps-bg, #060610);
        background: var(--ps-accent, #00e5ff);
        border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 60%, transparent);
        transition: filter 0.18s ease, transform 0.18s ease;
      }
      .media-empty__cta:hover { filter: brightness(1.08); }
      .media-empty__cta:active { transform: translateY(1px); }
      .media-empty__cta:focus-visible { outline: 2px solid var(--ps-accent, #00e5ff); outline-offset: 3px; }
      .media-empty__hint { font-size: 0.7rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); }
      @media (prefers-reduced-motion: reduce) { .media-empty__cta { transition: none; } }
      .media-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 8px; }
      .media-tile {
        position: relative; aspect-ratio: 1; border-radius: 10px; overflow: hidden; margin: 0;
        background: color-mix(in oklch, var(--ps-bg, #060610) 85%, transparent);
        border: 1px solid color-mix(in oklch, var(--ps-ink, #f4f4ff) 10%, transparent);
      }
      .media-tile img, .media-tile video { width: 100%; height: 100%; object-fit: cover; display: block; }
      .media-alt {
        position: absolute; left: 4px; right: 4px; bottom: 4px;
        background: rgba(0, 0, 0, 0.75); color: white; border: none; border-radius: 5px;
        padding: 4px 6px; font-size: 0.62rem; font-family: inherit; outline: none;
      }
      .media-x {
        position: absolute; top: 4px; right: 4px; width: 22px; height: 22px;
        background: rgba(0, 0, 0, 0.7); color: white; border: none; border-radius: 50%; cursor: pointer; font-size: 1rem; line-height: 1;
      }
      .media-add {
        aspect-ratio: 1; border-radius: 10px; cursor: pointer; font-size: 1.5rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 50%, transparent);
        background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 4%, transparent);
        border: 1px dashed color-mix(in oklch, var(--ps-ink, #f4f4ff) 18%, transparent);
      }

      /* ── Meta grid ── */
      .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      @media (max-width: 700px) { .meta-grid { grid-template-columns: 1fr; } }
      .meta-col { display: flex; flex-direction: column; gap: 6px; }
      .meta-lbl { font-size: 0.7rem; font-weight: 600; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 65%, transparent); display: flex; align-items: center; gap: 6px; }
      .meta-aux { margin-left: auto; opacity: 0.65; font-weight: 400; }
      /* .meta-input removed — now Spartan hlmInput. */
      .tag-input {
        display: flex; flex-wrap: wrap; gap: 5px; padding: 6px;
        background: color-mix(in oklch, var(--ps-bg, #060610) 80%, transparent);
        border: 1px solid color-mix(in oklch, var(--ps-ink, #f4f4ff) 10%, transparent); border-radius: 9px;
      }
      .tag-input input { flex: 1; min-width: 140px; background: transparent; border: none; outline: none; color: var(--ps-ink, #f4f4ff); font-family: inherit; font-size: 0.8rem; padding: 4px; }
      .tag-chip {
        display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 999px;
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 14%, transparent);
        color: var(--ps-accent, #00e5ff); font-size: 0.7rem; font-weight: 600;
      }
      .tag-chip button { background: transparent; border: none; color: inherit; cursor: pointer; padding: 0; line-height: 1; }

      .og-card {
        display: grid; grid-template-columns: 70px 1fr; gap: 10px; padding: 8px;
        background: color-mix(in oklch, var(--ps-bg, #060610) 75%, transparent);
        border: 1px solid color-mix(in oklch, var(--ps-ink, #f4f4ff) 10%, transparent);
        border-radius: 9px;
      }
      .og-card--fallback {
        grid-template-columns: 1fr;
        border-style: dashed;
        border-color: color-mix(in oklch, var(--ps-accent, #00e5ff) 30%, transparent);
      }
      .og-card img { width: 70px; height: 70px; object-fit: cover; border-radius: 6px; }
      .og-meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .og-site { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.06em; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); }
      .og-title { font-size: 0.78rem; font-weight: 600; color: var(--ps-ink, #f4f4ff); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .og-desc { font-size: 0.68rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 82%, transparent); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

      /* ── AI row ── */
      .ai-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 8px; border-radius: 10px; background: color-mix(in oklch, var(--ps-accent, #00e5ff) 4%, transparent); }
      /* .ai-tone removed — now Spartan hlmSelect. */
      .btn-ai {
        display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 7px;
        background: linear-gradient(135deg, var(--ps-accent, #00e5ff), var(--ps-accent-secondary, #7c3aed));
        color: #000; border: none; cursor: pointer; font-weight: 700; font-size: 0.76rem; font-family: inherit;
        transition: all 0.18s ease;
      }
      .btn-ai:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 4px 14px color-mix(in oklch, var(--ps-accent, #00e5ff) 35%, transparent); }
      .btn-ai:disabled { opacity: 0.45; cursor: not-allowed; }
      .ai-variants { display: flex; align-items: center; gap: 6px; margin-left: auto; }
      .ai-nav {
        width: 26px; height: 26px; border-radius: 50%; border: 1px solid color-mix(in oklch, var(--ps-ink, #f4f4ff) 12%, transparent);
        background: transparent; color: var(--ps-ink, #f4f4ff); cursor: pointer; font-size: 0.9rem; line-height: 1; font-family: inherit;
      }
      .ai-vidx { font-size: 0.7rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 65%, transparent); font-variant-numeric: tabular-nums; }
      .ai-use {
        padding: 4px 10px; border-radius: 7px; background: color-mix(in oklch, var(--ps-accent, #00e5ff) 18%, transparent);
        border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 40%, transparent);
        color: var(--ps-accent, #00e5ff); cursor: pointer; font-family: inherit; font-size: 0.7rem; font-weight: 700;
      }

      /* ── Schedule ── */
      .sched-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
      .sched-btns { display: inline-flex; gap: 6px; align-items: center; flex-wrap: wrap; }
      .sched-btn {
        padding: 6px 12px; border-radius: 7px; cursor: pointer; font-family: inherit; font-size: 0.74rem; font-weight: 600;
        background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 4%, transparent);
        border: 1px solid color-mix(in oklch, var(--ps-ink, #f4f4ff) 10%, transparent);
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 70%, transparent);
      }
      .sched-btn.is-on { background: color-mix(in oklch, var(--ps-accent, #00e5ff) 16%, transparent); border-color: color-mix(in oklch, var(--ps-accent, #00e5ff) 40%, transparent); color: var(--ps-accent, #00e5ff); }
      /* .sched-dt/.sched-tz removed — now Spartan hlmInput/hlmSelect. */
      .best-times { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-left: auto; }
      .best-h { font-size: 0.66rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); }
      .best-chip {
        padding: 3px 9px; border-radius: 999px; cursor: pointer; font-family: inherit; font-size: 0.66rem; font-weight: 600;
        background: color-mix(in oklch, #a78bfa 14%, transparent);
        border: 1px solid color-mix(in oklch, #a78bfa 35%, transparent);
        color: #c4b5fd;
      }

      .status-line {
        display: flex; gap: 8px; font-size: 0.7rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent);
        padding-top: 4px; flex-wrap: wrap;
      }

      .action-row { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
      .publish-hint {
        display: flex; align-items: center; gap: 6px; justify-content: flex-end;
        margin: 6px 0 0; font-size: 0.7rem;
        color: color-mix(in oklch, #fbbf24 82%, var(--ps-ink, #f4f4ff) 18%);
      }
      .publish-hint svg { flex-shrink: 0; }
      .btn-ghost {
        padding: 8px 14px; border-radius: 8px; cursor: pointer; font-family: inherit; font-size: 0.78rem; font-weight: 600;
        background: transparent; border: 1px solid color-mix(in oklch, var(--ps-ink, #f4f4ff) 12%, transparent);
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 80%, transparent);
        transition: all 0.16s ease;
      }
      .btn-ghost:hover { color: var(--ps-ink, #f4f4ff); border-color: color-mix(in oklch, var(--ps-accent, #00e5ff) 40%, transparent); }
      .btn-ghost.sm { padding: 5px 10px; font-size: 0.72rem; }
      .btn-ghost.danger { color: #ff8a9d; border-color: color-mix(in oklch, #ff5470 26%, transparent); }
      .btn-primary {
        padding: 8px 16px; border-radius: 8px; cursor: pointer; border: none; font-family: inherit; font-size: 0.8rem; font-weight: 700;
        background: linear-gradient(135deg, var(--ps-accent, #00e5ff), color-mix(in oklch, var(--ps-accent, #00e5ff) 70%, var(--ps-accent-secondary, #7c3aed) 30%));
        color: #000; transition: all 0.18s ease;
      }
      .btn-primary.sm { padding: 5px 10px; font-size: 0.72rem; }
      .btn-primary:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 4px 14px color-mix(in oklch, var(--ps-accent, #00e5ff) 35%, transparent); }
      .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }

      .rss-row details { border-top: 1px dashed color-mix(in oklch, var(--ps-ink, #f4f4ff) 10%, transparent); padding-top: 10px; }
      .rss-row summary { cursor: pointer; font-size: 0.74rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 70%, transparent); }
      .rss-body { display: flex; flex-direction: column; gap: 8px; padding-top: 8px; }
      .rss-body input {
        padding: 7px 10px; border-radius: 7px; background: color-mix(in oklch, var(--ps-bg, #060610) 80%, transparent);
        border: 1px solid color-mix(in oklch, var(--ps-ink, #f4f4ff) 10%, transparent);
        color: var(--ps-ink, #f4f4ff); font-family: inherit; font-size: 0.78rem; outline: none;
      }
      .rss-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; font-size: 0.74rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 75%, transparent); }
      .rss-list a { color: var(--ps-accent, #00e5ff); }
      .rss-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .rss-hint { font-size: 0.68rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); }

      /* ── Post list ── */
      .list-pane { display: flex; flex-direction: column; gap: 10px; }
      .empty-state {
        display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center; padding: 50px 18px;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 65%, transparent);
      }
      .empty-state svg { opacity: 0.4; }
      .empty-state h3 { color: var(--ps-ink, #f4f4ff); margin: 0; font-size: 1rem; }
      .empty-state p { font-size: 0.82rem; margin: 0; }
      .post-card {
        padding: 14px; border-radius: 14px;
        background: color-mix(in oklch, var(--ps-bg, #060610) 65%, transparent);
        border: 1px solid color-mix(in oklch, var(--ps-ink, #f4f4ff) 8%, transparent);
        display: flex; flex-direction: column; gap: 10px;
      }
      .post-h { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .post-platforms { display: inline-flex; gap: 4px; }
      .post-pglyph {
        width: 20px; height: 20px; border-radius: 5px;
        background: color-mix(in oklch, var(--brand) 14%, transparent);
        color: var(--brand); display: grid; place-items: center;
      }
      .post-status { font-size: 0.6rem; font-weight: 700; text-transform: uppercase; padding: 2px 7px; border-radius: 999px; }
      .post-status.is-draft     { background: color-mix(in oklch, var(--ps-ink, #f4f4ff) 10%, transparent); color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 75%, transparent); }
      .post-status.is-scheduled { background: color-mix(in oklch, var(--ps-accent, #00e5ff) 16%, transparent); color: var(--ps-accent, #00e5ff); }
      .post-status.is-published { background: color-mix(in oklch, #34d399 18%, transparent); color: #6ee7b7; }
      .post-status.is-partial   { background: color-mix(in oklch, #fbbf24 18%, transparent); color: #fcd34d; }
      .post-status.is-failed    { background: color-mix(in oklch, #ff5470 18%, transparent); color: #ff8a9d; }
      .post-time { font-size: 0.7rem; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); margin-left: auto; }
      .post-body { color: var(--ps-ink, #f4f4ff); font-size: 0.85rem; margin: 0; line-height: 1.5; white-space: pre-wrap; }
      .post-thumbs { display: flex; gap: 6px; flex-wrap: wrap; }
      .post-thumbs img { width: 60px; height: 60px; object-fit: cover; border-radius: 6px; }
      .post-stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; }
      .stat-tile {
        --brand: var(--ps-accent, #00e5ff);
        padding: 8px 10px; border-radius: 10px;
        background: color-mix(in oklch, var(--brand) 5%, transparent);
        border: 1px solid color-mix(in oklch, var(--brand) 22%, transparent);
      }
      .stat-h { display: flex; align-items: center; gap: 5px; font-size: 0.68rem; font-weight: 700; color: var(--brand); margin-bottom: 5px; }
      .stat-glyph { display: inline-grid; place-items: center; }
      .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; font-variant-numeric: tabular-nums; }
      .stat-grid > div { display: flex; flex-direction: column; gap: 1px; font-size: 0.85rem; font-weight: 700; color: var(--ps-ink, #f4f4ff); }
      .stat-k { font-size: 0.55rem; text-transform: uppercase; letter-spacing: 0.08em; color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 55%, transparent); font-weight: 600; }
      .post-links { display: flex; gap: 10px; flex-wrap: wrap; font-size: 0.74rem; }
      .post-links a { color: var(--ps-accent, #00e5ff); text-decoration: none; }
      .post-links a:hover { text-decoration: underline; }
      .post-actions { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap; }

      /* ── Calendar ── */
      @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

      @media (prefers-reduced-motion: reduce) {
        .chip:hover, .btn-ai:hover, .btn-primary:hover { transform: none; }
        .social-wrap { animation: none; }
      }
    `,
  ],
})
export class AdminSocialComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  readonly state = inject(AdminStateService);

  /** Guards the site-reactive load effect (see constructor). */
  private loadedSiteId: string | null = null;

  constructor() {
    // Site-reactive load: accounts + posts are site-scoped. On a deep-link the
    // selected site resolves AFTER mount, and there is NO data-refresh timer
    // here (the only setInterval is the per-OAuth popup poll), so an ngOnInit
    // one-shot would leave the panels empty forever. Fire on site resolve/switch.
    // (Reactivity class-bug — same fix as analytics/webhooks/recipes/pseo/mcp/forms.)
    effect(() => {
      const id = this.state.selectedSite()?.id ?? null;
      if (id !== this.loadedSiteId) {
        this.loadedSiteId = id;
        this.loadAccounts();
        this.loadPosts();
      }
    });
    // S44 — autosave the in-progress composer draft on every change (reads the
    // signals to register the effect's dependencies). Skips while editing an
    // existing post (that has its own server-side row).
    effect(() => {
      const snapshot = {
        content: this.content(),
        selected: this.selected(),
        perPlatform: this.perPlatform(),
        scheduleAt: this.scheduleAt(),
        hashtags: this.hashtags(),
        link: this.link(),
      };
      if (this.editingId()) return;
      this.persistDraft(snapshot);
    });
  }

  /** Persist the composer draft to localStorage, or clear it when empty. SSR/
   *  private-mode safe (try/catch). (Distinct from `saveDraft()`, which saves a
   *  draft POST to the server.) */
  private persistDraft(d: {
    content: string;
    selected: PlatformId[];
    perPlatform: Partial<Record<PlatformId, string>>;
    scheduleAt: string | null;
    hashtags: string[];
    link: string;
  }): void {
    try {
      const isEmpty = !d.content.trim() && d.selected.length === 0 && d.hashtags.length === 0 && !d.link.trim();
      if (isEmpty) {
        localStorage.removeItem(this.DRAFT_KEY);
        return;
      }
      localStorage.setItem(this.DRAFT_KEY, JSON.stringify(d));
    } catch {
      /* quota / private mode — autosave is best-effort */
    }
  }

  /** Restore a saved draft into the composer when it is currently empty. */
  private restoreDraft(): void {
    try {
      if (this.content().trim() || this.selected().length > 0) return;
      const raw = localStorage.getItem(this.DRAFT_KEY);
      if (!raw) return;
      const d = JSON.parse(raw) as Partial<{
        content: string;
        selected: PlatformId[];
        perPlatform: Partial<Record<PlatformId, string>>;
        scheduleAt: string | null;
        hashtags: string[];
        link: string;
      }>;
      if (!d.content?.trim() && !(d.selected?.length)) return;
      if (d.content) this.content.set(d.content);
      if (Array.isArray(d.selected)) this.selected.set(d.selected);
      if (d.perPlatform) this.perPlatform.set(d.perPlatform);
      if (d.scheduleAt) this.scheduleAt.set(d.scheduleAt);
      if (Array.isArray(d.hashtags)) this.hashtags.set(d.hashtags);
      if (d.link) this.link.set(d.link);
      this.draftRestored.set(true);
    } catch {
      /* corrupt draft — ignore */
    }
  }

  /** Dismiss the "draft restored" hint + clear the saved draft. */
  dismissDraftHint(): void {
    this.draftRestored.set(false);
  }

  /* ── S27 — post templates (localStorage) ── */

  /** Read saved templates from localStorage (SSR/private-mode safe). */
  private loadTemplates(): { id: string; name: string; content: string }[] {
    try {
      const raw = localStorage.getItem(this.TEMPLATES_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw) as unknown;
      if (!Array.isArray(arr)) return [];
      return arr
        .filter(
          (t): t is { id: string; name: string; content: string } =>
            !!t && typeof t === 'object' && typeof (t as { content?: unknown }).content === 'string',
        )
        .slice(0, 30);
    } catch {
      return [];
    }
  }

  private persistTemplates(list: { id: string; name: string; content: string }[]): void {
    try {
      localStorage.setItem(this.TEMPLATES_KEY, JSON.stringify(list));
    } catch {
      /* quota / private mode — best-effort */
    }
  }

  /** Save the current composer content as a reusable template (auto-named). */
  saveTemplate(): void {
    const content = this.content().trim();
    if (!content) return;
    const name = content.length > 30 ? content.slice(0, 30).trimEnd() + '…' : content;
    const next = [
      { id: crypto.randomUUID(), name, content },
      ...this.templates().filter((t) => t.content !== content),
    ].slice(0, 30);
    this.templates.set(next);
    this.persistTemplates(next);
    this.toast.success('Template saved');
  }

  /** Insert a saved template into the composer (replaces empty / appends otherwise). */
  useTemplate(t: { content: string }): void {
    const cur = this.content();
    this.content.set(cur.trim() ? `${cur.replace(/\s+$/, '')}\n\n${t.content}` : t.content);
  }

  /**
   * Delete a saved template. Destructive + no undo, so confirm first via the
   * file's action-armed toast pattern (matches deletePost / disconnect) — a bare
   * one-click `×` was too easy to fire by accident.
   */
  deleteTemplate(id: string): void {
    const name = this.templates().find((t) => t.id === id)?.name ?? 'this template';
    this.toast.warning(`Delete template “${name}”? This can’t be undone.`, {
      action: { label: 'Delete', run: () => this.performDeleteTemplate(id) },
      duration: 7000,
    });
  }

  private performDeleteTemplate(id: string): void {
    const next = this.templates().filter((t) => t.id !== id);
    this.templates.set(next);
    this.persistTemplates(next);
    this.toast.success('Template deleted.');
  }

  /* ── S26 — bulk Draft/Queue actions (selection persisted to localStorage) ── */

  private readonly BULK_KEY = 'ps_social_bulk_sel_v1';
  readonly bulkSelected = signal<Set<string>>(this.loadBulkSel());

  private loadBulkSel(): Set<string> {
    try {
      const raw = localStorage.getItem(this.BULK_KEY);
      const arr = raw ? (JSON.parse(raw) as unknown) : [];
      return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []);
    } catch {
      return new Set();
    }
  }

  private persistBulkSel(set: Set<string>): void {
    try {
      if (set.size === 0) localStorage.removeItem(this.BULK_KEY);
      else localStorage.setItem(this.BULK_KEY, JSON.stringify([...set]));
    } catch {
      /* best-effort */
    }
  }

  isBulkSelected(id: string): boolean {
    return this.bulkSelected().has(id);
  }

  /** Toggle a post in the bulk-selection set. */
  toggleBulk(id: string): void {
    const next = new Set(this.bulkSelected());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.bulkSelected.set(next);
    this.persistBulkSel(next);
  }

  /** Clear the whole bulk selection. */
  clearBulk(): void {
    this.bulkSelected.set(new Set());
    this.persistBulkSel(new Set());
  }

  /** Delete every selected post (one confirm for the batch). */
  bulkDelete(): void {
    const ids = this.bulkSelected();
    if (ids.size === 0) return;
    const n = ids.size;
    this.toast.warning(`Delete ${n} selected post${n === 1 ? '' : 's'}? This can’t be undone.`, {
      action: {
        label: `Delete ${n}`,
        run: () => {
          for (const post of this.filteredPosts()) {
            if (ids.has(post.id)) this.performDeletePost(post);
          }
          this.clearBulk();
        },
      },
      duration: 7000,
    });
  }

  /* ── S31 — platform cost advisory (X pay-per-use) ── */

  private readonly X_NOTICE_KEY = 'ps_social_x_cost_dismissed_v1';
  private readonly xNoticeDismissed = signal<boolean>(this.loadXDismissed());

  private loadXDismissed(): boolean {
    try {
      return localStorage.getItem(this.X_NOTICE_KEY) === '1';
    } catch {
      return false;
    }
  }

  /** Advisory shown when X/Twitter is a selected target — its API is pay-per-use
   *  since 2026 (link posts are far pricier). `null` when not applicable. */
  readonly xCostNotice = computed<string | null>(() => {
    if (this.xNoticeDismissed() || !this.selected().includes('twitter')) return null;
    return this.link().trim().length > 0
      ? 'Heads up: X charges ~$0.20 for a post containing a link (2026 API pricing) — far more than a plain post (~$0.015).'
      : 'Heads up: X (Twitter) posting is pay-per-use (~$0.015/post; ~$0.20 if it contains a link) under 2026 API pricing.';
  });

  /** Permanently dismiss the X pricing advisory (persisted to localStorage). */
  dismissXNotice(): void {
    this.xNoticeDismissed.set(true);
    try {
      localStorage.setItem(this.X_NOTICE_KEY, '1');
    } catch {
      /* best-effort */
    }
  }

  /* ── S15 — live per-platform preview ── */

  /** One preview card per selected platform: the effective copy (per-platform
   *  override or shared content, plus hashtags) rendered as it will post, with
   *  the body char count vs the platform limit (matching the chip counter). */
  readonly previewCards = computed(() => {
    const tags = this.hashtags();
    const tagStr = tags.length ? '\n\n' + tags.map((t) => '#' + t).join(' ') : '';
    return this.selected().map((pid) => {
      const def = this.defOf(pid);
      const body = (this.perPlatform()[pid] ?? this.content()).trim();
      return {
        id: pid,
        label: def?.label ?? pid,
        color: def?.color ?? '#888888',
        glyph: def?.glyph ?? '',
        text: body ? body + tagStr : tagStr.trim(),
        chars: this.charsFor(pid),
        limit: def?.charLimit ?? 0,
        over: !!def && this.charsFor(pid) > def.charLimit,
      };
    });
  });

  readonly platforms = PLATFORMS;

  /* ── Signals ── */
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly tab = signal<Tab>('compose');
  readonly accounts = signal<SocialAccount[]>([]);
  /** Set when the accounts load fails so connected platforms don't silently look "Not connected". */
  readonly accountsError = signal<boolean>(false);
  readonly posts = signal<SocialPost[]>([]);
  readonly analyticsCache = signal<Record<string, AnalyticsRow[]>>({});

  /* Composer state */
  readonly content = signal('');
  readonly selected = signal<PlatformId[]>([]);
  readonly perPlatform = signal<Partial<Record<PlatformId, string>>>({});
  /** S44 — composer autosave: in-progress draft persists to localStorage so a
   *  reload / accidental nav never loses a half-written post. */
  private readonly DRAFT_KEY = 'ps_social_draft_v1';
  readonly draftRestored = signal(false);
  /** S27 — localStorage-backed reusable post templates / snippets. */
  private readonly TEMPLATES_KEY = 'ps_social_templates_v1';
  readonly templates = signal<{ id: string; name: string; content: string }[]>(this.loadTemplates());
  /**
   * Tightest char limit among selected platforms that use the MAIN composer copy
   * (a platform with its own override counts against that override, via the
   * override's own counter — not here). Drives the live composer counter so a
   * long post shows its strictest budget at the cursor. `null` when nothing is
   * selected, or every selected platform has an override → no main-copy counter.
   */
  readonly composerLimit = computed<{ limit: number; platform: string } | null>(() => {
    let min = Infinity;
    let platform = '';
    for (const pid of this.selected()) {
      if (this.hasOverride(pid)) continue;
      const def = this.defOf(pid);
      if (def && def.charLimit < min) {
        min = def.charLimit;
        platform = def.label;
      }
    }
    return min === Infinity ? null : { limit: min, platform };
  });
  /** Composer copy length vs the tightest main-copy limit → ok | near (≥90%) | over. */
  readonly composerCharState = computed<'ok' | 'near' | 'over'>(() => {
    const cl = this.composerLimit();
    if (!cl) return 'ok';
    const n = this.content().length;
    if (n > cl.limit) return 'over';
    if (n >= cl.limit * 0.9) return 'near';
    return 'ok';
  });
  /** Full class string for the composer counter (Tailwind only — social is over
   *  its SCSS budget, so no new component CSS). Cyan-muted → amber → red. */
  readonly composerCtClass = computed(() => {
    const base = 'text-[0.72rem] tabular-nums transition-colors';
    switch (this.composerCharState()) {
      case 'over':
        return `${base} text-red-400 font-semibold`;
      case 'near':
        return `${base} text-amber-400`;
      default:
        return `${base} text-white/55`;
    }
  });
  readonly media = signal<MediaItem[]>([]);
  readonly hashtags = signal<string[]>([]);
  readonly link = signal('');
  readonly og = signal<OgData | null>(null);
  /** Hostname of the entered link (for the fallback card when OG data is absent). */
  readonly linkHost = computed(() => {
    const u = this.link().trim();
    if (!u) return '';
    try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; }
  });
  readonly scheduleAt = signal<string | null>(null);
  readonly scheduleTz = signal('America/Los_Angeles');
  readonly bestTimes = signal<string[]>([]);
  readonly editingId = signal<string | null>(null);
  /** Per-post in-flight publish lock — blocks a double-click from publishing twice
   *  to the user's real social accounts (no undo on a duplicate post). */
  readonly publishingIds = signal<Set<string>>(new Set());
  isPublishing(id: string): boolean {
    return this.publishingIds().has(id);
  }
  /** Post ids with an in-flight delete — guards the toast-armed destructive
   *  delete against a double-DELETE + drives the row's "Deleting…" state. */
  readonly deletingPostIds = signal<Set<string>>(new Set());
  isDeletingPost(id: string): boolean {
    return this.deletingPostIds().has(id);
  }
  /** Platform ids with an in-flight account disconnect — guards the toast-armed
   *  action against a double-DELETE + drives the row's "Disconnecting…" state
   *  (passed to <app-social-accounts> which renders the per-row busy state). */
  readonly disconnectingPids = signal<Set<string>>(new Set());

  /* Auto-Pilot */
  readonly autoPilotEnabled = signal(false);
  readonly autoPilotPrompt = signal('');
  readonly autoPilotCadenceHours = signal(24);
  readonly autoPilotTargetNetworks = signal<PlatformId[]>([]);
  readonly autoPilotDefaultPrompt = signal('');
  readonly autoPilotSaving = signal(false);
  readonly autoPilotDialogOpen = signal(false);

  /* Hashtag draft */
  hashtagDraft = '';

  /* AI assist */
  readonly aiLoading = signal(false);
  readonly aiVariants = signal<string[]>([]);
  readonly variantIdx = signal(0);
  aiTone: 'punchy' | 'warm' | 'authoritative' | 'playful' | 'story' = 'punchy';

  /* Mention picker */
  readonly mentionOpen = signal(false);
  readonly mentionResults = signal<{ handle: string; name?: string }[]>([]);
  readonly mentionIdx = signal(0);
  private mentionAnchor = -1;

  /* Drag/drop */
  readonly dragOver = signal(false);

  /* RSS */
  rssUrl = '';
  readonly rssItems = signal<{ title: string; url: string }[]>([]);
  readonly importingRss = signal(false);


  @ViewChild('mainTa') private taRef?: ElementRef<HTMLTextAreaElement>;
  @ViewChild('fileInput') private fileInputRef?: ElementRef<HTMLInputElement>;

  /* ── Computed ── */
  readonly connectedCount = computed(() => this.accounts().filter((a) => a.connected).length);
  readonly draftsCount = computed(() => this.posts().filter((p) => p.status === 'draft').length);
  readonly scheduledCount = computed(() => this.posts().filter((p) => p.status === 'scheduled').length);
  readonly publishedCount = computed(
    () => this.posts().filter((p) => ['published', 'partial', 'failed'].includes(p.status)).length
  );
  readonly filteredPosts = computed(() => {
    const t = this.tab();
    const all = this.posts();
    if (t === 'drafts') return all.filter((p) => p.status === 'draft');
    if (t === 'queue') return all.filter((p) => p.status === 'scheduled').sort((a, b) => (a.scheduled_at || '').localeCompare(b.scheduled_at || ''));
    if (t === 'sent') return all.filter((p) => ['published', 'partial', 'failed'].includes(p.status));
    return [];
  });

  /* ── Lifecycle ── */
  ngOnInit(): void {
    // S44 — restore an autosaved composer draft (no-op if the composer isn't empty).
    this.restoreDraft();
    // Deep links: `?tab=compose|drafts|queue|sent|calendar` selects the tab so
    // every tab is a bookmarkable/shareable URL; `?action=new` focuses the
    // composer. Guard against the navigate-loop — only apply when the param
    // differs from the current tab (selectTab sets the signal BEFORE writing
    // the URL, so the echo-back fires here as a no-op).
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((q) => {
      const t = q.get('tab');
      if (t && SOCIAL_TABS.includes(t as Tab) && t !== this.tab()) {
        this.applyTab(t as Tab);
      }
      if (q.get('action') === 'new') {
        this.applyTab('compose');
        queueMicrotask(() => this.taRef?.nativeElement?.focus());
      }
    });
    // Site-scoped loads (accounts + posts) are owned by the constructor effect
    // so a deep-link populates them when selectedSite() resolves. Auto-pilot
    // config is org-level (no site param) — load it once on mount.
    this.loadAutoPilotConfig();
  }

  /* ── Listener: cross-window OAuth callback ── */
  @HostListener('window:message', ['$event'])
  onWindowMessage(ev: MessageEvent): void {
    const data = ev.data as { type?: string; platform?: PlatformId; handle?: string };
    if (data?.type === 'social-oauth-success' && data.platform) {
      this.toast.success(`Connected ${this.defOf(data.platform)?.label}`);
      this.loadAccounts();
    }
    if (data?.type === 'social-oauth-error') {
      this.toast.error('Connection failed — try again.');
    }
  }

  /* ── Account methods ── */
  private siteId(): string | null {
    return this.state.selectedSite()?.id ?? null;
  }
  accountFor(pid: PlatformId): SocialAccount | undefined {
    return this.accounts().find((a) => a.platform === pid);
  }
  isConnected(pid: PlatformId): boolean {
    return !!this.accountFor(pid)?.connected;
  }
  defOf(pid: PlatformId | undefined): PlatformDef | undefined {
    return this.platforms.find((p) => p.id === pid);
  }

  /** Public retry for the inline accounts-load-error banner. */
  retryAccounts(): void { this.loadAccounts(); }

  private loadAccounts(): void {
    const sid = this.siteId();
    if (!sid) return;
    this.accountsError.set(false);
    // {silent} so the inline banner is the only signal (not a generic toast on
    // top) when connection states can't load.
    this.api.get<{ data: SocialAccount[] }>(`/social/accounts`, { site_id: sid }, { silent: true }).subscribe({
      next: (r) => { this.accounts.set(r.data ?? []); this.accountsError.set(false); },
      error: () => {
        // Keep the platforms list visible, but flag that the "Not connected"
        // badges may be stale so the operator doesn't reconnect a duplicate.
        this.accounts.set(this.platforms.map((p) => ({ platform: p.id, connected: false })));
        this.accountsError.set(true);
      },
    });
  }

  connect(pid: PlatformId): void {
    const sid = this.siteId();
    if (!sid) { this.toast.error('Pick a site first'); return; }
    // Paste-key platforms (no OAuth dance) — the worker's GET /connect returns a
    // paste_key spec (JSON), so opening a popup at it just shows raw JSON. Open
    // the paste-key form instead. OAuth platforms keep the popup flow below.
    if (this.defOf(pid)?.pasteKey) { this.openPaste(pid); return; }
    // The connect endpoint is bearer-auth-gated, so a `window.open` browser
    // navigation can't authenticate (that was the "auth required" 401 on X /
    // Twitter). Fetch it WITH the bearer (ApiService) to get the authorize URL,
    // THEN open the popup at the provider's authorize page.
    this.api
      .get<{ data?: { authorize_url?: string } }>(`/social/${pid}/connect`, { site_id: sid }, { silent: true })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
      next: (res: { data?: { authorize_url?: string } }) => {
        const authUrl = res?.data?.authorize_url;
        if (!authUrl) { this.toast.error(`Couldn't start ${this.defOf(pid)?.label} sign-in — try again.`); return; }
        const popup = window.open(authUrl, 'social-oauth', 'width=620,height=720,popup=yes');
        if (!popup) { this.toast.error('Popup blocked — allow popups and try again'); return; }
        // Popup-closed poll, leak-proofed: stops on popup close, on component
        // destroy (route nav mid-flow), or after a 10-min abandonment cap.
        // Previously every Connect click left a 600ms interval running forever
        // when the popup was abandoned — accumulating across attempts.
        let capTimer = 0;
        const stopPoll = (): void => { window.clearInterval(poll); window.clearTimeout(capTimer); };
        const poll = window.setInterval(() => {
          if (popup.closed) { stopPoll(); this.loadAccounts(); }
        }, 600);
        capTimer = window.setTimeout(stopPoll, 600_000);
        this.destroyRef.onDestroy(stopPoll);
      },
      error: (err: { status?: number; error?: { error?: { code?: string; message?: string; deeplink?: string } } }) => {
        const e = err?.error?.error;
        if (err?.status === 501 || e?.code === 'APP_CREDS_MISSING') {
          this.toast.error(e?.message ?? `${this.defOf(pid)?.label} sign-in isn't configured yet.`);
        } else {
          this.toast.error(e?.message ?? `Couldn't start ${this.defOf(pid)?.label} sign-in — try again.`);
        }
      },
    });
  }

  // ── Paste-key connect (Bluesky / Mastodon / Telegram / Discord) ──────────
  readonly pasteOpen = signal<PlatformId | null>(null);
  openPaste(pid: PlatformId): void {
    this.pasteOpen.set(pid);
  }

  /** The paste dialog connected — reload the accounts list. */
  onPasteConnected(): void {
    this.closePaste();
    this.loadAccounts();
  }
  closePaste(): void { this.pasteOpen.set(null); }

  disconnect(pid: PlatformId): void {
    const sid = this.siteId();
    if (!sid) return;
    // The worker disconnects by account UUID (DELETE /social/accounts/:id), not
    // by platform — resolve the connected account for this platform first.
    const acct = this.accounts().find((a) => a.platform === pid && a.connected);
    if (!acct?.id) {
      this.toast.error(`No connected ${this.defOf(pid)?.label} account to disconnect.`);
      return;
    }
    // Destructive — re-OAuth required to restore. Confirm via the action-armed toast.
    this.toast.warning(`Disconnect ${this.defOf(pid)?.label}? You’ll need to reconnect via OAuth to use it again.`, {
      action: { label: 'Disconnect', run: () => this.performDisconnect(pid, acct.id as string) },
      duration: 7000,
    });
  }
  private performDisconnect(pid: PlatformId, acctId: string): void {
    if (this.disconnectingPids().has(pid)) return; // re-armed toast action while in flight = no-op
    this.disconnectingPids.update((s) => new Set(s).add(pid));
    const done = () => this.disconnectingPids.update((s) => { const n = new Set(s); n.delete(pid); return n; });
    this.api.delete(`/social/accounts/${acctId}`, { silent: true }).subscribe({
      next: () => {
        done();
        this.toast.success(`Disconnected ${this.defOf(pid)?.label}`);
        this.loadAccounts();
        this.selected.update((s) => s.filter((id) => id !== pid));
      },
      error: () => { done(); this.toast.error('Disconnect failed'); },
    });
  }

  /* ── Auto-Pilot ── */

  /**
   * Hydrate auto-pilot signals from the worker. Silent on failure — the
   * controls render in their "off" default state, which is the safest UX
   * for a setting the user can always re-toggle.
   */
  private loadAutoPilotConfig(): void {
    this.api.get<{ data: {
      enabled: boolean;
      prompt: string;
      cadence_hours: number;
      target_networks: PlatformId[];
      default_prompt: string;
    } }>('/social/auto-pilot/config').subscribe({
      next: (r) => {
        const d = r?.data;
        if (!d) return;
        this.autoPilotEnabled.set(!!d.enabled);
        this.autoPilotPrompt.set(d.prompt ?? '');
        this.autoPilotCadenceHours.set(d.cadence_hours ?? 24);
        this.autoPilotTargetNetworks.set(d.target_networks ?? []);
        this.autoPilotDefaultPrompt.set(d.default_prompt ?? '');
      },
      error: () => {
        // Backend may not have shipped yet — defaults keep the toggle usable
      },
    });
  }

  /** Persist toggle change immediately (header checkbox UX). */
  setAutoPilot(enabled: boolean): void {
    this.autoPilotSaving.set(true);
    const previous = this.autoPilotEnabled();
    this.autoPilotEnabled.set(enabled);
    this.api
      .post<{ data: { enabled: boolean; cadence_hours: number; target_networks: PlatformId[] } }>(
        '/social/auto-pilot/config',
        { enabled },
      )
      .subscribe({
        next: (r) => {
          if (r?.data) {
            this.autoPilotEnabled.set(!!r.data.enabled);
            this.autoPilotCadenceHours.set(r.data.cadence_hours);
            this.autoPilotTargetNetworks.set(r.data.target_networks);
          }
          this.autoPilotSaving.set(false);
          this.toast.success(enabled ? 'Auto-Pilot on — drafts will appear in the Drafts tab.' : 'Auto-Pilot off.');
        },
        error: () => {
          this.autoPilotEnabled.set(previous);
          this.autoPilotSaving.set(false);
          this.toast.error('Auto-Pilot toggle failed');
        },
      });
  }

  /** Open the prompt-editor dialog (the child seeds its drafts from the inputs). */
  openAutoPilotPrompt(): void {
    this.autoPilotDialogOpen.set(true);
  }

  closeAutoPilotDialog(): void {
    this.autoPilotDialogOpen.set(false);
  }

  /** The dialog saved — apply the server-returned config to the live signals. */
  applyAutoPilotSaved(d: { prompt: string; cadence_hours: number; target_networks: string[] }): void {
    this.autoPilotPrompt.set(d.prompt);
    this.autoPilotCadenceHours.set(d.cadence_hours);
    this.autoPilotTargetNetworks.set(d.target_networks as PlatformId[]);
    this.autoPilotDialogOpen.set(false);
    this.toast.success('Auto-Pilot prompt saved.');
  }

  /* ── Composer state ── */
  isPlatformSelected(pid: PlatformId): boolean {
    return this.selected().includes(pid);
  }
  hasOverride(pid: PlatformId): boolean {
    return Object.prototype.hasOwnProperty.call(this.perPlatform(), pid);
  }
  togglePlatform(pid: PlatformId): void {
    if (!this.isConnected(pid)) return;
    if (this.isPlatformSelected(pid)) {
      // 2nd click → toggle override
      if (this.hasOverride(pid)) {
        this.removeOverride(pid);
      } else {
        this.setOverride(pid, this.content());
      }
    } else {
      this.selected.update((s) => [...s, pid]);
      this.refreshBestTimes();
    }
  }
  removePlatform(pid: PlatformId): void {
    this.selected.update((s) => s.filter((id) => id !== pid));
    this.removeOverride(pid);
    this.refreshBestTimes();
  }
  setOverride(pid: PlatformId, text: string): void {
    this.perPlatform.update((m) => ({ ...m, [pid]: text }));
  }
  removeOverride(pid: PlatformId): void {
    this.perPlatform.update((m) => {
      const { [pid]: _drop, ...rest } = m;
      return rest;
    });
  }
  charsFor(pid: PlatformId): number {
    return (this.perPlatform()[pid] ?? this.content()).length;
  }

  /** Counter colour state for a platform char count: ok | near (≥90%) | over —
   *  matches the main composer counter + the shared <app-char-count> so every
   *  social counter warns amber BEFORE the hard red over-limit, not at it. */
  ctState(len: number, limit: number): 'ok' | 'near' | 'over' {
    if (len > limit) return 'over';
    if (len >= limit * 0.9) return 'near';
    return 'ok';
  }

  onContentChange(v: string): void {
    this.content.set(v);
    this.checkMentionTrigger();
  }
  onContentKeydown(ev: KeyboardEvent): void {
    if (this.mentionOpen()) {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); this.mentionIdx.update((i) => Math.min(this.mentionResults().length - 1, i + 1)); }
      if (ev.key === 'ArrowUp')   { ev.preventDefault(); this.mentionIdx.update((i) => Math.max(0, i - 1)); }
      if (ev.key === 'Escape')    { this.mentionOpen.set(false); }
      if (ev.key === 'Enter' && this.mentionResults().length > 0) {
        ev.preventDefault();
        this.insertMention(this.mentionResults()[this.mentionIdx()], ev);
      }
    }
    // Cmd+Enter = publish
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter' && this.canPublish()) {
      ev.preventDefault();
      this.publish();
    }
  }

  private checkMentionTrigger(): void {
    const ta = this.taRef?.nativeElement;
    if (!ta) return;
    const caret = ta.selectionStart ?? 0;
    const slice = this.content().slice(0, caret);
    const m = slice.match(/@([\w]{0,20})$/);
    if (!m) { this.mentionOpen.set(false); return; }
    this.mentionAnchor = caret - m[0].length;
    const q = m[1];
    const sel = this.selected()[0];
    if (!sel) return;
    this.api
      .get<{ items: { handle: string; name?: string }[] }>(`/social/mentions`, { platform: sel, q })
      .subscribe({
        next: (r) => {
          this.mentionResults.set(r.items ?? []);
          this.mentionIdx.set(0);
          this.mentionOpen.set((r.items ?? []).length > 0);
        },
        error: () => this.mentionOpen.set(false),
      });
  }

  insertMention(m: { handle: string }, ev: Event): void {
    ev.preventDefault();
    const ta = this.taRef?.nativeElement;
    if (!ta) return;
    const before = this.content().slice(0, this.mentionAnchor);
    const after = this.content().slice(ta.selectionStart ?? this.mentionAnchor);
    const next = `${before}@${m.handle} ${after}`;
    this.content.set(next);
    this.mentionOpen.set(false);
    queueMicrotask(() => {
      ta.focus();
      const pos = before.length + m.handle.length + 2;
      ta.setSelectionRange(pos, pos);
    });
  }

  /* ── Hashtags ── */
  onHashtagKeydown(ev: KeyboardEvent): void {
    if (ev.key === ' ' || ev.key === ',' || ev.key === 'Enter') {
      ev.preventDefault();
      this.commitHashtag();
    } else if (ev.key === 'Backspace' && !this.hashtagDraft && this.hashtags().length > 0) {
      this.hashtags.update((t) => t.slice(0, -1));
    }
  }
  private commitHashtag(): void {
    const raw = this.hashtagDraft.trim().replace(/^#/, '');
    if (!raw) return;
    if (this.hashtags().length >= 30) {
      this.toast.warning('Max 30 hashtags');
      return;
    }
    if (!this.hashtags().includes(raw)) {
      this.hashtags.update((t) => [...t, raw]);
    }
    this.hashtagDraft = '';
  }
  removeHashtag(i: number): void {
    this.hashtags.update((t) => t.filter((_, ix) => ix !== i));
  }

  /* ── Media ── */
  onDragOver(ev: DragEvent): void { ev.preventDefault(); this.dragOver.set(true); }
  onDrop(ev: DragEvent): void {
    ev.preventDefault();
    this.dragOver.set(false);
    const files = Array.from(ev.dataTransfer?.files ?? []);
    if (files.length) this.uploadFiles(files);
  }
  onFiles(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    if (files.length) this.uploadFiles(files);
    input.value = '';
  }
  private uploadFiles(files: File[]): void {
    for (const f of files) {
      const fd = new FormData();
      fd.append('file', f);
      const sid = this.siteId();
      if (sid) fd.append('site_id', sid);
      this.api.postFormData<{ media: MediaItem }>('/social/media', fd).subscribe({
        next: (r: { media: MediaItem }) => {
          this.media.update((m) => [...m, r.media]);
        },
        error: () => {
          // Optimistic local preview fallback when backend not yet wired
          const url = URL.createObjectURL(f);
          this.media.update((m) => [
            ...m,
            {
              id: `local-${Date.now()}-${Math.random()}`,
              url,
              thumb_url: url,
              alt: '',
              bytes: f.size,
              type: f.type.startsWith('video/') ? 'video' : 'image',
            },
          ]);
          console.warn('[social] media upload backend missing, local preview only');
        },
      });
    }
  }
  updateAlt(id: string, alt: string): void {
    this.media.update((m) => m.map((x) => (x.id === id ? { ...x, alt } : x)));
  }
  removeMedia(id: string): void {
    this.media.update((m) => m.filter((x) => x.id !== id));
  }

  /* ── OG fetch ── */
  fetchOg(): void {
    const u = this.link().trim();
    if (!u) { this.og.set(null); return; }
    this.api.post<{ og: OgData }>('/social/og-preview', { url: u }, { silent: true }).subscribe({
      next: (r) => {
        // A stale route can return a parseable-but-shapeless 200 → `r.og` is
        // undefined or a `{}` with no usable fields. Either collapses to null so
        // the composer shows the branded hostname fallback card, never a blank
        // OG card (and never leaks `undefined` into the OgData|null signal).
        const og = r?.og;
        const usable =
          og && typeof og === 'object' && !!(og.title || og.description || og.image || og.site_name);
        this.og.set(usable ? og : null);
      },
      error: () => this.og.set(null),
    });
  }

  /* ── AI assist ── */
  generate(): void {
    if (this.selected().length === 0) {
      this.toast.warning('Select at least one platform first');
      return;
    }
    const sid = this.siteId();
    if (!sid) {
      this.toast.warning('Select a site first');
      return;
    }
    this.aiLoading.set(true);
    // The worker route is POST /api/social/:siteId/posts/generate — it returns
    // per-platform drafts { data: { variants: [{platform, text}] } } behind the
    // social_publishing_native flag (503 when off). Earlier this called a
    // nonexistent /api/social/generate → 404 → the AI-assist button always failed.
    this.api
      .post<{ data?: { variants?: { platform: string; text: string }[] } }>(`/social/${sid}/posts/generate`, {
        topic: this.content() || 'a tasteful update from our team',
        platforms: this.selected(),
        tone: this.aiTone,
      })
      .subscribe({
        next: (r) => {
          this.aiLoading.set(false);
          // Map the per-platform drafts into the variant carousel (pick the one
          // you like to seed the composer). An empty set (flag off / all failed /
          // shapeless 200) is a failure, not a silent dead-end.
          const drafts = (r?.data?.variants ?? [])
            .map((v) => v?.text)
            .filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
          if (drafts.length === 0) {
            this.toast.error('AI assist unavailable right now');
            return;
          }
          this.aiVariants.set(drafts);
          this.variantIdx.set(0);
        },
        error: () => {
          this.aiLoading.set(false);
          this.toast.error('AI assist unavailable right now');
        },
      });
  }
  prevVariant(): void { this.variantIdx.update((i) => Math.max(0, i - 1)); }
  nextVariant(): void { this.variantIdx.update((i) => Math.min(this.aiVariants().length - 1, i + 1)); }
  useVariant(): void {
    const v = this.aiVariants()[this.variantIdx()];
    if (v) this.content.set(v);
  }

  /* ── Scheduling ── */
  openScheduler(): void {
    if (!this.scheduleAt()) {
      const d = new Date();
      d.setHours(d.getHours() + 1, 0, 0, 0);
      this.scheduleAt.set(toDatetimeLocal(d));
    }
  }
  private refreshBestTimes(): void {
    const plats = this.selected();
    if (plats.length === 0) { this.bestTimes.set([]); return; }
    this.api
      .get<{ times: string[] }>('/social/best-times', { platforms: plats.join(',') })
      .subscribe({
        next: (r) => this.bestTimes.set(r.times ?? []),
        error: () => this.bestTimes.set([]),
      });
  }
  applyBestTime(label: string): void {
    // label like "Tue 9am" — pick the next matching slot
    const m = label.match(/^(\w{3})\s+(\d{1,2})(am|pm)/i);
    if (!m) return;
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(m[1]);
    const hour = (parseInt(m[2], 10) % 12) + (m[3].toLowerCase() === 'pm' ? 12 : 0);
    const next = new Date();
    while (next.getDay() !== wd || next < new Date()) next.setDate(next.getDate() + 1);
    next.setHours(hour, 0, 0, 0);
    this.scheduleAt.set(toDatetimeLocal(next));
  }

  /* ── Status line helpers ── */
  mediaSummary(): string {
    const items = this.media();
    if (items.length === 0) return 'no media';
    const kb = Math.round(items.reduce((s, m) => s + (m.bytes || 0), 0) / 1024);
    return `${items.length} media · ${kb} KB`;
  }
  scheduleSummary(): string {
    const at = this.scheduleAt();
    if (!at) return 'posting now';
    try {
      return `scheduled for ${new Date(at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })} ${this.scheduleTz()}`;
    } catch { return 'scheduled'; }
  }
  /** True when a schedule time is set but already in the past — you can't
   *  schedule backwards. The native [min] only guards the picker, so a typed
   *  past value is blocked here (and surfaced via publishBlockReason). */
  scheduledInPast(): boolean {
    const at = this.scheduleAt();
    if (!at) return false;
    const t = new Date(at).getTime();
    return Number.isFinite(t) && t <= Date.now();
  }

  /** Lower bound for the schedule picker — now, in the input's local format. */
  get minSchedule(): string {
    return toDatetimeLocal(new Date());
  }

  canPublish(): boolean {
    if (!this.content().trim() && this.media().length === 0) return false;
    if (this.selected().length === 0) return false;
    if (this.scheduledInPast()) return false;
    // Char-limit enforcement per selected platform
    for (const pid of this.selected()) {
      const def = this.defOf(pid);
      if (def && this.charsFor(pid) > def.charLimit) return false;
    }
    return true;
  }

  /**
   * Human reason the Publish button is disabled, or `null` when ready. Surfaced
   * inline so a greyed-out Publish is explained — not a silent dead-end. Mirrors
   * the billing custom-amount + domains add-domain validation hints. Order is
   * UX-prioritised: pick a platform → add content → fix an over-limit platform.
   */
  publishBlockReason(): string | null {
    if (this.selected().length === 0) return 'Select at least one platform to publish.';
    if (!this.content().trim() && this.media().length === 0) return 'Write a message or attach media first.';
    for (const pid of this.selected()) {
      const def = this.defOf(pid);
      if (def && this.charsFor(pid) > def.charLimit) {
        return `${def.label} is ${this.charsFor(pid) - def.charLimit} character${this.charsFor(pid) - def.charLimit === 1 ? '' : 's'} over its ${def.charLimit.toLocaleString()} limit.`;
      }
    }
    if (this.scheduledInPast()) return 'Scheduled time is in the past — pick a future time or switch to Post now.';
    return null;
  }

  /* ── Tabs (deep-linked) ── */
  /** User clicked a tab: apply it + reflect it in the URL (`?tab=…`) so the
   *  tab is shareable/bookmarkable. `replaceUrl` keeps tab-flipping out of the
   *  back-history stack while still updating the address bar. */
  selectTab(t: Tab): void {
    if (t !== this.tab()) this.applyTab(t);
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab: t },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  /** Set the active tab + run its data side-effect. Pure state — no URL write,
   *  so it's safe to call from the `?tab=` deep-link handler without looping. */
  private applyTab(t: Tab): void {
    this.tab.set(t);
    // Per-tab lists + count badges all derive from the full `posts()` set client-side
    // (`filteredPosts`), loaded once when the site resolves — so no per-tab reload is
    // needed. (Reloading with a status filter zeroed the other tabs' count badges.)
  }

  /* ── Posts ── */
  loadPosts(): void {
    const sid = this.siteId();
    if (!sid) return;
    this.loading.set(true);
    // Always load the FULL set (no status filter): the tab COUNT badges + `filteredPosts`
    // both derive from `posts()` and filter client-side by tab. A server-side status
    // filter would leave `posts()` holding only the active tab's rows → the other two
    // tab count badges would wrongly read 0.
    this.api.get<{ data: SocialPost[] }>('/social/posts', { site_id: sid }).subscribe({
      next: (r) => { const posts = r.data ?? []; this.posts.set(posts); this.loading.set(false); this.prefetchAnalytics(posts); },
      error: () => { this.loading.set(false); },
    });
  }

  /** Selected platforms → their connected account UUIDs (the worker keys posts by account, not platform). */
  private accountIdsForSelected(): string[] {
    const sel = new Set(this.selected());
    return this.accounts()
      .filter((a) => a.connected && !!a.id && sel.has(a.platform))
      .map((a) => a.id as string);
  }

  /** Build the worker `CreatePostSchema` payload (also valid for PATCH = .partial()). */
  private buildCreatePayload(): Record<string, unknown> {
    const overrides: Record<string, { content: string }> = {};
    for (const [plat, txt] of Object.entries(this.perPlatform())) {
      if (txt && txt.trim()) overrides[plat] = { content: txt };
    }
    const ids = this.accountIdsForSelected();
    const payload: Record<string, unknown> = {
      site_id: this.siteId()!,
      content: this.content(),
    };
    if (ids.length) payload['account_ids'] = ids;
    if (Object.keys(overrides).length) payload['per_platform_overrides'] = overrides;
    if (this.hashtags().length) payload['hashtags'] = this.hashtags();
    if (this.link()) payload['link'] = this.link();
    if (this.scheduleAt()) payload['schedule_at'] = this.scheduleAt();
    return payload;
  }

  saveDraft(): void {
    if (!this.siteId()) { this.toast.error('Pick a site first'); return; }
    const id = this.editingId();
    const payload = this.buildCreatePayload();
    // POST (new) requires ≥1 account; PATCH (edit) may omit.
    if (!id && !(payload['account_ids'] as string[] | undefined)?.length) {
      this.toast.error('Connect an account for the selected platform(s) first.');
      return;
    }
    this.saving.set(true);
    const req = id
      ? this.api.patch<{ data: { id: string } }>(`/social/posts/${id}`, payload, { silent: true })
      : this.api.post<{ data: { id: string } }>('/social/posts', payload, { silent: true });
    req.subscribe({
      next: () => { this.saving.set(false); this.toast.success('Draft saved'); this.resetComposer(); this.loadPosts(); },
      error: () => { this.saving.set(false); this.toast.error('Save failed'); },
    });
  }

  publish(): void {
    if (!this.canPublish()) return;
    const payload = this.buildCreatePayload();
    if (!(payload['account_ids'] as string[] | undefined)?.length) {
      this.toast.error('Connect an account for the selected platform(s) first.');
      return;
    }
    const scheduled = !!this.scheduleAt();
    this.saving.set(true);
    // Create the post, then trigger it (worker create doesn't auto-send;
    // immediate posts call publish-now, scheduled posts keep their schedule_at).
    this.api.post<{ data: { id: string } }>('/social/posts', payload, { silent: true }).subscribe({
      next: (r) => {
        const id = r.data?.id;
        if (id && !scheduled) {
          this.api.post(`/social/posts/${id}/publish-now`, {}, { silent: true }).subscribe({
            next: () => { this.saving.set(false); this.toast.success(`Posting to ${this.selected().length} platform${this.selected().length === 1 ? '' : 's'}…`); this.resetComposer(); this.loadPosts(); },
            error: () => { this.saving.set(false); this.toast.error('Created the post but publishing failed — see Drafts.'); this.resetComposer(); this.loadPosts(); },
          });
        } else {
          this.saving.set(false);
          this.toast.success(scheduled ? 'Post scheduled' : 'Draft created');
          this.resetComposer();
          this.loadPosts();
        }
      },
      error: () => { this.saving.set(false); this.toast.error('Publish failed'); },
    });
  }

  publishNow(post: SocialPost): void {
    if (this.publishingIds().has(post.id)) return; // guard double-submit → no duplicate publish
    this.publishingIds.update((s) => new Set(s).add(post.id));
    const release = () =>
      this.publishingIds.update((s) => {
        const n = new Set(s);
        n.delete(post.id);
        return n;
      });
    this.api.post(`/social/posts/${post.id}/publish-now`, {}, { silent: true }).subscribe({
      next: () => { release(); this.toast.success('Publishing…'); this.loadPosts(); },
      error: () => { release(); this.toast.error('Publish failed'); },
    });
  }
  /**
   * Calendar-edit entry point — the calendar child emits its structural
   * subset (id-only hand-off); we resolve the FULL post from the live list
   * before opening the composer (the child never owns the list).
   */
  editCalendarPost(id: string): void {
    const post = this.posts().find((p) => p.id === id);
    if (!post) return;
    this.editPost(post);
  }

  editPost(post: SocialPost): void {
    this.editingId.set(post.id);
    this.content.set(post.content);
    this.selected.set([...post.platforms]);
    this.perPlatform.set({ ...(post.per_platform_content ?? {}) });
    this.media.set([...post.media]);
    this.hashtags.set([...post.hashtags]);
    this.link.set(post.link ?? '');
    this.og.set(post.og ?? null);
    this.scheduleAt.set(post.scheduled_at ?? null);
    this.tab.set('compose');
  }
  deletePost(post: SocialPost): void {
    // Destructive (deletes a draft / cancels a user-scheduled queued post) with no
    // undo — confirm first via the file's action-armed toast pattern.
    this.toast.warning('Delete this post? This can’t be undone.', {
      action: { label: 'Delete', run: () => this.performDeletePost(post) },
      duration: 7000,
    });
  }
  private performDeletePost(post: SocialPost): void {
    if (this.deletingPostIds().has(post.id)) return; // re-armed toast action while in flight = no-op
    this.deletingPostIds.update((s) => new Set(s).add(post.id));
    const done = () => this.deletingPostIds.update((s) => { const n = new Set(s); n.delete(post.id); return n; });
    this.api.delete(`/social/posts/${post.id}`, { silent: true }).subscribe({
      next: () => { done(); this.toast.success('Deleted'); this.loadPosts(); },
      error: () => { done(); this.toast.error('Delete failed'); },
    });
  }
  duplicatePost(post: SocialPost): void {
    this.editingId.set(null);
    this.content.set(post.content);
    this.selected.set([...post.platforms]);
    this.media.set([...post.media]);
    this.hashtags.set([...post.hashtags]);
    this.tab.set('compose');
    this.toast.info('Duplicated as new draft');
  }
  discard(): void {
    if (!this.content().trim() && this.media().length === 0) return this.resetComposer();
    // Action-armed toast (cockpit pattern) — non-blocking, consistent with the
    // rest of admin; replaces the native confirm() z-stack/focus break.
    this.toast.warning('Discard this post? Your draft will be cleared.', {
      action: { label: 'Discard', run: () => this.resetComposer() },
      duration: 7000,
    });
  }
  private resetComposer(): void {
    this.draftRestored.set(false);
    this.editingId.set(null);
    this.content.set('');
    this.perPlatform.set({});
    this.media.set([]);
    this.hashtags.set([]);
    this.hashtagDraft = '';
    this.link.set('');
    this.og.set(null);
    this.scheduleAt.set(null);
    this.aiVariants.set([]);
    this.variantIdx.set(0);
  }

  /* ── Analytics ── */
  /** PURE reader — never fetches. Analytics are prefetched by `prefetchAnalytics` when
   *  posts load, so this template getter can't trigger a signal write mid-render (that
   *  fired NG0600 on the Sent tab the moment it had published posts to render). */
  analyticsFor(postId: string): AnalyticsRow[] {
    return this.analyticsCache()[postId] ?? [];
  }

  /** Fetch per-post analytics for published posts OUTSIDE change detection — called from
   *  `loadPosts`' async subscribe callback, never a template getter. */
  private prefetchAnalytics(posts: SocialPost[]): void {
    const cache = this.analyticsCache();
    for (const p of posts) {
      if (!['published', 'partial', 'failed'].includes(p.status) || cache[p.id]) continue;
      this.api.get<{ data: { per_platform: AnalyticsRow[] } }>(`/social/posts/${p.id}/analytics`).subscribe({
        next: (r) => this.analyticsCache.update((m) => ({ ...m, [p.id]: r.data?.per_platform ?? [] })),
        error: () => this.analyticsCache.update((m) => ({ ...m, [p.id]: [] })),
      });
    }
  }

  /* ── RSS ── */
  /**
   * The RSS feed URL is fetched server-side (SSRF-adjacent), so accept only a
   * well-formed https URL with a dotted public hostname — rejecting http://,
   * junk, and bare internal hosts before the import call.
   */
  private isValidHttpsUrl(raw: string): boolean {
    return isValidPublicHttpsUrl(raw);
  }
  /** Button gate: the typed RSS URL is a valid https feed URL. */
  rssUrlValid(): boolean {
    return this.isValidHttpsUrl(this.rssUrl.trim());
  }
  /** Inline-hint gate: a non-empty value that fails validation. */
  rssUrlInvalid(): boolean {
    const v = this.rssUrl.trim();
    return v.length > 0 && !this.isValidHttpsUrl(v);
  }
  rssPreview(): void {
    const url = this.rssUrl.trim();
    if (!this.isValidHttpsUrl(url)) {
      this.toast.error('Enter a valid https:// feed URL (e.g. https://example.com/feed.xml).');
      return;
    }
    this.api.post<{ items: { title: string; url: string }[] }>('/social/import-rss', {
      url,
      preview: true,
    }, { silent: true }).subscribe({
      next: (r) => this.rssItems.set((r.items ?? []).slice(0, 10)),
      error: () => this.toast.error('Could not parse feed'),
    });
  }
  /**
   * Copy the previewed feed items to the clipboard as `Title — URL` lines, ready
   * to paste into the composer. A real, working interim while auto-scheduling
   * (which needs the worker schedule path) is built — replaces a button that
   * previously 501'd with a misleading "RSS import failed" toast.
   */
  async copyRssLinks(): Promise<void> {
    const items = this.rssItems();
    if (items.length === 0) return;
    const text = items.map((it) => `${it.title} — ${it.url}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      this.toast.success(`Copied ${items.length} link${items.length === 1 ? '' : 's'} — paste into your post.`);
    } catch {
      this.toast.error('Could not copy — select the links manually.');
    }
  }

  /** Import the previewed feed items as draft posts (assign accounts + schedule in the composer). */
  importRssDrafts(): void {
    if (this.rssItems().length === 0 || this.importingRss()) return;
    const url = this.rssUrl.trim();
    if (!this.isValidHttpsUrl(url)) {
      this.toast.error('Enter a valid https:// feed URL before importing.');
      return;
    }
    this.importingRss.set(true);
    this.api.post<{ ok: boolean; created: number }>('/social/import-rss', { url, site_id: this.siteId() ?? undefined }, { silent: true }).subscribe({
      next: (r) => {
        this.importingRss.set(false);
        this.toast.success(`Imported ${r.created} draft${r.created === 1 ? '' : 's'} — find them in Drafts.`);
        this.rssItems.set([]);
        this.rssUrl = '';
        this.loadPosts();
      },
      error: (err: unknown) => {
        this.importingRss.set(false);
        const msg = (err as { error?: { error?: { message?: string } } })?.error?.error?.message ?? 'Could not import the feed.';
        this.toast.error(msg);
      },
    });
  }


}

/* ──────────────────────────────────────────────────────────────────── */
/*  Pure helpers                                                        */
/* ──────────────────────────────────────────────────────────────────── */

function toDatetimeLocal(d: Date): string {
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}
