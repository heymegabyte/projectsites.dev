import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { isValidEmail } from '../../../utils/validators/email';
import {
  OrgApiService,
  type FullOrganization,
  type OrgInvitation,
  type OrgMember,
  type OrgRole,
} from '../../auth/org-api.service';

/**
 * `/admin/team` — Team members + invitations (idea #24, org invites).
 *
 * @remarks
 * Lists members (email + role) and pending invitations, with an invite form
 * (email + role select), per-row remove/cancel, and a seat-usage line. All
 * org calls go through {@link OrgApiService} (its own isolated HTTP client,
 * `AuthResult<T>`, never throws). Live email validation, a busy guard on every
 * mutation, and explicit error / success / empty states. Brand dark theme, AA
 * contrast, 44px targets, `prefers-reduced-motion` safe via Tailwind `motion-*`.
 */
@Component({
  selector: 'app-admin-team',
  standalone: true,
  imports: [FormsModule, RouterLink],
  template: `
    <section class="bg-dark text-white px-6 py-8 max-md:px-4" data-testid="team-page">
      <header class="mb-6 max-w-3xl">
        <p class="text-[0.72rem] font-bold uppercase tracking-[0.15em] text-primary m-0">Organization</p>
        <h1 class="text-2xl font-extrabold tracking-tight mt-1 mb-1.5">Team members</h1>
        <p class="text-[0.88rem] text-text-secondary m-0">
          Invite teammates to manage your sites. Owners and admins can invite and remove members.
        </p>
      </header>

      @if (error()) {
        <div
          class="mb-5 max-w-3xl rounded-lg border border-red-500/30 bg-red-500/10 px-3.5 py-2.5 text-[0.82rem] text-red-300"
          role="alert"
          data-testid="team-error"
        >
          {{ error() }}
        </div>
      }

      @if (success()) {
        <div
          class="mb-5 max-w-3xl rounded-lg border border-primary/30 bg-primary-dim px-3.5 py-2.5 text-[0.82rem] text-primary"
          role="status"
          data-testid="team-success"
        >
          {{ success() }}
        </div>
      }

      <!-- Seat usage -->
      <p class="mb-6 text-[0.82rem] text-text-secondary" data-testid="team-seats">
        <span class="font-semibold text-white">{{ seatsUsed() }}</span> of
        <span class="font-semibold text-white">{{ seatsUnlimited() ? 'unlimited' : seatLimit() }}</span>
        seats used
        @if (seatsFull()) {
          <span class="text-amber-300/90" data-testid="team-seats-full">
            · Seat limit reached —
            <a routerLink="/admin/billing" class="underline hover:text-amber-200">upgrade your plan</a>
            to invite more.
          </span>
        }
      </p>

      <!-- Invite form -->
      <section
        class="mb-8 max-w-3xl rounded-2xl border border-white/[0.08] bg-dark-card p-5"
        aria-labelledby="team-invite-heading"
      >
        <h2 id="team-invite-heading" class="text-[1rem] font-bold m-0 mb-3.5">Invite a member</h2>
        <form (ngSubmit)="invite()" novalidate class="flex gap-3 items-start max-md:flex-col">
          <div class="flex-1 flex flex-col gap-1.5 w-full">
            <label for="team-invite-email" class="text-[0.78rem] font-semibold text-text-secondary">
              Email
            </label>
            <input
              id="team-invite-email"
              name="email"
              type="email"
              autocomplete="off"
              inputmode="email"
              [ngModel]="inviteEmail()"
              (ngModelChange)="inviteEmail.set($event)"
              (blur)="emailTouched.set(true)"
              [disabled]="seatsFull()"
              [attr.aria-invalid]="showEmailError()"
              aria-describedby="team-invite-email-error"
              placeholder="teammate@example.com"
              data-testid="team-invite-email"
              class="min-h-[44px] rounded-lg border border-white/[0.1] bg-dark-surface px-3.5 text-[0.9rem] text-white placeholder:text-white/30 outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
            />
            @if (showEmailError()) {
              <span
                id="team-invite-email-error"
                class="text-[0.75rem] text-red-300"
                data-testid="team-invite-email-error"
              >
                Enter a valid email address.
              </span>
            }
          </div>

          <div class="flex flex-col gap-1.5 max-md:w-full">
            <label for="team-invite-role" class="text-[0.78rem] font-semibold text-text-secondary">
              Role
            </label>
            <select
              id="team-invite-role"
              name="role"
              [ngModel]="inviteRole()"
              (ngModelChange)="inviteRole.set($event)"
              [disabled]="seatsFull()"
              data-testid="team-invite-role"
              class="min-h-[44px] rounded-lg border border-white/[0.1] bg-dark-surface px-3 text-[0.9rem] text-white outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
              <option value="owner">Owner</option>
            </select>
          </div>

          <button
            type="submit"
            [disabled]="inviting() || !emailValid() || seatsFull()"
            data-testid="team-invite-submit"
            class="min-h-[44px] self-end max-md:self-stretch rounded-lg bg-primary px-4 text-[0.9rem] font-bold text-dark transition-colors motion-safe:transition-all hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {{ inviting() ? 'Sending…' : 'Send invite' }}
          </button>
        </form>
      </section>

      @if (loading()) {
        <p class="text-[0.85rem] text-text-secondary" role="status" data-testid="team-loading">
          Loading your team…
        </p>
      } @else {
        <!-- Members -->
        <section class="mb-8 max-w-3xl" aria-labelledby="team-members-heading">
          <h2 id="team-members-heading" class="text-[1rem] font-bold m-0 mb-3">
            Members
            <span class="text-text-secondary font-normal">({{ members().length }})</span>
          </h2>
          @if (members().length) {
            <ul class="m-0 p-0 list-none flex flex-col gap-2" data-testid="team-members">
              @for (m of members(); track memberKey(m)) {
                <li
                  class="flex items-center justify-between gap-3 rounded-lg border border-white/[0.06] bg-dark-card px-3.5 py-2.5"
                  data-testid="team-member-row"
                >
                  <div class="min-w-0">
                    <span class="block text-[0.9rem] text-white font-medium truncate">{{ memberEmail(m) }}</span>
                    <span class="block text-[0.74rem] text-text-secondary capitalize">{{ m.role }}</span>
                  </div>
                  @if (isLastOwner(m)) {
                    <span
                      class="shrink-0 rounded-lg px-3 py-2 text-[0.74rem] font-medium text-text-secondary"
                      data-testid="team-last-owner"
                      title="Promote another member to owner before removing the last owner."
                    >
                      Last owner
                    </span>
                  } @else {
                    <button
                      type="button"
                      (click)="removeMember(m)"
                      [disabled]="isBusy(memberKey(m))"
                      [attr.aria-label]="'Remove ' + memberEmail(m)"
                      data-testid="team-member-remove"
                      class="min-h-[44px] shrink-0 rounded-lg border border-red-500/25 bg-transparent px-3 text-[0.8rem] font-semibold text-red-300 transition-colors hover:bg-red-500/10 focus-visible:ring-2 focus-visible:ring-red-500/40 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {{ isBusy(memberKey(m)) ? 'Removing…' : 'Remove' }}
                    </button>
                  }
                </li>
              }
            </ul>
          } @else {
            <p class="text-[0.85rem] text-text-secondary" data-testid="team-members-empty">
              No members yet.
            </p>
          }
        </section>

        <!-- Pending invitations -->
        <section class="max-w-3xl" aria-labelledby="team-invites-heading">
          <h2 id="team-invites-heading" class="text-[1rem] font-bold m-0 mb-3">
            Pending invitations
            <span class="text-text-secondary font-normal">({{ invitations().length }})</span>
          </h2>
          @if (invitations().length) {
            <ul class="m-0 p-0 list-none flex flex-col gap-2" data-testid="team-invitations">
              @for (inv of invitations(); track inv.id) {
                <li
                  class="flex items-center justify-between gap-3 rounded-lg border border-white/[0.06] bg-dark-card px-3.5 py-2.5"
                  data-testid="team-invitation-row"
                >
                  <div class="min-w-0">
                    <span class="block text-[0.9rem] text-white font-medium truncate">{{ inv.email }}</span>
                    <span class="block text-[0.74rem] text-text-secondary capitalize">
                      {{ inv.role }}@if (inv.status) { · {{ inv.status }} }
                    </span>
                  </div>
                  <button
                    type="button"
                    (click)="cancelInvitation(inv)"
                    [disabled]="isBusy(inv.id)"
                    [attr.aria-label]="'Cancel invitation for ' + inv.email"
                    data-testid="team-invitation-cancel"
                    class="min-h-[44px] shrink-0 rounded-lg border border-white/[0.12] bg-transparent px-3 text-[0.8rem] font-semibold text-text-secondary transition-colors hover:bg-white/[0.04] hover:text-white focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {{ isBusy(inv.id) ? 'Cancelling…' : 'Cancel' }}
                  </button>
                </li>
              }
            </ul>
          } @else {
            <p class="text-[0.85rem] text-text-secondary" data-testid="team-invitations-empty">
              No pending invitations.
            </p>
          }
        </section>
      }
    </section>
  `,
})
export class TeamComponent {
  private readonly orgApi = inject(OrgApiService);

  /** Default seat cap when entitlements don't surface one. */
  private static readonly DEFAULT_SEAT_LIMIT = 10;

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly success = signal<string | null>(null);

  readonly members = signal<OrgMember[]>([]);
  readonly invitations = signal<OrgInvitation[]>([]);
  readonly seatLimit = signal(TeamComponent.DEFAULT_SEAT_LIMIT);

  readonly inviteEmail = signal('');
  readonly inviteRole = signal<OrgRole>('member');
  readonly emailTouched = signal(false);
  readonly inviting = signal(false);

  /** Ids (member key / invitation id) with an in-flight mutation. */
  private readonly busyIds = signal<ReadonlySet<string>>(new Set());

  // Shared validator — local EMAIL_RE caused FE/BE parity drift (see sign-in).
  readonly emailValid = computed(() => isValidEmail(this.inviteEmail()));
  readonly showEmailError = computed(() => this.emailTouched() && !this.emailValid());
  /** Seats = active members + outstanding invitations (each holds a seat). */
  readonly seatsUsed = computed(() => this.members().length + this.invitations().length);
  /** `-1` seat limit = unlimited (enterprise) — never "full". */
  readonly seatsUnlimited = computed(() => this.seatLimit() < 0);
  /** Every seat consumed — further invites are rejected server-side (409). */
  readonly seatsFull = computed(
    () => !this.seatsUnlimited() && this.seatsUsed() >= this.seatLimit(),
  );
  /** How many owners the org has — drives the last-owner remove guard. */
  readonly ownerCount = computed(() => this.members().filter((m) => m.role === 'owner').length);

  constructor() {
    void this.load();
  }

  /** Fetch the active org's members + invitations. */
  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    const res = await this.orgApi.getFullOrganization();
    this.loading.set(false);

    if (res.ok) {
      this.applyOrg(res.data);
    } else {
      this.members.set([]);
      this.invitations.set([]);
      this.error.set(res.error);
    }
  }

  private applyOrg(org: FullOrganization): void {
    this.members.set(Array.isArray(org.members) ? org.members : []);
    this.invitations.set(
      (Array.isArray(org.invitations) ? org.invitations : []).filter(
        (i) => !i.status || i.status === 'pending',
      ),
    );
    // Show the TRUE seat cap from entitlements, not the hardcoded default —
    // a free org is 1 seat, not 10. `-1` = unlimited.
    if (typeof org.seatLimit === 'number') this.seatLimit.set(org.seatLimit);
  }

  /** Send an invite; on success, refresh the lists. */
  async invite(): Promise<void> {
    this.emailTouched.set(true);
    this.error.set(null);
    this.success.set(null);
    if (this.inviting() || !this.emailValid()) return;

    const email = this.inviteEmail().trim();
    const role = this.inviteRole();
    this.inviting.set(true);
    const res = await this.orgApi.inviteMember({ email, role });
    this.inviting.set(false);

    if (res.ok) {
      this.success.set(`Invitation sent to ${email}.`);
      this.inviteEmail.set('');
      this.emailTouched.set(false);
      await this.load();
    } else {
      this.error.set(res.error);
    }
  }

  /** Remove a member after confirmation; refresh on success. */
  async removeMember(member: OrgMember): Promise<void> {
    const key = this.memberKey(member);
    const email = this.memberEmail(member);
    if (this.isBusy(key)) return;
    if (!confirm(`Remove ${email} from your team?`)) return;

    this.error.set(null);
    this.success.set(null);
    this.setBusy(key, true);
    const res = await this.orgApi.removeMember({ memberIdOrEmail: member.id || email });
    this.setBusy(key, false);

    if (res.ok) {
      this.success.set(`Removed ${email}.`);
      await this.load();
    } else {
      this.error.set(res.error);
    }
  }

  /** Cancel a pending invitation after confirmation; refresh on success. */
  async cancelInvitation(inv: OrgInvitation): Promise<void> {
    if (this.isBusy(inv.id)) return;
    if (!confirm(`Cancel the invitation for ${inv.email}?`)) return;

    this.error.set(null);
    this.success.set(null);
    this.setBusy(inv.id, true);
    const res = await this.orgApi.cancelInvitation({ invitationId: inv.id });
    this.setBusy(inv.id, false);

    if (res.ok) {
      this.success.set(`Cancelled the invitation for ${inv.email}.`);
      await this.load();
    } else {
      this.error.set(res.error);
    }
  }

  /**
   * True when this member is the org's SOLE owner — removing them would leave
   * the org ownerless, which the server rejects (409). Mirror that guard on the
   * client so the destructive control is never offered (no confusing 409 toast).
   */
  isLastOwner(m: OrgMember): boolean {
    return m.role === 'owner' && this.ownerCount() <= 1;
  }

  /** Stable key for a member row — prefer id, fall back to email. */
  memberKey(m: OrgMember): string {
    return m.id || this.memberEmail(m);
  }

  /** Best-available email for a member across Better Auth shapes. */
  memberEmail(m: OrgMember): string {
    return m.user?.email ?? m.email ?? m.userId ?? 'Unknown member';
  }

  isBusy(id: string): boolean {
    return this.busyIds().has(id);
  }

  private setBusy(id: string, busy: boolean): void {
    const next = new Set(this.busyIds());
    if (busy) {
      next.add(id);
    } else {
      next.delete(id);
    }
    this.busyIds.set(next);
  }
}
