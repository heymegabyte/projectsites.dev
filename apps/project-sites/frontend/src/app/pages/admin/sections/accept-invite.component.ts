import { Component, inject, signal, type OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiService } from '../../../services/api.service';
import { ToastService } from '../../../services/toast.service';
import { AuthService } from '../../../services/auth.service';

@Component({
  selector: 'app-admin-accept-invite',
  standalone: true,
  template: `
    <div class="p-7 flex-1 overflow-y-auto animate-fade-in max-md:p-4" data-testid="accept-invite-section">
      <section class="card max-w-xl mx-auto text-center"
               [attr.role]="state() === 'error' ? 'alert' : 'status'"
               [attr.aria-live]="state() === 'error' ? 'assertive' : 'polite'"
               [attr.aria-busy]="state() === 'verifying' ? 'true' : null">
        @if (state() === 'verifying') {
          <div class="invite-glyph invite-glyph--cyan" data-testid="invite-glyph" aria-hidden="true">
            <span class="invite-spinner"></span>
          </div>
          <h1 class="text-base font-semibold text-white m-0">Verifying invite…</h1>
          <p class="text-[0.78rem] text-text-secondary mt-2">Checking the token from your email.</p>
        } @else if (state() === 'success') {
          <div class="invite-glyph invite-glyph--success" data-testid="invite-glyph" aria-hidden="true">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
          <h1 class="text-base font-semibold text-emerald-300 m-0 mt-2">Joined</h1>
          <p class="text-[0.78rem] text-text-secondary mt-1">Redirecting to admin…</p>
        } @else {
          <div class="invite-glyph invite-glyph--warn" data-testid="invite-glyph" aria-hidden="true">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          </div>
          <h1 class="text-base font-semibold text-amber-300 m-0 mt-2">Couldn't accept invite</h1>
          <p class="text-[0.78rem] text-text-secondary mt-1">{{ message() }}</p>
          @if (errorCode() === 'WRONG_USER') {
            <div class="flex flex-wrap gap-2 justify-center mt-3">
              <button class="btn-primary" data-testid="switch-account" (click)="switchAccount()"
                      title="Sign out, then sign in as the invited account — this invite reopens automatically">Sign out &amp; sign in as the invited account</button>
              <button class="btn-ghost" (click)="goAdmin()" title="Back to admin home">Go to admin</button>
            </div>
          } @else {
            <button class="btn-primary mt-3" (click)="goAdmin()" title="Back to admin home">Go to admin</button>
          }
        }
      </section>
    </div>
  `,
  styles: [`
    .card { background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06); border-radius: 14px; padding: 2rem; margin-top: 4rem; }
    .btn-primary { padding: 0.5rem 1rem; border-radius: 8px; background: rgba(0,229,255,0.12); color: #00E5FF; font-weight: 600; border: 1px solid rgba(0,229,255,0.35); cursor: pointer; font-size: 0.78rem; }
    .btn-ghost { padding: 0.5rem 1rem; border-radius: 8px; background: transparent; color: #c3c7cf; font-weight: 600; border: 1px solid rgba(255,255,255,0.16); cursor: pointer; font-size: 0.78rem; }
    /* Cockpit glyph halo — framed accent disc instead of a bare floating char. */
    .invite-glyph { width: 56px; height: 56px; margin: 0 auto 0.25rem; border-radius: 50%; display: grid; place-items: center; font-size: 1.5rem; line-height: 1; }
    .invite-glyph--cyan { background: rgba(0,229,255,0.10); border: 1px solid rgba(0,229,255,0.30); color: #00E5FF; }
    .invite-glyph--success { background: rgba(16,185,129,0.12); border: 1px solid rgba(16,185,129,0.35); color: #6ee7b7; }
    .invite-glyph--warn { background: rgba(245,158,11,0.12); border: 1px solid rgba(245,158,11,0.35); color: #fcd34d; }
    .invite-spinner { width: 22px; height: 22px; border: 2.5px solid rgba(0,229,255,0.25); border-top-color: #00E5FF; border-radius: 50%; animation: invite-spin 0.8s linear infinite; }
    @keyframes invite-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .invite-spinner { animation: none; } }
  `],
})
export class AdminAcceptInviteComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private auth = inject(AuthService);
  state = signal<'verifying' | 'success' | 'error'>('verifying');
  message = signal('');
  /** Server error code (e.g. WRONG_USER) — drives the contextual recovery CTA. */
  errorCode = signal('');

  ngOnInit(): void {
    const token = this.route.snapshot.queryParamMap.get('token');
    if (!token) { this.state.set('error'); this.message.set('Missing token in URL.'); return; }
    // {silent}: the error branch renders a contextual panel with the server
    // message — suppress the generic ApiService toast so an expired/used invite
    // doesn't ALSO fire a misleading "resource not found" toast on top.
    this.api.post<{ data: { joined: boolean; role: string } }>('/team/invites/accept', { token }, { silent: true }).subscribe({
      next: (r) => {
        this.state.set('success');
        this.toast.success(`Joined as ${r.data?.role ?? 'member'}`);
        setTimeout(() => this.router.navigateByUrl('/admin'), 1200);
      },
      error: (err) => {
        this.state.set('error');
        this.errorCode.set(err?.error?.error?.code || '');
        this.message.set(err?.error?.error?.message || 'Invite could not be accepted.');
      },
    });
  }
  goAdmin(): void { this.router.navigateByUrl('/admin'); }

  /**
   * WRONG_USER recovery (embarrassingly-easy): the invite is for a different email
   * than the signed-in account. Sign out, then bounce to /signin with THIS accept
   * URL (token preserved) as returnUrl — so signing in as the invited account lands
   * back here and the token auto-accepts. One click instead of "figure out how to
   * sign out, switch accounts, and re-open the email link" (≈5 steps → 1).
   */
  switchAccount(): void {
    const token = this.route.snapshot.queryParamMap.get('token') ?? '';
    this.auth.logout();
    const returnUrl = `/admin/accept-invite?token=${encodeURIComponent(token)}`;
    this.router.navigateByUrl(`/signin?returnUrl=${encodeURIComponent(returnUrl)}`);
  }
}
