import { Component, type OnInit, type OnDestroy, inject, signal, ElementRef, ViewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { Subject, debounceTime, distinctUntilChanged, switchMap, forkJoin, of, takeUntil } from 'rxjs';
import { ApiService, type BusinessResult } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { GeolocationService } from '../../services/geolocation.service';
import { ToastService } from '../../services/toast.service';
import { canPreviewPrebuilt, prebuiltPreviewUrl } from '../homepage/prebuilt-preview';

interface SearchItem {
  type: 'business' | 'prebuilt' | 'custom';
  name: string;
  address: string;
  place_id?: string;
  distance?: string;
  distanceMiles?: number;
  lat?: number;
  lng?: number;
  phone?: string;
  website?: string;
  types?: string[];
  siteId?: string;
  slug?: string;
  status?: string;
}

@Component({
  selector: 'app-search',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './search.component.html',
  styleUrl: './search.component.scss',
})
export class SearchComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private geo = inject(GeolocationService);
  private toast = inject(ToastService);
  private router = inject(Router);

  @ViewChild('searchInput') searchInput!: ElementRef<HTMLInputElement>;

  query = '';
  results = signal<SearchItem[]>([]);
  loading = signal(false);
  dropdownOpen = signal(false);
  showLocationPrompt = signal(false);
  /** True when the Google Places proxy returns a provider `_error` — the UI nudges
   * the guest to pick "Build a custom website" and enter details manually. */
  searchUnavailable = signal(false);

  // FAQ
  openFaqIndex = signal<number | null>(null);

  // Pricing
  annualPricing = signal(false);

  // Contact form
  contactName = '';
  contactEmail = '';
  contactPhone = '';
  contactMessage = '';
  contactSubmitting = signal(false);
  contactSuccess = signal(false);

  private searchSubject = new Subject<string>();
  private destroy$ = new Subject<void>();

  ngOnInit(): void {
    this.searchSubject
      .pipe(
        debounceTime(300),
        distinctUntilChanged(),
        switchMap((q) => {
          if (q.length < 2) {
            this.results.set([]);
            this.dropdownOpen.set(false);
            this.searchUnavailable.set(false);
            return of(null);
          }
          this.loading.set(true);
          const lat = this.geo.lat() ?? undefined;
          const lng = this.geo.lng() ?? undefined;
          return forkJoin({
            businesses: this.api.searchBusinesses(q, lat, lng, { silent: true }),
            sites: this.api.searchSites(q),
          });
        }),
        takeUntil(this.destroy$)
      )
      .subscribe({
        next: (res) => {
        this.loading.set(false);
        if (!res) return;

        // A provider `_error` on the businesses proxy means Google lookup is down.
        this.searchUnavailable.set(res.businesses._error != null);

        const items: SearchItem[] = [];
        const seen = new Set<string>();

        // Build a map of Google Places data by place_id for cross-referencing
        const placeMap = new Map<string, BusinessResult>();
        for (const b of res.businesses.data || []) {
          if (b.place_id) {
            placeMap.set(b.place_id, b);
          }
        }

        // Pre-built sites first
        for (const s of res.sites.data || []) {
          const key = s.place_id || s.business_name;
          if (!seen.has(key)) {
            seen.add(key);
            // Cross-reference with Google Places data for lat/lng and distance
            const placeData = s.place_id ? placeMap.get(s.place_id) : undefined;
            const item: SearchItem = {
              type: 'prebuilt',
              name: s.business_name,
              address: s.business_address,
              place_id: s.place_id,
              siteId: s.id,
              slug: s.slug,
              status: s.status,
              lat: placeData?.lat,
              lng: placeData?.lng,
              phone: placeData?.phone,
              website: placeData?.website,
              types: placeData?.types,
            };
            if (this.geo.hasLocation() && placeData?.lat && placeData?.lng) {
              const miles = this.geo.distanceMiles(this.geo.lat()!, this.geo.lng()!, placeData.lat, placeData.lng);
              item.distanceMiles = miles;
              item.distance = this.geo.formatDistance(miles);
            }
            items.push(item);
          }
        }

        // Google Places results
        for (const b of res.businesses.data || []) {
          const key = b.place_id || b.name;
          if (!seen.has(key)) {
            seen.add(key);
            const item: SearchItem = {
              type: 'business',
              name: b.name,
              address: b.address,
              place_id: b.place_id,
              lat: b.lat,
              lng: b.lng,
              phone: b.phone,
              website: b.website,
              types: b.types,
            };
            if (this.geo.hasLocation() && b.lat && b.lng) {
              const miles = this.geo.distanceMiles(this.geo.lat()!, this.geo.lng()!, b.lat, b.lng);
              item.distanceMiles = miles;
              item.distance = this.geo.formatDistance(miles);
            }
            items.push(item);
          }
        }

        // Sort by distance if available
        items.sort((a, b) => {
          if (a.type === 'prebuilt' && b.type !== 'prebuilt') return -1;
          if (b.type === 'prebuilt' && a.type !== 'prebuilt') return 1;
          return (a.distanceMiles ?? Infinity) - (b.distanceMiles ?? Infinity);
        });

        // Add custom option
        items.push({
          type: 'custom',
          name: 'Build a custom website',
          address: 'Enter your business details manually',
        });

        this.results.set(items);
        this.dropdownOpen.set(true);
        },
        error: () => {
          this.loading.set(false);
          this.searchUnavailable.set(true);
        },
      });

    // Request geolocation after delay
    if (!this.auth.isLocationDeclined()) {
      setTimeout(() => this.checkGeolocation(), 5000);
    }
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  onSearchInput(): void {
    this.searchSubject.next(this.query);
  }

  /** Whether a search result exposes a live, already-built site the guest can preview. */
  canPreview(item: SearchItem): boolean {
    return canPreviewPrebuilt(item);
  }

  /** Public URL of the delivered site for the Preview affordance (`''` when not previewable). */
  previewUrl(item: SearchItem): string {
    return prebuiltPreviewUrl(item.slug);
  }

  selectItem(item: SearchItem): void {
    this.dropdownOpen.set(false);

    if (item.type === 'custom') {
      this.auth.setMode('custom');
      this.auth.clearSelectedBusiness();
      this.navigateToDetailsOrSignin();
      return;
    }

    // All results (business or prebuilt) navigate to /create with business data pre-loaded
    this.auth.setMode('business');
    localStorage.removeItem('ps_create_draft');
    this.auth.setSelectedBusiness({
      name: item.name,
      address: item.address,
      place_id: item.place_id,
      phone: item.phone,
      website: item.website,
      types: item.types,
      lat: item.lat,
      lng: item.lng,
    });

    this.navigateToDetailsOrSignin();
  }

  private navigateToDetailsOrSignin(): void {
    if (this.auth.isLoggedIn()) {
      this.router.navigate(['/create']);
    } else {
      this.router.navigate(['/signin']);
    }
  }

  private async checkGeolocation(): Promise<void> {
    if (this.geo.hasLocation()) return;
    try {
      const perm = await navigator.permissions.query({ name: 'geolocation' });
      if (perm.state === 'granted') {
        this.geo.requestLocation();
      } else if (perm.state === 'prompt') {
        this.showLocationPrompt.set(true);
      }
    } catch {
      // Permissions API not supported
      this.showLocationPrompt.set(true);
    }
  }

  allowLocation(): void {
    this.showLocationPrompt.set(false);
    this.geo.requestLocation();
  }

  skipLocation(): void {
    this.showLocationPrompt.set(false);
    this.auth.setLocationDeclined();
  }

  closeDropdown(): void {
    setTimeout(() => this.dropdownOpen.set(false), 200);
  }

  toggleFaq(index: number): void {
    this.openFaqIndex.set(this.openFaqIndex() === index ? null : index);
  }

  togglePricing(): void {
    this.annualPricing.set(!this.annualPricing());
  }

  startBuildFlow(): void {
    if (this.searchInput?.nativeElement) {
      this.searchInput.nativeElement.focus();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  scrollToHow(): void {
    document.getElementById('how-it-works')?.scrollIntoView({ behavior: 'smooth' });
  }

  submitContact(): void {
    if (!this.contactName || !this.contactEmail || !this.contactMessage) {
      this.toast.show('Please fill in all required fields.', 'error');
      return;
    }
    this.contactSubmitting.set(true);
    this.api.submitContact({
      name: this.contactName,
      email: this.contactEmail,
      phone: this.contactPhone || undefined,
      message: this.contactMessage,
    }).subscribe({
      next: () => {
        this.contactSubmitting.set(false);
        this.contactSuccess.set(true);
        this.contactName = '';
        this.contactEmail = '';
        this.contactPhone = '';
        this.contactMessage = '';
        this.toast.show('Message sent! We\'ll get back to you soon.', 'success');
      },
      error: () => {
        this.contactSubmitting.set(false);
        this.toast.show('Failed to send message. Please try again.', 'error');
      },
    });
  }
}
