import { Component, inject } from '@angular/core';

import { BoltEmbedService } from '../../../services/bolt-embed.service';
import { AdminStateService } from '../admin-state.service';
import { OnboardingChecklistComponent } from '../onboarding-checklist.component';

/**
 * Editor route — a thin shell. The bolt.diy iframe itself lives in
 * AdminComponent and is owned by BoltEmbedService, so it survives every
 * admin sub-route change. This component renders:
 *
 *  - empty-site state (no site selected)
 *  - ONE cinematic loading veil (animated mark only — no progress/segment bar)
 *    that stays up across the WHOLE boot and fades the instant the workspace is
 *    truly ready (BoltEmbedService.editorReady). It's the SOLE loader: the
 *    in-iframe bolt loader is suppressed when embedded, so nothing flashes
 *    inside the iframe when this veil fades.
 */
@Component({
  imports: [OnboardingChecklistComponent],
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
      opacity: 1;
      animation: edFade 260ms var(--ease-cinematic);
      /* Drives the fade-OUT: Angular's animate.leave adds .ed-veil--leaving when
         the workspace is ready and holds the element in the DOM until this
         transition settles, so the veil fades away (never a hard cut) and stops
         intercepting clicks the instant it starts leaving. */
      transition: opacity 420ms var(--ease-cinematic);
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
    @if (!state.selectedSite()) {
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
    } @else if (!bolt.editorReady()) {
      <div class="ed-veil" animate.leave="ed-veil--leaving" role="status" aria-live="polite" aria-busy="true">
        <div class="ed-aurora" aria-hidden="true"></div>
        <div class="ed-veil-card">
          <div class="ed-mark" aria-hidden="true">
            <span class="ed-ring"></span>
            <span class="ed-core"></span>
            <svg class="ed-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <path d="M13 2 4.5 13.2a.6.6 0 0 0 .48.96H11l-1 7.84 8.5-11.2a.6.6 0 0 0-.48-.96H12l1-7.84Z"/>
            </svg>
          </div>
          <div class="ed-headline">Booting your AI editor</div>
          <div class="ed-sub">{{ bolt.loadingStage() }}<span class="ed-dots"><i></i><i></i><i></i></span></div>
          <div class="ed-footnote">First visit only — subsequent opens are instant.</div>
        </div>
      </div>
    }
  `,
})
export class AdminEditorComponent {
  state = inject(AdminStateService);
  bolt = inject(BoltEmbedService);

  openPalette(): void {
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'k', metaKey: true }));
  }
}
