import { Component, type OnInit, signal, computed, inject, type OnDestroy, HostListener, ViewChild, ElementRef } from '@angular/core';
import { Router } from '@angular/router';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { InstallPromptService } from '../../services/install-prompt.service';
import { interval, Subscription, switchMap, filter } from 'rxjs';

interface Notification {
  id: string;
  type: string;
  title: string;
  message: string;
  action_url: string | null;
  read: number;
  created_at: string;
}

@Component({
  selector: 'app-notification-bell',
  standalone: true,
  imports: [],
  template: `
    <div class="notification-wrapper">
      <button
        #bellBtn
        class="bell-btn"
        [class.has-unread]="displayUnread() > 0"
        (click)="toggleDropdown()"
        [attr.aria-label]="'Notifications' + (displayUnread() > 0 ? ', ' + displayUnread() + ' unread' : '')"
        aria-haspopup="true"
        [attr.aria-expanded]="isOpen()"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/>
          <path d="M13.73 21a2 2 0 01-3.46 0"/>
        </svg>
        @if (displayUnread() > 0) {
          <span class="badge" [attr.aria-hidden]="true">{{ displayUnread() > 9 ? '9+' : displayUnread() }}</span>
          <span class="ring-pulse" aria-hidden="true"></span>
        }
      </button>

      @if (isOpen()) {
        <div class="dropdown">
          <div class="dropdown-header">
            <span>Notifications</span>
            @if (unreadCount() > 0) {
              <button class="mark-all-btn" (click)="markAllRead()">Mark all read</button>
            }
          </div>

          @if (displayNotifications().length === 0) {
            <div class="empty-state">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#3e3e5a" stroke-width="1.5">
                <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                <path d="M13.73 21a2 2 0 01-3.46 0"/>
              </svg>
              <p>No notifications yet</p>
            </div>
          } @else {
            <div class="notification-list">
              @for (notif of displayNotifications(); track notif.id) {
                @if (notif.type === 'install') {
                  <!-- Install Project Sites — an in-app App Notification with an Install
                       action (native beforeinstallprompt) or the iOS Share→A2HS hint. -->
                  <div class="notification-item install-notif unread" data-testid="notif-install">
                    <div class="notif-icon" data-type="install">⤓</div>
                    <div class="notif-content">
                      <span class="notif-title">{{ notif.title }}</span>
                      <span class="notif-message">{{ notif.message }}</span>
                      <div class="install-actions">
                        @if (install.mode() === 'native') {
                          <button type="button" class="install-cta" (click)="doInstall()" data-testid="notif-install-accept">Install</button>
                        }
                        <button type="button" class="install-dismiss-btn" (click)="dismissInstall()" data-testid="notif-install-dismiss">Dismiss</button>
                      </div>
                    </div>
                    <span class="unread-dot"></span>
                  </div>
                } @else {
                  <button
                    type="button"
                    class="notification-item"
                    [class.unread]="!notif.read"
                    (click)="handleClick(notif)"
                  >
                    <div class="notif-icon" [attr.data-type]="notif.type">
                      {{ typeIcon(notif.type) }}
                    </div>
                    <div class="notif-content">
                      <span class="notif-title">{{ notif.title }}</span>
                      <span class="notif-message">{{ notif.message }}</span>
                      <span class="notif-time">{{ timeAgo(notif.created_at) }}</span>
                    </div>
                    @if (!notif.read) {
                      <span class="unread-dot"></span>
                    }
                  </button>
                }
              }
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .notification-wrapper { position: relative; }
    .bell-btn {
      background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06);
      color: #94a3b8; cursor: pointer;
      padding: 8px; position: relative; border-radius: 10px;
      transition:
        color var(--ps-dur-fast, 140ms) var(--ps-ease-emphasized, cubic-bezier(0.16,1,0.3,1)),
        background var(--ps-dur-fast, 140ms),
        border-color var(--ps-dur-fast, 140ms),
        transform var(--ps-dur-fast, 140ms),
        box-shadow var(--ps-dur-base, 220ms);
    }
    .bell-btn:hover {
      color: #00E5FF; background: rgba(0,229,255,0.08);
      border-color: rgba(0,229,255,0.25);
      transform: translateY(-1px);
      box-shadow: 0 4px 14px -4px rgba(0,229,255,0.30);
    }
    .bell-btn:focus-visible { outline: 2px solid #00E5FF; outline-offset: 2px; }
    .bell-btn.has-unread svg { animation: bellShake 2.6s ease-in-out infinite; transform-origin: 50% 4px; }
    @keyframes bellShake {
      0%, 88%, 100% { transform: rotate(0); }
      90% { transform: rotate(-10deg); }
      92% { transform: rotate(10deg); }
      94% { transform: rotate(-7deg); }
      96% { transform: rotate(7deg); }
      98% { transform: rotate(0); }
    }
    @media (prefers-reduced-motion: reduce) {
      .bell-btn.has-unread svg { animation: none; }
      .ring-pulse { animation: none !important; }
      .bell-btn:hover { transform: none; }
    }
    .badge {
      position: absolute; top: 2px; right: 2px;
      background: linear-gradient(135deg, #f43f5e, #ef4444);
      color: #fff; font-size: 10px;
      font-weight: 800; min-width: 18px; height: 18px;
      border-radius: 999px; display: flex; align-items: center;
      justify-content: center; padding: 0 5px;
      box-shadow: 0 0 0 2px #060610, 0 4px 10px -2px rgba(239,68,68,0.6);
      font-variant-numeric: tabular-nums;
      letter-spacing: -0.01em;
      z-index: 2;
    }
    /* Concentric pulse ring on unread — fires every 2.4s. */
    .ring-pulse {
      position: absolute; top: 1px; right: 1px;
      width: 20px; height: 20px; border-radius: 999px;
      pointer-events: none;
      box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.55);
      animation: ringPulse 2.4s cubic-bezier(0.16, 1, 0.3, 1) infinite;
      z-index: 1;
    }
    @keyframes ringPulse {
      0%   { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.55); opacity: 0.9; }
      70%  { box-shadow: 0 0 0 10px rgba(239, 68, 68, 0); opacity: 0; }
      100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); opacity: 0; }
    }
    .dropdown {
      position: absolute; top: calc(100% + 8px); right: 0;
      width: 360px; max-height: 420px; overflow-y: auto;
      background:
        radial-gradient(ellipse 100% 60% at 50% 0%, rgba(0, 229, 255, 0.06), transparent 60%),
        linear-gradient(180deg, rgba(20, 20, 42, 0.96), rgba(10, 10, 28, 0.98));
      backdrop-filter: blur(18px) saturate(150%);
      -webkit-backdrop-filter: blur(18px) saturate(150%);
      border: 1px solid color-mix(in oklch, #00E5FF 22%, transparent);
      border-radius: var(--ps-radius-md, 12px);
      box-shadow:
        0 16px 48px -8px rgba(0, 0, 0, 0.55),
        0 0 80px rgba(0, 229, 255, 0.05),
        inset 0 1px 0 rgba(255, 255, 255, 0.06);
      animation: dropdownIn 240ms var(--ps-ease-emphasized, cubic-bezier(0.16, 1, 0.3, 1)) both;
      transform-origin: top right;
      z-index: 1100;
      isolation: isolate;
    }
    .dropdown::before {
      content: ""; position: absolute; top: 0; left: 0; right: 0; height: 1px;
      background: linear-gradient(90deg, transparent, rgba(0,229,255,0.55) 30%, rgba(124,58,237,0.40) 70%, transparent);
      pointer-events: none;
    }
    .dropdown-header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 14px 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      font-family: 'Sora', system-ui, sans-serif;
      font-size: 14px; font-weight: 700; color: #f0f0f8;
      letter-spacing: -0.01em;
    }
    .mark-all-btn {
      background: rgba(0, 229, 255, 0.08); border: 1px solid rgba(0, 229, 255, 0.22);
      color: #00E5FF; font-size: 11px; font-weight: 700;
      cursor: pointer; padding: 4px 10px; border-radius: 6px;
      letter-spacing: 0.04em; text-transform: uppercase;
      transition: background var(--ps-dur-fast) var(--ps-ease-emphasized), transform var(--ps-dur-fast);
      font-family: 'JetBrains Mono', monospace;
    }
    .mark-all-btn:hover { background: rgba(0,229,255,0.16); transform: translateY(-1px); }
    .empty-state { padding: 36px 16px; text-align: center; }
    .empty-state p {
      color: #64748b; font-size: 13px; margin-top: 10px;
      font-family: 'Space Grotesk', system-ui, sans-serif;
    }
    .notification-list { padding: 6px; }
    .notification-item {
      display: flex; align-items: flex-start; gap: 10px;
      /* keyboard-operable <button> reset (was a mouse-only clickable div) */
      width: 100%; text-align: left; background: none; color: inherit; font: inherit;
      padding: 10px 12px; cursor: pointer;
      border-radius: var(--ps-radius-sm, 8px);
      border: 1px solid transparent;
      transition:
        background var(--ps-dur-fast, 140ms),
        border-color var(--ps-dur-fast, 140ms),
        transform var(--ps-dur-fast, 140ms) var(--ps-ease-emphasized, cubic-bezier(0.16,1,0.3,1));
      animation: notifIn 240ms var(--ps-ease-emphasized, cubic-bezier(0.16,1,0.3,1)) both;
    }
    .notification-item:focus-visible {
      outline: 2px solid #00E5FF; outline-offset: -2px;
    }
    .notification-item:hover {
      background: rgba(0,229,255,0.05);
      border-color: rgba(0,229,255,0.15);
      transform: translateX(2px);
    }
    .notification-item.unread {
      background: linear-gradient(90deg, rgba(0,229,255,0.06), rgba(0,229,255,0.02));
      border-color: rgba(0,229,255,0.10);
    }
    .notif-icon {
      width: 32px; height: 32px; border-radius: var(--ps-radius-sm, 8px);
      background: linear-gradient(135deg, rgba(0,229,255,0.14), rgba(124,58,237,0.10));
      border: 1px solid rgba(0,229,255,0.20);
      display: flex; align-items: center; justify-content: center;
      font-size: 14px; flex-shrink: 0;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.06);
    }
    .notif-content { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .notif-title {
      font-size: 13px; font-weight: 600; color: #f0f0f8;
      font-family: 'Sora', system-ui, sans-serif;
      letter-spacing: -0.01em;
      text-wrap: balance;
    }
    .notif-message {
      font-size: 12px; color: #94a3b8;
      font-family: 'Space Grotesk', system-ui, sans-serif;
      line-height: 1.4;
      overflow: hidden; text-overflow: ellipsis;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
      text-wrap: pretty;
    }
    .notif-time {
      font-size: 10px; color: #64748b; margin-top: 2px;
      font-family: 'JetBrains Mono', monospace;
      letter-spacing: 0.04em;
      font-variant-numeric: tabular-nums;
    }
    /* Install Project Sites — in-app App Notification variant (has actions, not click-through). */
    .install-notif { cursor: default; }
    .install-notif .notif-icon { color: #00E5FF; font-size: 16px; }
    .install-actions { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
    .install-cta {
      font-size: 12px; font-weight: 700; padding: 6px 14px; border-radius: 8px;
      border: none; cursor: pointer;
      color: #060610; background: #00E5FF;
      transition: filter var(--ps-dur-fast, 140ms) ease, transform var(--ps-dur-fast, 140ms) ease, box-shadow var(--ps-dur-base, 220ms) ease;
    }
    .install-cta:hover { filter: brightness(1.08); transform: translateY(-1px); box-shadow: 0 4px 14px -4px rgba(0,229,255,0.5); }
    .install-cta:focus-visible { outline: 2px solid #f0f0f8; outline-offset: 2px; }
    .install-dismiss-btn {
      font-size: 11px; font-weight: 600; padding: 6px 12px; border-radius: 8px;
      cursor: pointer;
      color: #94a3b8; background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      transition: color var(--ps-dur-fast, 140ms) ease, background var(--ps-dur-fast, 140ms) ease, border-color var(--ps-dur-fast, 140ms) ease;
    }
    .install-dismiss-btn:hover { color: #f0f0f8; background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.14); }
    .install-dismiss-btn:focus-visible { outline: 2px solid #00E5FF; outline-offset: 2px; }
    @media (prefers-reduced-motion: reduce) {
      .install-cta { transition: none; }
      .install-cta:hover { transform: none; }
    }
    .unread-dot {
      width: 8px; height: 8px; border-radius: 50%; background: #00E5FF;
      flex-shrink: 0; margin-top: 6px;
      box-shadow: 0 0 8px rgba(0,229,255,0.6);
      animation: pulseDot 1.8s ease-in-out infinite;
    }
    @keyframes pulseDot {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.55; transform: scale(0.86); }
    }
    @keyframes dropdownIn {
      from { opacity: 0; transform: translateY(-8px) scale(0.96); filter: blur(2px); }
      60%  { opacity: 1; filter: blur(0); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes notifIn {
      from { opacity: 0; transform: translateY(-4px); }
      to   { opacity: 1; transform: translateY(0); }
    }
  `],
})
export class NotificationBellComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  /** PWA install (A2HS) state — surfaced as an in-app "Install Project Sites" notification. */
  readonly install = inject(InstallPromptService);
  private router = inject(Router);
  private pollSub?: Subscription;

  isOpen = signal(false);
  @ViewChild('bellBtn') private bellBtn?: ElementRef<HTMLButtonElement>;

  /** Esc closes the open dropdown + returns focus to the bell (keyboard users
   *  must be able to dismiss it — it previously only closed on click). */
  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.isOpen()) {
      this.isOpen.set(false);
      this.bellBtn?.nativeElement.focus();
    }
  }
  notifications = signal<Notification[]>([]);
  unreadCount = signal(0);

  /**
   * A synthetic "Install Project Sites" notification, present only while the PWA is
   * installable (Chromium `beforeinstallprompt` captured, or returning-visitor iOS
   * Safari) and not dismissed — surfaces A2HS install as an in-app App Notification
   * with an Install action instead of a floating chip. (Brian 2026-09-27.)
   */
  private installNotif = computed<Notification | null>(() => {
    const m = this.install.mode();
    if (!m) return null;
    return {
      id: '__install__',
      type: 'install',
      title: 'Install Project Sites',
      message:
        m === 'ios'
          ? 'Tap the Share button, then “Add to Home Screen” — launches like a native app.'
          : 'Add it to your home screen — launches like a native app, works offline.',
      action_url: null,
      read: 0,
      created_at: '',
    };
  });
  /** Server notifications with the install App Notification pinned on top when present. */
  readonly displayNotifications = computed<Notification[]>(() => {
    const inst = this.installNotif();
    const server = this.notifications();
    return inst ? [inst, ...server] : server;
  });
  /** Unread badge count including the install notification when it's showing. */
  readonly displayUnread = computed(() => this.unreadCount() + (this.installNotif() ? 1 : 0));

  ngOnInit(): void {
    if (!this.auth.isLoggedIn()) return;
    this.fetchNotifications();

    // Poll every 60 seconds for new notifications
    this.pollSub = interval(60_000).pipe(
      filter(() => this.auth.isLoggedIn()),
      // `silent: true` — a poll status-0 must NOT fire ApiService's alarming
      // "Can't reach the server" toast (the component handler below is silent, but
      // ApiService toasts BEFORE it). Notifications are non-critical background data.
      switchMap(() => this.api.get<{ data: Notification[]; unread_count: number }>('/notifications', undefined, { silent: true })),
    ).subscribe({
      next: (res) => {
        this.notifications.set(res.data);
        this.unreadCount.set(res.unread_count);
      },
      error: () => { /* silent — poll failures are non-critical */ },
    });
  }

  ngOnDestroy(): void {
    this.pollSub?.unsubscribe();
  }

  toggleDropdown(): void {
    this.isOpen.set(!this.isOpen());
    if (this.isOpen()) this.fetchNotifications();
  }

  fetchNotifications(): void {
    this.api.get<{ data: Notification[]; unread_count: number }>('/notifications').subscribe({
      next: (res) => {
        this.notifications.set(res.data);
        this.unreadCount.set(res.unread_count);
      },
      error: () => {
        // silently fail — notifications are non-critical
      },
    });
  }

  handleClick(notif: Notification): void {
    if (!notif.read) {
      // Fire-and-forget; api.service already toasts on error.
      this.api.patch(`/notifications/${notif.id}/read`, {}).subscribe({ error: () => {} });
      const updated = this.notifications().map((n) =>
        n.id === notif.id ? { ...n, read: 1 } : n,
      );
      this.notifications.set(updated);
      this.unreadCount.set(Math.max(0, this.unreadCount() - 1));
    }
    if (notif.action_url) {
      this.router.navigateByUrl(notif.action_url);
    }
    this.isOpen.set(false);
  }

  markAllRead(): void {
    // Fire-and-forget; api.service already toasts on error.
    this.api.post('/notifications/read-all', {}).subscribe({ error: () => {} });
    const updated = this.notifications().map((n) => ({ ...n, read: 1 }));
    this.notifications.set(updated);
    this.unreadCount.set(0);
  }

  /** Trigger the native PWA install sheet from the Install App Notification (user gesture). */
  doInstall(): void {
    void this.install.install();
  }

  /** Dismiss the Install App Notification for good (remembered in localStorage). */
  dismissInstall(): void {
    this.install.dismiss();
  }

  typeIcon(type: string): string {
    const icons: Record<string, string> = {
      site_published: '🚀',
      billing_reminder: '💳',
      feedback_received: '💬',
      domain_verified: '🌐',
      build_failed: '⚠️',
      announcement: '📢',
    };
    return icons[type] || '🔔';
  }

  timeAgo(dateStr: string): string {
    const now = Date.now();
    const then = new Date(dateStr).getTime();
    const diff = Math.floor((now - then) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
    return new Date(dateStr).toLocaleDateString();
  }
}
