import { TestBed } from '@angular/core/testing';
import { InstallPromptService, isIosSafari, iosHintEligible } from './install-prompt.service';

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/153.0.0.0 Mobile/15E148 Safari/604.1';
const DESKTOP_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

describe('install-prompt helpers', () => {
  it('isIosSafari: true ONLY for genuine iOS Safari', () => {
    expect(isIosSafari(IPHONE_SAFARI)).toBe(true);
    expect(isIosSafari(IPHONE_CHROME)).toBe(false); // Chrome on iOS can't A2HS
    expect(isIosSafari(DESKTOP_CHROME)).toBe(false);
  });

  it('iosHintEligible: needs iOS Safari + returning visitor (≥2) + not standalone', () => {
    expect(iosHintEligible(IPHONE_SAFARI, 2, false)).toBe(true);
    expect(iosHintEligible(IPHONE_SAFARI, 1, false)).toBe(false); // never nag a first-timer
    expect(iosHintEligible(IPHONE_SAFARI, 3, true)).toBe(false); // already installed
    expect(iosHintEligible(DESKTOP_CHROME, 5, false)).toBe(false); // not iOS Safari
  });
});

describe('InstallPromptService', () => {
  beforeEach(() => {
    try {
      localStorage.removeItem('ps_pwa_install_dismissed');
    } catch {
      /* ignore */
    }
  });

  it('mode() is null until installable (no beforeinstallprompt + non-iOS test env)', () => {
    const svc = TestBed.inject(InstallPromptService);
    // Headless Chrome test env: no beforeinstallprompt fired, not iOS Safari, not standalone
    // → neither the native nor the iOS path is active.
    expect(svc.mode()).toBeNull();
  });

  it('dismiss() forces mode() to null and remembers the dismissal', () => {
    const svc = TestBed.inject(InstallPromptService);
    svc.dismiss();
    expect(svc.mode()).toBeNull();
    expect(localStorage.getItem('ps_pwa_install_dismissed')).toBe('1');
  });
});
