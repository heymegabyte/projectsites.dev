import { Injectable, signal } from '@angular/core';

/**
 * Opens the domain menu popup for the currently-selected site. A root singleton (leaf module —
 * imports nothing but @angular/core) so ANY surface can open the SAME popup by flipping one
 * signal without dragging in the popup component: the editor Preview URL-bar button (via the
 * `PS_OPEN_DOMAIN_MENU` bridge message → BoltEmbedService), the admin navbar, Cmd+K, etc.
 * `DomainMenuPopupComponent` is mounted once in the admin shell and renders whenever `isOpen()`.
 */
@Injectable({ providedIn: 'root' })
export class DomainMenuService {
  readonly isOpen = signal(false);
  open(): void {
    this.isOpen.set(true);
  }
  close(): void {
    this.isOpen.set(false);
  }
  toggle(): void {
    this.isOpen.update((v) => !v);
  }
}
