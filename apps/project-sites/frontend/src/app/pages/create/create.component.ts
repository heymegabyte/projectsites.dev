import {
  Component,
  type OnInit,
  type OnDestroy,
  inject,
  signal,
  ChangeDetectorRef,
} from '@angular/core';
import { Router, ActivatedRoute, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import {
  Subject,
  debounceTime,
  distinctUntilChanged,
  switchMap,
  of,
  takeUntil,
  timer,
  catchError,
  type Subscription,
} from 'rxjs';
import {
  ApiService,
  type CreateSitePayload,
  type AutofillResult,
} from '../../services/api.service';
import { AuthService, type SelectedBusiness } from '../../services/auth.service';
import { GeolocationService } from '../../services/geolocation.service';
import { ToastService } from '../../services/toast.service';
import { TelemetryService } from '../../services/telemetry.service';
import {
  mapClaimPrefillToFields,
  parseClaimBuildState,
  parseClaimAdoptResult,
  type ClaimBuildStatus,
} from './claim-prefill';
import { renderThemeDossier } from './theme-presets';

/**
 * Clean a URL for display and storage — strips tracking parameters (utm_*,
 * fbclid, gclid, etc.), removes trailing slashes, and normalizes the URL
 * for a polished, professional appearance.
 */
function cleanUrl(raw: string): string {
  if (!raw || !raw.trim()) return '';
  try {
    let urlStr = raw.trim();
    if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://')) {
      urlStr = 'https://' + urlStr;
    }
    const url = new URL(urlStr);
    const junkParams = [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'fbclid',
      'gclid',
      'gad_source',
      'dclid',
      'msclkid',
      'mc_cid',
      'mc_eid',
      'yclid',
      'twclid',
      'igshid',
      'ref',
      'source',
      'si',
      '_ga',
      '_gl',
      '_hsenc',
      '_hsmi',
      'hsa_cam',
      'hsa_grp',
      'hsa_mt',
      'hsa_src',
      'hsa_ad',
      'hsa_acc',
      'hsa_net',
      'hsa_ver',
      'hsa_kw',
    ];
    for (const p of junkParams) url.searchParams.delete(p);
    // If no meaningful params remain, strip the query entirely
    let cleaned = url.origin + url.pathname;
    if (url.searchParams.toString()) cleaned += '?' + url.searchParams.toString();
    // Remove trailing slash (unless it's just the root)
    if (cleaned.endsWith('/') && cleaned !== url.origin + '/') {
      cleaned = cleaned.slice(0, -1);
    }
    return cleaned;
  } catch {
    // If URL parsing fails, just strip obvious utm params with regex
    return raw
      .trim()
      .replace(/[?&](utm_\w+|fbclid|gclid|gad_source|ref|source|si)=[^&#]*/gi, '')
      .replace(/\?$/, '');
  }
}

/**
 * Address autocomplete suggestion from Google Places API.
 *
 * @remarks
 * Displayed in the address dropdown when the user types 3+ characters.
 * The `place_id` is used for precise geocoding if needed.
 */
interface AddressSuggestion {
  description: string;
  place_id?: string;
}

/**
 * Business suggestion from the Google Places business search API.
 *
 * @remarks
 * Selecting a business from the dropdown auto-populates all form fields:
 * name, address, phone, and website. The `place_id` is passed to the
 * backend for enriched research during AI site generation.
 */
interface BusinessSuggestion {
  name: string;
  address: string;
  place_id: string;
  phone?: string;
  website?: string;
  types?: string[];
}

/**
 * Create/Reset Website page — the primary site creation form.
 *
 * @remarks
 * **Auto-populate flow:**
 * 1. User types business name → debounced search (300ms, min 2 chars)
 * 2. Dropdown shows Google Places results with name + address
 * 3. Selecting a result fills: name, address, phone, website
 * 4. "Auto-Populate with AI" button fetches additional data
 *
 * **Submission paths:**
 * - Not logged in → store data, redirect to `/signin`
 * - Logged in, new site → `POST /api/sites/create-from-search` → `/waiting`
 * - Logged in, reset mode → `POST /api/sites/:id/reset` → `/admin`
 */
@Component({
  selector: 'app-create',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './create.component.html',
  styleUrl: './create.component.scss',
})
export class CreateComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  auth = inject(AuthService);
  private geo = inject(GeolocationService);
  private toast = inject(ToastService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private cdr = inject(ChangeDetectorRef);
  private telemetry = inject(TelemetryService);

  businessName = '';
  businessAddress = '';
  businessPhone = '';
  businessWebsite = '';
  businessCategory = '';
  additionalContext = '';
  submitting = signal(false);

  /** Conceptual sub-steps within the single-page form. Persisted in
   *  sessionStorage so a mid-flow refresh restores progress + indicator state. */
  readonly steps = [
    { id: 1, label: 'Business', describe: 'Name and address' },
    { id: 2, label: 'Details', describe: 'Category and context' },
    { id: 3, label: 'Brand assets', describe: 'Logo, icon, images' },
  ] as const;
  currentStep = signal<1 | 2 | 3>(1);

  /** Reactive accessor — derives which steps are "complete" from form state. */
  stepComplete(id: 1 | 2 | 3): boolean {
    if (id === 1) return !!(this.businessName.trim() && this.businessAddress.trim());
    if (id === 2) return !!(this.businessCategory || this.additionalContext.trim());
    if (id === 3)
      return !!(
        this.logoFile ||
        this.aiLogoUrl ||
        this.faviconFile ||
        this.aiFaviconUrl ||
        this.additionalFiles.length > 0 ||
        this.aiImageUrls.length > 0
      );
    return false;
  }

  /** Move the highlighted step pill — used on field focus/blur and on submit. */
  setStep(id: 1 | 2 | 3): void {
    this.currentStep.set(id);
    try {
      sessionStorage.setItem(CreateComponent.STEP_KEY, String(id));
    } catch {
      /* private mode — ignore */
    }
  }

  private static readonly STEP_KEY = 'ps_create_step';

  /** Attempted-submit flag — gates inline error rendering on required fields. */
  attempted = signal(false);

  get nameError(): string | null {
    if (!this.attempted()) return null;
    return this.businessName.trim()
      ? null
      : 'Business name is required so we know what site to build.';
  }
  get addressError(): string | null {
    if (!this.attempted()) return null;
    return this.businessAddress.trim()
      ? null
      : 'Address is required for local SEO and the contact card.';
  }

  categories = [
    '',
    'Restaurant / Café',
    'Bar / Nightlife / Brewery',
    'Bakery / Coffee Shop',
    'Beauty / Spa / Wellness',
    'Salon / Barbershop',
    'Legal / Law Firm',
    'Medical / Healthcare',
    'Retail / Shop',
    'Technology / SaaS',
    'Construction / Home Services',
    'Fitness / Gym',
    'Real Estate',
    'Photography / Creative',
    'Automotive',
    'Education / Tutoring',
    'Financial / Accounting',
    'Other',
  ];

  // Reset mode: when navigating from admin "Reset & Rebuild"
  resetSiteId: string | null = null;

  selectedBusiness = signal<SelectedBusiness | null>(null);

  addressSuggestions = signal<AddressSuggestion[]>([]);
  addressDropdownOpen = signal(false);
  /** True when the ADDRESS-search proxy is down (provider `_error`) — surface an
   * honest "address lookup unavailable, type it manually" nudge instead of a
   * silently-empty dropdown (parity with {@link searchUnavailable} for business). */
  addressUnavailable = signal(false);
  private addressSubject = new Subject<string>();

  businessSuggestions = signal<BusinessSuggestion[]>([]);
  businessDropdownOpen = signal(false);
  /** True when the business-search proxy is down (provider `_error`) — the UI
   * nudges the guest to enter details manually instead of showing "no results". */
  searchUnavailable = signal(false);
  private businessSubject = new Subject<string>();

  autoPopulating = signal(false);

  loadingPhone = signal(false);
  loadingWebsite = signal(false);
  loadingCategory = signal(false);
  loadingContext = signal(false);

  /**
   * In-flight AI autofill state. When `true`, every field that hasn't
   * been touched shows a shimmer border. Clears the moment the response
   * resolves (or fails).
   */
  autofilling = signal(false);

  /**
   * Set of form field keys the user has touched (typed in, focused, or
   * had pre-filled from a known-good source like Google Places). Late-
   * arriving AI suggestions MUST NOT clobber anything in this set.
   *
   * Field keys: `name | address | phone | website | category | context |
   * tagline | audience | description | url | subdomain | colors`.
   */
  touchedFields = signal<Set<string>>(new Set<string>());

  /** Per-field shimmer state — driven from `autofilling()` minus touched. */
  shimmering(field: string): boolean {
    return this.autofilling() && !this.touchedFields().has(field);
  }

  /** Count of fields actually filled by the AI in the last call — drives the submit-button label. */
  autofillCount = signal(0);

  /** Mark a field as user-touched. Once touched, AI cannot overwrite it. */
  markTouched(field: string): void {
    const s = this.touchedFields();
    if (s.has(field)) return;
    const next = new Set(s);
    next.add(field);
    this.touchedFields.set(next);
  }

  /** True when the form is still pristine (no user edits + no pre-fill). */
  private isFormPristine(): boolean {
    return this.touchedFields().size === 0;
  }

  discoveringImages = signal(false);

  modalImage = signal<string | null>(null);
  modalImageName = signal('');
  modalAiPrompt = '';
  modalAiProcessing = signal(false);
  aiLogoUrl: string | null = null;
  aiLogoQuality: { quality_score: number; recommendation: string; description: string } | null =
    null;
  aiFaviconUrl: string | null = null;
  aiFaviconQuality: { quality_score: number; recommendation: string; description: string } | null =
    null;
  aiImageUrls: {
    url: string;
    name: string;
    quality?: { quality_score: number; recommendation: string; description: string } | null;
  }[] = [];
  brandAssessment: {
    brand_maturity: string;
    website_quality_score: number;
    asset_strategy: string;
    recommendation: string;
  } | null = null;

  logoFile: File | null = null;
  logoPreview: string | null = null;
  faviconFile: File | null = null;
  faviconPreview: string | null = null;
  additionalFiles: File[] = [];
  imagePreviews: { name: string; url: string }[] = [];

  private destroy$ = new Subject<void>();

  /** claimyour.site funnel — live background-build status for the banner. */
  claimBuildStatus = signal<ClaimBuildStatus | null>(null);
  /** The live preview URL once a claim build completes (else null). */
  claimPreviewUrl = signal<string | null>(null);
  /** The shortlink the visitor arrived on (drives the claim/adopt CTA). */
  private claimShortlink: string | null = null;
  /** True when the owner arrived via an INVALID/expired claim link (`?claim_invalid=1`, AL-700):
   * the worker redirects the dead link here instead of showing a raw-JSON 404, and we greet them
   * with a friendly one-line notice + the normal build funnel — never a dead-end. */
  claimInvalid = signal(false);
  /** True once the visitor has claimed (adopted) the built site. */
  claimed = signal(false);
  /** Busy guard for the claim/adopt request (double-submit safe). */
  claiming = signal(false);
  private claimPollSub?: Subscription;

  /** Whether the visitor is signed in (gates the claim CTA copy/flow). */
  get isLoggedIn(): boolean {
    return this.auth.isLoggedIn();
  }

  /**
   * Claim (adopt) the completed claim-built site for the signed-in visitor's org.
   * Anonymous → route to sign-in with a returnUrl back to this funnel; signed-in
   * → `POST /api/claim/:shortlink/adopt` (re-parents the platform-org site).
   * Idempotent + double-submit-guarded; ApiService surfaces 401/404/409 as toasts.
   */
  claimThisSite(): void {
    const shortlink = this.claimShortlink;
    if (!shortlink || this.claiming() || this.claimed()) return;
    if (!this.auth.isLoggedIn()) {
      this.router.navigate(['/signin'], {
        queryParams: { returnUrl: `/create?claim=${encodeURIComponent(shortlink)}` },
      });
      return;
    }
    this.claiming.set(true);
    this.api
      .post<{
        data?: { claimed?: boolean; slug?: string };
      }>(`/claim/${encodeURIComponent(shortlink)}/adopt`, {})
      .subscribe({
        next: (res) => {
          const r = parseClaimAdoptResult(res?.data);
          this.claiming.set(false);
          if (r.claimed) {
            this.claimed.set(true);
            this.toast.success(r.slug ? `You now own ${r.slug}.` : 'This site is now yours.');
          }
          this.cdr.detectChanges();
        },
        error: () => {
          this.claiming.set(false);
          this.cdr.detectChanges();
        },
      });
  }

  ngOnInit(): void {
    this.telemetry.track('site.create.opened', {
      reset_mode: !!this.route.snapshot.queryParams['reset'],
    });
    const params = this.route.snapshot.queryParams;
    if (params['name']) {
      this.businessName = params['name'];
      // Name from sidebar selector is a "known good" pre-fill — lock it
      // so AI inference cannot clobber the user's exact wording.
      this.markTouched('name');
    }
    if (params['address']) {
      this.businessAddress = params['address'];
      this.markTouched('address');
    }
    if (params['phone']) {
      this.businessPhone = params['phone'];
      this.markTouched('phone');
    }
    if (params['website']) {
      this.businessWebsite = cleanUrl(params['website']);
      this.markTouched('website');
    }
    if (params['reset']) this.resetSiteId = params['reset'];
    // claimyour.site funnel: ?claim=<shortlink> → fetch the researched profile +
    // prefill the form (the background build is already running server-side).
    if (params['claim']) this.loadClaimPrefill(params['claim']);
    // ?claim_invalid=1 (AL-700) → the owner clicked an expired/invalid claim link; the worker
    // redirected them here (not a raw-JSON dead-end). Greet with a friendly notice, funnel unchanged.
    if (params['claim_invalid']) this.claimInvalid.set(true);

    const shouldAutoCreate = this.auth.getAutoCreate();
    const hasPendingBuild = this.auth.getPendingBuild();
    const biz = this.auth.getSelectedBusiness();

    if (biz) {
      // Coming from search selection — always use stored business data
      if (this.auth.getMode() === 'business' && biz.place_id) {
        this.selectedBusiness.set(biz);
      }
      this.businessName = biz.name || this.businessName;
      this.businessAddress = biz.address || this.businessAddress;
      if (biz.phone) this.businessPhone = biz.phone;
      if (biz.website) this.businessWebsite = cleanUrl(biz.website);
      if (hasPendingBuild && !this.auth.isLoggedIn()) {
        // Keep pendingBuild — user needs to sign in first
      } else if (hasPendingBuild && this.auth.isLoggedIn() && !shouldAutoCreate) {
        this.auth.setPendingBuild(false);
      }
    } else if (!params['name']) {
      // No business selected and no query params — restore from localStorage draft
      this.restoreFormDraft();
    }

    // Restore the active step pill (sessionStorage — cleared when tab closes).
    try {
      const saved = sessionStorage.getItem(CreateComponent.STEP_KEY);
      const n = saved ? Number(saved) : NaN;
      if (n === 1 || n === 2 || n === 3) this.currentStep.set(n as 1 | 2 | 3);
    } catch {
      /* private mode — ignore */
    }

    // Auto-Create with AI: trigger auto-populate after a short delay to let the view settle
    if (shouldAutoCreate && this.businessName && this.businessAddress) {
      this.auth.setAutoCreate(false);
      setTimeout(() => this.autoPopulate(), 300);
    }

    // AI autofill — fired when the user arrives via /create?name=...
    // (sidebar selector "press Enter" flow). Runs in parallel with
    // anything else; never blocks the page. Late-arriving suggestions
    // skip any field the user has already touched.
    if (params['name'] && params['name'].trim() && this.auth.isLoggedIn()) {
      // We pre-locked `name` above, so AI inference can fill everything
      // else but never overwrite the user's exact business name.
      setTimeout(() => this.runAutofill(params['name'].trim()), 50);
    }

    // Pending build: user was redirected to signin, now logged in — auto-submit
    if (hasPendingBuild && this.auth.isLoggedIn() && this.businessName && this.businessAddress) {
      this.auth.setPendingBuild(false);
      setTimeout(() => this.submitBuild(), 500);
    }

    this.businessSubject
      .pipe(
        debounceTime(300),
        distinctUntilChanged(),
        switchMap((q) => {
          if (q.length < 2) {
            this.businessSuggestions.set([]);
            this.businessDropdownOpen.set(false);
            this.searchUnavailable.set(false);
            return of(null);
          }
          const lat = this.geo.lat() ?? undefined;
          const lng = this.geo.lng() ?? undefined;
          return this.api.searchBusinesses(q, lat, lng, { silent: true });
        }),
        takeUntil(this.destroy$),
      )
      .subscribe({
        next: (res) => {
          if (!res) return;
          // A provider `_error` means the search backend is down — nudge manual entry.
          this.searchUnavailable.set(res._error != null);
          this.businessSuggestions.set(res.data || []);
          this.businessDropdownOpen.set((res.data || []).length > 0);
        },
        error: () => {
          // A hard failure (network / 5xx) is equally "search is unavailable".
          this.searchUnavailable.set(true);
          this.businessSuggestions.set([]);
          this.businessDropdownOpen.set(false);
        },
      });

    this.addressSubject
      .pipe(
        debounceTime(300),
        distinctUntilChanged(),
        switchMap((q) => {
          if (q.length < 3) {
            this.addressSuggestions.set([]);
            this.addressUnavailable.set(false);
            this.addressDropdownOpen.set(false);
            return of(null);
          }
          const lat = this.geo.lat() ?? undefined;
          const lng = this.geo.lng() ?? undefined;
          return this.api.searchAddress(q, lat, lng, { silent: true });
        }),
        takeUntil(this.destroy$),
      )
      .subscribe({
        next: (res) => {
          if (!res) return;
          // Provider `_error` → address lookup is down; surface the honest nudge
          // rather than a blank dropdown (parity with the business-search handling).
          this.addressUnavailable.set(res._error != null);
          this.addressSuggestions.set(res.data || []);
          this.addressDropdownOpen.set((res.data || []).length > 0);
        },
        error: () => {
          this.addressUnavailable.set(true);
          this.addressSuggestions.set([]);
          this.addressDropdownOpen.set(false);
        },
      });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  onAddressInput(): void {
    this.markTouched('address');
    this.addressSubject.next(this.businessAddress);
  }

  selectAddress(suggestion: AddressSuggestion): void {
    this.businessAddress = suggestion.description;
    this.addressDropdownOpen.set(false);
  }

  closeAddressDropdown(): void {
    setTimeout(() => this.addressDropdownOpen.set(false), 200);
  }

  onBusinessInput(): void {
    this.markTouched('name');
    this.businessSubject.next(this.businessName);
  }

  /**
   * Handles business selection from the autocomplete dropdown.
   * Auto-populates name + address (always) and phone + website when Google
   * Places provides them.
   */
  selectBusiness(biz: BusinessSuggestion): void {
    this.searchUnavailable.set(false);
    this.businessName = biz.name;
    if (biz.address && !this.businessAddress.trim()) this.businessAddress = biz.address;
    if (biz.address) this.businessAddress = biz.address;
    if (biz.phone && !this.businessPhone.trim()) this.businessPhone = biz.phone;
    if (biz.website && !this.businessWebsite.trim()) this.businessWebsite = cleanUrl(biz.website);
    this.businessDropdownOpen.set(false);
    this.selectedBusiness.set({
      name: biz.name,
      address: biz.address,
      place_id: biz.place_id,
      phone: biz.phone,
      website: biz.website,
    });
    this.telemetry.track('site.create.business_selected', {
      has_place_id: !!biz.place_id,
      has_phone: !!biz.phone,
      has_website: !!biz.website,
    });
    this.saveFormDraft();
  }

  closeBusinessDropdown(): void {
    setTimeout(() => this.businessDropdownOpen.set(false), 200);
  }

  dismissBusiness(): void {
    this.selectedBusiness.set(null);
  }

  autoPopulate(): void {
    if (!this.businessName.trim()) {
      this.toast.error('Enter a business name first');
      return;
    }
    this.autoPopulating.set(true);
    this.loadingPhone.set(true);
    this.loadingWebsite.set(true);
    this.loadingCategory.set(true);
    this.loadingContext.set(true);
    const lat = this.geo.lat() ?? undefined;
    const lng = this.geo.lng() ?? undefined;
    this.api.searchBusinesses(this.businessName, lat, lng).subscribe({
      next: (res) => {
        const searchTerm = this.businessName.toLowerCase().trim();
        const match = (res.data || []).find(
          (b) =>
            b.name.toLowerCase().includes(searchTerm) || searchTerm.includes(b.name.toLowerCase()),
        );
        if (match) {
          // Always overwrite fields from match (supports switching businesses)
          this.businessPhone = match.phone || '';
          this.loadingPhone.set(false);
          this.businessWebsite = cleanUrl(match.website || '');
          this.loadingWebsite.set(false);
          if (match.address) this.businessAddress = match.address;
          this.additionalContext = this.generateContextPrompt(match);
          this.loadingContext.set(false);
          this.cdr.detectChanges();
          this.toast.success('Auto-populated from Google Places');
          this.discoverBrandImages(match.website);
        } else {
          // No match — generate context from name + inferred category
          this.loadingPhone.set(false);
          this.loadingWebsite.set(false);
          const inferred = this.inferCategoryFromName(this.businessName);
          const design = this.getDesignRecommendations(inferred || '');
          const parts: string[] = [];
          parts.push(`Design style: ${design.style}.`);
          parts.push(renderThemeDossier(design.themeStyle));
          parts.push(`Brand colors: primary ${design.primaryColor}, accent ${design.accentColor}.`);
          parts.push(
            `Typography: ${design.headingFont} for headings, ${design.bodyFont} for body text.`,
          );
          parts.push(`Target audience: ${design.audience}.`);
          parts.push('');
          parts.push(`Recommended sections: ${design.sections.join(', ')}.`);
          parts.push('');
          parts.push(
            'Include smooth scroll animations, hover micro-interactions, and a responsive mobile-first layout.',
          );
          parts.push(
            'Prioritize vibrant, colorful design with bold gradients and dynamic visual elements.',
          );
          this.additionalContext = parts.join('\n');
          this.loadingContext.set(false);
          this.cdr.detectChanges();
          this.toast.info('No exact match — populated from business name');
          this.discoverBrandImages(this.businessWebsite || undefined);
        }

        const types = match?.types || this.selectedBusiness()?.types;
        // If AI categorization doesn't respond in 8s, fall back to local inference
        const categoryTimeout = setTimeout(() => {
          if (this.loadingCategory()) {
            const inferred =
              this.inferCategory(types) || this.inferCategoryFromName(this.businessName);
            this.businessCategory = inferred || 'Other';
            this.loadingCategory.set(false);
            this.cdr.detectChanges();
          }
        }, 8000);

        this.api.categorize(this.businessName, this.businessAddress, types).subscribe({
          next: (catRes) => {
            clearTimeout(categoryTimeout);
            const aiCategory = catRes.data?.category;
            if (aiCategory && aiCategory !== 'Other') {
              this.businessCategory = aiCategory;
            } else {
              const inferred =
                this.inferCategory(types) || this.inferCategoryFromName(this.businessName);
              this.businessCategory = inferred || aiCategory || 'Other';
            }
            this.loadingCategory.set(false);
            this.cdr.detectChanges();
          },
          error: () => {
            clearTimeout(categoryTimeout);
            const inferred =
              this.inferCategory(types) || this.inferCategoryFromName(this.businessName);
            this.businessCategory = inferred || 'Other';
            this.loadingCategory.set(false);
            this.cdr.detectChanges();
          },
        });

        this.autoPopulating.set(false);
        this.saveFormDraft();
      },
      error: () => {
        // Even on search error, still try to set category locally
        const inferred = this.inferCategoryFromName(this.businessName);
        this.businessCategory = inferred || 'Other';
        this.cdr.detectChanges();
        this.autoPopulating.set(false);
        this.saveFormDraft();
        this.toast.error('Auto-populate failed — category set from business name');
      },
    });
  }

  /**
   * Run AI autofill for the create form.
   *
   * While the call is in-flight, every untouched field shimmers. When the
   * response arrives, only fields the user has NOT touched are filled — late-
   * arriving inference must never clobber active edits.
   */
  runAutofill(name: string): void {
    if (!name.trim()) return;
    this.autofilling.set(true);
    this.autofillCount.set(0);
    this.cdr.detectChanges();

    this.telemetry.track('site.create.autofill_started', { name_length: name.length });

    this.api.autofillSite(name.trim()).subscribe({
      next: (res) => {
        const data = res.data;
        this.applyAutofill(data);
        this.autofilling.set(false);
        this.cdr.detectChanges();
        this.saveFormDraft();
        this.telemetry.track('site.create.autofill_completed', {
          model: res.meta?.model,
          latency_ms: res.meta?.latency_ms,
          fields_applied: this.autofillCount(),
        });
      },
      error: (err) => {
        this.autofilling.set(false);
        this.cdr.detectChanges();
        // Don't block the page — let the user fill the form by hand
        this.toast.info('AI suggestions unavailable — fill in details manually');
        this.telemetry.track('site.create.autofill_failed', { status: err?.status });
      },
    });
  }

  /**
   * Apply an AI autofill response to form state. ONLY fills fields the
   * user has not yet touched — late-arriving inference NEVER clobbers
   * an active edit.
   */
  private applyAutofill(data: AutofillResult): void {
    let count = 0;
    const touched = this.touchedFields();

    // Business name — usually pre-locked but defensive in case of empty query
    if (data.name && data.name.trim() && !touched.has('name') && !this.businessName.trim()) {
      this.businessName = data.name.trim();
      count++;
    }

    if (data.business_address && !touched.has('address') && !this.businessAddress.trim()) {
      this.businessAddress = data.business_address;
      count++;
    }

    if (data.phone && !touched.has('phone') && !this.businessPhone.trim()) {
      this.businessPhone = data.phone;
      count++;
    }

    if (data.primary_url && !touched.has('website') && !this.businessWebsite.trim()) {
      this.businessWebsite = cleanUrl(data.primary_url);
      count++;
    }

    if (data.category && !touched.has('category') && !this.businessCategory) {
      // Only apply if it's in the dropdown list — otherwise leave empty
      if (this.categories.includes(data.category)) {
        this.businessCategory = data.category;
        count++;
      }
    }

    // Compose an "Additional details" block from the high-signal AI fields,
    // but only if the user hasn't typed anything in there yet.
    if (!touched.has('context') && !this.additionalContext.trim()) {
      const parts: string[] = [];
      if (data.description) parts.push(`About: ${data.description}`);
      if (data.tagline) parts.push(`Tagline: ${data.tagline}`);
      if (data.target_audience) parts.push(`Target audience: ${data.target_audience}`);
      if (data.brand_colors && data.brand_colors.length) {
        parts.push(`Brand colors: ${data.brand_colors.join(', ')}`);
      }
      if (data.suggested_subdomains && data.suggested_subdomains.length) {
        parts.push(`Suggested subdomains: ${data.suggested_subdomains.join(', ')}`);
      }
      if (data.additional_context) parts.push(data.additional_context);
      if (parts.length) {
        this.additionalContext = parts.join('\n');
        count++;
      }
    }

    this.autofillCount.set(count);
  }

  private discoverBrandImages(website?: string): void {
    // Clear previous AI-discovered images before loading new ones
    this.aiLogoUrl = null;
    this.aiLogoQuality = null;
    this.aiFaviconUrl = null;
    this.aiFaviconQuality = null;
    this.aiImageUrls = [];
    this.brandAssessment = null;
    this.discoveringImages.set(true);
    this.cdr.detectChanges();

    this.api
      .discoverImages(this.businessName.trim(), this.businessAddress.trim() || undefined, website)
      .subscribe({
        next: (res) => {
          const data = res.data;
          if (data.logo?.url && !this.logoFile) {
            this.aiLogoUrl = data.logo.url;
            this.aiLogoQuality = data.logo.quality || null;
          }
          if (data.favicon?.url && !this.faviconFile) {
            this.aiFaviconUrl = data.favicon.url;
            this.aiFaviconQuality = data.favicon.quality || null;
          }
          this.aiImageUrls = (data.images || []).map(
            (img: {
              url: string;
              name: string;
              quality?: {
                quality_score: number;
                recommendation: string;
                description: string;
              } | null;
            }) => ({
              url: img.url,
              name: img.name,
              quality: img.quality || null,
            }),
          );
          this.brandAssessment = data.brand_assessment || null;
          this.discoveringImages.set(false);
          this.cdr.detectChanges();
          this.saveFormDraft();
        },
        error: () => {
          this.discoveringImages.set(false);
        },
      });
  }

  private generateContextPrompt(match: BusinessSuggestion): string {
    const biz = this.selectedBusiness();
    const types = match.types || biz?.types;
    const parts: string[] = [];
    const category =
      this.businessCategory ||
      this.inferCategory(types) ||
      this.inferCategoryFromName(this.businessName);

    // Industry context (no phone/address — those are already in the form fields)
    if (types && types.length > 0) {
      const readable = types
        .filter((t) => !['point_of_interest', 'establishment'].includes(t))
        .map((t) => t.replace(/_/g, ' '))
        .slice(0, 4);
      if (readable.length > 0) {
        parts.push(`Industry: ${readable.join(', ')}.`);
      }
    }

    const design = this.getDesignRecommendations(category);
    parts.push(`Design style: ${design.style}.`);
    parts.push(renderThemeDossier(design.themeStyle));
    parts.push(`Brand colors: primary ${design.primaryColor}, accent ${design.accentColor}.`);
    parts.push(`Typography: ${design.headingFont} for headings, ${design.bodyFont} for body text.`);
    parts.push(`Target audience: ${design.audience}.`);
    parts.push('');
    parts.push(`Recommended sections: ${design.sections.join(', ')}.`);
    parts.push('');
    parts.push(
      'Include smooth scroll animations, hover micro-interactions, and a responsive mobile-first layout.',
    );
    parts.push('Add a professional contact form with validation.');
    parts.push('Use high-quality placeholder images with CSS gradient fallbacks.');
    parts.push(
      'Prioritize vibrant, colorful design with bold gradients and dynamic visual elements.',
    );
    if (design.extras) parts.push(design.extras);

    return parts.join('\n');
  }

  private inferCategory(types?: string[]): string {
    if (!types) return '';
    const t = types.join(' ').toLowerCase();
    if (t.includes('restaurant') || t.includes('food') || t.includes('cafe'))
      return 'Restaurant / Café';
    if (t.includes('hair') || t.includes('beauty') || t.includes('salon') || t.includes('barber'))
      return 'Salon / Barbershop';
    if (t.includes('lawyer') || t.includes('law')) return 'Legal / Law Firm';
    if (
      t.includes('doctor') ||
      t.includes('health') ||
      t.includes('dentist') ||
      t.includes('medical')
    )
      return 'Medical / Healthcare';
    if (t.includes('store') || t.includes('shop') || t.includes('retail')) return 'Retail / Shop';
    if (t.includes('gym') || t.includes('fitness')) return 'Fitness / Gym';
    if (t.includes('real_estate')) return 'Real Estate';
    if (t.includes('car') || t.includes('auto')) return 'Automotive';
    return '';
  }

  private inferCategoryFromName(name: string): string {
    const n = name.toLowerCase();
    // Specific hospitality signals first — a lounge/brewery is noir, a
    // bakery/roaster is retro, a spa is artisan (each a distinct elaborate
    // theme), so route them before the broad "Restaurant / Café" catch below.
    if (
      n.includes('cocktail') ||
      n.includes('speakeasy') ||
      n.includes('taproom') ||
      n.includes('nightclub') ||
      n.includes('brewery') ||
      n.includes('brewing') ||
      n.includes('tavern') ||
      n.includes('lounge') ||
      /\bpub\b/.test(n) ||
      /\bbar\b/.test(n)
    )
      return 'Bar / Nightlife / Brewery';
    if (
      n.includes('bakery') ||
      n.includes('bakehouse') ||
      n.includes('patisserie') ||
      n.includes('coffee') ||
      n.includes('espresso') ||
      n.includes('roaster') ||
      n.includes('roastery')
    )
      return 'Bakery / Coffee Shop';
    if (
      n.includes('spa') ||
      n.includes('wellness') ||
      n.includes('massage') ||
      n.includes('facial') ||
      n.includes('skincare') ||
      n.includes('apothecary') ||
      n.includes('holistic')
    )
      return 'Beauty / Spa / Wellness';
    if (
      n.includes('pizza') ||
      n.includes('restaurant') ||
      n.includes('café') ||
      n.includes('cafe') ||
      n.includes('grill') ||
      n.includes('bistro') ||
      n.includes('kitchen') ||
      n.includes('diner') ||
      n.includes('bakery') ||
      n.includes('sushi')
    )
      return 'Restaurant / Café';
    if (
      n.includes('salon') ||
      n.includes('barber') ||
      n.includes('hair') ||
      n.includes('beauty') ||
      n.includes('shear') ||
      n.includes('cuts')
    )
      return 'Salon / Barbershop';
    if (n.includes('law') || n.includes('legal') || n.includes('attorney') || n.includes('counsel'))
      return 'Legal / Law Firm';
    if (
      n.includes('dental') ||
      n.includes('medical') ||
      n.includes('clinic') ||
      n.includes('health') ||
      n.includes('doctor') ||
      n.includes('chiro') ||
      n.includes('therapy') ||
      n.includes('pharma')
    )
      return 'Medical / Healthcare';
    if (
      n.includes('tech') ||
      n.includes('software') ||
      n.includes('digital') ||
      n.includes('solutions') ||
      n.includes('systems') ||
      n.includes('cloud') ||
      n.includes('app')
    )
      return 'Technology / SaaS';
    if (
      n.includes('fitness') ||
      n.includes('gym') ||
      n.includes('crossfit') ||
      n.includes('yoga') ||
      n.includes('pilates') ||
      n.includes('forge')
    )
      return 'Fitness / Gym';
    if (
      n.includes('realty') ||
      n.includes('real estate') ||
      n.includes('properties') ||
      n.includes('homes')
    )
      return 'Real Estate';
    if (
      n.includes('photo') ||
      n.includes('studio') ||
      n.includes('creative') ||
      n.includes('design') ||
      n.includes('art')
    )
      return 'Photography / Creative';
    if (
      n.includes('construct') ||
      n.includes('plumb') ||
      n.includes('electric') ||
      n.includes('roofing') ||
      n.includes('hvac') ||
      n.includes('landscap')
    )
      return 'Construction / Home Services';
    if (
      n.includes('auto') ||
      n.includes('motor') ||
      n.includes('car') ||
      n.includes('tire') ||
      n.includes('mechanic')
    )
      return 'Automotive';
    if (
      n.includes('school') ||
      n.includes('tutor') ||
      n.includes('academy') ||
      n.includes('learning')
    )
      return 'Education / Tutoring';
    if (
      n.includes('account') ||
      n.includes('tax') ||
      n.includes('financial') ||
      n.includes('invest') ||
      n.includes('insurance')
    )
      return 'Financial / Accounting';
    if (n.includes('shop') || n.includes('store') || n.includes('boutique') || n.includes('market'))
      return 'Retail / Shop';
    if (
      n.includes('pub') ||
      n.includes('bar') ||
      n.includes('tavern') ||
      n.includes('lounge') ||
      n.includes('brew')
    )
      return 'Restaurant / Café';
    if (
      n.includes('express') ||
      n.includes('delivery') ||
      n.includes('ship') ||
      n.includes('courier') ||
      n.includes('logistics') ||
      n.includes('택배') ||
      n.includes('parcel') ||
      n.includes('freight')
    )
      return 'Retail / Shop';
    return '';
  }

  private getDesignRecommendations(category: string): {
    style: string;
    themeStyle: string;
    primaryColor: string;
    accentColor: string;
    headingFont: string;
    bodyFont: string;
    audience: string;
    sections: string[];
    extras?: string;
  } {
    const defaults: {
      style: string;
      themeStyle: string;
      primaryColor: string;
      accentColor: string;
      headingFont: string;
      bodyFont: string;
      audience: string;
      sections: string[];
      extras?: string;
    } = {
      style: 'Modern minimalist with bold typography',
      themeStyle: 'classic',
      primaryColor: '#1a1a2e',
      accentColor: '#e94560',
      headingFont: 'Montserrat',
      bodyFont: 'Inter',
      audience: 'Local customers and online visitors',
      sections: [
        'Hero with CTA',
        'Services',
        'About',
        'Testimonials',
        'Gallery',
        'Contact',
        'Footer with social links',
      ],
    };

    const map: Record<string, Partial<typeof defaults>> = {
      'Restaurant / Café': {
        style: 'Warm and inviting with food photography emphasis',
        themeStyle: 'warm',
        primaryColor: '#2d1810',
        accentColor: '#d4a574',
        headingFont: 'Playfair Display',
        bodyFont: 'Lato',
        audience: 'Diners, food enthusiasts, and families looking for a great meal',
        sections: [
          'Hero with ambiance photo',
          'Menu highlights',
          'About the chef',
          'Hours & location',
          'Reservations',
          'Gallery',
          'Reviews',
          'Contact',
        ],
        extras:
          'Include a menu section with prices. Add OpenTable or reservation widget placeholder. Show business hours prominently.',
      },
      'Bar / Nightlife / Brewery': {
        style: 'Cinematic after-dark lounge with dramatic single-source light',
        themeStyle: 'noir',
        primaryColor: '#0e0e12',
        accentColor: '#c8a24a',
        headingFont: 'Cinzel',
        bodyFont: 'Manrope',
        audience: 'Cocktail enthusiasts and night-out crowds seeking an intimate atmosphere',
        sections: [
          'Hero with spotlight wordmark',
          'Signature cocktails / tap list',
          'The room & ambiance',
          'Events & live music',
          'Reservations',
          'Gallery',
          'Hours & location',
          'Contact',
        ],
        extras:
          'Include a "Reserve a table" CTA and a signature-drinks / tap-list menu in a moody, spotlit grid.',
      },
      'Bakery / Coffee Shop': {
        style: 'Nostalgic, playful retro with warm color blocks and badges',
        themeStyle: 'retro',
        primaryColor: '#4a2f1a',
        accentColor: '#e08a2e',
        headingFont: 'Bricolage Grotesque',
        bodyFont: 'DM Sans',
        audience: 'Regulars and newcomers looking for a warm, fun neighborhood spot',
        sections: [
          'Hero with sunburst headline',
          'Menu & daily bakes',
          'Our story',
          'Order & pickup',
          'Gallery',
          'Reviews',
          'Hours & location',
          'Contact',
        ],
        extras:
          'Include an "Order online" CTA and a daily-bakes / menu board laid out in warm retro color blocks.',
      },
      'Beauty / Spa / Wellness': {
        style: 'Handcrafted, earthy and calming with a tactile natural palette',
        themeStyle: 'artisan',
        primaryColor: '#3a2f28',
        accentColor: '#b8794f',
        headingFont: 'Spectral',
        bodyFont: 'Karla',
        audience: 'Clients seeking restorative, natural self-care and small-batch craft',
        sections: [
          'Hero with treatment ambiance',
          'Services & rituals',
          'Our practitioners',
          'Products & ingredients',
          'Booking',
          'Testimonials',
          'Location & hours',
          'Contact',
        ],
        extras:
          'Include a "Book a treatment" CTA and an ingredients / provenance story block with a tactile, handcrafted feel.',
      },
      'Salon / Barbershop': {
        style: 'Sleek and premium with dark accents',
        themeStyle: 'luxe',
        primaryColor: '#1a1a2e',
        accentColor: '#c9a96e',
        headingFont: 'Cormorant Garamond',
        bodyFont: 'Raleway',
        audience: 'Style-conscious clients seeking premium grooming services',
        sections: [
          'Hero with salon interior',
          'Services & pricing',
          'Meet the team',
          'Before/After gallery',
          'Booking CTA',
          'Reviews',
          'Location & hours',
          'Contact',
        ],
        extras:
          'Include a booking button linking to scheduling software. Show service prices in a clean grid.',
      },
      'Legal / Law Firm': {
        style: 'Professional and trustworthy with serif typography',
        themeStyle: 'editorial',
        primaryColor: '#1b2a4a',
        accentColor: '#c0922e',
        headingFont: 'Merriweather',
        bodyFont: 'Source Sans Pro',
        audience: 'Individuals and businesses seeking legal representation',
        sections: [
          'Hero with firm name',
          'Practice areas',
          'Attorney profiles',
          'Case results',
          'Testimonials',
          'Free consultation CTA',
          'Blog/Resources',
          'Contact',
        ],
        extras:
          'Include a "Free Consultation" CTA prominently. Add practice area icons. Professional headshots section.',
      },
      'Medical / Healthcare': {
        style: 'Clean, calming, and trustworthy with fresh organic accents',
        themeStyle: 'botanical',
        primaryColor: '#123b3a',
        accentColor: '#5cc2a6',
        headingFont: 'Poppins',
        bodyFont: 'Open Sans',
        audience: 'Patients seeking quality healthcare services',
        sections: [
          'Hero with facility',
          'Services',
          'Provider profiles',
          'Patient testimonials',
          'Insurance accepted',
          'Online booking',
          'Location & hours',
          'Contact',
        ],
        extras: 'Include HIPAA compliance notice in footer. Add a patient portal link placeholder.',
      },
      'Technology / SaaS': {
        style: 'Futuristic with gradient accents and glassmorphism',
        themeStyle: 'futuristic',
        primaryColor: '#0f0f23',
        accentColor: '#6366f1',
        headingFont: 'Space Grotesk',
        bodyFont: 'Inter',
        audience: 'Tech-savvy professionals and businesses',
        sections: [
          'Hero with product demo',
          'Features grid',
          'How it works',
          'Pricing',
          'Integrations',
          'Testimonials',
          'FAQ',
          'CTA',
        ],
        extras:
          'Include animated feature cards. Add a product screenshot or demo video placeholder.',
      },
      'Fitness / Gym': {
        style: 'Bold and energetic with high contrast',
        themeStyle: 'bold',
        primaryColor: '#1a1a2e',
        accentColor: '#ff4444',
        headingFont: 'Oswald',
        bodyFont: 'Roboto',
        audience: 'Fitness enthusiasts and health-conscious individuals',
        sections: [
          'Hero with action shot',
          'Classes & programs',
          'Trainers',
          'Membership plans',
          'Facility gallery',
          'Success stories',
          'Free trial CTA',
          'Contact',
        ],
        extras: 'Include class schedule section. Bold "Join Now" CTA with pricing.',
      },
      'Real Estate': {
        style: 'Elegant with large property imagery',
        themeStyle: 'luxe',
        primaryColor: '#1a1a2e',
        accentColor: '#2ecc71',
        headingFont: 'Libre Baskerville',
        bodyFont: 'Nunito',
        audience: 'Home buyers, sellers, and investors',
        sections: [
          'Hero with featured listing',
          'Featured properties',
          'Agent profile',
          'Services',
          'Market stats',
          'Testimonials',
          'Search CTA',
          'Contact',
        ],
        extras: 'Include property cards with price, beds, baths. Add neighborhood guides section.',
      },
      'Construction / Home Services': {
        style: 'Rugged and reliable with strong imagery',
        themeStyle: 'rugged',
        primaryColor: '#2c3e50',
        accentColor: '#e67e22',
        headingFont: 'Roboto Slab',
        bodyFont: 'Roboto',
        audience: 'Homeowners and businesses needing renovation or repair services',
        sections: [
          'Hero with project photo',
          'Services',
          'Project gallery',
          'Process steps',
          'Testimonials',
          'Certifications',
          'Free estimate CTA',
          'Contact',
        ],
        extras: 'Include a "Get Free Estimate" form prominently. Show before/after project photos.',
      },
      'Photography / Creative': {
        style: 'Minimal with maximum focus on visual work',
        themeStyle: 'brutalist',
        primaryColor: '#111111',
        accentColor: '#ffffff',
        headingFont: 'DM Sans',
        bodyFont: 'DM Sans',
        audience: 'Clients looking for professional photography or creative services',
        sections: [
          'Full-screen hero gallery',
          'Portfolio grid',
          'About',
          'Services & packages',
          'Client love',
          'Booking',
          'Contact',
        ],
        extras: 'Use a masonry grid for the portfolio. Large, full-bleed images throughout.',
      },
      'Retail / Shop': {
        style: 'Chic boutique with editorial product photography',
        themeStyle: 'boutique',
        primaryColor: '#2a1f2d',
        accentColor: '#b76e79',
        headingFont: 'Fraunces',
        bodyFont: 'Jost',
        audience: 'Shoppers seeking a curated, premium retail experience',
        sections: [
          'Hero lookbook',
          'Featured products',
          'Collections',
          'About the shop',
          'Reviews',
          'Visit us & hours',
          'Newsletter signup',
          'Contact',
        ],
        extras:
          'Show a shoppable product grid with price + quick-add. Add a "Shop the look" section and a store-hours + map block.',
      },
      Automotive: {
        style: 'Engineered and sleek with metallic accents',
        themeStyle: 'precision',
        primaryColor: '#15181c',
        accentColor: '#d81f26',
        headingFont: 'Rajdhani',
        bodyFont: 'Inter',
        audience: 'Drivers seeking sales, service, or repairs they can trust',
        sections: [
          'Hero vehicle shot',
          'Services & inventory',
          'Why choose us',
          'Specials & financing',
          'Reviews',
          'Book service / Get a quote',
          'Location & hours',
          'Contact',
        ],
        extras:
          'Include a "Book Service" or "Get a Quote" CTA. Show service/spec cards in a precise grid with technical captions.',
      },
      'Education / Tutoring': {
        style: 'Bright and encouraging with friendly rounded shapes',
        themeStyle: 'scholarly',
        primaryColor: '#1c3d5a',
        accentColor: '#ffb703',
        headingFont: 'Poppins',
        bodyFont: 'Nunito',
        audience: 'Students, parents, and lifelong learners',
        sections: [
          'Hero with students',
          'Programs & subjects',
          'How it works',
          'Meet the tutors',
          'Success stories',
          'Pricing & enroll',
          'FAQ',
          'Contact',
        ],
        extras:
          'Include an "Enroll" or "Book a Free Session" CTA. Show program cards + testimonial bubbles.',
      },
      'Financial / Accounting': {
        style: 'Timeless and authoritative with serif typography',
        themeStyle: 'heritage',
        primaryColor: '#0e2338',
        accentColor: '#b08d57',
        headingFont: 'Playfair Display',
        bodyFont: 'Source Sans Pro',
        audience: 'Individuals and businesses seeking trusted financial guidance',
        sections: [
          'Hero with firm name',
          'Services',
          'Our approach',
          'Team & credentials',
          'Results & stats',
          'Testimonials',
          'Schedule a consultation',
          'Contact',
        ],
        extras:
          'Include a "Schedule a Consultation" CTA. Show a credentials/certifications strip and years-in-business + clients-served counters.',
      },
    };

    const rec = map[category];
    return rec ? ({ ...defaults, ...rec } as typeof defaults) : defaults;
  }

  private static readonly DRAFT_KEY = 'ps_create_draft';

  saveFormDraft(): void {
    const draft = {
      businessName: this.businessName,
      businessAddress: this.businessAddress,
      businessPhone: this.businessPhone,
      businessWebsite: this.businessWebsite,
      businessCategory: this.businessCategory,
      additionalContext: this.additionalContext,
      aiLogoUrl: this.aiLogoUrl,
      aiLogoQuality: this.aiLogoQuality,
      aiFaviconUrl: this.aiFaviconUrl,
      aiFaviconQuality: this.aiFaviconQuality,
      aiImageUrls: this.aiImageUrls,
      brandAssessment: this.brandAssessment,
      selectedBusiness: this.selectedBusiness(),
      savedAt: Date.now(),
    };
    try {
      localStorage.setItem(CreateComponent.DRAFT_KEY, JSON.stringify(draft));
    } catch {
      /* quota exceeded — ignore */
    }
  }

  private restoreFormDraft(): void {
    try {
      const raw = localStorage.getItem(CreateComponent.DRAFT_KEY);
      if (!raw) return;
      const draft = JSON.parse(raw);
      // Only restore if saved within the last 24 hours
      if (draft.savedAt && Date.now() - draft.savedAt > 86400000) {
        localStorage.removeItem(CreateComponent.DRAFT_KEY);
        return;
      }
      if (draft.businessName) this.businessName = draft.businessName;
      if (draft.businessAddress) this.businessAddress = draft.businessAddress;
      if (draft.businessPhone) this.businessPhone = draft.businessPhone;
      if (draft.businessWebsite) this.businessWebsite = cleanUrl(draft.businessWebsite);
      if (draft.businessCategory) this.businessCategory = draft.businessCategory;
      if (draft.additionalContext) this.additionalContext = draft.additionalContext;
      if (draft.aiLogoUrl) this.aiLogoUrl = draft.aiLogoUrl;
      if (draft.aiLogoQuality) this.aiLogoQuality = draft.aiLogoQuality;
      if (draft.aiFaviconUrl) this.aiFaviconUrl = draft.aiFaviconUrl;
      if (draft.aiFaviconQuality) this.aiFaviconQuality = draft.aiFaviconQuality;
      if (draft.brandAssessment) this.brandAssessment = draft.brandAssessment;
      if (draft.aiImageUrls?.length) this.aiImageUrls = draft.aiImageUrls;
      if (draft.selectedBusiness?.place_id) this.selectedBusiness.set(draft.selectedBusiness);
      // Force Angular to pick up the category select value
      setTimeout(() => this.cdr.detectChanges(), 0);
    } catch {
      /* corrupt data — ignore */
    }
  }

  clearFormDraft(): void {
    localStorage.removeItem(CreateComponent.DRAFT_KEY);
  }

  /**
   * Prefill the form from a claimyour.site claim link. Fetches the researched
   * lead profile and applies present fields; failures are silent (the form just
   * stays empty for the user to fill). The background build is already running.
   */
  loadClaimPrefill(shortlink: string): void {
    this.claimShortlink = shortlink;
    this.api
      .get<{
        data?: {
          prefill?: Record<string, unknown>;
          buildStatus?: string;
          previewUrl?: string | null;
        };
      }>(`/claim/${encodeURIComponent(shortlink)}/profile`)
      .subscribe({
        next: (res) => {
          const f = mapClaimPrefillToFields(res?.data?.prefill ?? {});
          if (f.businessName) {
            this.businessName = f.businessName;
            this.markTouched('name');
          }
          if (f.businessAddress) {
            this.businessAddress = f.businessAddress;
            this.markTouched('address');
          }
          if (f.businessPhone) {
            this.businessPhone = f.businessPhone;
            this.markTouched('phone');
          }
          if (f.businessWebsite) {
            this.businessWebsite = f.businessWebsite;
            this.markTouched('website');
          }
          if (f.businessCategory) this.businessCategory = f.businessCategory;
          if (f.additionalContext) this.additionalContext = f.additionalContext;
          // Surface the background build that the claim link already kicked off,
          // then poll until it finishes so the visitor sees the preview link the
          // moment it's ready (the build survives them leaving this page).
          const state = parseClaimBuildState(res?.data);
          this.claimBuildStatus.set(state.status);
          this.claimPreviewUrl.set(state.previewUrl);
          this.cdr.detectChanges();
          if (!state.terminal && (state.status === 'building' || state.status === 'pending')) {
            this.pollClaimBuild(shortlink);
          }
        },
        error: () => {
          /* claim prefill is best-effort — leave the form empty */
        },
      });
  }

  /**
   * Poll the claim profile endpoint every 5s until the background build reaches
   * a terminal state, updating the status banner + preview link. Self-cancels on
   * terminal status and on component destroy (takeUntil + stored subscription) —
   * no leaked timer (per the route-subscribe-leak discipline).
   */
  private pollClaimBuild(shortlink: string): void {
    this.claimPollSub?.unsubscribe();
    this.claimPollSub = timer(5000, 5000)
      .pipe(
        switchMap(() =>
          this.api
            .get<{
              data?: { buildStatus?: string; previewUrl?: string | null };
            }>(`/claim/${encodeURIComponent(shortlink)}/profile`)
            .pipe(catchError(() => of(null))),
        ),
        takeUntil(this.destroy$),
      )
      .subscribe((res) => {
        if (!res) return; // a transient fetch error — keep polling
        const state = parseClaimBuildState(res.data);
        this.claimBuildStatus.set(state.status);
        this.claimPreviewUrl.set(state.previewUrl);
        this.cdr.detectChanges();
        if (state.terminal) this.claimPollSub?.unsubscribe();
      });
  }

  onLogoSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file && file.size <= 5 * 1024 * 1024) {
      this.logoFile = file;
      this.logoPreview = URL.createObjectURL(file);
    } else if (file) {
      this.toast.error('Logo must be under 5 MB');
    }
  }

  removeLogo(): void {
    this.logoFile = null;
    this.aiLogoUrl = null;
    if (this.logoPreview) {
      URL.revokeObjectURL(this.logoPreview);
      this.logoPreview = null;
    }
  }

  onFaviconSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file && file.size <= 2 * 1024 * 1024 && file.type === 'image/png') {
      this.faviconFile = file;
      this.faviconPreview = URL.createObjectURL(file);
    } else if (file) {
      this.toast.error('Favicon must be a PNG under 2 MB');
    }
  }

  removeFavicon(): void {
    this.faviconFile = null;
    this.aiFaviconUrl = null;
    if (this.faviconPreview) {
      URL.revokeObjectURL(this.faviconPreview);
      this.faviconPreview = null;
    }
  }

  removeAiImage(url: string): void {
    this.aiImageUrls = this.aiImageUrls.filter((img) => img.url !== url);
    this.saveFormDraft();
  }

  onAiLogoError(): void {
    this.aiLogoUrl = null;
    this.saveFormDraft();
  }

  onAiFaviconError(): void {
    this.aiFaviconUrl = null;
    this.saveFormDraft();
  }

  onAiImageLoad(event: Event, url: string): void {
    const img = event.target as HTMLImageElement;
    // Remove images that loaded but are actually transparent 1x1 pixels or tiny placeholders
    if (img.naturalWidth <= 2 || img.naturalHeight <= 2) {
      this.removeAiImage(url);
      return;
    }
    // JS fallback: force the correct width based on aspect ratio at 64px height
    const ratio = img.naturalWidth / img.naturalHeight;
    const targetWidth = Math.round(64 * ratio);
    img.style.width = targetWidth + 'px';
    img.style.height = '64px';
  }

  openImageModal(url: string, name: string): void {
    this.modalImage.set(url);
    this.modalImageName.set(name);
    this.modalAiPrompt = '';
    this.modalAiProcessing.set(false);
  }

  closeImageModal(): void {
    this.modalImage.set(null);
    this.modalImageName.set('');
    this.modalAiPrompt = '';
    this.modalAiProcessing.set(false);
  }

  submitImageAiEdit(): void {
    if (!this.modalAiPrompt.trim() || this.modalAiProcessing()) return;
    const currentUrl = this.modalImage();
    this.modalAiProcessing.set(true);

    this.api.editImage(this.modalAiPrompt, currentUrl || undefined).subscribe({
      next: (res) => {
        const newUrl = res.data.url;
        // Preload the new image before swapping — keep processing state until loaded
        const preload = new Image();
        preload.onload = () => {
          // Replace the image in whichever slot it belongs to
          if (currentUrl === this.aiLogoUrl) {
            this.aiLogoUrl = newUrl;
          } else if (currentUrl === this.aiFaviconUrl) {
            this.aiFaviconUrl = newUrl;
          } else {
            const idx = this.aiImageUrls.findIndex((img) => img.url === currentUrl);
            if (idx >= 0) {
              this.aiImageUrls[idx] = { url: newUrl, name: this.aiImageUrls[idx].name };
              this.aiImageUrls = [...this.aiImageUrls];
            }
          }
          this.modalImage.set(newUrl);
          this.modalAiProcessing.set(false);
          this.modalAiPrompt = '';
          this.saveFormDraft();
          this.cdr.detectChanges();
          this.toast.success('Image updated with AI');
        };
        preload.onerror = () => {
          this.modalAiProcessing.set(false);
          this.toast.error('Generated image failed to load');
        };
        preload.src = newUrl;
      },
      error: (err) => {
        this.modalAiProcessing.set(false);
        this.toast.error(err?.error?.error?.message || 'AI image generation failed');
      },
    });
  }

  onImagesSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files || []);
    const maxSize = 10 * 1024 * 1024;
    const valid = files.filter((f) => f.size <= maxSize).slice(0, 20 - this.additionalFiles.length);
    if (valid.length < files.length) {
      this.toast.info(`${files.length - valid.length} files skipped (too large or limit reached)`);
    }
    this.additionalFiles.push(...valid);
    for (const file of valid) {
      this.imagePreviews.push({ name: file.name, url: URL.createObjectURL(file) });
    }
  }

  removeImage(name: string): void {
    const idx = this.imagePreviews.findIndex((p) => p.name === name);
    if (idx >= 0) {
      URL.revokeObjectURL(this.imagePreviews[idx].url);
      this.imagePreviews.splice(idx, 1);
    }
    this.additionalFiles = this.additionalFiles.filter((f) => f.name !== name);
  }

  private hasFilesToUpload(): boolean {
    return !!(this.logoFile || this.faviconFile || this.additionalFiles.length > 0);
  }

  private buildUploadFormData(): FormData {
    const fd = new FormData();
    if (this.logoFile) fd.append('logo', this.logoFile);
    if (this.faviconFile) fd.append('favicon', this.faviconFile);
    for (const file of this.additionalFiles) fd.append('images', file);
    return fd;
  }

  submitBuild(): void {
    this.attempted.set(true);
    if (!this.businessName.trim()) {
      this.setStep(1);
      this.toast.error('Business name is required so we know what site to build.');
      return;
    }
    if (!this.businessAddress.trim()) {
      this.setStep(1);
      this.toast.error('Address is required for local SEO and the contact card.');
      return;
    }

    // If not logged in, store business info and redirect to signin
    if (!this.auth.isLoggedIn()) {
      this.auth.setMode('custom');
      this.auth.setSelectedBusiness({
        name: this.businessName.trim(),
        address: this.businessAddress.trim(),
        phone: this.businessPhone.trim() || undefined,
        website: this.businessWebsite.trim() || undefined,
      });
      this.auth.setPendingBuild(true);
      this.router.navigate(['/signin']);
      return;
    }

    this.submitting.set(true);
    // Fires GA4 `generate_lead` via the conversion alias in TelemetryService.
    this.telemetry.track('site.create.submitted', {
      mode: this.selectedBusiness() ? 'business' : 'custom',
      reset_mode: !!this.resetSiteId,
      has_uploads: this.hasFilesToUpload(),
      has_context: this.additionalContext.trim().length > 0,
    });

    // Reset mode: rebuild an existing site
    if (this.resetSiteId) {
      this.api
        .resetSite(this.resetSiteId, {
          business: { name: this.businessName.trim(), address: this.businessAddress.trim() },
          additional_context: this.additionalContext || undefined,
        })
        .subscribe({
          next: () => {
            this.submitting.set(false);
            this.toast.success('Reset triggered — rebuilding site...');
            this.router.navigate(['/admin']);
          },
          error: (err) => {
            this.submitting.set(false);
            this.toast.error(err?.error?.error?.message || err?.error?.message || 'Reset failed');
            this.telemetry.track('site.create.failed', {
              reset_mode: true,
              status: err?.status,
            });
          },
        });
      return;
    }

    // Upload files first if present, then create site
    if (this.hasFilesToUpload()) {
      const count =
        (this.logoFile ? 1 : 0) + (this.faviconFile ? 1 : 0) + this.additionalFiles.length;
      this.toast.info(`Uploading ${count} asset${count === 1 ? '' : 's'}...`);
      this.api.uploadAssets(this.buildUploadFormData()).subscribe({
        next: (uploadRes) => {
          this.toast.success(`${count} asset${count === 1 ? '' : 's'} uploaded — starting build…`);
          this.createSiteWithUploadId(uploadRes.data.upload_id);
        },
        error: () => {
          this.submitting.set(false);
          // api.service already toasted a human-readable error — extra inline cue here is the disabled state lifting.
        },
      });
    } else {
      this.createSiteWithUploadId(undefined);
    }
  }

  private createSiteWithUploadId(uploadId?: string): void {
    const biz = this.selectedBusiness();

    const payload: CreateSitePayload & { upload_id?: string } = {
      mode: biz ? 'business' : 'custom',
      additional_context: this.additionalContext || undefined,
      business: {
        name: this.businessName.trim(),
        address: this.businessAddress.trim(),
        place_id: biz?.place_id,
        phone: this.businessPhone.trim() || undefined,
        website: this.businessWebsite.trim() || undefined,
        types: biz?.types,
        category: this.businessCategory || undefined,
      },
    };
    // AL-467: forward the deliberate theme personality as an AUTHORITATIVE signal
    // (not just the dossier prose baked into additional_context) — but ONLY for a
    // known dropdown category, so the worker still derives from the business name /
    // Places type for '' / 'Other' / freeform verticals (never forced to classic).
    const cat = this.businessCategory?.trim();
    if (cat && cat !== 'Other' && this.categories.includes(cat)) {
      payload.theme_style = this.getDesignRecommendations(cat).themeStyle;
    }
    if (uploadId) payload.upload_id = uploadId;

    this.api.createSiteFromSearch(payload).subscribe({
      next: (res) => {
        this.submitting.set(false);
        this.auth.clearSelectedBusiness();
        this.auth.setPendingBuild(false);
        this.clearFormDraft();
        try {
          sessionStorage.removeItem(CreateComponent.STEP_KEY);
        } catch {
          /* ignore */
        }
        this.toast.success('Site build started!');
        // API returns site_id (not id) — handle both formats
        const siteId = res.data.site_id || res.data.id;
        const slug = res.data.slug;
        this.router.navigate(['/waiting'], {
          queryParams: { id: siteId, slug },
        });
      },
      error: (err) => {
        this.submitting.set(false);
        this.toast.error(
          err?.error?.error?.message || err?.error?.message || 'Failed to create site',
        );
        this.telemetry.track('site.create.failed', {
          reset_mode: false,
          status: err?.status,
        });
      },
    });
  }
}
