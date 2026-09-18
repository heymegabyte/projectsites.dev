import { Component, signal, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthApiService } from './auth-api.service';
import { AuthService } from '../../services/auth.service';
import { isValidEmail } from '../../utils/validators/email';

/**
 * Better Auth sign-up surface — name + email + password registration.
 *
 * @remarks
 * Mirrors {@link SignInComponent}'s UX bar: live validation (name required,
 * valid email, ≥8-char password), busy guard on submit, error + success state.
 * Self-contained — only {@link AuthApiService} + Router. Brand dark theme, AA
 * contrast, 44px targets, reduced-motion safe.
 */
@Component({
  selector: 'app-sign-up',
  standalone: true,
  imports: [FormsModule, RouterLink],
  template: `
    <main
      class="min-h-screen grid place-items-center bg-dark px-4 py-10 text-white"
      data-testid="sign-up-page"
    >
      <section
        class="w-full max-w-md rounded-2xl border border-white/[0.08] bg-dark-card p-7 shadow-2xl max-md:p-5"
        aria-labelledby="sign-up-heading"
      >
        <header class="mb-6">
          <h1 id="sign-up-heading" class="text-2xl font-extrabold tracking-tight m-0">
            Create your account
          </h1>
          <p class="text-[0.85rem] text-text-secondary mt-1.5 mb-0">
            Start building sites in minutes.
          </p>
        </header>

        @if (error()) {
          <div
            class="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-[0.82rem] text-red-300"
            role="alert"
            data-testid="sign-up-error"
          >
            {{ error() }}
          </div>
        }

        @if (done()) {
          <div
            class="mb-4 rounded-lg border border-primary/30 bg-primary-dim px-3.5 py-2.5 text-[0.82rem] text-primary"
            role="status"
            data-testid="sign-up-success"
          >
            Account created — taking you to your dashboard…
          </div>
        }

        <form (ngSubmit)="submit()" novalidate class="flex flex-col gap-4">
          <div class="flex flex-col gap-1.5">
            <label for="signup-name" class="text-[0.8rem] font-semibold text-text-secondary">
              Name
            </label>
            <input
              id="signup-name"
              name="name"
              type="text"
              autocomplete="name"
              [ngModel]="name()"
              (ngModelChange)="name.set($event)"
              (blur)="touched.set(true)"
              [attr.aria-invalid]="showNameError()"
              aria-describedby="signup-name-error"
              placeholder="Jane Doe"
              data-testid="sign-up-name"
              class="min-h-[44px] rounded-lg border border-white/[0.1] bg-dark-surface px-3.5 text-[0.9rem] text-white placeholder:text-white/30 outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/40"
            />
            @if (showNameError()) {
              <span id="signup-name-error" class="text-[0.75rem] text-red-300" data-testid="sign-up-name-error">
                Name is required.
              </span>
            }
          </div>

          <div class="flex flex-col gap-1.5">
            <label for="signup-email" class="text-[0.8rem] font-semibold text-text-secondary">
              Email
            </label>
            <input
              id="signup-email"
              name="email"
              type="email"
              autocomplete="email"
              inputmode="email"
              [ngModel]="email()"
              (ngModelChange)="email.set($event)"
              (blur)="touched.set(true)"
              [attr.aria-invalid]="showEmailError()"
              aria-describedby="signup-email-error"
              placeholder="you@example.com"
              data-testid="sign-up-email"
              class="min-h-[44px] rounded-lg border border-white/[0.1] bg-dark-surface px-3.5 text-[0.9rem] text-white placeholder:text-white/30 outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/40"
            />
            @if (showEmailError()) {
              <span id="signup-email-error" class="text-[0.75rem] text-red-300" data-testid="sign-up-email-error">
                Enter a valid email address.
              </span>
            }
          </div>

          <div class="flex flex-col gap-1.5">
            <label for="signup-password" class="text-[0.8rem] font-semibold text-text-secondary">
              Password
            </label>
            <div class="relative">
              <input
                id="signup-password"
                name="password"
                [type]="showPassword() ? 'text' : 'password'"
                autocomplete="new-password"
                [ngModel]="password()"
                (ngModelChange)="password.set($event)"
                (blur)="touched.set(true)"
                [attr.aria-invalid]="showPasswordError()"
                aria-describedby="signup-password-error"
                placeholder="At least 8 characters"
                data-testid="sign-up-password"
                class="min-h-[44px] w-full rounded-lg border border-white/[0.1] bg-dark-surface px-3.5 pr-11 text-[0.9rem] text-white placeholder:text-white/30 outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/40"
              />
              <button
                type="button"
                (click)="showPassword.set(!showPassword())"
                [attr.aria-label]="showPassword() ? 'Hide password' : 'Show password'"
                [attr.aria-pressed]="showPassword()"
                data-testid="sign-up-password-toggle"
                class="absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-white/45 transition-colors hover:text-white/80 focus-visible:ring-2 focus-visible:ring-primary/50 outline-none"
              >
                @if (showPassword()) {
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18" /><path d="M10.58 10.58a3 3 0 0 0 4.24 4.24" /><path d="M9.88 4.24A10.9 10.9 0 0 1 12 4c6.5 0 10 8 10 8a13.6 13.6 0 0 1-2.29 2.88" /><path d="M6.61 6.61C3.9 8.3 2 12 2 12s3.5 8 10 8a10.9 10.9 0 0 0 2.12-.22" /></svg>
                } @else {
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-8 10-8 10 8 10 8-3.5 8-10 8-10-8-10-8Z" /><circle cx="12" cy="12" r="3" /></svg>
                }
              </button>
            </div>
            @if (showPasswordError()) {
              <span id="signup-password-error" class="text-[0.75rem] text-red-300" data-testid="sign-up-password-error">
                Use at least 8 characters.
              </span>
            }
          </div>

          <button
            type="submit"
            [disabled]="busy() || !canSubmit()"
            data-testid="sign-up-submit"
            class="min-h-[44px] rounded-lg bg-primary px-4 text-[0.9rem] font-bold text-dark transition-colors motion-safe:transition-all hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {{ busy() ? 'Creating account…' : 'Create account' }}
          </button>
        </form>

        <div class="my-5 flex items-center gap-3 text-[0.72rem] text-white/50" aria-hidden="true">
          <span class="h-px flex-1 bg-white/[0.08]"></span>
          OR
          <span class="h-px flex-1 bg-white/[0.08]"></span>
        </div>

        <div class="flex flex-col gap-2.5">
          <a
            href="/api/auth/google?returnUrl=/admin"
            data-testid="sign-up-google"
            class="min-h-[44px] flex items-center justify-center gap-2 rounded-lg border border-white/[0.12] bg-transparent px-4 text-[0.85rem] font-semibold text-white transition-colors hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-primary/50 no-underline"
          >
            <svg class="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
            Continue with Google
          </a>
          <a
            href="/api/auth/github?returnUrl=/admin"
            data-testid="sign-up-github"
            class="min-h-[44px] flex items-center justify-center gap-2 rounded-lg border border-white/[0.12] bg-transparent px-4 text-[0.85rem] font-semibold text-white transition-colors hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-primary/50 no-underline"
          >
            <svg class="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.385-1.335-1.755-1.335-1.755-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 21.795 24 17.295 24 12 24 5.37 18.63 0 12 0z"/></svg>
            Continue with GitHub
          </a>
        </div>

        <p class="mt-6 mb-0 text-center text-[0.82rem] text-text-secondary">
          Already have an account?
          <a
            routerLink="/auth/sign-in"
            data-testid="sign-up-to-sign-in"
            class="font-semibold text-primary underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-primary/50 rounded"
          >
            Sign in
          </a>
        </p>
      </section>
    </main>
  `,
})
export class SignUpComponent {
  private readonly authApi = inject(AuthApiService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly name = signal('');
  readonly email = signal('');
  readonly password = signal('');
  readonly showPassword = signal(false);
  readonly touched = signal(false);
  readonly busy = signal(false);
  readonly done = signal(false);
  readonly error = signal<string | null>(null);

  readonly nameValid = computed(() => this.name().trim().length > 0);
  // Shared validator — see sign-in.component.ts; local EMAIL_RE = parity drift.
  readonly emailValid = computed(() => isValidEmail(this.email()));
  readonly passwordValid = computed(() => this.password().length >= 8);
  readonly canSubmit = computed(
    () => this.nameValid() && this.emailValid() && this.passwordValid(),
  );
  readonly showNameError = computed(() => this.touched() && !this.nameValid());
  readonly showEmailError = computed(() => this.touched() && !this.emailValid());
  readonly showPasswordError = computed(() => this.touched() && !this.passwordValid());

  /** Register the account; on success route to the admin dashboard. */
  async submit(): Promise<void> {
    this.touched.set(true);
    this.error.set(null);
    if (this.busy() || !this.canSubmit()) return;

    this.busy.set(true);
    const res = await this.authApi.signUpEmail({
      name: this.name().trim(),
      email: this.email().trim(),
      password: this.password(),
    });

    if (res.ok) {
      this.done.set(true);
      this.busy.set(false);
      // Mint the local session the route guards key off — Better Auth only
      // sets a cookie, and /admin without ps_session bounces to /signin.
      this.auth.setSession(res.data.token ?? 'ba-cookie-session', this.email().trim());
      this.router.navigateByUrl('/admin');
    } else {
      this.busy.set(false);
      this.error.set(res.error);
    }
  }
}
