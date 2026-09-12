import { Component, signal, computed, inject, type OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthApiService } from './auth-api.service';
import { AuthService } from '../../services/auth.service';
import { isValidEmail } from '../../utils/validators/email';

/**
 * Open-redirect-safe post-sign-in destination. Only a same-origin absolute path
 * (a single leading `/`, never `//` protocol-relative or a `scheme:` URL) is
 * honored; anything else (external, empty, `javascript:`) falls back to `/admin`.
 *
 * @example sanitizeReturnUrl('/admin/billing') // '/admin/billing'
 * @example sanitizeReturnUrl('//evil.com')     // '/admin'
 */
export function sanitizeReturnUrl(raw: string | null | undefined): string {
  return raw && /^\/(?!\/)/.test(raw) ? raw : '/admin';
}

/**
 * Better Auth sign-in surface — email + password, plus a one-tap "email me a
 * magic link" passwordless path and a link across to sign-up.
 *
 * @remarks
 * Self-contained: the only collaborators are {@link AuthApiService} (its own
 * isolated HTTP client) and the Router. Live field validation, a busy guard on
 * every submit, and explicit error + success states. Brand dark theme, AA
 * contrast, 44px targets, `prefers-reduced-motion` safe via Tailwind `motion-*`.
 */
@Component({
  selector: 'app-sign-in',
  standalone: true,
  imports: [FormsModule, RouterLink],
  template: `
    <main
      class="min-h-screen grid place-items-center bg-dark px-4 py-10 text-white"
      data-testid="sign-in-page"
    >
      <section
        class="w-full max-w-md rounded-2xl border border-white/[0.08] bg-dark-card p-7 shadow-2xl max-md:p-5"
        aria-labelledby="sign-in-heading"
      >
        <header class="mb-6">
          <h1 id="sign-in-heading" class="text-2xl font-extrabold tracking-tight m-0">
            Welcome back
          </h1>
          <p class="text-[0.85rem] text-text-secondary mt-1.5 mb-0">
            Sign in to manage your sites.
          </p>
        </header>

        @if (error()) {
          <div
            class="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-[0.82rem] text-red-300"
            role="alert"
            data-testid="sign-in-error"
          >
            {{ error() }}
          </div>
        }

        @if (magicSent()) {
          <div
            class="mb-4 rounded-lg border border-primary/30 bg-primary-dim px-3.5 py-2.5 text-[0.82rem] text-primary"
            role="status"
            data-testid="sign-in-magic-sent"
          >
            Check your inbox — we sent a magic link to {{ email().trim() }}.
          </div>
        }

        <form (ngSubmit)="submit()" novalidate class="flex flex-col gap-4">
          <div class="flex flex-col gap-1.5">
            <label for="signin-email" class="text-[0.8rem] font-semibold text-text-secondary">
              Email
            </label>
            <input
              id="signin-email"
              name="email"
              type="email"
              autocomplete="email"
              inputmode="email"
              [ngModel]="email()"
              (ngModelChange)="email.set($event)"
              (blur)="touched.set(true)"
              [attr.aria-invalid]="showEmailError()"
              aria-describedby="signin-email-error"
              placeholder="you@example.com"
              data-testid="sign-in-email"
              class="min-h-[44px] rounded-lg border border-white/[0.1] bg-dark-surface px-3.5 text-[0.9rem] text-white placeholder:text-white/30 outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/40"
            />
            @if (showEmailError()) {
              <span id="signin-email-error" class="text-[0.75rem] text-red-300" data-testid="sign-in-email-error">
                Enter a valid email address.
              </span>
            }
          </div>

          <div class="flex flex-col gap-1.5">
            <label for="signin-password" class="text-[0.8rem] font-semibold text-text-secondary">
              Password
            </label>
            <input
              id="signin-password"
              name="password"
              type="password"
              autocomplete="current-password"
              [ngModel]="password()"
              (ngModelChange)="password.set($event)"
              (blur)="touched.set(true)"
              [attr.aria-invalid]="showPasswordError()"
              aria-describedby="signin-password-error"
              placeholder="Your password"
              data-testid="sign-in-password"
              class="min-h-[44px] rounded-lg border border-white/[0.1] bg-dark-surface px-3.5 text-[0.9rem] text-white placeholder:text-white/30 outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/40"
            />
            @if (showPasswordError()) {
              <span id="signin-password-error" class="text-[0.75rem] text-red-300" data-testid="sign-in-password-error">
                Password is required.
              </span>
            }
          </div>

          <button
            type="submit"
            [disabled]="busy() || !canSubmit()"
            data-testid="sign-in-submit"
            class="min-h-[44px] rounded-lg bg-primary px-4 text-[0.9rem] font-bold text-dark transition-colors motion-safe:transition-all hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {{ busy() ? 'Signing in…' : 'Sign in' }}
          </button>
        </form>

        <div class="my-5 flex items-center gap-3 text-[0.72rem] text-white/50" aria-hidden="true">
          <span class="h-px flex-1 bg-white/[0.08]"></span>
          OR
          <span class="h-px flex-1 bg-white/[0.08]"></span>
        </div>

        <!-- Social OAuth buttons — matches backend Better Auth socialProviders -->
        <div class="flex flex-col gap-2.5">
          <a
            [href]="'/api/auth/google?returnUrl=' + safeReturnUrl()"
            data-testid="sign-in-google"
            class="min-h-[44px] flex items-center justify-center gap-2 rounded-lg border border-white/[0.12] bg-transparent px-4 text-[0.85rem] font-semibold text-white transition-colors hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-primary/50 no-underline"
          >
            <svg class="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
            Continue with Google
          </a>
          <a
            [attr.href]="githubUnavailable() ? null : '/api/auth/github?returnUrl=' + safeReturnUrl()"
            [attr.aria-disabled]="githubUnavailable() ? 'true' : null"
            [attr.tabindex]="githubUnavailable() ? -1 : null"
            data-testid="sign-in-github"
            class="min-h-[44px] flex items-center justify-center gap-2 rounded-lg border border-white/[0.12] bg-transparent px-4 text-[0.85rem] font-semibold text-white transition-colors hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-primary/50 no-underline"
            [class.opacity-50]="githubUnavailable()"
            [class.cursor-not-allowed]="githubUnavailable()"
            [class.pointer-events-none]="githubUnavailable()"
          >
            <svg class="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.385-1.335-1.755-1.335-1.755-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 21.795 24 17.295 24 12 24 5.37 18.63 0 12 0z"/></svg>
            {{ githubUnavailable() ? 'GitHub — temporarily unavailable' : 'Continue with GitHub' }}
          </a>
        </div>

        <button
          type="button"
          (click)="emailMagicLink()"
          [disabled]="magicBusy() || !emailValid()"
          data-testid="sign-in-magic-link"
          class="min-h-[44px] w-full rounded-lg border border-white/[0.12] bg-transparent px-4 text-[0.85rem] font-semibold text-white transition-colors hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {{ magicBusy() ? 'Sending…' : 'Email me a magic link' }}
        </button>
        @if (!emailValid() && !magicBusy()) {
          <!-- The magic-link button is disabled until a valid email is entered; a disabled
               control can't surface a title/tooltip, so explain the dependency inline (why
               it's dimmed + how to enable it) rather than leaving a silent dead-end. -->
          <p class="mt-1.5 mb-0 text-center text-[0.72rem] text-text-secondary" data-testid="sign-in-magic-hint">
            Enter your email above to get a passwordless magic link.
          </p>
        }

        <p class="mt-6 mb-0 text-center text-[0.82rem] text-text-secondary">
          New here?
          <a
            routerLink="/auth/sign-up"
            data-testid="sign-in-to-sign-up"
            class="font-semibold text-primary underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-primary/50 rounded"
          >
            Create an account
          </a>
        </p>
      </section>
    </main>
  `,
})
export class SignInComponent implements OnInit {
  private readonly authApi = inject(AuthApiService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  /**
   * Better Auth → ps_session bridge (heal-on-arrival).
   *
   * Cookie-only Better Auth flows (magic-link email verify, OAuth callbackURL
   * redirects) land the user on a guarded route with a live BA cookie but NO
   * localStorage `ps_session` — the auth guard bounces them straight back
   * here. On arrival, probe `/api/auth/get-session`; when a BA session
   * exists, mint the local session and continue to the intended destination.
   * The worker's authMiddleware already resolves BA cookie sessions on every
   * API call, so the local token's only job is satisfying the client guard.
   */
  async ngOnInit(): Promise<void> {
    this.surfaceAuthError();
    if (this.auth.isLoggedIn()) return;
    const res = await this.authApi.getSession();
    if (res.ok && res.data.user?.email) {
      this.auth.setSession(res.data.session?.token ?? 'ba-cookie-session', res.data.user.email);
      this.router.navigateByUrl(this.safeReturnUrl());
    }
  }

  /**
   * Surface an OAuth-provider failure the worker flagged via `?auth_error=`. GitHub sign-in
   * start currently can't proceed — the `oauth_states.provider` CHECK admits only 'google', so
   * the 'github' state INSERT throws; the worker now 302s back here with the code instead of
   * 500ing on a prospect-facing CTA. Steer the user to a method that works (magic-link + Google
   * are on this page) via the existing `error` signal the template renders, and strip the param
   * so a refresh doesn't re-show it. AL-185.
   */
  private surfaceAuthError(): void {
    const code = this.route.snapshot.queryParamMap.get('auth_error');
    if (!code) return;
    if (code === 'github_unavailable') this.githubUnavailable.set(true);
    this.error.set(
      code === 'github_unavailable'
        ? 'GitHub sign-in is temporarily unavailable — use “Email me a magic link” below or continue with Google.'
        : 'That sign-in method is temporarily unavailable — use “Email me a magic link” below or continue with Google.',
    );
    this.router.navigate([], {
      queryParams: { auth_error: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  /**
   * Post-sign-in destination from `?returnUrl=` (the app bounces protected 401s
   * to `/signin?returnUrl=…`), open-redirect-sanitized.
   */
  /** Post-sign-in destination — exposed for template OAuth button hrefs. */
  safeReturnUrl(): string {
    return sanitizeReturnUrl(this.route.snapshot.queryParamMap.get('returnUrl'));
  }

  readonly email = signal('');
  readonly password = signal('');
  readonly touched = signal(false);
  readonly busy = signal(false);
  readonly magicBusy = signal(false);
  readonly magicSent = signal(false);
  readonly error = signal<string | null>(null);
  /**
   * True after a `?auth_error=github_unavailable` redirect — disables the GitHub CTA so the
   * user can't re-click straight into the same failure loop (the worker 302s it right back).
   * Transient (this visit only): a fresh load leaves GitHub live for when the provider CHECK is
   * widened to enable it. AL-186.
   */
  readonly githubUnavailable = signal(false);

  // Shared validator (utils/validators/email.ts) — mirrors the backend
  // emailSchema (254-char cap, ASCII pattern). A local EMAIL_RE here caused
  // FE/BE parity drift: overlong/unicode/<script>-shaped emails were accepted
  // client-side and rejected server-side (caught by value-domains-auth E2E).
  readonly emailValid = computed(() => isValidEmail(this.email()));
  readonly passwordValid = computed(() => this.password().length > 0);
  readonly canSubmit = computed(() => this.emailValid() && this.passwordValid());
  readonly showEmailError = computed(() => this.touched() && !this.emailValid());
  readonly showPasswordError = computed(() => this.touched() && !this.passwordValid());

  /** Sign in with email + password; on success route to the admin dashboard. */
  async submit(): Promise<void> {
    this.touched.set(true);
    this.error.set(null);
    if (this.busy() || !this.canSubmit()) return;

    this.busy.set(true);
    const res = await this.authApi.signInEmail({
      email: this.email().trim(),
      password: this.password(),
    });
    this.busy.set(false);

    if (res.ok) {
      // Mint the local session the route guards key off — Better Auth only
      // sets a cookie, and navigating to /admin without ps_session bounces
      // straight back here (the guard reads localStorage, not cookies).
      this.auth.setSession(res.data.token ?? 'ba-cookie-session', this.email().trim());
      this.router.navigateByUrl(this.safeReturnUrl());
    } else {
      this.error.set(this.friendlyAuthError(res.error));
    }
  }

  /**
   * Map a raw auth error to a user-actionable message.
   *
   * Better Auth's captcha plugin (`better-auth.ts`) gates `POST /sign-in/email`
   * on a Cloudflare-Turnstile token that this password form does NOT yet render
   * — so a real password submit returns `400 "Missing CAPTCHA response"`. The
   * live passwordless paths (magic-link + Google + GitHub) work; rather than
   * strand the user on that cryptic string, steer them to a method that signs
   * them in. All other errors (bad credentials, network) pass through verbatim.
   *
   * @remarks Forward-compatible: the guidance only fires on the captcha-missing
   *   error, so once the Turnstile token is wired (or the form is removed) this
   *   branch stops firing on its own — no follow-up cleanup needed.
   */
  private friendlyAuthError(raw: string | undefined): string {
    const s = (raw ?? '').toString();
    if (/captcha|missing.?response/i.test(s)) {
      return 'Use “Email me a magic link” below, or continue with Google or GitHub — those sign you in instantly.';
    }
    return s;
  }

  /** Request a passwordless magic link to the entered email. */
  async emailMagicLink(): Promise<void> {
    this.touched.set(true);
    this.error.set(null);
    this.magicSent.set(false);
    if (this.magicBusy() || !this.emailValid()) return;

    this.magicBusy.set(true);
    const res = await this.authApi.sendMagicLink({
      email: this.email().trim(),
      callbackURL: this.safeReturnUrl(),
    });
    this.magicBusy.set(false);

    if (res.ok) {
      this.magicSent.set(true);
    } else {
      this.error.set(res.error);
    }
  }
}
