import { Directive, ElementRef, effect, inject, input } from '@angular/core';
import { ApiService } from '../services/api.service';

/**
 * Apply `appAuthImageSrc` to an `img` to load it from a BEARER-authenticated
 * same-origin endpoint.
 *
 * A plain `img` whose `src` is an `/api/…` route triggers a browser navigation
 * that sends NO `Authorization` header (auth here is bearer-only, not cookie) →
 * the request 401s → a broken image. This directive fetches the bytes WITH auth
 * via {@link ApiService.getBlobAbsolute}, binds an object URL, and — via the
 * effect's `onCleanup` — cancels any in-flight fetch and revokes the prior object
 * URL on every src change / destroy, so no object URL leaks and a slow stale fetch
 * can never overwrite a newer src.
 *
 * The fetch is `silent` (no toast) — a failed thumbnail should degrade to a blank
 * image, not nag the user. See the `plain-navigation-cant-carry-bearer` project memory.
 *
 * @example
 * ```html
 * <img [appAuthImageSrc]="screenshotUrl(snap, m)" alt="…" width="320" height="180" />
 * ```
 */
@Directive({ selector: 'img[appAuthImageSrc]', standalone: true })
export class AuthImageSrcDirective {
  private readonly api = inject(ApiService);
  private readonly el: ElementRef<HTMLImageElement> = inject(ElementRef);

  /** The authed absolute path to load (e.g. `/api/sites/…/screenshot.png`). */
  readonly appAuthImageSrc = input<string | null>(null);

  constructor() {
    // Re-run on every src change. `onCleanup` (fired before the next run AND on
    // destroy) cancels the prior in-flight fetch and revokes its object URL — a
    // single place that both prevents leaks and stops a slow old fetch from binding
    // a stale URL over a newer one. Replaces the old ngOnChanges + ngOnDestroy pair.
    effect((onCleanup) => {
      const src = this.appAuthImageSrc();
      if (!src) {
        this.el.nativeElement.removeAttribute('src');
        return;
      }
      let objectUrl: string | null = null;
      const sub = this.api.getBlobAbsolute(src, { silent: true }).subscribe({
        next: (blob) => {
          objectUrl = URL.createObjectURL(blob);
          this.el.nativeElement.src = objectUrl;
        },
        error: () => {
          // Leave the element blank — a broken authed thumbnail is not user-actionable.
        },
      });
      onCleanup(() => {
        sub.unsubscribe();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      });
    });
  }
}
