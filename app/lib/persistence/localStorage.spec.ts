import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { getLocalStorage, setLocalStorage } from './localStorage';

/**
 * Observability contract for the client-side localStorage helpers. A quota-full
 * or permission-denied WRITE must be VISIBLE (a structured warn), never a silent
 * data-loss where the caller believes the write succeeded. No IndexedDB / jsdom
 * needed — we stub a minimal `window` + `localStorage` so the helpers take the
 * client path, then force `setItem` / `getItem` to throw.
 */
describe('setLocalStorage', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubGlobal('window', {} as unknown as Window);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('logs a structured warn naming the key when the write fails (quota/denied), never silent', () => {
    vi.stubGlobal('localStorage', {
      setItem: vi.fn(() => {
        throw new Error('QuotaExceededError');
      }),
      getItem: vi.fn(),
    } as unknown as Storage);

    setLocalStorage('settings', { theme: 'dark' });

    // The breach must be observable AND name the key that failed to persist.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [msg] = warnSpy.mock.calls[0];
    expect(String(msg)).toContain('settings');
  });

  it('does not warn on a successful write', () => {
    vi.stubGlobal('localStorage', {
      setItem: vi.fn(),
      getItem: vi.fn(),
    } as unknown as Storage);

    setLocalStorage('settings', { theme: 'dark' });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('getLocalStorage', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubGlobal('window', {} as unknown as Window);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    errorSpy.mockRestore();
  });

  it('returns null on a read failure (still observable)', () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => {
        throw new Error('SecurityError');
      }),
      setItem: vi.fn(),
    } as unknown as Storage);

    expect(getLocalStorage('settings')).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('parses stored JSON on a successful read', () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => JSON.stringify({ theme: 'light' })),
      setItem: vi.fn(),
    } as unknown as Storage);

    expect(getLocalStorage('settings')).toEqual({ theme: 'light' });
  });
});
