// Client-side storage utilities.
//
// The client check is evaluated PER CALL (not once at module load): `localStorage`
// can be absent at import time (SSR / hydration ordering) yet present later, and a
// stale module-load snapshot would wrongly early-return forever.
function hasLocalStorage(): boolean {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined';
}

export function getLocalStorage(key: string): any | null {
  if (!hasLocalStorage()) {
    return null;
  }

  try {
    const item = localStorage.getItem(key);
    return item ? JSON.parse(item) : null;
  } catch (error) {
    console.error(`Error reading from localStorage key "${key}":`, error);
    return null;
  }
}

export function setLocalStorage(key: string, value: any): void {
  if (!hasLocalStorage()) {
    return;
  }

  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    // A quota-full / permission-denied WRITE must be OBSERVABLE — otherwise the
    // caller believes it persisted and silently loses the user's data. Warn with
    // the key so the breach is greppable, then swallow (the write is best-effort).
    console.warn(`localStorage write FAILED for key "${key}" (quota exceeded or access denied) — value NOT persisted:`, error);
  }
}
