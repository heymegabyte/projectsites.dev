/**
 * Admin → Social → Drafts / Queue / Sent post list (CENTER pane).
 *
 * Presentational split-out of `social.component.ts`'s DRAFTS/QUEUE/SENT list block.
 * Renders the bulk-action bar, the empty-state launchpad, and the per-post cards
 * (platform glyphs · status pill · body · media thumbs · Sent analytics tiles +
 * per-platform links · per-tab action buttons). It holds NO service calls and NO
 * data-fetch — it is a pure view over the `posts` the parent already loaded +
 * filtered. Every mutation/action is emitted to the parent, which owns
 * loadPosts / editPost / deletePost / publishNow / duplicatePost / bulk ops.
 *
 * Parameterized by `status` so ONE component renders all three tabs identically:
 *   - 'drafts' → Edit / Delete / Publish actions, "Save a draft…" empty copy
 *   - 'queue'  → Edit time / Cancel / Send now, "Schedule a post…" empty copy
 *   - 'sent'   → analytics tiles + per-platform links + Duplicate action
 *
 * INPUTS:
 *   status         — which tab this list represents ('drafts' | 'queue' | 'sent')
 *   posts          — the already-filtered SocialPost[] to render (parent computes)
 *   platforms      — the platform catalog (PLATFORMS) for glyph/label/color lookup
 *   analytics      — postId → AnalyticsRow[] (prefetched by the parent; Sent only)
 *   selectedIds    — the bulk-selection Set (parent-owned)
 *   deletingIds    — post ids with an in-flight delete → "Deleting…"/"Cancelling…"
 *   publishingIds  — post ids with an in-flight publish → "Publishing…"/"Send now"
 * OUTPUTS:
 *   toggleSelect   — postId to add/remove from the bulk selection
 *   bulkDelete     — the "Delete selected" click
 *   clearSelect    — the "Clear" click
 *   openComposer   — the empty-state "Open composer" click
 *   edit / delete / publish / duplicate — the per-post action clicks (full post)
 *
 * Imports the post TYPES from the sibling accounts component (PlatformId /
 * PlatformDef / SocialAccount), matching how the parent resolves them — parent →
 * child import only, no cycle.
 */
import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RevealDirective } from '../../../directives/reveal.directive';
import { RollingCounterComponent } from '../../../components/rolling-counter/rolling-counter.component';
import { type PlatformId, type PlatformDef } from './social-accounts.component';

export type PostStatus = 'draft' | 'scheduled' | 'published' | 'partial' | 'failed';

export interface PostListMediaItem {
  id: string;
  url: string;
  thumb_url?: string;
  alt: string;
  bytes: number;
  type: 'image' | 'video' | 'gif';
}

export interface SocialPost {
  id: string;
  content: string;
  per_platform_content?: Partial<Record<PlatformId, string>>;
  platforms: PlatformId[];
  media: PostListMediaItem[];
  hashtags: string[];
  link?: string;
  og?: { title: string; description: string; image: string; site_name: string };
  scheduled_at?: string;
  published_at?: string;
  status: PostStatus;
  per_platform_status?: Partial<Record<PlatformId, 'ok' | 'pending' | 'failed'>>;
  per_platform_url?: Partial<Record<PlatformId, string>>;
}

export interface AnalyticsRow {
  platform: PlatformId;
  impressions: number;
  likes: number;
  shares: number;
  clicks: number;
}

/** Which tab this list renders. Maps 1:1 to the parent's 'drafts'|'queue'|'sent'. */
export type PostListTab = 'drafts' | 'queue' | 'sent';

@Component({
  selector: 'app-social-post-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  imports: [CommonModule, RevealDirective, RollingCounterComponent],
  template: `
    <div class="list-pane" appReveal>
      @if (selectedIds.size > 0) {
        <div class="bulk-bar" role="region" aria-label="Bulk actions">
          <span class="bulk-ct">{{ selectedIds.size }} selected</span>
          <button type="button" class="btn-ghost sm danger" (click)="bulkDelete.emit()">Delete selected</button>
          <button type="button" class="btn-ghost sm" (click)="clearSelect.emit()">Clear</button>
        </div>
      }
      @if (posts.length === 0) {
        <div class="empty-state">
          <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/></svg>
          <h3>Nothing here yet</h3>
          <p>{{ status === 'drafts' ? 'Save a draft from the composer to see it here.' : status === 'queue' ? 'Schedule a post to fill the queue.' : 'Published posts will appear here with analytics.' }}</p>
          <button type="button" class="btn-primary" (click)="openComposer.emit()">Open composer</button>
        </div>
      } @else {
        @for (post of posts; track post.id) {
          <article class="post-card" appReveal [revealDelay]="$index * 60" [class.is-bulk-selected]="isSelected(post.id)">
            <header class="post-h">
              <input type="checkbox" class="post-sel" [checked]="isSelected(post.id)" (change)="toggleSelect.emit(post.id)" [attr.aria-label]="'Select this post for bulk actions'" />
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

            @if (status === 'sent') {
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
              @if (status === 'drafts') {
                <button type="button" class="btn-ghost sm" (click)="edit.emit(post)">Edit</button>
                <button type="button" class="btn-ghost sm danger" [disabled]="isDeleting(post.id)" [attr.aria-busy]="isDeleting(post.id)" (click)="delete.emit(post)">{{ isDeleting(post.id) ? 'Deleting…' : 'Delete' }}</button>
                <button type="button" class="btn-primary sm" [class.is-busy]="isPublishing(post.id)" [disabled]="isPublishing(post.id)" (click)="publish.emit(post)">{{ isPublishing(post.id) ? 'Publishing…' : 'Publish' }}</button>
              }
              @if (status === 'queue') {
                <button type="button" class="btn-ghost sm" (click)="edit.emit(post)">Edit time</button>
                <button type="button" class="btn-ghost sm danger" [disabled]="isDeleting(post.id)" [attr.aria-busy]="isDeleting(post.id)" (click)="delete.emit(post)">{{ isDeleting(post.id) ? 'Cancelling…' : 'Cancel' }}</button>
                <button type="button" class="btn-primary sm" [class.is-busy]="isPublishing(post.id)" [disabled]="isPublishing(post.id)" (click)="publish.emit(post)">{{ isPublishing(post.id) ? 'Publishing…' : 'Send now' }}</button>
              }
              @if (status === 'sent') {
                <button type="button" class="btn-ghost sm" (click)="duplicate.emit(post)">Duplicate</button>
              }
            </div>
          </article>
        }
      }
    </div>
  `,
  styles: [
    `
      :host { display: contents; }

      .bulk-bar { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.6rem; padding: 0.5rem 0.75rem; border-radius: 0.6rem; border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 30%, transparent); background: color-mix(in oklch, var(--ps-bg, #060610) 80%, var(--ps-accent, #00e5ff) 10%); backdrop-filter: blur(6px); }
      .bulk-ct { font-size: 0.78rem; font-weight: 700; color: var(--ps-ink, #f4f4ff); margin-right: auto; }
      .post-sel { width: 15px; height: 15px; accent-color: var(--ps-accent, #00e5ff); cursor: pointer; flex: none; }
      .post-card.is-bulk-selected { outline: 1.5px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 55%, transparent); outline-offset: 1px; }

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
      .btn-primary.is-busy { opacity: 0.65; cursor: progress; }

      /* Post list */
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
    `,
  ],
})
export class SocialPostListComponent {
  /** Which tab this list renders — parameterizes empty-state copy + action buttons. */
  @Input() status: PostListTab = 'drafts';
  /** The already-filtered posts to render (the parent computes/sorts them). */
  @Input() posts: readonly SocialPost[] = [];
  /** Platform catalog (PLATFORMS) — for glyph/label/color lookup. */
  @Input() platforms: readonly PlatformDef[] = [];
  /** postId → prefetched analytics rows (Sent tab only; parent owns the fetch). */
  @Input() analytics: Readonly<Record<string, AnalyticsRow[]>> = {};
  /** The bulk-selection set (parent-owned). */
  @Input() selectedIds: ReadonlySet<string> = new Set();
  /** Post ids with an in-flight delete → drives the row "Deleting…"/"Cancelling…" state. */
  @Input() deletingIds: ReadonlySet<string> = new Set();
  /** Post ids with an in-flight publish → drives the row "Publishing…" state. */
  @Input() publishingIds: ReadonlySet<string> = new Set();

  /** Emits the postId to toggle in the bulk selection. */
  @Output() readonly toggleSelect = new EventEmitter<string>();
  /** Emits the "Delete selected" bulk-bar click. */
  @Output() readonly bulkDelete = new EventEmitter<void>();
  /** Emits the "Clear" bulk-bar click. */
  @Output() readonly clearSelect = new EventEmitter<void>();
  /** Emits the empty-state "Open composer" click. */
  @Output() readonly openComposer = new EventEmitter<void>();
  /** Emits the post to edit (drafts + queue). */
  @Output() readonly edit = new EventEmitter<SocialPost>();
  /** Emits the post to delete/cancel (drafts + queue). */
  @Output() readonly delete = new EventEmitter<SocialPost>();
  /** Emits the post to publish/send-now (drafts + queue). */
  @Output() readonly publish = new EventEmitter<SocialPost>();
  /** Emits the post to duplicate as a new draft (sent). */
  @Output() readonly duplicate = new EventEmitter<SocialPost>();

  isSelected(id: string): boolean {
    return this.selectedIds.has(id);
  }

  isDeleting(id: string): boolean {
    return this.deletingIds.has(id);
  }

  isPublishing(id: string): boolean {
    return this.publishingIds.has(id);
  }

  defOf(pid: PlatformId | undefined): PlatformDef | undefined {
    return this.platforms.find((p) => p.id === pid);
  }

  /** PURE reader over the prefetched analytics cache — never fetches. */
  analyticsFor(postId: string): AnalyticsRow[] {
    return this.analytics[postId] ?? [];
  }
}
