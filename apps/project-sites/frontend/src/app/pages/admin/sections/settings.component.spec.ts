import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal, type WritableSignal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { of, throwError, Subject } from 'rxjs';
import { AdminSettingsComponent } from './settings.component';
import { ApiService } from '../../../services/api.service';
import { ToastService } from '../../../services/toast.service';
import { ConfirmService } from '../../../services/confirm.service';
import { AuthService } from '../../../services/auth.service';
import { AdminStateService } from '../admin-state.service';
import { AdminWebhooksComponent } from './webhooks.component';
import { AdminDeliverabilityComponent } from './deliverability.component';
import { AdminDomainsComponent } from './domains.component';
import { AdminApiTokensComponent } from './api-tokens.component';

/**
 * Convergence r23 cohesion guard for the Settings section.
 *
 * Locks the cyan/black overview stat strip (rolling counters reflect live
 * connection/team state), the tablist a11y contract (role + aria-selected),
 * and the reveal-on-mount animation that every tab shares.
 */
describe('AdminSettingsComponent (cyan/black cohesion + a11y)', () => {
  let fixture: ComponentFixture<AdminSettingsComponent>;
  let selectedSite: WritableSignal<{ id: string; slug: string; business_name?: string } | null>;

  function build(initial: { id: string; slug: string } | null): void {
    selectedSite = signal(initial);
    TestBed.configureTestingModule({
      imports: [AdminSettingsComponent],
      providers: [
        {
          provide: ApiService,
          useValue: {
            get: jasmine.createSpy('get').and.returnValue(of({ data: null })),
            put: jasmine.createSpy('put').and.returnValue(of({})),
            post: jasmine.createSpy('post').and.returnValue(of({})),
            delete: jasmine.createSpy('delete').and.returnValue(of({})),
            updateSite: jasmine.createSpy('updateSite').and.returnValue(of({})),
          },
        },
        { provide: ToastService, useValue: { error: jasmine.createSpy('error'), success: jasmine.createSpy('success'), info: jasmine.createSpy('info'), warning: jasmine.createSpy('warning') } },
        { provide: ConfirmService, useValue: { confirm: jasmine.createSpy('confirm').and.resolveTo(false) } },
        { provide: Router, useValue: { navigate: jasmine.createSpy('navigate') } },
        { provide: ActivatedRoute, useValue: { firstChild: null, fragment: of(null), snapshot: { fragment: null, url: [] } } },
        { provide: AdminStateService, useValue: { selectedSite, loadData: () => undefined } },
      ],
    });
    fixture = TestBed.createComponent(AdminSettingsComponent);
    fixture.detectChanges();
  }

  afterEach(() => TestBed.resetTestingModule());

  // The MCP env-vars manager is a full-width component; inside a 1/3-width
  // provider card it squished ("all the other content was squished on one
  // side"). Opening it makes the card span the full grid row
  // (`[class.col-span-full]="isMcpEnvVarsOpen(p.id)"`). This locks the toggle
  // that drives that span.
  it('toggleMcpEnvVars opens/closes the per-provider env-vars panel (drives the full-width span)', () => {
    build({ id: 's', slug: 'demo' });
    const c = fixture.componentInstance;
    expect(c.isMcpEnvVarsOpen('mailchimp')).toBeFalse();
    c.toggleMcpEnvVars('mailchimp');
    expect(c.isMcpEnvVarsOpen('mailchimp')).toBeTrue();
    c.toggleMcpEnvVars('mailchimp'); // toggles closed again
    expect(c.isMcpEnvVarsOpen('mailchimp')).toBeFalse();
  });

  it('MCP tab conveys project AI vars: callout + link + a >8 expand toggle', () => {
    build({ id: 's', slug: 'demo' });
    const c = fixture.componentInstance;
    c.orgEnvVars.set(Array.from({ length: 10 }, (_, i) => ({ key: 'VAR_' + i, exposed_to_ai: i % 2 === 0 })));
    c.setTab('mcp');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="mcp-aivars-link"]')).withContext('link to AI Env Vars').not.toBeNull();
    // First 8 shown; the >8 toggle appears and expands to all 10.
    expect(el.querySelectorAll('[data-testid="mcp-aivars-list"] li').length).withContext('first 8 shown').toBe(8);
    const toggle = el.querySelector('[data-testid="mcp-aivars-toggle"]') as HTMLButtonElement | null;
    expect(toggle).withContext('>8 → expand toggle present').not.toBeNull();
    toggle!.click();
    fixture.detectChanges();
    expect(el.querySelectorAll('[data-testid="mcp-aivars-list"] li').length).withContext('expands to all 10').toBe(10);
  });

  it('brand-asset uploaders: a branded button opens a HIDDEN typed input + a format/size hint (no native "No file chosen")', () => {
    build({ id: 's', slug: 'demo' });
    fixture.componentInstance.setTab('general');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const logo = el.querySelector('[data-testid="business-logo-upload"]') as HTMLInputElement;
    const icon = el.querySelector('[data-testid="business-icon-upload"]') as HTMLInputElement;
    // native inputs are HIDDEN (so the browser's unpolished "No file chosen" never shows)…
    expect(logo).withContext('logo input present').not.toBeNull();
    expect(logo.classList.contains('hidden')).withContext('logo input hidden').toBeTrue();
    expect(icon.classList.contains('hidden')).withContext('icon input hidden').toBeTrue();
    // …but keep their type-constraint contract (locks settings-upload-affordances.spec.ts)
    expect(logo.getAttribute('accept')).toBe('image/*');
    expect(icon.getAttribute('accept')).toBe('image/png,image/jpeg,image/webp');
    // a format/size hint sets expectations BEFORE upload (matches the on-change size cap)
    const hints = Array.from(el.querySelectorAll('.biz-file-hint')).map((h) => h.textContent || '');
    expect(hints.some((t) => /up to 5.*MB/.test(t))).withContext('logo 5MB hint').toBeTrue();
    expect(hints.some((t) => /up to 2.*MB/.test(t))).withContext('icon 2MB hint').toBeTrue();
    // the branded trigger opens the hidden input (label→input association replaced by a click)
    const btn = el.querySelector('.biz-file-btn') as HTMLButtonElement;
    const clickSpy = spyOn(logo, 'click');
    btn.click();
    expect(clickSpy).withContext('button triggers the hidden file input').toHaveBeenCalled();
  });

  it('emailInvalid flags a malformed contact email (empty optional = valid); saveGeneral no-ops when invalid', () => {
    build({ id: 's', slug: 'demo' });
    const c = fixture.componentInstance;
    c.business.contact_email = '';
    expect(c.emailInvalid(c.business.contact_email)).withContext('empty optional email is valid').toBeFalse();
    c.business.business_name = 'Acme';
    c.business.contact_email = 'not-an-email';
    expect(c.emailInvalid(c.business.contact_email)).withContext('malformed contact email → invalid').toBeTrue();
    const api = TestBed.inject(ApiService) as unknown as { updateSite: jasmine.Spy };
    c.saveGeneral(new Event('submit'));
    expect(api.updateSite).withContext('no save with an invalid email — real validation, not a silent garbage save').not.toHaveBeenCalled();
  });

  it('saveGeneral persists identity + MIRRORS contact_email → reply_email (one email field, not two)', () => {
    build({ id: 's', slug: 'demo' });
    const c = fixture.componentInstance;
    const api = TestBed.inject(ApiService) as unknown as { updateSite: jasmine.Spy; put: jasmine.Spy };
    c.business.business_name = 'Acme';
    c.business.contact_email = 'hi@acme.com';
    c.saveGeneral(new Event('submit'));
    expect(api.updateSite).withContext('business identity persists to the site record').toHaveBeenCalled();
    expect(api.put).withContext('contact + reply written as the SAME value').toHaveBeenCalledWith(
      '/sites/s/ai-settings', { contact_email: 'hi@acme.com', reply_email: 'hi@acme.com' });
  });

  // The Save button gate already disables on an invalid email; it MUST also disable
  // on the empty REQUIRED business_name — otherwise the button looks saveable, the
  // user clicks, and saveGeneral() silently no-op-blocks (confusing "active but does
  // nothing" control). This locks the gate's completeness.
  it('disables the General Save button when the required business_name is empty', () => {
    build({ id: 's', slug: 'demo' });
    const c = fixture.componentInstance;
    const el = fixture.nativeElement as HTMLElement;
    const save = () => el.querySelector('[data-testid="general-save"]') as HTMLButtonElement | null;
    // Dirty + valid email, but the required name cleared → Save MUST be disabled.
    c.business.business_name = '';
    c.business.contact_email = 'hi@acme.com';
    c.businessDirty.set(true);
    fixture.detectChanges();
    expect(save()).withContext('General save button present').not.toBeNull();
    expect(save()!.disabled).withContext('empty required business_name → Save disabled').toBeTrue();
    // Restore a name → Save enabled (dirty + non-empty name + valid email).
    c.business.business_name = 'Acme';
    c.businessDirty.set(true);
    fixture.detectChanges();
    expect(save()!.disabled).withContext('valid name + dirty + valid email → Save enabled').toBeFalse();
  });

  // Disabling Save on an empty required name is necessary but not SUFFICIENT — a
  // silently-greyed Save with no reason is a confusing dead-control (WCAG 3.3.1
  // Error Identification). markBusinessDirty (fires on every ngModelChange) must
  // live-validate the one required field so #biz-err-name + aria-invalid appear
  // the moment the name is cleared, mirroring Social's publishBlockReason pattern.
  it('shows a live required-field error + aria-invalid when business_name is cleared', () => {
    build({ id: 's', slug: 'demo' });
    const c = fixture.componentInstance;
    const el = fixture.nativeElement as HTMLElement;
    const nameInput = () => el.querySelector('[data-testid="business-name"]') as HTMLInputElement | null;
    const errText = () => (el.querySelector('#biz-err-name')?.textContent || '').trim();

    // A valid name → no error.
    c.business.business_name = 'Acme';
    c.markBusinessDirty();
    fixture.detectChanges();
    expect(c.businessErrors().business_name).withContext('valid name → no error').toBeFalsy();

    // Clearing the required name → live error + aria-invalid + rendered message.
    c.business.business_name = '';
    c.markBusinessDirty();
    fixture.detectChanges();
    expect(c.businessErrors().business_name)
      .withContext('cleared required name surfaces a live error (explains the disabled Save)')
      .toBe('Business name is required.');
    expect(nameInput()?.getAttribute('aria-invalid'))
      .withContext('empty required field is aria-invalid').toBe('true');
    expect(errText()).withContext('#biz-err-name renders the message').toBe('Business name is required.');

    // Typing a valid name again clears it live.
    c.business.business_name = 'Acme Co';
    c.markBusinessDirty();
    fixture.detectChanges();
    expect(c.businessErrors().business_name).withContext('valid again → error cleared').toBeFalsy();
    expect(nameInput()?.getAttribute('aria-invalid')).withContext('valid → not aria-invalid').toBeNull();
  });

  // Team + invite emails are reply targets ([[always]] mailto mandate). The team
  // rows aren't clickable, so a plain mailto link is the clean fix (no propagation).
  it('renders team member + pending-invite emails as mailto: links', () => {
    build({ id: 's', slug: 'demo' });
    fixture.componentInstance.tab.set('team');
    fixture.componentInstance.members.set([
      { id: 'm1', email: 'team@example.com', role: 'admin', created_at: new Date().toISOString() } as never,
    ]);
    fixture.componentInstance.invites.set([
      { id: 'i1', email: 'invite@example.com', role: 'editor', created_at: new Date().toISOString() } as never,
    ]);
    fixture.detectChanges();
    const hrefs = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('a[href^="mailto:"]'))
      .map((a) => a.getAttribute('href'));
    expect(hrefs).withContext('member email is a mailto link').toContain('mailto:team@example.com');
    expect(hrefs).withContext('pending-invite email is a mailto link').toContain('mailto:invite@example.com');
  });

  it('exposes the tabs as a tablist with one selected tab', () => {
    build({ id: 's', slug: 'demo' });
    const el = fixture.nativeElement as HTMLElement;
    const nav = el.querySelector('nav[role="tablist"]');
    expect(nav).toBeTruthy();
    const tabs = el.querySelectorAll('button[role="tab"]');
    // 9 tabs: the Business tab was folded into General (2026-08-12), so:
    // General · Team · AI Chat · MCP · AI Env Vars · Webhooks · Email · Domains · API Tokens.
    expect(tabs.length).toBe(9);
    const selected = Array.from(tabs).filter((t) => t.getAttribute('aria-selected') === 'true');
    expect(selected.length).toBe(1);
    const labels = Array.from(tabs).map((t) => t.textContent?.trim());
    expect(labels).withContext('Webhooks now a Settings tab').toContain('Webhooks');
    expect(labels).withContext('Email now a Settings tab').toContain('Email');
    expect(labels).withContext('Domains now a Settings tab').toContain('Domains');
    expect(labels).withContext('API Tokens now a Settings tab').toContain('API Tokens');
    expect(labels).withContext('Business tab folded into General').not.toContain('Business');
  });

  it('embeds the Webhooks surface under its own Settings tab (moved from top-level nav)', () => {
    // Isolate from AdminWebhooksComponent's own DI graph (RouterLink etc.) —
    // assert it MOUNTS in the tabpanel, not its internals.
    selectedSite = signal({ id: 's', slug: 'demo' });
    TestBed.configureTestingModule({
      imports: [AdminSettingsComponent],
      providers: [
        { provide: ApiService, useValue: { get: () => of({ data: null }), put: () => of({}), post: () => of({}), delete: () => of({}) } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0, info: () => 0, warning: () => 0 } },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(false) } },
        { provide: Router, useValue: { navigate: jasmine.createSpy('navigate') } },
        { provide: ActivatedRoute, useValue: { firstChild: null, fragment: of('webhooks'), snapshot: { fragment: 'webhooks', url: [] } } },
        { provide: AdminStateService, useValue: { selectedSite, loadData: () => undefined } },
      ],
    });
    TestBed.overrideComponent(AdminWebhooksComponent, { set: { template: '<div data-testid="wh-stub"></div>', imports: [] } });
    fixture = TestBed.createComponent(AdminSettingsComponent);
    fixture.detectChanges();
    fixture.componentInstance.setTab('webhooks');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const panel = el.querySelector('[data-testid="settings-webhooks-panel"]');
    expect(panel).withContext('webhooks tabpanel renders').toBeTruthy();
    expect(panel!.getAttribute('role')).toBe('tabpanel');
    expect(panel!.getAttribute('aria-labelledby')).toBe('settings-tab-webhooks');
    expect(el.querySelector('app-admin-webhooks')).withContext('webhooks component embedded').toBeTruthy();
  });

  it('embeds the Domains surface under its own Settings tab (moved from top-level nav 2026-08-12)', () => {
    // Isolate from AdminDomainsComponent's own DI graph — assert it MOUNTS in
    // the tabpanel, not its internals.
    selectedSite = signal({ id: 's', slug: 'demo' });
    TestBed.configureTestingModule({
      imports: [AdminSettingsComponent],
      providers: [
        { provide: ApiService, useValue: { get: () => of({ data: null }), put: () => of({}), post: () => of({}), delete: () => of({}) } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0, info: () => 0, warning: () => 0 } },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(false) } },
        { provide: Router, useValue: { navigate: jasmine.createSpy('navigate') } },
        { provide: ActivatedRoute, useValue: { firstChild: null, fragment: of('domains'), snapshot: { fragment: 'domains', url: [], queryParamMap: { get: () => null } } } },
        { provide: AdminStateService, useValue: { selectedSite, loadData: () => undefined } },
      ],
    });
    TestBed.overrideComponent(AdminDomainsComponent, { set: { template: '<div data-testid="dom-stub"></div>', imports: [] } });
    fixture = TestBed.createComponent(AdminSettingsComponent);
    fixture.detectChanges();
    fixture.componentInstance.setTab('domains');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const panel = el.querySelector('[data-testid="settings-domains-panel"]');
    expect(panel).withContext('domains tabpanel renders').toBeTruthy();
    expect(panel!.getAttribute('role')).toBe('tabpanel');
    expect(panel!.getAttribute('aria-labelledby')).toBe('settings-tab-domains');
    expect(el.querySelector('app-admin-domains')).withContext('domains component embedded').toBeTruthy();
  });

  it('embeds the API Tokens surface under its own Settings tab (moved from top-level nav 2026-08-12)', () => {
    // Isolate from AdminApiTokensComponent's own DI graph — assert it MOUNTS in
    // the tabpanel, not its internals (the component self-gates on public_api_v1).
    // ActivatedRoute stub carries queryParamMap: the component reads ?sort= at
    // field-init (bookmarkable sort), so a bare snapshot would throw on construct.
    selectedSite = signal({ id: 's', slug: 'demo' });
    TestBed.configureTestingModule({
      imports: [AdminSettingsComponent],
      providers: [
        { provide: ApiService, useValue: { get: () => of({ data: null }), put: () => of({}), post: () => of({}), delete: () => of({}) } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0, info: () => 0, warning: () => 0 } },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(false) } },
        { provide: Router, useValue: { navigate: jasmine.createSpy('navigate') } },
        { provide: ActivatedRoute, useValue: { firstChild: null, fragment: of('api-tokens'), snapshot: { fragment: 'api-tokens', url: [], queryParamMap: { get: () => null } } } },
        // orgId() is read by AdminApiTokensComponent.loadTokens (constructor effect).
        { provide: AdminStateService, useValue: { selectedSite, loadData: () => undefined, orgId: () => 'org-1' } },
      ],
    });
    TestBed.overrideComponent(AdminApiTokensComponent, { set: { template: '<div data-testid="tok-stub"></div>', imports: [] } });
    fixture = TestBed.createComponent(AdminSettingsComponent);
    fixture.detectChanges();
    fixture.componentInstance.setTab('api-tokens');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const panel = el.querySelector('[data-testid="settings-api-tokens-panel"]');
    expect(panel).withContext('api-tokens tabpanel renders').toBeTruthy();
    expect(panel!.getAttribute('role')).toBe('tabpanel');
    expect(panel!.getAttribute('aria-labelledby')).toBe('settings-tab-api-tokens');
    expect(el.querySelector('app-admin-api-tokens')).withContext('api-tokens component embedded').toBeTruthy();
  });

  it('Email tab shows the free-send allowance + a NON-dead SMTP affordance + embeds Deliverability', () => {
    // Isolate from the embedded components' DI graphs (RouterLink etc.).
    selectedSite = signal({ id: 's', slug: 'demo' });
    TestBed.configureTestingModule({
      imports: [AdminSettingsComponent],
      providers: [
        { provide: ApiService, useValue: { get: () => of({ data: null }), put: () => of({}), post: () => of({}), delete: () => of({}) } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0, info: () => 0, warning: () => 0 } },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(false) } },
        { provide: Router, useValue: { navigate: jasmine.createSpy('navigate') } },
        { provide: ActivatedRoute, useValue: { firstChild: null, fragment: of('email'), snapshot: { fragment: 'email', url: [] } } },
        { provide: AdminStateService, useValue: { selectedSite, loadData: () => undefined } },
      ],
    });
    TestBed.overrideComponent(AdminDeliverabilityComponent, { set: { template: '<div data-testid="dlv-stub"></div>', imports: [] } });
    fixture = TestBed.createComponent(AdminSettingsComponent);
    fixture.detectChanges();
    fixture.componentInstance.setTab('email');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const panel = el.querySelector('[data-testid="settings-email-panel"]');
    expect(panel).withContext('email tabpanel renders').toBeTruthy();
    expect(panel!.getAttribute('role')).toBe('tabpanel');
    expect(panel!.getAttribute('aria-labelledby')).toBe('settings-tab-email');
    // Free-send allowance card surfaces the cap figure + the shared sender.
    const allowance = el.querySelector('[data-testid="email-allowance-card"]');
    expect(allowance?.textContent).withContext('shared sender shown').toContain('noreply@projectsites.dev');
    expect(allowance?.querySelector('app-rolling-counter')).withContext('cap figure rolls').toBeTruthy();
    // SMTP affordance is a graceful, disabled coming-soon control — never a dead/mutating button.
    const smtpBtn = el.querySelector('[data-testid="email-smtp-configure"]') as HTMLButtonElement | null;
    expect(smtpBtn).withContext('SMTP affordance present').toBeTruthy();
    expect(smtpBtn!.disabled).withContext('disabled — backend persistence not yet shipped').toBeTrue();
    expect(smtpBtn!.getAttribute('aria-disabled')).toBe('true');
    // The SMTP card is an informative feature-preview (benefit bullets), not a bare stub.
    const benefits = el.querySelectorAll('[data-testid="email-smtp-card"] .smtp-benefits li');
    expect(benefits.length).withContext('SMTP benefits previewed').toBe(3);
    // The "Coming soon" pill uses the cyan-token class (cockpit cohesion), NOT a
    // hardcoded amber inline style (brand-token drift).
    const soon = el.querySelector('[data-testid="email-smtp-soon"]') as HTMLElement | null;
    expect(soon).withContext('coming-soon pill present').toBeTruthy();
    expect(soon!.classList.contains('coming-soon-pill')).withContext('uses the shared cyan-token pill class').toBeTrue();
    expect(soon!.getAttribute('style')).withContext('no hardcoded inline color/amber').toBeNull();
    // Deliverability (SPF/DKIM/DMARC) is embedded under the same tab.
    expect(el.querySelector('app-admin-deliverability')).withContext('deliverability embedded').toBeTruthy();
  });

  it('associates the active panel with its tab (APG: role=tabpanel + aria-labelledby ↔ tab id + aria-controls)', () => {
    build({ id: 's', slug: 'demo' }); // default tab = general
    const el = fixture.nativeElement as HTMLElement;
    const panel = el.querySelector('[role="tabpanel"]');
    expect(panel).withContext('active panel exposes role=tabpanel').toBeTruthy();
    expect(panel!.id).toBe('settings-panel');
    expect(panel!.getAttribute('aria-labelledby')).withContext('panel labelled by the active tab').toBe('settings-tab-general');
    const labelTab = el.querySelector('#settings-tab-general');
    expect(labelTab).withContext('aria-labelledby resolves to a real tab').toBeTruthy();
    expect(labelTab!.getAttribute('role')).toBe('tab');
    expect(labelTab!.getAttribute('aria-controls')).withContext('tab points back at its panel').toBe('settings-panel');
  });

  it('the settings tablist is keyboard-navigable — ArrowRight moves focus to the next tab (hlmTablist APG roving)', () => {
    build({ id: 's', slug: 'demo' });
    const host = fixture.nativeElement as HTMLElement;
    document.body.appendChild(host); // focus() + document.activeElement need the el in the doc
    try {
      const nav = host.querySelector('nav[role="tablist"]')!;
      const tabs = Array.from(nav.querySelectorAll('button[role="tab"]')) as HTMLButtonElement[];
      expect(tabs.length).withContext('multiple settings tabs').toBeGreaterThan(1);
      tabs[0].focus();
      tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      expect(document.activeElement)
        .withContext('ArrowRight moves focus to the next tab (APG roving tabindex)').toBe(tabs[1]);
    } finally {
      host.remove();
    }
  });

  it('revokeInvite confirms (danger) before deleting the invite; cancel → no DELETE', async () => {
    build({ id: 's', slug: 'demo' });
    const c = fixture.componentInstance;
    const api = TestBed.inject(ApiService) as unknown as { delete: jasmine.Spy };
    const confirm = TestBed.inject(ConfirmService) as unknown as { confirm: jasmine.Spy };
    // confirm resolves false by default → cancelled
    await c.revokeInvite({ id: 'inv1', email: 'x@y.com' } as never);
    expect(confirm.confirm).withContext('a destructive revoke must confirm first').toHaveBeenCalled();
    expect((confirm.confirm.calls.mostRecent().args[0] as { danger?: boolean }).danger).withContext('red destructive modal').toBeTrue();
    expect(api.delete).withContext('no DELETE when cancelled').not.toHaveBeenCalled();
    // confirmed → deletes the invite
    confirm.confirm.and.resolveTo(true);
    await c.revokeInvite({ id: 'inv1', email: 'x@y.com' } as never);
    expect(api.delete).toHaveBeenCalledWith('/team/invites/inv1');
  });

  it('navigates within the SPA (fragment route) when switching tabs — no full reload', () => {
    build({ id: 's', slug: 'demo' });
    const router = TestBed.inject(Router) as unknown as { navigate: jasmine.Spy };
    fixture.componentInstance.setTab('mcp');
    expect(router.navigate).toHaveBeenCalledWith([], { fragment: 'mcp', replaceUrl: true });
    expect(fixture.componentInstance.tab()).toBe('mcp');
  });

  // AL-044: the in-app cross-tab links (`routerLink="." [fragment]="'mcp'"` / `'env-vars'`)
  // change the URL fragment WITHOUT re-running ngOnInit, so the snapshot-only read left them
  // dead — confirmed in a real browser (URL → #env-vars, tab stayed on MCP). ngOnInit now
  // subscribes to route.fragment; a fragment-only nav switches the tab. Unknown fragments
  // are ignored (guarded by TABS membership).
  it('switches the tab on a fragment-only navigation AFTER init (fixes the dead cross-tab links)', () => {
    const frag = new Subject<string | null>();
    selectedSite = signal({ id: 's', slug: 'demo' });
    TestBed.configureTestingModule({
      imports: [AdminSettingsComponent],
      providers: [
        { provide: ApiService, useValue: { get: () => of({ data: null }), put: () => of({}), post: () => of({}), delete: () => of({}) } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0, info: () => 0, warning: () => 0 } },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(false) } },
        { provide: Router, useValue: { navigate: jasmine.createSpy('navigate') } },
        { provide: ActivatedRoute, useValue: { firstChild: null, fragment: frag.asObservable(), snapshot: { fragment: null, url: [] } } },
        { provide: AdminStateService, useValue: { selectedSite, loadData: () => undefined, orgId: () => 'org-1' } },
      ],
    });
    fixture = TestBed.createComponent(AdminSettingsComponent);
    fixture.detectChanges(); // ngOnInit subscribes; starts on 'general'
    expect(fixture.componentInstance.tab()).toBe('general');
    frag.next('env-vars'); // the in-app [fragment=env-vars] link → fragment-only nav
    expect(fixture.componentInstance.tab()).withContext('dead cross-tab link now switches the tab').toBe('env-vars');
    frag.next('not-a-real-tab'); // an unknown fragment must be ignored, not blank the panel
    expect(fixture.componentInstance.tab()).withContext('unknown fragment ignored').toBe('env-vars');
  });

});

/**
 * sendInvite emails a real team invite to invite.email. It had no client
 * validation → a typo POSTs /team/invites and round-trips to a generic server
 * error. Now it validates the address first (useful inline error, no wasted
 * POST) — the CRUD "real validation + useful errors" bar.
 */
describe('AdminSettingsComponent (invite email validation)', () => {
  let post: jasmine.Spy;
  let error: jasmine.Spy;
  function build(): AdminSettingsComponent {
    post = jasmine.createSpy('post').and.returnValue(of({}));
    error = jasmine.createSpy('error');
    TestBed.configureTestingModule({
      imports: [AdminSettingsComponent],
      providers: [
        { provide: ApiService, useValue: { get: () => of({ data: null }), put: () => of({}), post, delete: () => of({}) } },
        { provide: ToastService, useValue: { error, success: () => 0, info: () => 0, warning: () => 0 } },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(false) } },
        { provide: Router, useValue: { navigate: () => undefined } },
        { provide: ActivatedRoute, useValue: { firstChild: null, fragment: of(null), snapshot: { fragment: null, url: [] } } },
        { provide: AdminStateService, useValue: { selectedSite: signal({ id: 's1', slug: 's' }), loadData: () => undefined } },
      ],
    });
    return TestBed.createComponent(AdminSettingsComponent).componentInstance;
  }
  afterEach(() => TestBed.resetTestingModule());

  it('rejects a malformed invite email — no POST, useful error', () => {
    const c = build();
    c.invite = { email: 'notanemail', role: 'editor' };
    c.sendInvite();
    expect(post).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });

  it('rejects an empty invite email', () => {
    const c = build();
    c.invite = { email: '   ', role: 'editor' };
    c.sendInvite();
    expect(post).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });

  it('accepts a well-formed email — POSTs once to /team/invites', () => {
    const c = build();
    c.invite = { email: 'mate@example.com', role: 'editor' };
    c.sendInvite();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.calls.mostRecent().args[0]).toBe('/team/invites');
  });

  it('inviteEmailInvalid() is true only for a non-empty malformed value', () => {
    const c = build();
    c.invite = { email: '', role: 'editor' };
    expect(c.inviteEmailInvalid()).toBe(false); // empty = incomplete, not "invalid"
    c.invite = { email: 'nope', role: 'editor' };
    expect(c.inviteEmailInvalid()).toBe(true);
    c.invite = { email: 'ok@x.io', role: 'editor' };
    expect(c.inviteEmailInvalid()).toBe(false);
  });
});

/**
 * WCAG 4.1.2 — the invite form's email input + role select are placeholder-only
 * inside a 3-col grid with NO visible label, so a screen reader announced them
 * with no purpose. They get an aria-label (no visible label exists to associate).
 */
describe('AdminSettingsComponent (invite control accessible names)', () => {
  function render(): ComponentFixture<AdminSettingsComponent> {
    TestBed.configureTestingModule({
      imports: [AdminSettingsComponent],
      providers: [
        { provide: ApiService, useValue: { get: () => of({ data: null }), put: () => of({}), post: () => of({}), delete: () => of({}) } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0, info: () => 0, warning: () => 0 } },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(false) } },
        { provide: Router, useValue: { navigate: () => undefined } },
        { provide: ActivatedRoute, useValue: { firstChild: null, fragment: of(null), snapshot: { fragment: null, url: [] } } },
        { provide: AdminStateService, useValue: { selectedSite: signal({ id: 's1', slug: 's' }), loadData: () => undefined } },
      ],
    });
    const fx = TestBed.createComponent(AdminSettingsComponent);
    fx.detectChanges();                       // run ngOnInit first (it may set tab from the route)
    fx.componentInstance.tab.set('team');     // the invite form lives in the Team tab
    fx.componentInstance.inviting.set(true);
    fx.detectChanges();
    return fx;
  }
  const inviteEmail = (el: HTMLElement) => el.querySelector('input[placeholder="teammate@email.com"]') as HTMLInputElement | null;
  const accName = (c: Element, el: HTMLElement) => c.getAttribute('aria-label') || (c.id && el.querySelector(`label[for="${c.id}"]`));
  afterEach(() => TestBed.resetTestingModule());

  it('the invite email input has an accessible name', () => {
    const el = render().nativeElement as HTMLElement;
    const input = inviteEmail(el)!;
    expect(input).withContext('invite form rendered in Team tab').toBeTruthy();
    expect(accName(input, el)).withContext('email input has aria-label or associated label').toBeTruthy();
  });

  it('the invite role select has an accessible name', () => {
    const el = render().nativeElement as HTMLElement;
    const grid = inviteEmail(el)!.closest('.grid')!;
    const select = grid.querySelector('select') as HTMLSelectElement;
    expect(select).withContext('role select in the invite grid').toBeTruthy();
    expect(accName(select, el)).withContext('role select has aria-label or associated label').toBeTruthy();
  });
});

/**
 * submitPaste() POSTs an MCP paste-key (connects an integration). It had no
 * in-flight guard + the Save button had no [disabled], so rapid clicks fired
 * duplicate connect POSTs during the request window. pasteSaving() now guards
 * the handler + disables the button.
 */
describe('AdminSettingsComponent (paste-key connect is double-submit-safe)', () => {
  function build(post: jasmine.Spy): AdminSettingsComponent {
    TestBed.configureTestingModule({
      imports: [AdminSettingsComponent],
      providers: [
        { provide: ApiService, useValue: { get: () => of({ data: null }), put: () => of({}), post, delete: () => of({}) } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0, info: () => 0, warning: () => 0 } },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(false) } },
        { provide: Router, useValue: { navigate: () => undefined } },
        { provide: ActivatedRoute, useValue: { firstChild: null, fragment: of(null), snapshot: { fragment: null, url: [] } } },
        { provide: AdminStateService, useValue: { selectedSite: signal({ id: 's1', slug: 'demo' }), loadData: () => undefined } },
      ],
    });
    const c = TestBed.createComponent(AdminSettingsComponent).componentInstance;
    c.pastedKey = 'sk-test-123';
    return c;
  }
  afterEach(() => TestBed.resetTestingModule());

  it('fires only ONE POST while the first paste-connect is in flight', () => {
    const inflight = new Subject<unknown>(); // never completes → request stays pending
    const post = jasmine.createSpy('post').and.returnValue(inflight.asObservable());
    const c = build(post);
    c.submitPaste('stripe');
    c.submitPaste('stripe'); // second rapid click while the first is pending
    expect(post).toHaveBeenCalledTimes(1);
    expect(c.pasteSaving()).withContext('in-flight flag set').toBeTrue();
  });

  it('clears the in-flight flag after the POST resolves (re-submittable)', () => {
    const post = jasmine.createSpy('post').and.returnValue(of({}));
    const c = build(post);
    c.submitPaste('stripe');
    expect(c.pasteSaving()).toBeFalse(); // synchronous of({}) completed
  });
});

import { NEVER } from 'rxjs';
import { ConfirmService as ConfirmService2 } from '../../../services/confirm.service';
import { Router as Router2, ActivatedRoute as ActivatedRoute2 } from '@angular/router';

/**
 * WCAG 4.1.3 (Status Messages) + 1.3.1 — the 2FA toggle on the Team tab is the
 * most security-sensitive control in this section and persists ASYNCHRONOUSLY
 * (no Save button). While the PUT is in flight the only feedback was a visual
 * "saving…" span (no aria-live) and the checkbox carried no aria-busy, so a
 * screen-reader user toggling "Require 2FA" got ZERO signal that a network save
 * was running. The control now exposes aria-busy and the status text is an
 * aria-live polite region. Mirrors the feature-flags refresh button pattern.
 */
describe('AdminSettingsComponent (2FA toggle async-save is announced to AT)', () => {
  function render(): ComponentFixture<AdminSettingsComponent> {
    TestBed.configureTestingModule({
      imports: [AdminSettingsComponent],
      providers: [
        { provide: ApiService, useValue: { get: () => of({ data: null }), put: () => of({}), post: () => of({}), delete: () => of({}) } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0, info: () => 0, warning: () => 0 } },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(false) } },
        { provide: Router, useValue: { navigate: () => undefined } },
        { provide: ActivatedRoute, useValue: { firstChild: null, fragment: of(null), snapshot: { fragment: null, url: [] } } },
        { provide: AdminStateService, useValue: { selectedSite: signal({ id: 's1', slug: 's' }), loadData: () => undefined } },
      ],
    });
    const fx = TestBed.createComponent(AdminSettingsComponent);
    fx.detectChanges();                    // ngOnInit may set the tab from the route
    fx.componentInstance.tab.set('team');  // the 2FA toggle lives in the Team tab
    fx.detectChanges();
    return fx;
  }
  const toggle = (el: HTMLElement) =>
    el.querySelector('[data-testid="team-2fa-toggle"]') as HTMLInputElement | null;
  afterEach(() => TestBed.resetTestingModule());

  it('reflects savingSecurity() on the 2FA checkbox via aria-busy', () => {
    const fx = render();
    const el = fx.nativeElement as HTMLElement;
    const cb = toggle(el)!;
    expect(cb).withContext('2FA toggle rendered in Team tab').toBeTruthy();
    // Idle: no in-flight save → not busy.
    expect(cb.getAttribute('aria-busy')).withContext('not busy at rest').not.toBe('true');
    // In-flight save → busy announced to AT.
    fx.componentInstance.savingSecurity.set(true);
    fx.detectChanges();
    expect(cb.getAttribute('aria-busy'))
      .withContext('aria-busy=true while the 2FA PUT is in flight').toBe('true');
  });

  it('announces the in-flight save via an aria-live region (not a silent visual hint)', () => {
    const fx = render();
    fx.componentInstance.savingSecurity.set(true);
    fx.detectChanges();
    const el = fx.nativeElement as HTMLElement;
    const live = Array.from(el.querySelectorAll('[aria-live]')).find(
      (n) => /saving/i.test(n.textContent ?? ''),
    );
    expect(live).withContext('"saving…" status is an aria-live region').toBeTruthy();
    expect(live!.getAttribute('aria-live')).toBe('polite');
  });
});

/**
 * WCAG 4.1.2 — the MCP paste-key flow renders a password <input> with only a
 * dynamic [placeholder] and no <label>/aria-label, so a screen reader announced
 * it with no purpose. It now carries a provider-scoped accessible name
 * ('API key for ' + p.id). The paste branch only renders when the provider is
 * NOT connected (connections() = []) and pasteMode() === p.id.
 */
describe('AdminSettingsComponent (MCP paste-key input accessible name)', () => {
  function render(): ComponentFixture<AdminSettingsComponent> {
    TestBed.configureTestingModule({
      imports: [AdminSettingsComponent],
      providers: [
        { provide: ApiService, useValue: { get: () => of({ data: null }), put: () => of({}), post: () => of({}), delete: () => of({}) } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0, info: () => 0, warning: () => 0 } },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(false) } },
        { provide: Router, useValue: { navigate: () => undefined } },
        { provide: ActivatedRoute, useValue: { firstChild: null, fragment: of(null), snapshot: { fragment: null, url: [] } } },
        { provide: AdminStateService, useValue: { selectedSite: signal({ id: 's1', slug: 'demo' }), loadData: () => undefined } },
      ],
    });
    const fx = TestBed.createComponent(AdminSettingsComponent);
    fx.detectChanges();                    // ngOnInit may set the tab from the route
    fx.componentInstance.tab.set('mcp');   // the provider catalogue lives in the MCP tab
    return fx;
  }
  afterEach(() => TestBed.resetTestingModule());

  it('gives the MCP paste-key input a provider-scoped accessible name', () => {
    const fx = render();
    const c = fx.componentInstance;
    // First provider in the frozen catalogue (resend) — not connected by default
    // (connections() = []), so the @else if (pasteMode() === p.id) branch renders.
    const providerId = c.providers[0].id;
    c.connections.set([]);
    c.pasteMode.set(providerId);
    fx.detectChanges();
    const el = fx.nativeElement as HTMLElement;
    const input = el.querySelector('input[type="password"][placeholder]') as HTMLInputElement | null;
    expect(input).withContext('paste-key input rendered in the MCP tab').toBeTruthy();
    expect(input!.getAttribute('aria-label')).toBe('API key for ' + providerId);
  });
});

/**
 * MCP-connection disconnect is toast-armed (7s action, re-clickable mid-async).
 * A second disconnect of the same connection while one is in flight must NOT
 * fire a duplicate DELETE.
 */
describe('AdminSettingsComponent (disconnect in-flight guard)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('ignores a re-entrant disconnect of the same connection while one is in flight', () => {
    const del = jasmine.createSpy('delete').and.returnValue(NEVER);
    TestBed.configureTestingModule({
      imports: [AdminSettingsComponent],
      providers: [
        { provide: ApiService, useValue: { get: () => of({ data: null }), put: () => of({}), post: () => of({}), delete: del } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0, info: () => 0, warning: () => 0 } },
        { provide: ConfirmService2, useValue: { confirm: () => Promise.resolve(false) } },
        { provide: Router2, useValue: { navigate: () => 0 } },
        { provide: ActivatedRoute2, useValue: { firstChild: null, fragment: of(null), snapshot: { fragment: null, url: [] } } },
        { provide: AdminStateService, useValue: { selectedSite: signal({ id: 's1', slug: 'a' }), loadData: () => undefined } },
      ],
    });
    const c = TestBed.createComponent(AdminSettingsComponent).componentInstance;
    const pd = (c as unknown as { performDisconnect: (conn: unknown, siteId: string) => void }).performDisconnect.bind(c);
    pd({ id: 'conn9', provider: 'stripe' }, 's1');
    pd({ id: 'conn9', provider: 'stripe' }, 's1');
    expect(del).withContext('no duplicate DELETE').toHaveBeenCalledTimes(1);
    expect((c as unknown as { isDisconnecting: (id: string) => boolean }).isDisconnecting('conn9')).toBeTrue();
  });
});

/**
 * MCP connectOauth — the MailChimp "auth required" fix on the Settings panel.
 * The `/mcp/:id/connect` route is bearer-gated, so the old cookie-`fetch` +
 * popup-at-the-gated-route 401'd. connectOauth now fetches the authorize URL
 * WITH the bearer (ApiService) then opens the popup there; 501 → paste-key.
 */
describe('AdminSettingsComponent — MCP connectOauth (bearer fetch, MailChimp auth-required fix)', () => {
  let selectedSite: WritableSignal<{ id: string; slug: string } | null>;
  let win: jasmine.Spy;

  function build(get: jasmine.Spy): AdminSettingsComponent {
    selectedSite = signal<{ id: string; slug: string } | null>({ id: 's1', slug: 'demo' });
    TestBed.configureTestingModule({
      imports: [AdminSettingsComponent],
      providers: [
        { provide: ApiService, useValue: { get, put: () => of({}), post: () => of({}), delete: () => of({}) } },
        { provide: ToastService, useValue: { error: () => 0, success: () => 0, info: jasmine.createSpy('info'), warning: () => 0 } },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(false) } },
        { provide: Router, useValue: { navigate: () => 0 } },
        { provide: ActivatedRoute, useValue: { firstChild: null, fragment: of(null), snapshot: { fragment: null, url: [] } } },
        { provide: AdminStateService, useValue: { selectedSite, loadData: () => undefined } },
      ],
    });
    return TestBed.createComponent(AdminSettingsComponent).componentInstance;
  }

  beforeEach(() => {
    win = spyOn(window, 'open').and.returnValue({ closed: false } as Window);
    // Stop the popup-close poller from actually scheduling in the test.
    spyOn(window, 'setInterval').and.returnValue(0 as unknown as ReturnType<typeof setInterval>);
  });
  afterEach(() => TestBed.resetTestingModule());

  it('fetches the authorize URL WITH the bearer (silent) then opens the popup there', () => {
    const get = jasmine.createSpy('get').and.callFake((path: string) =>
      /\/connect$/.test(path)
        ? of({ data: { mode: 'oauth', authorize_url: 'https://login.mailchimp.com/oauth2/authorize?x=1' } })
        : of({ data: null }),
    );
    const c = build(get);
    c.connectOauth('mailchimp');
    expect(get).toHaveBeenCalledWith('/mcp/mailchimp/connect', { site_id: 's1', return_url: '/admin/settings#mcp' }, { silent: true });
    expect(win).toHaveBeenCalledWith('https://login.mailchimp.com/oauth2/authorize?x=1', 'mcp_oauth', jasmine.any(String));
  });

  it('falls back to the paste-key form (no broken popup) when OAuth is not configured (501)', () => {
    const get = jasmine.createSpy('get').and.callFake((path: string) =>
      /\/connect$/.test(path)
        ? throwError(() => ({ status: 501, error: { error: 'oauth_not_configured' } }))
        : of({ data: null }),
    );
    const c = build(get);
    c.connectOauth('mailchimp');
    expect(win).not.toHaveBeenCalled();
    expect(c.pasteMode()).toBe('mailchimp');
  });
});

/**
 * AL-710 regression — knowledge-file upload auth + timeout hardening.
 *
 * The raw-XHR knowledge upload read a DEAD `localStorage.getItem('session_token')` key
 * (never written since the token moved to `ps_session`), so it sent `Bearer null` → the
 * Bearer-only worker 401'd EVERY upload (a shipped-broken, doomed control). It also had NO
 * timeout, so a hung upload spun "uploading" forever. This locks: (1) the Bearer comes from
 * AuthService.getToken(), (2) a 60s timeout is set, (3) ontimeout fails the row + toasts an
 * actionable message (owner never stranded), (4) no `Bearer null` when signed out.
 */
describe('AdminSettingsComponent — knowledge upload auth + timeout (AL-710)', () => {
  const toast = {
    error: jasmine.createSpy('kerr'),
    success: jasmine.createSpy('ksucc'),
    info: () => 0,
    warning: () => 0,
  };
  class FakeXHR {
    static instances: FakeXHR[] = [];
    headers: Record<string, string> = {};
    timeout = 0;
    status = 200;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    aborted = false;
    open(): void {}
    setRequestHeader(k: string, v: string): void {
      this.headers[k] = v;
    }
    send(): void {
      FakeXHR.instances.push(this);
    }
    abort(): void {
      this.aborted = true;
    }
  }
  let OrigXHR: typeof XMLHttpRequest;

  function make(token: string | null): AdminSettingsComponent {
    toast.error.calls.reset();
    toast.success.calls.reset();
    FakeXHR.instances = [];
    const selectedSite = signal<{ id: string; slug: string } | null>({ id: 'site-1', slug: 's' });
    TestBed.configureTestingModule({
      imports: [AdminSettingsComponent],
      providers: [
        { provide: ApiService, useValue: { get: () => of({ data: null }), put: () => of({}), post: () => of({}), delete: () => of({}), updateSite: () => of({}) } },
        { provide: ToastService, useValue: toast },
        { provide: ConfirmService, useValue: { confirm: () => Promise.resolve(false) } },
        { provide: Router, useValue: { navigate: jasmine.createSpy('navigate') } },
        { provide: ActivatedRoute, useValue: { firstChild: null, fragment: of(null), snapshot: { fragment: null, url: [] } } },
        { provide: AdminStateService, useValue: { selectedSite, loadData: () => undefined } },
        { provide: AuthService, useValue: { getToken: () => token } },
      ],
    });
    return TestBed.createComponent(AdminSettingsComponent).componentInstance;
  }
  const pdf = (name: string): File => new File([new Blob(['%PDF-1.4'])], name, { type: 'application/pdf' });

  beforeEach(() => {
    OrigXHR = window.XMLHttpRequest;
    (window as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXHR;
  });
  afterEach(() => {
    (window as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = OrigXHR;
    TestBed.resetTestingModule();
  });

  it('attaches Bearer from AuthService.getToken() (NOT the dead session_token key)', () => {
    const c = make('tok-abc');
    (c as unknown as { uploadKnowledgeFiles: (f: FileList) => void }).uploadKnowledgeFiles([pdf('doc.pdf')] as unknown as FileList);
    expect(FakeXHR.instances[0]?.headers['Authorization']).toBe('Bearer tok-abc');
  });

  it('sets a 60s timeout so a hung upload cannot spin forever', () => {
    const c = make('tok-abc');
    (c as unknown as { uploadKnowledgeFiles: (f: FileList) => void }).uploadKnowledgeFiles([pdf('doc.pdf')] as unknown as FileList);
    expect(FakeXHR.instances[0]?.timeout).toBe(60000);
  });

  it('ontimeout fails the row + toasts an actionable message (owner never stranded)', () => {
    const c = make('tok-abc');
    (c as unknown as { uploadKnowledgeFiles: (f: FileList) => void }).uploadKnowledgeFiles([pdf('slow.pdf')] as unknown as FileList);
    expect(c.kbUploads().find((u) => u.filename === 'slow.pdf')?.status).toBe('uploading');
    FakeXHR.instances[0].ontimeout?.();
    expect(c.kbUploads().find((u) => u.filename === 'slow.pdf')?.status).toBe('error');
    expect(toast.error).toHaveBeenCalled();
  });

  it('omits Authorization entirely when signed out (getToken null) — never sends `Bearer null`', () => {
    const c = make(null);
    (c as unknown as { uploadKnowledgeFiles: (f: FileList) => void }).uploadKnowledgeFiles([pdf('doc.pdf')] as unknown as FileList);
    expect(FakeXHR.instances[0]?.headers['Authorization']).toBeUndefined();
  });
});
