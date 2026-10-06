/**
 * @module services/auth
 *
 * @description
 * Client-side session container for the admin SPA. Owns the localStorage keys
 * (`ps_session`, `ps_selected_business`, `ps_mode`, `ps_pending_build`,
 * `ps_location_declined`, `ps_auto_create`) and exposes signals that downstream
 * components/guards can read reactively.
 *
 * @remarks
 * - Tokens live in `localStorage` (deliberate — the SPA is single-origin so XSS
 *   protection comes from CSP + Trusted Types, not httpOnly cookies; the editor
 *   iframe needs the token at boot, which httpOnly cookies cannot provide).
 * - Sessions auto-expire after `SESSION_TTL_MS` (7 days) on read — never stale
 *   credentials silently re-used.
 * - All `localStorage` calls are inside try/catch so private-mode / quota-full
 *   browsers never throw past this layer.
 */
import { Injectable, inject, signal, computed } from '@angular/core';

const SESSION_KEY = 'ps_session';
const BUSINESS_KEY = 'ps_selected_business';
const MODE_KEY = 'ps_mode';
const PENDING_BUILD_KEY = 'ps_pending_build';
const LOCATION_DECLINED_KEY = 'ps_location_declined';
const AUTO_CREATE_KEY = 'ps_auto_create';

/** Session TTL in milliseconds (7 days). */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Persisted auth session shape. `createdAt` was added in Turn 1; older blobs
 * without it are treated as fresh (never expire on read).
 */
export interface Session {
  token: string;
  identifier: string;
  /** Timestamp when the session was created (for expiry). */
  createdAt?: number;
}

/**
 * Selected-business cache used by the create-site flow. Subset of Google Places
 * fields needed to seed the AI workflow without re-querying Places.
 */
export interface SelectedBusiness {
  name: string;
  address: string;
  place_id?: string;
  phone?: string;
  website?: string;
  types?: string[];
  lat?: number;
  lng?: number;
  /**
   * Business vertical the owner chose (one of the create-form category options).
   * Matches the `business.category` field the create-from-search worker accepts.
   * Persisted so a signed-out owner's category survives the signin bounce + the
   * returning auto-submit threads it into the build (#28 — else the AI got a
   * thinner brief than the owner assembled).
   */
  category?: string;
  /**
   * The owner's free-text "additional details" for the build. Matches the
   * top-level `additional_context` field the create-from-search worker accepts.
   * Persisted alongside {@link category} so the full brief survives signin (#28).
   */
  additional_context?: string;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private sessionSignal = signal<Session | null>(this.loadSession());

  constructor() {
  }

  /** Read-only signal of the active session — null when signed out. */
  readonly session = this.sessionSignal.asReadonly();

  /** Convenience derived signal — true when a non-expired session is present. */
  readonly isLoggedIn = computed(() => this.sessionSignal() !== null);

  /** Convenience derived signal — the active identifier (email) or `''`. */
  readonly email = computed(() => this.sessionSignal()?.identifier ?? '');

  /**
   * Hydrate `session` from localStorage on construction. Expired sessions are
   * dropped (and removed from storage) so a stale token never reaches the API
   * interceptor.
   */
  private loadSession(): Session | null {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const session: Session = JSON.parse(raw);
      // Expire sessions older than TTL
      if (session.createdAt && Date.now() - session.createdAt > SESSION_TTL_MS) {
        localStorage.removeItem(SESSION_KEY);
        return null;
      }
      return session;
    } catch {
      return null;
    }
  }

  /**
   * The current bearer token, or `null` when signed out.
   *
   * @example
   * ```ts
   * const token = auth.getToken();
   * if (token) headers.set('authorization', `Bearer ${token}`);
   * ```
   */
  getToken(): string | null {
    return this.sessionSignal()?.token ?? null;
  }

  /**
   * Persist a fresh session (post-magic-link or post-OAuth callback). Stamps
   * `createdAt: Date.now()` so the TTL check on next reload works.
   */
  setSession(token: string, identifier: string): void {
    const session: Session = { token, identifier, createdAt: Date.now() };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    this.sessionSignal.set(session);
  }

  /**
   * Wipe every session-derived key — session, business selection, mode, pending
   * build, auto-create flag. Does NOT clear `ps_location_declined` (that's a
   * UX preference, not a credential).
   */
  clearSession(): void {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(BUSINESS_KEY);
    localStorage.removeItem(MODE_KEY);
    localStorage.removeItem(PENDING_BUILD_KEY);
    localStorage.removeItem(AUTO_CREATE_KEY);
    this.sessionSignal.set(null);
  }

  /** Full logout: clear all session data. Alias for {@link clearSession}. */
  logout(): void {
    this.clearSession();
  }

  /** Read the persisted Places-derived business selection — null if unset. */
  getSelectedBusiness(): SelectedBusiness | null {
    try {
      const raw = localStorage.getItem(BUSINESS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  /** Persist the Places-derived business selection used by the create flow. */
  setSelectedBusiness(business: SelectedBusiness): void {
    localStorage.setItem(BUSINESS_KEY, JSON.stringify(business));
  }

  /** Clear the persisted business selection (e.g. after site creation). */
  clearSelectedBusiness(): void {
    localStorage.removeItem(BUSINESS_KEY);
  }

  /** Read the create-flow mode — defaults to `'business'` when unset/invalid. */
  getMode(): 'business' | 'custom' {
    const value = localStorage.getItem(MODE_KEY);
    return value === 'custom' ? 'custom' : 'business';
  }

  /** Persist the create-flow mode for the next visit. */
  setMode(mode: 'business' | 'custom'): void {
    localStorage.setItem(MODE_KEY, mode);
  }

  /** True when an in-progress build is waiting on auth callback hand-off. */
  getPendingBuild(): boolean {
    return localStorage.getItem(PENDING_BUILD_KEY) === 'true';
  }

  /** Toggle the pending-build flag — `false` removes the key entirely. */
  setPendingBuild(pending: boolean): void {
    if (pending) {
      localStorage.setItem(PENDING_BUILD_KEY, 'true');
    } else {
      localStorage.removeItem(PENDING_BUILD_KEY);
    }
  }

  /** True when the user explicitly declined the geolocation prompt before. */
  isLocationDeclined(): boolean {
    return localStorage.getItem(LOCATION_DECLINED_KEY) === 'true';
  }

  /** Record the user declining the geolocation prompt so we don't ask again. */
  setLocationDeclined(): void {
    localStorage.setItem(LOCATION_DECLINED_KEY, 'true');
  }

  /** True when post-auth flow should auto-create a site (signin from CTA). */
  getAutoCreate(): boolean {
    return localStorage.getItem(AUTO_CREATE_KEY) === 'true';
  }

  /** Toggle the auto-create flag — `false` removes the key entirely. */
  setAutoCreate(value: boolean): void {
    if (value) {
      localStorage.setItem(AUTO_CREATE_KEY, 'true');
    } else {
      localStorage.removeItem(AUTO_CREATE_KEY);
    }
  }
}
