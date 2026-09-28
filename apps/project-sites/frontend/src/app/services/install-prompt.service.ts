import { Injectable, signal, computed, inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

/**
 * The Chromium `beforeinstallprompt` event — not in the standard DOM lib.
 * @see https://developer.mozilla.org/docs/Web/API/BeforeInstallPromptEvent
 */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISS_KEY = 'ps_pwa_install_dismissed';
const VISITS_KEY = 'ps_pwa_visits';
/** Don't surface the iOS hint until a visitor has come back — never nag a first-timer. */
const IOS_HINT_MIN_VISITS = 2;

/**
 * iOS Safari is the ONLY iOS browser that can Add to Home Screen — Chrome,
 * Firefox, Edge, and Opera on iOS all use WebKit but cannot A2HS, so they must
 * be excluded.
 *
 * @param ua - `navigator.userAgent`.
 * @returns true only for genuine iOS Safari.
 * @example
 * isIosSafari('…iPhone…Safari…')           // → true
 * isIosSafari('…iPhone…CriOS…')             // → false (Chrome on iOS)
 */
export function isIosSafari(ua: string): boolean {
  const isIosDevice = /iphone|ipad|ipod/i.test(ua);
  const isOtherIosBrowser = /crios|fxios|edgios|opios/i.test(ua);
  const isSafari = /safari/i.test(ua);
  return isIosDevice && isSafari && !isOtherIosBrowser;
}

/**
 * Whether to show the manual iOS "Add to Home Screen" hint.
 *
 * @returns true only on returning-visitor iOS Safari that isn't already installed.
 * @example
 * iosHintEligible('…iPhone…Safari…', 2, false) // → true
 * iosHintEligible('…iPhone…Safari…', 1, false) // → false (first visit)
 */
export function iosHintEligible(ua: string, visits: number, standalone: boolean): boolean {
  return isIosSafari(ua) && visits >= IOS_HINT_MIN_VISITS && !standalone;
}

/**
 * Add-to-Home-Screen (A2HS / PWA install) state + install action — backlog #25.
 *
 * @remarks
 * Formerly the standalone bottom-left `InstallPromptComponent` chip; now a root
 * service so the **NotificationBell** can surface installability as an in-app
 * **App Notification** with an *Install* action (Brian 2026-09-27) instead of a
 * separate floating widget.
 *
 * Two paths, one signal ({@link mode}):
 * - **`'native'`** — Chromium/Android fired `beforeinstallprompt`; {@link install}
 *   triggers the one-tap native install sheet (must be called from a user gesture).
 * - **`'ios'`** — iOS Safari has no `beforeinstallprompt`, so on a *returning*
 *   visitor the notification shows a manual "Share → Add to Home Screen" hint
 *   (no programmatic install; never on first visit).
 * - **`null`** — not installable, already installed/standalone, or dismissed.
 *
 * Deferred-ask doctrine (per `always.md` § PWA): never nags — a dismissal is
 * remembered in localStorage, `mode` is `null` when already standalone/installed,
 * and the iOS hint is visit-gated. `providedIn: 'root'` + instantiated eagerly by
 * AppComponent so it captures `beforeinstallprompt` the instant it fires at boot.
 */
@Injectable({ providedIn: 'root' })
export class InstallPromptService {
  private readonly platformId = inject(PLATFORM_ID);

  /** The captured, still-usable install event (single-use; cleared after prompt). */
  private readonly deferred = signal<BeforeInstallPromptEvent | null>(null);
  /** User dismissed this session, OR a prior dismissal is remembered. */
  private readonly dismissed = signal<boolean>(false);
  /** Returning-visitor iOS Safari that can't programmatically prompt. */
  private readonly iosEligible = signal<boolean>(false);

  /** Which install affordance to surface: a native Install action, the iOS hint, or nothing. */
  readonly mode = computed<'native' | 'ios' | null>(() => {
    if (this.dismissed()) return null;
    if (this.deferred() !== null) return 'native';
    if (this.iosEligible()) return 'ios';
    return null;
  });

  constructor() {
    if (!isPlatformBrowser(this.platformId)) return;
    const standalone = this.isStandalone();
    if (standalone || this.wasDismissed()) {
      this.dismissed.set(true);
      return;
    }
    const visits = this.bumpVisits();
    this.iosEligible.set(iosHintEligible(this.userAgent(), visits, standalone));

    // Service (not a component) → listen on window directly. Registered in the
    // constructor, and AppComponent injects this at boot, so the one-shot
    // `beforeinstallprompt` is captured whenever it fires.
    window.addEventListener('beforeinstallprompt', (e) => this.onBeforeInstall(e));
    window.addEventListener('appinstalled', () => this.onInstalled());
  }

  private onBeforeInstall(e: Event): void {
    // Suppress Chrome's default mini-infobar; we surface our own notification.
    e.preventDefault();
    if (this.dismissed()) return;
    this.deferred.set(e as BeforeInstallPromptEvent);
  }

  private onInstalled(): void {
    this.deferred.set(null);
    this.iosEligible.set(false);
    this.dismissed.set(true);
    this.remember();
  }

  /**
   * Trigger the native install sheet (Chromium `'native'` mode only). Must be
   * called synchronously from a user gesture (the notification's Install click).
   * No-op on iOS/`null` mode.
   */
  async install(): Promise<void> {
    const evt = this.deferred();
    if (!evt) return;
    this.deferred.set(null); // single-use — drop before awaiting so the notification clears immediately
    try {
      await evt.prompt();
      const choice = await evt.userChoice;
      // If they declined the native sheet, don't re-nag this session.
      if (choice?.outcome === 'dismissed') this.remember();
    } catch {
      /* prompt() can reject if already consumed — safe to ignore */
    }
  }

  /** Dismiss the install affordance for good (remembered in localStorage). */
  dismiss(): void {
    this.dismissed.set(true);
    this.remember();
  }

  private userAgent(): string {
    try {
      return navigator.userAgent ?? '';
    } catch {
      return '';
    }
  }

  private isStandalone(): boolean {
    try {
      return (
        window.matchMedia?.('(display-mode: standalone)').matches === true ||
        // iOS Safari exposes navigator.standalone instead of display-mode.
        (navigator as unknown as { standalone?: boolean }).standalone === true
      );
    } catch {
      return false;
    }
  }

  private wasDismissed(): boolean {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  }

  /** Increment + persist the visit counter; returns the new count (≥1). */
  private bumpVisits(): number {
    try {
      const next = (parseInt(localStorage.getItem(VISITS_KEY) ?? '0', 10) || 0) + 1;
      localStorage.setItem(VISITS_KEY, String(next));
      return next;
    } catch {
      return 1;
    }
  }

  private remember(): void {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* private mode / quota — non-fatal */
    }
  }
}
