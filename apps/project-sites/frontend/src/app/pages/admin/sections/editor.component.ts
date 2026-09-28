import { Component, computed, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { BoltEmbedService } from '../../../services/bolt-embed.service';
import { AdminStateService } from '../admin-state.service';
import { OnboardingChecklistComponent } from '../onboarding-checklist.component';

/**
 * Editor route — a thin shell. The bolt.diy iframe itself lives in
 * AdminComponent and is owned by BoltEmbedService, so it survives every
 * admin sub-route change. This component renders:
 *
 *  - empty-site state (no site selected)
 *  - "site not found" state when a `/admin/editor/:siteId` deep-link names a site
 *    the caller doesn't own / that doesn't exist (a coherent panel + a link back to
 *    the sites grid — NEVER a raw admin-404).
 *  - ONE cinematic loading veil (animated mark only — no progress/segment bar)
 *    that stays up across the WHOLE boot and fades the instant the workspace is
 *    truly ready (BoltEmbedService.editorReady). It's the SOLE loader: the
 *    in-iframe bolt loader is suppressed when embedded, so nothing flashes
 *    inside the iframe when this veil fades.
 *
 * Deep-link: a `:siteId` route param (from `/admin/editor/:siteId`) is read from
 * ActivatedRoute and passed to {@link AdminStateService.selectSiteById}, so opening
 * or sharing an editor URL selects THAT site. Bare `/admin/editor` (no param) leaves
 * the current selection alone (falls back to `selectedSite() ?? sites()[0]`).
 */
@Component({
  imports: [OnboardingChecklistComponent, RouterLink],
  selector: 'app-admin-editor',
  standalone: true,
  styles: [`
    :host { --ease-cinematic: cubic-bezier(0.4, 0, 0.2, 1); display: block; }

    .empty-glyph {
      width: 88px; height: 88px;
      display: flex; align-items: center; justify-content: center;
      border-radius: 20px;
      background: linear-gradient(135deg, rgba(0, 229, 255, 0.08), rgba(124, 58, 237, 0.05));
      border: 1px solid rgba(0, 229, 255, 0.12);
      color: rgba(0, 229, 255, 0.7);
      box-shadow:
        0 16px 48px -24px rgba(0, 229, 255, 0.3),
        0 0 0 1px rgba(0, 229, 255, 0.05) inset;
      animation: pulseGlow 3.6s var(--ease-cinematic) infinite;
    }

    @keyframes pulseGlow {
      0%, 100% { box-shadow: 0 16px 48px -24px rgba(0, 229, 255, 0.3), 0 0 0 1px rgba(0, 229, 255, 0.05) inset; }
      50% { box-shadow: 0 20px 64px -24px rgba(0, 229, 255, 0.45), 0 0 0 1px rgba(0, 229, 255, 0.12) inset; }
    }

    /* Loading veil — ONE indicator over the iframe's visible slot, below the admin
       topbar, so the user never sees bolt.diy's own boot flicker underneath. */
    .ed-veil {
      position: absolute;
      inset: 62px 0 0 0;
      display: flex; align-items: center; justify-content: center;
      z-index: 2;
      overflow: hidden;
      background: #060610;
      /* Opaque from frame 1 — NO entry fade-in. The old 'animation: edFade' ramped
         opacity 0→1 over 260ms, and during that ramp the booting iframe flashed
         through the semi-transparent veil (the "flash during presentation"). A
         loading COVER must be solid the instant it mounts, never fade in. */
      opacity: 1;
      /* Never intercept the cursor — the loader is purely visual, so clicks pass
         straight through to the editor at ALL times (Brian: no cursor pointer events). */
      pointer-events: none;
      will-change: opacity;
      /* Fade-OUT only (Angular's animate.leave adds .ed-veil--leaving when the
         workspace is ready, holding the element in the DOM until this settles).
         An ease-IN curve keeps the veil near-opaque for most of the transition and
         drops fast only at the very end — so any last-moment iframe relayout/twitch
         stays masked until the reveal is essentially complete, instead of bleeding
         through a long linear cross-fade. */
      transition: opacity 560ms cubic-bezier(0.7, 0, 0.84, 0);
    }
    /* Fade out + go click-through the moment the veil begins leaving. */
    .ed-veil--leaving {
      opacity: 0;
      pointer-events: none;
    }
    /* Slowly drifting aurora mesh — cinematic depth behind the card. */
    .ed-aurora {
      position: absolute; inset: -25%;
      background:
        radial-gradient(38% 34% at 22% 28%, rgba(0, 229, 255, 0.18), transparent 60%),
        radial-gradient(34% 30% at 78% 30%, rgba(124, 58, 237, 0.20), transparent 62%),
        radial-gradient(46% 40% at 50% 88%, rgba(0, 229, 255, 0.10), transparent 66%);
      filter: blur(26px) saturate(1.15);
      animation: edDrift 14s var(--ease-cinematic) infinite;
    }
    .ed-veil-card {
      position: relative;
      display: flex; flex-direction: column; align-items: center; gap: 0.7rem;
      padding: 2.1rem 2.6rem 1.8rem;
      border-radius: 24px;
      background: linear-gradient(180deg, rgba(14, 14, 40, 0.62), rgba(6, 6, 16, 0.62));
      border: 1px solid rgba(0, 229, 255, 0.12);
      box-shadow: 0 30px 80px -32px rgba(0, 0, 0, 0.7), inset 0 1px 0 rgba(255, 255, 255, 0.05);
      backdrop-filter: blur(14px) saturate(1.1);
      -webkit-backdrop-filter: blur(14px) saturate(1.1);
      text-align: center;
    }

    /* Animated brand mark: a rotating conic ring + a breathing core + a bolt glyph. */
    .ed-mark { position: relative; width: 76px; height: 76px; margin-bottom: 0.2rem; }
    .ed-ring {
      position: absolute; inset: 0; border-radius: 50%;
      background: conic-gradient(from 0deg, transparent 0deg, rgba(0, 229, 255, 0.95) 130deg, rgba(124, 58, 237, 0.95) 250deg, transparent 360deg);
      -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 4px), #000 calc(100% - 3.5px));
      mask: radial-gradient(farthest-side, transparent calc(100% - 4px), #000 calc(100% - 3.5px));
      animation: edSpin 2.4s linear infinite;
    }
    .ed-core {
      position: absolute; inset: 13px; border-radius: 50%;
      background: radial-gradient(circle at 34% 28%, rgba(0, 229, 255, 0.34), rgba(124, 58, 237, 0.16) 68%, transparent 82%);
      animation: edBreathe 3s var(--ease-cinematic) infinite;
    }
    .ed-glyph {
      position: absolute; inset: 0; margin: auto; width: 30px; height: 30px;
      color: #00E5FF;
      filter: drop-shadow(0 0 9px rgba(0, 229, 255, 0.55));
      animation: edBreathe 3s var(--ease-cinematic) infinite;
    }

    .ed-headline {
      font-family: 'Sora', system-ui, sans-serif;
      font-weight: 600; font-size: 1.08rem; color: #f4f4ff; letter-spacing: -0.02em;
    }
    .ed-sub {
      display: inline-flex; align-items: baseline;
      font-size: 0.78rem; color: rgba(244, 244, 255, 0.66);
      font-family: 'JetBrains Mono', ui-monospace, monospace;
    }
    .ed-dots { display: inline-flex; margin-left: 1px; }
    .ed-dots i {
      width: 3px; height: 3px; margin-left: 2px; border-radius: 50%;
      background: rgba(0, 229, 255, 0.85); align-self: center;
      animation: edDot 1.2s var(--ease-cinematic) infinite;
    }
    .ed-dots i:nth-child(2) { animation-delay: 0.16s; }
    .ed-dots i:nth-child(3) { animation-delay: 0.32s; }

    .ed-footnote { font-size: 0.7rem; color: rgba(244, 244, 255, 0.4); margin-top: 0.5rem; }

    @keyframes edSpin { to { transform: rotate(360deg); } }
    @keyframes edFade { from { opacity: 0; } to { opacity: 1; } }
    @keyframes edBreathe { 0%, 100% { transform: scale(0.94); opacity: 0.85; } 50% { transform: scale(1.06); opacity: 1; } }
    @keyframes edDrift {
      0%, 100% { transform: translate3d(0, 0, 0) scale(1); }
      33% { transform: translate3d(3%, -2%, 0) scale(1.06); }
      66% { transform: translate3d(-3%, 2%, 0) scale(1.03); }
    }
    @keyframes edDot { 0%, 100% { opacity: 0.3; transform: translateY(0); } 50% { opacity: 1; transform: translateY(-2px); } }

    @media (prefers-reduced-motion: reduce) {
      .empty-glyph, .ed-veil, .ed-aurora, .ed-core, .ed-glyph, .ed-dots i { animation: none; }
      .ed-ring { animation-duration: 4s; }
    }
  `],
  template: `
    <h1 class="sr-only">Site editor</h1>
    @if (showNotFound()) {
      <!-- A /admin/editor/:siteId deep-link named a site this account can't open.
           A coherent recovery panel — NOT the raw admin-404, NOT a doomed blank. -->
      <div class="p-7 max-w-[820px] mx-auto">
        <div class="empty-state-pretty" data-testid="editor-site-not-found">
          <div class="empty-glyph">
            <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="#00E5FF" stroke-width="1.4">
              <circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6"/>
            </svg>
          </div>
          <h3 class="glow-h-grad text-2xl font-semibold m-0">We couldn't find that site</h3>
          <p class="text-[0.92rem] text-text-secondary max-w-[480px] mx-auto m-0 leading-relaxed">
            The editor link points to a site that isn't in your account (it may have been
            deleted, or belongs to a different workspace). Open one of your sites to keep going.
          </p>
          <div class="flex gap-2 justify-center mt-1">
            <a class="btn-primary" routerLink="/admin/sites">View your sites</a>
            <button class="btn-ghost" (click)="state.newSite()">+ Create a new site</button>
          </div>
        </div>
      </div>
    } @else if (!state.selectedSite()) {
      <div class="p-7 max-w-[820px] mx-auto space-y-6">
        <app-onboarding-checklist />
        <div class="empty-state-pretty">
          <div class="empty-glyph">
            <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="#00E5FF" stroke-width="1.4">
              <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>
            </svg>
          </div>
          <h3 class="glow-h-grad text-2xl font-semibold m-0">Welcome to your admin</h3>
          <p class="text-[0.92rem] text-text-secondary max-w-[480px] mx-auto m-0 leading-relaxed">
            Pick a site from the top-left selector to open it in the AI editor — or follow the checklist above to get fully set up in two minutes.
          </p>
          <div class="flex gap-2 justify-center mt-1">
            <button class="btn-primary" (click)="state.newSite()">+ Create a new site</button>
            <button class="btn-ghost" (click)="openPalette()">⌘K Quick find</button>
          </div>
        </div>
      </div>
    }
    <!-- The loading veil now lives at the TOP LEVEL of the shell (admin.component,
         sibling of the iframe) so nothing can overlap it — see .bolt-veil there. -->
  `,
})
export class AdminEditorComponent {
  state = inject(AdminStateService);
  bolt = inject(BoltEmbedService);
  private route = inject(ActivatedRoute);

  /**
   * The `:siteId` from the route (`/admin/editor/:siteId`), or null on the bare
   * `/admin/editor`. Driven by the param STREAM (not the snapshot) so an in-place param
   * change (SPA nav between two editor deep-links) re-selects without re-creating the
   * component. `route.paramMap` replays synchronously on subscribe, so this is set
   * before the first change-detection reads {@link showNotFound}.
   */
  private readonly deepLinkId = signal<string | null>(null);

  /**
   * Consume the `:siteId` param → select THAT site. Runs on subscribe (initial value)
   * AND any later param change. Only fires selection when an id is actually present, so
   * bare `/admin/editor` never overrides the persisted/first-site selection. Sites load
   * async, so an unknown id here is expected before load — {@link showNotFound} gates on
   * `state.loading()` so it never flashes "not found" before the list resolves.
   */
  private readonly _deepLinkSub = this.route.paramMap
    .pipe(takeUntilDestroyed())
    .subscribe((pm) => {
      const id = pm.get('siteId');
      this.deepLinkId.set(id);
      if (id) this.state.selectSiteById(id);
    });

  /**
   * True when a deep-linked `:siteId` doesn't match any loaded site AFTER the site list
   * has resolved — the signal to show the coherent "site not found" recovery panel
   * instead of the (misleading) welcome empty state or a raw 404. Never true while the
   * list is still loading (avoids a not-found flash) or on the bare `/admin/editor`.
   */
  readonly showNotFound = computed(() => {
    const id = this.deepLinkId();
    if (!id || this.state.loading()) return false;
    return !this.state.sites().some((s) => s.id === id);
  });

  /**
   * Latch: once the editor has READIED during THIS visit, keep the loading veil
   * gone even if `bolt.editorReady()` momentarily flaps back to false (a background
   * re-boot / site re-selection). The cover must fade out EXACTLY ONCE per visit —
   * never flash back in. `AdminEditorComponent` is re-created when the user leaves +
   * returns to /admin/editor, so this resets naturally for a genuinely new visit
   * (and if the iframe is already warm, `editorReady()` is true on init → the veil
   * never shows). The HARD_TIMEOUT in BoltEmbedService still force-readies, so the
   * latch can't strand the veil. (Brian 2026-09-27 — loader fades in→out, no flicker.)
   */
  // Seed from the CURRENT ready state so a warm re-entry (iframe already booted,
  // editorReady already true) renders the veil at opacity:0 from frame 1 — no flash
  // before the effect runs. A cold boot starts false → veil visible → fades on ready.
  private readonly readiedOnce = signal(this.bolt.editorReady());
  private readonly _veilLatch = effect(() => {
    if (this.bolt.editorReady()) this.readiedOnce.set(true);
  });

  openPalette(): void {
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'k', metaKey: true }));
  }
}
