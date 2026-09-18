import { TestBed } from '@angular/core/testing';
import { provideRouter, RouterLink } from '@angular/router';
import { By } from '@angular/platform-browser';
import { TeamComponent } from './team.component';
import {
  OrgApiService,
  type FullOrganization,
  type OrgInvitation,
  type OrgRole,
} from '../../auth/org-api.service';
import type { AuthResult } from '../../auth/auth-api.service';

function ok<T>(data: T): AuthResult<T> {
  return { ok: true, data };
}

const FULL_ORG: FullOrganization = {
  id: 'org_1',
  name: 'Acme',
  members: [
    { id: 'mem_1', role: 'owner', user: { email: 'owner@acme.test' } },
    { id: 'mem_2', role: 'member', email: 'dev@acme.test' },
  ],
  invitations: [{ id: 'inv_1', email: 'pending@acme.test', role: 'member', status: 'pending' }],
};

function makeOrgApiMock(): jasmine.SpyObj<OrgApiService> {
  const spy = jasmine.createSpyObj<OrgApiService>('OrgApiService', [
    'getFullOrganization',
    'inviteMember',
    'cancelInvitation',
    'removeMember',
  ]);
  spy.getFullOrganization.and.resolveTo(ok(FULL_ORG));
  spy.inviteMember.and.resolveTo(ok({ id: 'inv_2', email: 'new@acme.test', role: 'member' } as OrgInvitation));
  spy.cancelInvitation.and.resolveTo(ok({ status: true }));
  spy.removeMember.and.resolveTo(ok({ status: true }));
  return spy;
}

async function setup(api?: jasmine.SpyObj<OrgApiService>) {
  const orgApi = api ?? makeOrgApiMock();
  TestBed.configureTestingModule({
    imports: [TeamComponent],
    // provideRouter([]) — routerLink/router pipeline needs a router or NG0201.
    providers: [provideRouter([]), { provide: OrgApiService, useValue: orgApi }],
  });
  const fixture = TestBed.createComponent(TeamComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, orgApi };
}

describe('TeamComponent (org members + invites — idea #24)', () => {
  it('renders members + pending invitations + seat usage from the org payload', async () => {
    const { fixture } = await setup();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('[data-testid="team-page"]')).toBeTruthy();
    expect(el.querySelectorAll('[data-testid="team-member-row"]').length).toBe(2);
    expect(el.querySelectorAll('[data-testid="team-invitation-row"]').length).toBe(1);

    const text = el.textContent ?? '';
    expect(text).toContain('owner@acme.test');
    expect(text).toContain('dev@acme.test');
    expect(text).toContain('pending@acme.test');

    // 2 members + 1 invitation = 3 seats used.
    const seats = el.querySelector('[data-testid="team-seats"]')?.textContent ?? '';
    expect(seats).toContain('3');
    expect(seats).toContain('10');
  });

  it('shows the real entitlement seat cap and blocks invite when seats are full', async () => {
    const api = makeOrgApiMock();
    // Free org: 1 seat, the owner already fills it → full.
    api.getFullOrganization.and.resolveTo(
      ok({
        id: 'org_free',
        name: 'Solo',
        seatLimit: 1,
        members: [{ id: 'mem_1', role: 'owner', email: 'solo@acme.test' }],
        invitations: [],
      } as FullOrganization),
    );
    const { fixture } = await setup(api);
    const c = fixture.componentInstance;
    const el = fixture.nativeElement as HTMLElement;

    // Truthful "1 of 1", NOT the hardcoded default of 10.
    const seats = el.querySelector('[data-testid="team-seats"]')?.textContent ?? '';
    expect(seats).toContain('1');
    expect(seats).not.toContain('10');
    expect(c.seatsFull()).toBeTrue();

    // Full → upgrade hint shows and the submit is disabled even for a valid email.
    expect(el.querySelector('[data-testid="team-seats-full"]')).toBeTruthy();
    c.inviteEmail.set('valid@acme.test');
    fixture.detectChanges();
    const submit = el.querySelector('[data-testid="team-invite-submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBeTrue();

    // Full → the WHOLE invite form is gated (embarrassingly-easy: never a doomed
    // form-fill), not just the submit button — the owner can't type into inputs that
    // can't submit ("why can I type but not send?"). email + role disable with the button.
    const email = el.querySelector('[data-testid="team-invite-email"]') as HTMLInputElement;
    const role = el.querySelector('[data-testid="team-invite-role"]') as HTMLSelectElement;
    expect(email.disabled).withContext('email input disabled when seats full').toBeTrue();
    expect(role.disabled).withContext('role select disabled when seats full').toBeTrue();

    // The "upgrade your plan" link is a routerLink (SPA nav) — NOT a raw href that
    // full-reloads the admin (destroying the bolt iframe + polling state).
    const upgradeLink = fixture.debugElement
      .queryAll(By.directive(RouterLink))
      .find((d) => /upgrade/i.test((d.nativeElement as HTMLElement).textContent ?? ''));
    expect(upgradeLink).withContext('seat-limit "upgrade your plan" must use routerLink, not href').toBeTruthy();
  });

  it('treats a seat limit of -1 as unlimited (never full)', async () => {
    const api = makeOrgApiMock();
    api.getFullOrganization.and.resolveTo(
      ok({
        id: 'org_ent',
        name: 'Ent',
        seatLimit: -1,
        members: FULL_ORG.members,
        invitations: [],
      } as FullOrganization),
    );
    const { fixture } = await setup(api);
    const c = fixture.componentInstance;
    expect(c.seatsUnlimited()).toBeTrue();
    expect(c.seatsFull()).toBeFalse();
    const seats =
      (fixture.nativeElement as HTMLElement).querySelector('[data-testid="team-seats"]')
        ?.textContent ?? '';
    expect(seats.toLowerCase()).toContain('unlimited');
  });

  it('blocks invite submit until the email is valid (busy/validity guard)', async () => {
    const { fixture, orgApi } = await setup();
    const c = fixture.componentInstance;

    // Invalid email → guarded.
    c.inviteEmail.set('not-an-email');
    expect(c.emailValid()).toBeFalse();
    await c.invite();
    expect(orgApi.inviteMember).not.toHaveBeenCalled();
    expect(c.showEmailError()).toBeTrue();

    // Valid email → goes through.
    c.inviteEmail.set('valid@acme.test');
    expect(c.emailValid()).toBeTrue();
    await c.invite();
    expect(orgApi.inviteMember).toHaveBeenCalledTimes(1);
  });

  it('passes the selected role through to inviteMember', async () => {
    const { fixture, orgApi } = await setup();
    const c = fixture.componentInstance;

    c.inviteEmail.set('admin@acme.test');
    c.inviteRole.set('admin' as OrgRole);
    await c.invite();

    expect(orgApi.inviteMember).toHaveBeenCalledWith({ email: 'admin@acme.test', role: 'admin' });
  });

  it('surfaces a load error and renders an empty team', async () => {
    const api = makeOrgApiMock();
    api.getFullOrganization.and.resolveTo({ ok: false, error: 'No active organization found.' });
    const { fixture } = await setup(api);
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('[data-testid="team-error"]')?.textContent).toContain(
      'No active organization found.',
    );
    expect(el.querySelector('[data-testid="team-members-empty"]')).toBeTruthy();
  });

  it('cancels an invitation when confirmed', async () => {
    spyOn(window, 'confirm').and.returnValue(true);
    const { fixture, orgApi } = await setup();
    await fixture.componentInstance.cancelInvitation(FULL_ORG.invitations[0]);
    expect(orgApi.cancelInvitation).toHaveBeenCalledWith({ invitationId: 'inv_1' });
  });

  it('does not remove a member when the confirm is declined', async () => {
    spyOn(window, 'confirm').and.returnValue(false);
    const { fixture, orgApi } = await setup();
    await fixture.componentInstance.removeMember(FULL_ORG.members[1]);
    expect(orgApi.removeMember).not.toHaveBeenCalled();
  });

  it('guards the SOLE owner — shows "Last owner", not a Remove button (mirrors server 409)', async () => {
    // FULL_ORG has exactly one owner (owner@acme.test) + one member (dev@acme.test).
    const { fixture } = await setup();
    const c = fixture.componentInstance;
    const el = fixture.nativeElement as HTMLElement;

    expect(c.ownerCount()).toBe(1);
    expect(c.isLastOwner(FULL_ORG.members[0])).toBeTrue(); // the sole owner
    expect(c.isLastOwner(FULL_ORG.members[1])).toBeFalse(); // a plain member

    // The sole owner's row offers the non-destructive "Last owner" label…
    expect(el.querySelectorAll('[data-testid="team-last-owner"]').length).toBe(1);
    // …and only the member row keeps a Remove button.
    expect(el.querySelectorAll('[data-testid="team-member-remove"]').length).toBe(1);
  });

  it('allows removing an owner when the org has TWO owners (no last-owner lock)', async () => {
    const api = makeOrgApiMock();
    api.getFullOrganization.and.resolveTo(
      ok({
        id: 'org_two',
        name: 'Duo',
        members: [
          { id: 'mem_1', role: 'owner', email: 'a@acme.test' },
          { id: 'mem_2', role: 'owner', email: 'b@acme.test' },
        ],
        invitations: [],
      } as FullOrganization),
    );
    const { fixture } = await setup(api);
    const c = fixture.componentInstance;
    const el = fixture.nativeElement as HTMLElement;

    expect(c.ownerCount()).toBe(2);
    expect(c.isLastOwner(c.members()[0])).toBeFalse();
    // Both owners are removable → 2 Remove buttons, 0 "Last owner" labels.
    expect(el.querySelectorAll('[data-testid="team-member-remove"]').length).toBe(2);
    expect(el.querySelectorAll('[data-testid="team-last-owner"]').length).toBe(0);
  });
});
