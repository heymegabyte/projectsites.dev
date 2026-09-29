/**
 * Command-palette action registry.
 *
 * @remarks
 * Centralises every action surfaced by `<app-command-palette>`. Keeping the list
 * here (a) lets the palette component stay focused on UI + scoring, (b) makes
 * the action catalogue trivially unit-testable, and (c) allows other surfaces
 * (e.g. a `?` shortcut sheet) to reuse the same registry. Actions are defined
 * as plain data — the component wires `run()` callbacks at registration time
 * so the service has no dependency on Angular Router / Toast / Api.
 *
 * @example
 * ```ts
 * const reg = inject(CommandPaletteActionsService);
 * const all = reg.build({ go: (p) => router.navigateByUrl(p), ... });
 * ```
 */
import { Injectable, inject } from '@angular/core';
import { Observable, from, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { ApiService } from '../../services/api.service';
import { ConfirmService } from '../../services/confirm.service';
import { BoltEmbedService, type BoltFileEntry } from '../../services/bolt-embed.service';
import { ShareLinkService } from '../../services/share-link.service';

/** Row returned by the AI natural-language search endpoint (#94). */
export interface AiSearchRow {
  id: string;
  [key: string]: unknown;
}

/** Strongly-typed entity discriminator for `/api/admin/search/ai`. */
export type AiSearchEntity = 'audit' | 'forms' | 'traces' | 'sites' | 'users';

/** Public shape of an AI search hit, used by the palette result panel. */
export interface AiSearchHit {
  entity: AiSearchEntity;
  /** Row title rendered in the palette. */
  title: string;
  /** Optional sub-line. */
  description?: string;
  /** Where clicking the row should navigate. */
  navigateTo: string;
  /** Raw row for callers that want to inspect it. */
  raw: AiSearchRow;
}

/** A single, executable entry in the command palette. */
export interface PaletteAction {
  /** Stable identifier — used for recents + pinned persistence. */
  id: string;
  /** Visible row title. */
  title: string;
  /** Sub-line shown beneath the title (optional). */
  description?: string;
  /** Group bucket for sectioned rendering. */
  section: 'Navigation' | 'Sites' | 'Actions' | 'Settings' | 'Help' | 'Integrations' | 'AI' | 'Recent' | 'Pinned';
  /** Extra search tokens not present in title/description. */
  keywords?: string[];
  /** Optional keyboard hint chip (e.g. `G E`). */
  shortcut?: string;
  /** Inline SVG icon string (kept minimal — no icon-font dep). */
  icon?: string;
  /** Side-effect to run when the user activates the row. */
  run: () => void | Promise<void>;
  /** Optional href — when present, ⌘+Enter opens in a new tab. */
  href?: string;
}

/** Callbacks the palette wires when constructing the registry. */
export interface PaletteContext {
  /** Internal navigation. */
  go: (path: string) => void;
  /** External navigation in a new tab. */
  openExt: (url: string) => void;
  /** Copy text to clipboard (toast handled by callback). */
  copy: (text: string, label?: string) => void;
  /** Currently-selected site slug, if any. */
  slug?: string;
  /** Currently-selected site id, if any. */
  siteId?: string;
  /** Live list of sites for quick-switch entries. */
  sites: { id: string; slug: string; business_name?: string; status?: string }[];
  /** Theme toggle. */
  setTheme: (t: 'dark' | 'light' | 'system') => void;
  /** Sidebar toggle. */
  toggleSidebar: () => void;
  /** Sign out. */
  signOut: () => void;
  /** Snapshot create/rollback/deploy/reset hooks (deep-link aware). */
  createSnapshot: () => void;
  rollbackSnapshot: () => void;
  manualDeploy: () => void;
  resetSite: () => void;
  /** Broadcast a "live-polling paused" event. */
  toggleLivePolling: () => void;
  /** Trigger an AI improvement on current site. */
  aiImprove: () => void;
  /** Open the AI chat overlay (with prefilled prompt for support). */
  openAiChat: (prefill?: string) => void;
  /** Open the keyboard-shortcuts modal. */
  openShortcuts: () => void;
  /** Fallback "Ask AI" handler for unmatched queries. */
  askAi: (query: string) => void;
}

const ICONS = {
  arrow: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>',
  edit: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  layers: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
  chart: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
  form: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="7" y1="9" x2="17" y2="9"/><line x1="7" y1="13" x2="17" y2="13"/><line x1="7" y1="17" x2="13" y2="17"/></svg>',
  zap: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  endpoint: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="7" cy="12" r="1.5"/><line x1="12" y1="12" x2="18" y2="12"/></svg>',
  dollar: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
  shield: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/></svg>',
  cog: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06A2 2 0 1 1 4.29 16.96l.06-.06A1.65 1.65 0 0 0 4.68 15 1.65 1.65 0 0 0 3.17 14H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06A2 2 0 1 1 7.04 4.29l.06.06A1.65 1.65 0 0 0 9 4.68 1.65 1.65 0 0 0 10 3.17V3a2 2 0 1 1 4 0v.09c0 .67.39 1.27 1 1.51.61.25 1.31.11 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.32 9c.25.61.85 1 1.51 1H21a2 2 0 1 1 0 4h-.09c-.66 0-1.26.39-1.51 1Z"/></svg>',
  globe: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z"/></svg>',
  book: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/></svg>',
  user: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  plus: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  copy: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  ext: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
  sun: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>',
  signOut: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
  bell: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
  help: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  ai: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2 4 7v10l8 5 8-5V7Z"/><path d="M12 22V12"/><path d="M20 7l-8 5L4 7"/></svg>',
};

@Injectable({ providedIn: 'root' })
export class CommandPaletteActionsService {
  /**
   * Build the full action list for the current admin context.
   * Pure data-builder — never touches the DOM.
   *
   * @example
   * ```ts
   * const actions = service.build({ go, openExt, copy, sites, ... });
   * ```
   */
  build(ctx: PaletteContext): PaletteAction[] {
    const { go, openExt, copy, slug, siteId, sites, setTheme } = ctx;
    const navHref = (p: string) => `${window.location.origin}${p}`;

    const list: PaletteAction[] = [
      // ── Navigation (26 — every sidebar section is quick-navigable) ───────────────────────────────────────────
      { id: 'nav-editor',     title: 'Go to Editor',        section: 'Navigation', shortcut: 'G E', icon: ICONS.edit,    keywords: ['home', 'dashboard', 'code', 'edit'], href: navHref('/admin/editor'),    run: () => go('/admin/editor') },
      { id: 'nav-snapshots',  title: 'Go to Snapshots',     section: 'Navigation', shortcut: 'G S', icon: ICONS.layers,  keywords: ['versions', 'history', 'backup', 'restore', 'rollback', 'snap'], href: navHref('/admin/snapshots'), run: () => go('/admin/snapshots') },
      { id: 'nav-analytics',  title: 'Go to Analytics',     section: 'Navigation', shortcut: 'G A', icon: ICONS.chart,   keywords: ['visits', 'traffic', 'metrics', 'ga4', 'posthog'], href: navHref('/admin/analytics'), run: () => go('/admin/analytics') },
      { id: 'nav-forms',      title: 'Go to Forms',         section: 'Navigation', shortcut: 'G F', icon: ICONS.form,    keywords: ['submissions', 'router', 'contact'], href: navHref('/admin/forms'), run: () => go('/admin/forms') },
      { id: 'nav-traces',     title: 'Go to AI Traces',     section: 'Navigation', shortcut: 'G L', icon: ICONS.zap,     keywords: ['ai logs', 'token', 'cost', 'llm', 'trace'], href: navHref('/admin/traces'), run: () => go('/admin/traces') },
      { id: 'nav-voice',      title: 'Go to Voice',         section: 'Navigation', shortcut: 'G V', icon: ICONS.bell,    keywords: ['phone', 'call', 'sms', 'twilio', 'hotline', 'voicemail'], href: navHref('/admin/voice'), run: () => go('/admin/voice') },
      { id: 'nav-billing',    title: 'Go to Billing & Plan', section: 'Navigation', shortcut: 'G B', icon: ICONS.dollar, keywords: ['credits', 'stripe', 'plan', 'invoice'], href: navHref('/admin/billing'), run: () => go('/admin/billing') },
      { id: 'nav-logs',       title: 'Go to Logs',          section: 'Navigation', icon: ICONS.book,    keywords: ['audit', 'who', 'what', 'when', 'log', 'logs', 'correlation', 'request id', 'search', 'structured', 'trace'], href: navHref('/admin/logs'), run: () => go('/admin/logs') },
      { id: 'nav-domains',    title: 'Go to Domains',       section: 'Navigation', shortcut: 'G D', icon: ICONS.globe,   keywords: ['hostname', 'dns', 'custom'], href: navHref('/admin/settings#domains'), run: () => go('/admin/settings#domains') },
      { id: 'nav-docs',       title: 'Go to API Docs',      section: 'Navigation', icon: ICONS.book,    keywords: ['openapi', 'reference', 'tryit'], href: navHref('/admin/docs'), run: () => go('/admin/docs') },
      { id: 'nav-settings',   title: 'Go to Settings',      section: 'Navigation', icon: ICONS.cog,     keywords: ['org', 'team', 'mcp'], href: navHref('/admin/settings'), run: () => go('/admin/settings') },
      { id: 'nav-user',       title: 'Go to User Settings', section: 'Navigation', shortcut: 'G U', icon: ICONS.user,    keywords: ['profile', 'api key', 'theme'], href: navHref('/admin/user'), run: () => go('/admin/user') },
      // Remaining sidebar sections — quick-nav completeness (no G-chord to avoid
      // colliding with the global shortcut handler; search/click discoverable).
      { id: 'nav-apps',         title: 'Go to Apps',          section: 'Navigation', icon: ICONS.layers,   keywords: ['marketplace', 'install', 'self-host', 'container', 'medusa'], href: navHref('/admin/apps'), run: () => go('/admin/apps') },
      { id: 'nav-hosting',      title: 'Go to Hosting',       section: 'Navigation', icon: ICONS.layers,   keywords: ['hosting', 'preview', 'publish', 'promote', 'wfp', 'dispatch', 'r2', 'deploy', 'url'], href: navHref('/admin/hosting'), run: () => go('/admin/hosting') },
      { id: 'nav-social',       title: 'Go to Social',        section: 'Navigation', icon: ICONS.globe,    keywords: ['posts', 'schedule', 'twitter', 'linkedin', 'bluesky', 'auto-pilot'], href: navHref('/admin/social'), run: () => go('/admin/social') },
      { id: 'nav-deliverability', title: 'Go to Deliverability', section: 'Navigation', icon: ICONS.shield, keywords: ['spf', 'dkim', 'dmarc', 'email', 'spam', 'inbox placement'], href: navHref('/admin/deliverability'), run: () => go('/admin/deliverability') },
      { id: 'nav-webhooks',     title: 'Go to Webhooks',      section: 'Navigation', icon: ICONS.zap,      keywords: ['events', 'callbacks', 'endpoints', 'deliveries'], href: navHref('/admin/webhooks'), run: () => go('/admin/webhooks') },
      { id: 'cmd-share-link',   title: 'Share link…',         section: 'Actions',    icon: ICONS.ext,      keywords: ['approval', 'client', 'preview', 'share', 'stakeholder', 'review', 'password', 'link'], run: () => this.shareLinkSvc.open() },
      { id: 'nav-flags',        title: 'Go to Feature Flags', section: 'Navigation', icon: ICONS.cog,      keywords: ['flags', 'rollout', 'toggle', 'experimental', 'killswitch'], href: navHref('/admin/feature-flags'), run: () => go('/admin/feature-flags') },
      { id: 'nav-system-services', title: 'Go to System Services', section: 'Navigation', icon: ICONS.cog, keywords: ['services', 'platform', 'catalog', 'infrastructure', 'subdomains', 'containers', 'status', 'operator'], href: navHref('/admin/system-services'), run: () => go('/admin/system-services') },
      { id: 'nav-api-tokens',   title: 'Go to API Tokens',    section: 'Navigation', icon: ICONS.shield,   keywords: ['token', 'api', 'key', 'access', 'bearer', 'developer', 'pat'], href: navHref('/admin/settings#api-tokens'), run: () => go('/admin/settings#api-tokens') },
      { id: 'nav-leads',        title: 'Go to Lead Scanner',  section: 'Navigation', icon: ICONS.chart,    keywords: ['leads', 'scanner', 'prospects', 'outreach', 'no website', 'claim', 'operator'], href: navHref('/admin/leads'), run: () => go('/admin/leads') },
      { id: 'nav-super-admin',  title: 'Go to Super Admin',   section: 'Navigation', icon: ICONS.shield,   keywords: ['super admin', 'operator', 'cost', 'wallet', 'margin', 'markup', 'billing ops', 'impersonate'], href: navHref('/admin/super-admin'), run: () => go('/admin/super-admin') },
      { id: 'nav-site-features', title: 'Go to Features',          section: 'Navigation', icon: ICONS.cog,    keywords: ['features', 'plan', 'entitlements', 'site', 'add-on', 'tenant', 'preview'], href: navHref('/admin/site-features'), run: () => go('/admin/site-features') },

      // ── Settings tabs (5) ────────────────────────────────────────
      { id: 'set-general', title: 'Settings: General',     section: 'Settings', icon: ICONS.cog, keywords: ['org', 'contact', 'tone'],       run: () => go('/admin/settings#general') },
      { id: 'set-team',    title: 'Settings: Team',        section: 'Settings', icon: ICONS.user, keywords: ['invite', 'members', 'roles'],   run: () => go('/admin/settings#team') },
      { id: 'set-aichat',  title: 'Settings: AI Chat',     section: 'Settings', icon: ICONS.ai, keywords: ['persona', 'system prompt', 'rag'], run: () => go('/admin/settings#ai-chat') },
      { id: 'set-mcp',     title: 'Settings: MCP',         section: 'Settings', icon: ICONS.endpoint, keywords: ['mailchimp', 'stripe', 'slack', 'notion', 'github'], run: () => go('/admin/settings#mcp') },
      { id: 'set-danger',  title: 'Settings: Danger zone', section: 'Settings', icon: ICONS.shield, keywords: ['delete', 'export'],            run: () => go('/admin/settings#danger') },

      // ── Actions (24) ─────────────────────────────────────────────
      { id: 'act-new-site',     title: 'Create new site',        section: 'Actions', icon: ICONS.plus, keywords: ['build', 'start'], run: () => go('/create') },
      { id: 'act-snap-create',  title: 'Create snapshot of current site', section: 'Actions', icon: ICONS.layers, keywords: ['version', 'backup', 'freeze'], run: () => ctx.createSnapshot() },
      { id: 'act-snap-rollback', title: 'Roll back to previous snapshot', section: 'Actions', icon: ICONS.arrow, keywords: ['restore', 'undo'], run: () => ctx.rollbackSnapshot() },
      { id: 'act-deploy',       title: 'Run manual deploy',      section: 'Actions', icon: ICONS.zap, keywords: ['publish', 'push'], run: () => ctx.manualDeploy() },
      { id: 'act-reset',        title: 'Reset / rebuild site',   section: 'Actions', icon: ICONS.zap, keywords: ['regenerate'], run: () => ctx.resetSite() },
      { id: 'act-preview',      title: 'Open live preview',      section: 'Actions', icon: ICONS.ext, keywords: ['view', 'iframe'], run: () => slug && openExt(`https://${slug}.projectsites.dev`) },
      { id: 'act-copy-page',    title: 'Copy current page URL',  section: 'Actions', icon: ICONS.copy, keywords: ['url', 'clipboard'], run: () => copy(window.location.href, 'Page URL copied') },
      { id: 'act-copy-site',    title: 'Copy site URL',          section: 'Actions', icon: ICONS.copy, keywords: ['url', 'clipboard'], run: () => slug && copy(`https://${slug}.projectsites.dev`, 'Site URL copied') },
      { id: 'act-copy-appjs',   title: 'Copy app.js install snippet', section: 'Actions', icon: ICONS.copy, keywords: ['app.js', 'install', 'snippet', 'embed', 'script', 'form', 'contact', 'tracking'], run: () => copy(`<script src="https://projectsites.dev/app.js" data-slug="${slug || 'your-site'}" defer></script>`, 'Install snippet copied') },
      { id: 'act-open-site',    title: 'Open site in new tab',   section: 'Actions', icon: ICONS.ext, keywords: ['visit'], run: () => slug && openExt(`https://${slug}.projectsites.dev`) },
      { id: 'act-new-key',      title: 'Generate new API key',   section: 'Actions', icon: ICONS.plus, keywords: ['token', 'access'], run: () => go('/admin/user?action=create-key') },
      { id: 'act-invite',       title: 'Invite a teammate',      section: 'Actions', icon: ICONS.user, keywords: ['team', 'member'], run: () => go('/admin/settings?action=invite#team') },
      { id: 'act-connect-mcp',  title: 'Connect an MCP',         section: 'Actions', icon: ICONS.endpoint, keywords: ['integration'], run: () => go('/admin/settings#mcp') },
      { id: 'act-add-domain',   title: 'Add custom domain',      section: 'Actions', icon: ICONS.globe, keywords: ['hostname', 'dns'], run: () => go('/admin/settings#domains') },
      { id: 'act-buy-number',   title: 'Buy phone number',       section: 'Actions', icon: ICONS.bell, keywords: ['voice', 'sms', 'twilio', 'vanity', 'hotline'], run: () => go('/admin/voice') },
      { id: 'act-view-calls',   title: 'View voice conversations', section: 'Actions', icon: ICONS.bell, keywords: ['calls', 'sms', 'transcript', 'recording'], run: () => { try { localStorage.setItem('voice.activeTab', 'conversations'); } catch { /* */ } go('/admin/voice'); } },
      { id: 'act-test-hotline', title: 'Test the hotline',       section: 'Actions', icon: ICONS.bell, keywords: ['call', 'browser', 'mic', 'voice test'], run: () => { try { localStorage.setItem('voice.activeTab', 'test'); } catch { /* */ } go('/admin/voice'); } },
      { id: 'act-spend',        title: 'Show org-wide spend',    section: 'Actions', icon: ICONS.dollar, keywords: ['costs'], run: () => go('/admin/billing') },
      { id: 'act-export',       title: 'Export all data',        section: 'Actions', icon: ICONS.arrow, keywords: ['download', 'backup'], run: () => go('/admin/settings?action=export#danger') },
      { id: 'act-pause-poll',   title: 'Toggle live polling',    section: 'Actions', icon: ICONS.bell, keywords: ['pause', 'realtime'], run: () => ctx.toggleLivePolling() },
      { id: 'act-theme-dark',   title: 'Theme: Dark',            section: 'Actions', icon: ICONS.sun, keywords: ['appearance'], run: () => setTheme('dark') },
      { id: 'act-theme-light',  title: 'Theme: Light',           section: 'Actions', icon: ICONS.sun, keywords: ['appearance'], run: () => setTheme('light') },
      { id: 'act-theme-system', title: 'Theme: System',          section: 'Actions', icon: ICONS.sun, keywords: ['auto', 'appearance'], run: () => setTheme('system') },
      { id: 'act-toggle-side',  title: 'Toggle sidebar',         section: 'Actions', icon: ICONS.arrow, keywords: ['collapse'], run: () => ctx.toggleSidebar() },
      { id: 'act-signout',      title: 'Sign out',               section: 'Actions', icon: ICONS.signOut, keywords: ['logout', 'exit'], run: () => ctx.signOut() },
      { id: 'act-clear-cache',  title: 'Clear cache + reload (advanced)', section: 'Actions', icon: ICONS.bell, keywords: ['hard reload', 'cookies'], run: async () => {
        const ok = await this.confirmSvc.confirm({
          title: 'Clear local cache',
          message: 'Clear local cache + reload? Your stored preferences for this admin will be reset.',
          confirmLabel: 'Clear + reload',
          danger: false,
        });
        if (!ok) return;
        try { Object.keys(localStorage).forEach((k) => { if (k.startsWith('ps_')) localStorage.removeItem(k); }); } catch { /* ignore */ }
        location.reload();
      } },

      // ── AI (3) ───────────────────────────────────────────────────
      { id: 'ai-improve', title: 'AI: Improve site copy',    section: 'AI', icon: ICONS.ai, keywords: ['rewrite', 'polish'], run: () => ctx.aiImprove() },
      { id: 'ai-suggest', title: 'AI: Suggest design ideas', section: 'AI', icon: ICONS.ai, keywords: ['inspiration', 'mockup'], run: () => ctx.aiImprove() },
      { id: 'ai-chat',    title: 'AI: Chat with assistant',  section: 'AI', icon: ICONS.ai, keywords: ['ask', 'help'], run: () => ctx.openAiChat() },

      // ── Help (6) ─────────────────────────────────────────────────
      { id: 'help-shortcuts', title: 'Keyboard shortcuts',     section: 'Help', shortcut: '?', icon: ICONS.help, keywords: ['cheat sheet', 'hotkeys'], run: () => ctx.openShortcuts() },
      { id: 'help-docs',      title: "Open CLAUDE.md docs",    section: 'Help', icon: ICONS.book, keywords: ['readme', 'guide'], run: () => go('/admin/docs#overview') },
      { id: 'help-support',   title: 'Chat with support',      section: 'Help', icon: ICONS.help, keywords: ['contact', 'email'], run: () => ctx.openAiChat('I need help with…') },
      { id: 'help-email',     title: 'Email support',          section: 'Help', icon: ICONS.help, keywords: ['contact'], run: () => openExt('mailto:hey@megabyte.space?subject=Project%20Sites%20admin') },

      // ── Integrations (external dashboards) ───────────────────────
      { id: 'ext-cf',      title: 'Open Cloudflare dashboard', section: 'Integrations', icon: ICONS.ext, keywords: ['worker', 'd1', 'r2'], run: () => openExt('https://dash.cloudflare.com/?to=/:account/workers/services/view/project-sites/production') },
      { id: 'ext-d1',      title: 'Open D1 console',           section: 'Integrations', icon: ICONS.ext, keywords: ['database', 'sql'], run: () => openExt('https://dash.cloudflare.com/?to=/:account/workers/d1') },
      { id: 'ext-stripe',  title: 'Open Stripe dashboard',     section: 'Integrations', icon: ICONS.dollar, keywords: ['payments', 'subs'], run: () => openExt('https://dashboard.stripe.com') },
      { id: 'ext-posthog', title: 'Open PostHog dashboard',    section: 'Integrations', icon: ICONS.chart, keywords: ['analytics', 'events'], run: () => openExt('https://us.posthog.com') },
      { id: 'ext-sentry',  title: 'Open Sentry issues',        section: 'Integrations', icon: ICONS.bell, keywords: ['errors', 'crash'], run: () => openExt('https://sentry.io/organizations/megabyte-labs/issues/') },
    ];

    // ── Sites quick-switch (one row per site) ──────────────────────
    for (const s of sites.slice(0, 50)) {
      const label = s.business_name?.trim() ? `${s.business_name} (${s.slug})` : s.slug;
      list.push({
        id: `site:${s.id}`,
        title: `Switch to ${label}`,
        section: 'Sites',
        icon: ICONS.globe,
        keywords: ['site', 'project', 'switch', s.slug, s.business_name ?? '', s.status ?? ''],
        description: s.status ?? '',
        href: `${window.location.origin}/admin/editor?site=${s.id}`,
        run: () => go(`/admin/editor?site=${s.id}`),
      });
    }
    // De-emphasised current site flag — when siteId set, mark current entry
    if (siteId) {
      const cur = list.find((a) => a.id === `site:${siteId}`);
      if (cur) cur.description = (cur.description ? cur.description + ' · ' : '') + 'current';
    }

    return list;
  }

  /* ─────────────── #94 AI natural-language search ─────────────── */

  /** ApiService is lazy-resolved so existing tests that don't exercise this
   *  method keep working without changing their providers. */
  private apiSvc = inject(ApiService);
  /** Bolt embed service — lazy-resolved so palette tests don't need to
   *  provide a stub when they're only exercising the static action list. */
  private boltSvc = inject(BoltEmbedService);
  private confirmSvc = inject(ConfirmService);
  private shareLinkSvc = inject(ShareLinkService);

  /**
   * Item 45 — query the embedded bolt.diy iframe for its file list and
   * filter by `query` (case-insensitive substring match on `path`). Top 8
   * by shortest path. Returns an empty array when the editor isn't booted
   * or the query is empty — never throws, since the palette should never
   * crash on a backend hiccup.
   *
   * @example
   * ```ts
   * service.searchEditorFiles('App.tsx').subscribe((rows) => { ... });
   * ```
   */
  searchEditorFiles(query: string): Observable<PaletteAction[]> {
    const q = (query || '').trim().toLowerCase();
    if (!q) return of([] as PaletteAction[]);
    return from(this.boltSvc.listFiles().catch(() => [] as BoltFileEntry[])).pipe(
      map((files) => {
        const matches = files
          .filter((f) => f.path.toLowerCase().includes(q))
          .sort((a, b) => a.path.length - b.path.length)
          .slice(0, 8);
        return matches.map<PaletteAction>((f) => ({
          id: `editor-file:${f.path}`,
          title: f.path.replace(/^\/home\/project\//, ''),
          description: `${f.size.toLocaleString()} bytes · open in editor`,
          section: 'Sites',
          icon: ICONS.edit,
          keywords: ['file', 'editor', 'open', f.path],
          run: () => this.boltSvc.openFile(f.path),
        }));
      }),
      catchError(() => of([] as PaletteAction[])),
    );
  }

  /**
   * Call `POST /api/admin/search/ai` and translate raw rows into navigation
   * hits the palette can render. Errors degrade to an empty list (we never
   * want the palette to crash on a backend hiccup).
   *
   * @example
   * ```ts
   * service.askAiSearch('failed traces today').subscribe((hits) => {
   *   // hits[].navigateTo points at /admin/ai-logs, /admin/forms, etc.
   * });
   * ```
   */
  askAiSearch(query: string): Observable<AiSearchHit[]> {
    return this.apiSvc
      .post<{ data: { entity: AiSearchEntity; rows: AiSearchRow[] } }>(
        '/admin/search/ai',
        { query },
      )
      .pipe(
        map((r) => {
          const entity = r.data?.entity;
          const rows = r.data?.rows ?? [];
          if (!entity) return [];
          return rows.map((row) => this.aiSearchRowToHit(entity, row));
        }),
        catchError(() => of([] as AiSearchHit[])),
      );
  }

  /** Pure helper — converts one row + entity into a palette-ready hit. */
  aiSearchRowToHit(entity: AiSearchEntity, row: AiSearchRow): AiSearchHit {
    const id = String(row['id'] ?? '');
    if (entity === 'audit') {
      return {
        entity,
        title: `${String(row['action'] ?? 'audit event')} — ${id.slice(0, 8)}`,
        description: row['target_type'] ? `${row['target_type']} · ${row['target_id'] ?? ''}` : undefined,
        navigateTo: '/admin/logs',
        raw: row,
      };
    }
    if (entity === 'forms') {
      return {
        entity,
        title: `Form: ${String(row['form_name'] ?? '—')}`,
        description: `${row['email'] ?? ''} · ${row['status'] ?? ''}`,
        navigateTo: '/admin/forms',
        raw: row,
      };
    }
    if (entity === 'traces') {
      return {
        entity,
        title: `Trace: ${String(row['endpoint_slug'] ?? row['trace_kind'] ?? id.slice(0, 8))}`,
        description: `${row['model'] ?? ''} · ${row['status'] ?? ''}`,
        navigateTo: '/admin/ai-logs',
        raw: row,
      };
    }
    if (entity === 'sites') {
      const slug = String(row['slug'] ?? '');
      return {
        entity,
        title: `Site: ${String(row['business_name'] ?? slug)}`,
        description: slug,
        navigateTo: `/admin/editor?site=${id}`,
        raw: row,
      };
    }
    // users
    return {
      entity,
      title: `User: ${String(row['email'] ?? row['display_name'] ?? id.slice(0, 8))}`,
      description: String(row['display_name'] ?? ''),
      navigateTo: '/admin/settings',
      raw: row,
    };
  }
}
