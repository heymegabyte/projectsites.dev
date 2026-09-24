import { Component, DestroyRef, HostListener, computed, inject, signal, type OnInit } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { isValidEmail as isSharedValidEmail } from '../../../utils/validators/email';
import { DatePipe, SlicePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AdminStateService } from '../admin-state.service';
import { ApiService } from '../../../services/api.service';
import { ToastService } from '../../../services/toast.service';
import { ConfirmService } from '../../../services/confirm.service';
import { AuthService } from '../../../services/auth.service';
import { MCP_PROVIDERS, mcpAvailable } from './mcp-providers';
import { EnvVarsManagerComponent } from '../../../components/env-vars-manager/env-vars-manager.component';
import { AdminWebhooksComponent } from './webhooks.component';
import { AdminDeliverabilityComponent } from './deliverability.component';
import { AdminDomainsComponent } from './domains.component';
import { AdminApiTokensComponent } from './api-tokens.component';
import { HlmCheckboxDirective, HlmInputDirective, HlmSelectDirective, HlmTablistDirective } from '../../../ui';
import { BrnTooltipImports } from '@spartan-ng/brain/tooltip';
import { RevealDirective } from '../../../directives/reveal.directive';
import { RollingCounterComponent } from '../../../components/rolling-counter/rolling-counter.component';
import { AiSparkComponent } from '../../../components/ai-spark/ai-spark.component';

interface Member { id: string; email: string; name: string | null; role: string; created_at: string; }
interface Invite { id: string; email: string; role: string; created_at: string; expires_at: string; }
interface Conn { id: string; provider: string; display_name: string; status: string; connected_at: string; metadata?: Record<string, unknown>; }

// Settings tabs are SCOPED TO THE CURRENTLY-SELECTED PROJECT. Each tab loads
// data filtered by `state.selectedSite().id`. Theme + API keys are USER-level
// (see /admin/user). 2FA + Security defaults moved to the Team tab. Domains +
// API Tokens are folded in here as tabs (the standalone /admin/domains and
// /admin/api-tokens routes now redirect to #domains / #api-tokens).
const TABS = [
  { id: 'general',    label: 'General',     desc: 'Contact email · business identity · address · brand assets (this project)' },
  { id: 'team',       label: 'Team',        desc: 'Members · roles · invitations · 2FA' },
  { id: 'ai-chat',    label: 'AI Chat',     desc: 'System prompt · web search · knowledge files (this project)' },
  { id: 'mcp',        label: 'MCP',         desc: 'Per-project integrations: Slack, Stripe, Notion, HubSpot +20 more' },
  { id: 'env-vars',   label: 'AI Env Vars', desc: 'Custom key-value store surfaced to AI + MCP at inference time (org-wide)' },
  { id: 'webhooks',   label: 'Webhooks',    desc: 'Signed, retried event notifications to your endpoints (this project)' },
  { id: 'email',      label: 'Email',       desc: 'Sending limits · bring your own SMTP · deliverability (SPF/DKIM/DMARC)' },
  { id: 'domains',    label: 'Domains',     desc: 'Backup subdomain · connect a custom domain · AI domain search (this project)' },
  { id: 'api-tokens', label: 'API Tokens',  desc: 'Create · list · revoke psk_ Public API v1 tokens (org-wide)' },
] as const;

/**
 * Free monthly transactional-email allowance ProjectSites sends on a site's
 * behalf from the shared `noreply@projectsites.dev` sender (magic links + form
 * notifications). Past this, the owner brings their own SMTP. Surfaced in the
 * Email tab's allowance card. Mirror the worker's enforced cap when it lands.
 */
export const FREE_EMAIL_CAP_PER_MONTH = 500;
/** The shared sender address ProjectSites uses for free transactional email. */
export const PROVIDED_EMAIL_SENDER = 'noreply@projectsites.dev';
type Tab = (typeof TABS)[number]['id'];

// Provider catalogue moved to ./mcp-providers.ts (single source of truth shared
// with forms.component.ts — see task #34 deduplication).
const PROVIDERS = MCP_PROVIDERS;

@Component({
  selector: 'app-admin-settings',
  standalone: true,
  imports: [RevealDirective, RollingCounterComponent, AiSparkComponent, FormsModule, DatePipe, SlicePipe, RouterLink, EnvVarsManagerComponent, AdminWebhooksComponent, AdminDeliverabilityComponent, AdminDomainsComponent, AdminApiTokensComponent, HlmCheckboxDirective, HlmInputDirective, HlmSelectDirective, HlmTablistDirective, ...BrnTooltipImports],
  template: `
    <div class="p-7 flex-1 overflow-y-auto animate-fade-in max-md:p-4 space-y-6">
      <header class="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div class="kicker">Project</div>
          <h1 class="section-h text-lg font-bold text-white m-0">Settings</h1>
          @if (state.selectedSite(); as site) {
            <p class="text-[0.78rem] text-text-secondary m-0 mt-1">
              Scoped to <strong class="text-white">{{ site.business_name || site.slug }}</strong>
              <span class="text-text-secondary"> · per-project settings. For personal preferences (theme, API keys) see </span>
              <a routerLink="/admin/user" class="text-primary underline">your user settings</a>.
            </p>
          } @else {
            <p class="text-[0.78rem] text-text-secondary m-0 mt-1">Select a project from the top dropdown to edit its settings.</p>
          }
        </div>
        <!-- Filter-tabs search bar removed — Cmd-K palette is the search entry point now. -->
      </header>

      <nav class="flex gap-2 flex-wrap text-[0.78rem]" role="tablist" hlmTablist aria-label="Settings sections">
        @for (t of tabs; track t.id) {
          <button class="tab" role="tab" [id]="'settings-tab-' + t.id" [attr.aria-controls]="'settings-panel'" [class.active]="tab() === t.id" [attr.aria-selected]="tab() === t.id" (click)="setTab(t.id)" [title]="t.desc">{{ t.label }}</button>
        }
      </nav>

      <!-- ─────────────────── GENERAL ─────────────────── -->
      @if (tab() === 'general') {
        <section class="card" appReveal role="tabpanel" id="settings-panel" [attr.aria-labelledby]="'settings-tab-' + tab()">
          <header class="mb-4">
            <h2 class="m-0 text-base font-semibold text-white mb-1">General</h2>
            <p class="text-[0.7rem] text-text-secondary m-0">Contact + business identity used by the AI when it builds or refines this site. Brand colours, tone, and locale are auto-detected from your logo + content.</p>
          </header>
          @if (state.selectedSite(); as site) {
            <form (submit)="saveGeneral($event)" class="space-y-5" aria-label="General details">
              <!-- Group: Contact + identity -->
              <fieldset class="biz-group">
                <legend class="biz-legend">Identity</legend>
                <div class="grid md:grid-cols-2 gap-4">
                  <label class="block md:col-span-2">
                    <span class="muted-h">Contact email <small class="text-text-secondary">(shown on your site · the AI router also replies here)</small></span>
                    <input hlmInput type="email" class="w-full mt-1" placeholder="hello@yourbiz.com"
                           data-testid="general-contact-email" name="contact_email"
                           [(ngModel)]="business.contact_email" (ngModelChange)="markBusinessDirty()"
                           [attr.aria-invalid]="emailInvalid(business.contact_email) || null"
                           [attr.aria-describedby]="emailInvalid(business.contact_email) ? 'contact-email-hint' : null" />
                    @if (emailInvalid(business.contact_email)) {
                      <span id="contact-email-hint" role="alert" class="text-xs text-red-400 mt-1 block">Enter a valid email address (or leave blank).</span>
                    }
                  </label>
                  <label class="block">
                    <span class="muted-h">Business name</span>
                    <input hlmInput type="text" maxlength="200" required class="w-full mt-1"
                           data-testid="business-name" name="business_name"
                           [(ngModel)]="business.business_name" (ngModelChange)="markBusinessDirty()"
                           [attr.aria-invalid]="businessErrors().business_name ? 'true' : null" aria-describedby="biz-err-name" />
                    <p id="biz-err-name" class="biz-err" aria-live="polite">{{ businessErrors().business_name || '' }}</p>
                  </label>
                  <label class="block">
                    <span class="muted-h">Business phone</span>
                    <input hlmInput type="text" maxlength="32" class="w-full mt-1"
                           data-testid="business-phone" name="business_phone"
                           [(ngModel)]="business.business_phone" (ngModelChange)="markBusinessDirty()"
                           [attr.aria-invalid]="businessErrors().business_phone ? 'true' : null" aria-describedby="biz-err-phone" />
                    <p id="biz-err-phone" class="biz-err" aria-live="polite">{{ businessErrors().business_phone || '' }}</p>
                  </label>
                  <label class="block md:col-span-2">
                    <span class="muted-h">Business address</span>
                    <input hlmInput type="text" maxlength="500" class="w-full mt-1"
                           data-testid="business-address" name="business_address"
                           [(ngModel)]="business.business_address" (ngModelChange)="markBusinessDirty()"
                           [attr.aria-invalid]="businessErrors().business_address ? 'true' : null" aria-describedby="biz-err-addr" />
                    <p id="biz-err-addr" class="biz-err" aria-live="polite">{{ businessErrors().business_address || '' }}</p>
                  </label>
                </div>
              </fieldset>

              <!-- Group: Brand assets. Hidden native inputs (mirrors the AI-Chat
                   knowledge dropzone pattern) triggered by a branded button — no
                   unpolished native "No file chosen" text; a format/size hint sets
                   expectations BEFORE upload (the size cap is also validated on change). -->
              <fieldset class="biz-group">
                <legend class="biz-legend">Brand assets</legend>
                <div class="grid md:grid-cols-2 gap-4">
                  <div class="block">
                    <span class="muted-h">Logo</span>
                    <div class="biz-file-wrap mt-1">
                      <button type="button" class="biz-file-btn" aria-label="Choose a logo image to upload"
                              (click)="logoInput.click()">Choose file</button>
                      <input #logoInput type="file" accept="image/*" class="hidden" data-testid="business-logo-upload"
                             (change)="onBusinessLogo($any($event.target).files)" aria-describedby="biz-err-logo" />
                      @if (business.logoFile) {
                        <span class="biz-file-pill">{{ business.logoFile.name }}</span>
                      } @else {
                        <span class="biz-file-hint">PNG, JPG or WebP · up to 5&nbsp;MB</span>
                      }
                    </div>
                    <p id="biz-err-logo" class="biz-err" aria-live="polite">{{ businessErrors().logo || '' }}</p>
                  </div>
                  <div class="block">
                    <span class="muted-h">App icon</span>
                    <div class="biz-file-wrap mt-1">
                      <button type="button" class="biz-file-btn" aria-label="Choose an app icon image to upload"
                              (click)="iconInput.click()">Choose file</button>
                      <input #iconInput type="file" accept="image/png,image/jpeg,image/webp" class="hidden" data-testid="business-icon-upload"
                             (change)="onBusinessIcon($any($event.target).files)" aria-describedby="biz-err-icon" />
                      @if (business.iconFile) {
                        <span class="biz-file-pill">{{ business.iconFile.name }}</span>
                      } @else {
                        <span class="biz-file-hint">Square PNG, JPG or WebP · up to 2&nbsp;MB</span>
                      }
                    </div>
                    <p id="biz-err-icon" class="biz-err" aria-live="polite">{{ businessErrors().icon || '' }}</p>
                  </div>
                </div>
              </fieldset>

              <div class="flex justify-end gap-2">
                <button type="button" class="btn-ghost" (click)="resetBusiness()" [disabled]="!businessDirty()">Cancel</button>
                <button type="submit" class="btn-primary" data-testid="general-save"
                        [disabled]="!businessDirty() || savingBusiness() || emailInvalid(business.contact_email) || !business.business_name.trim()">{{ savingBusiness() ? 'Saving…' : 'Save' }}</button>
              </div>
            </form>
          } @else {
            <div class="rounded-xl border border-white/[0.08] bg-white/[0.02] p-6 text-center">
              <p class="text-text-secondary text-sm">Select a site from <strong class="text-light">Sites</strong> to edit its details.</p>
            </div>
          }
        </section>
      }

      <!-- ─────────────────── TEAM ─────────────────── -->
      @else if (tab() === 'team') {
        <section class="card" appReveal role="tabpanel" id="settings-panel" [attr.aria-labelledby]="'settings-tab-' + tab()">
          <h2 class="m-0 text-base font-semibold text-white mb-3">Team members</h2>
          <!-- 2FA + Invite live in twin card rows so heights match (min-height 64px). -->
          <div class="team-actions-grid mb-4">
            <div class="team-action-row" [brnTooltip]="'Require every member of this workspace to enroll a TOTP authenticator before signing in.'">
              <div class="flex flex-col">
                <span class="text-[0.78rem] font-semibold text-white leading-tight">Require Two-Factor Authentication</span>
                <span class="text-[0.66rem] text-text-secondary mt-0.5">Every member must enroll a TOTP authenticator before signing in.</span>
              </div>
              <label class="flex items-center gap-2 text-[0.72rem] cursor-pointer select-none">
                <span class="text-[0.6rem] text-text-secondary" role="status" aria-live="polite">
                  @if (savingSecurity()) { saving… }
                </span>
                <input hlmCheckbox type="checkbox"
                       data-testid="team-2fa-toggle"
                       [checked]="security.require_2fa"
                       (change)="toggleRequire2FA($event)"
                       [attr.aria-busy]="savingSecurity()"
                       [disabled]="savingSecurity()" />
                <span class="text-text-secondary">{{ security.require_2fa ? 'On' : 'Off' }}</span>
              </label>
            </div>
            <div class="team-action-row">
              <div class="flex flex-col">
                <span class="text-[0.78rem] font-semibold text-white leading-tight">Invite teammates</span>
                <span class="text-[0.66rem] text-text-secondary mt-0.5">Add an owner, editor, or viewer to this workspace.</span>
              </div>
              <button class="btn-primary" data-testid="team-invite-button" (click)="inviting.set(true)">+ Invite</button>
            </div>
          </div>
          @if (inviting()) {
            <div class="card-light p-3 mb-3 grid sm:grid-cols-3 gap-2">
              <input hlmInput type="email" placeholder="teammate@email.com" aria-label="Teammate email" [(ngModel)]="invite.email"
                [attr.aria-invalid]="inviteEmailInvalid() || null" [attr.aria-describedby]="inviteEmailInvalid() ? 'invite-email-hint' : null" />
              <select hlmSelect aria-label="Invite role" [(ngModel)]="invite.role">
                <option value="owner">Owner</option>
                <option value="editor">Editor</option>
                <option value="viewer">Viewer</option>
              </select>
              <div class="flex gap-2 justify-end">
                <button class="btn-ghost" (click)="inviting.set(false)">Cancel</button>
                <button class="btn-primary" (click)="sendInvite()" [disabled]="inviteEmailInvalid()">Send invite</button>
              </div>
              @if (inviteEmailInvalid()) {
                <span id="invite-email-hint" role="alert" class="sm:col-span-3 text-xs text-red-400">Enter a valid email address.</span>
              }
            </div>
          }
          @if (loadingTeam() && members().length === 0 && invites().length === 0) {
            <div class="space-y-2" aria-busy="true">
              @for (i of [1,2,3]; track i) {
                <div class="flex items-center gap-3 py-2 border-b border-white/[0.04]">
                  <div class="skeleton h-4 w-44"></div>
                  <div class="skeleton h-4 w-16"></div>
                  <div class="skeleton h-4 w-20"></div>
                  <div class="flex-1"></div>
                  <div class="skeleton h-4 w-12"></div>
                </div>
              }
            </div>
          } @else if (members().length === 0 && invites().length === 0) {
            <div class="empty-state">
              <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>
              <h3>Just you on this workspace</h3>
              <p>Invite teammates to collaborate on sites, content, and AI settings.</p>
              <button class="btn-primary" (click)="inviting.set(true)" [brnTooltip]="'Open the invite form'">+ Invite teammate</button>
            </div>
          } @else {
            <table class="w-full text-[0.78rem]">
              <thead class="text-text-secondary/70 uppercase text-[0.6rem] tracking-wider">
                <tr class="border-b border-white/[0.06]">
                  <th scope="col" class="text-left p-2">Email</th><th scope="col" class="text-left p-2">Role</th><th scope="col" class="text-left p-2">Joined</th><th scope="col" class="text-right p-2"></th>
                </tr>
              </thead>
              <tbody>
                @for (m of members(); track m.id) {
                  <tr class="border-b border-white/[0.04]">
                    <td class="p-2"><a class="settings-email-link" [href]="'mailto:' + m.email" [title]="'Email ' + m.email">{{ m.email }}</a></td>
                    <td class="p-2"><span class="badge">{{ m.role }}</span></td>
                    <td class="p-2 text-text-secondary">{{ m.created_at | date:'short' }}</td>
                    <td class="p-2 text-right">
                      @if (m.role !== 'owner') {
                        <button class="text-primary text-[0.72rem] mr-3" data-testid="team-make-owner"
                                [title]="'Transfer ownership to ' + m.email"
                                (click)="makeOwner(m)">Make owner</button>
                      }
                      <button class="text-red-400 text-[0.72rem] disabled:text-text-secondary/40 disabled:cursor-not-allowed"
                              [disabled]="isLastOwner(m)"
                              [title]="isLastOwner(m) ? 'Cannot remove the last owner — promote someone else first.' : 'Remove ' + m.email"
                              (click)="removeMember(m)">Remove</button>
                    </td>
                  </tr>
                }
                @for (i of invites(); track i.id) {
                  <tr class="border-b border-white/[0.04] bg-amber-500/[0.04]">
                    <td class="p-2"><a class="settings-email-link" [href]="'mailto:' + i.email" [title]="'Email ' + i.email">{{ i.email }}</a> <span class="text-[0.6rem] text-amber-300 ml-1">PENDING</span></td>
                    <td class="p-2"><span class="badge">{{ i.role }}</span></td>
                    <td class="p-2 text-text-secondary">invited {{ i.created_at | date:'short' }}</td>
                    <td class="p-2 text-right"><button class="text-red-400 text-[0.72rem]" (click)="revokeInvite(i)">Revoke</button></td>
                  </tr>
                }
              </tbody>
            </table>
          }
        </section>
      }

      <!-- ─────────────────── AI CHAT ─────────────────── -->
      @else if (tab() === 'ai-chat') {
        <section class="card" appReveal role="tabpanel" id="settings-panel" [attr.aria-labelledby]="'settings-tab-' + tab()">
          <header class="mb-4">
            <h2 class="m-0 text-base font-semibold text-white mb-1">AI Chat</h2>
            <p class="text-[0.7rem] text-text-secondary m-0">Persona + system prompt + knowledge files for the AI chat widget on your published site.</p>
          </header>

          <!-- Grid: System Prompt + Persona stacked on left; Web Search + Knowledge files on right. -->
          <div class="ai-chat-grid">
            <!-- LEFT COLUMN — System prompt (top) + Persona (below) -->
            <div class="ai-chat-col">
              <label class="block">
                <div class="flex items-center justify-between">
                  <span class="muted-h">System prompt</span>
                  <button class="btn-ghost text-[0.66rem] inline-flex items-center gap-1" (click)="improveChatField('system')" [disabled]="improvingField() === 'system'" [brnTooltip]="'Rewrite this system prompt for clarity + concrete behavioral rules'">@if (improvingField() !== 'system') { <app-ai-spark /> }<span>{{ improvingField() === 'system' ? 'Improving…' : 'Improve with AI' }}</span></button>
                </div>
                <textarea hlmInput [multiline]="true" class="w-full mt-1 font-mono text-[0.72rem] ai-chat-textarea" rows="10"
                          data-testid="ai-chat-system-prompt"
                          [placeholder]="chat.system_prompt_default || 'You are the AI concierge for [business]. Concise. Never invent prices.'"
                          [(ngModel)]="chat.system_prompt"></textarea>
                <p class="text-[0.62rem] text-text-secondary mt-1 leading-relaxed">
                  Tip: leave this empty and tap <strong>Improve with AI</strong> to load the v2 best-prompt default as a starting point — no AI credits used.
                </p>
              </label>
            </div>

            <!-- RIGHT COLUMN — Web search checkbox (top) + Knowledge files drop zone (below Persona) -->
            <div class="ai-chat-col">
              <label class="flex items-center gap-2 text-[0.78rem] text-white cursor-pointer self-end">
                <input hlmCheckbox type="checkbox"
                       data-testid="ai-chat-enable-web-search"
                       [checked]="allowWebResearch()"
                       (change)="toggleWebResearch($any($event.target).checked)"
                       [attr.aria-busy]="savingWebResearch()"
                       [disabled]="savingWebResearch()" />
                <span>Enable web search</span>
                <span class="text-[0.6rem] text-text-secondary" role="status" aria-live="polite">
                  @if (savingWebResearch()) { saving… }
                </span>
              </label>

              <div>
                <span class="muted-h">Knowledge files</span>
                <div class="kb-dropzone mt-1"
                     [class.drag]="kbDragOver()"
                     (dragover)="onKbDragOver($event)"
                     (dragleave)="kbDragOver.set(false)"
                     (drop)="onKbDrop($event)"
                     (click)="kbFileInput.click()"
                     data-testid="ai-chat-knowledge-dropzone">
                  <input #kbFileInput type="file" accept="application/pdf" multiple class="hidden"
                         (change)="onKbFileInput($any($event.target).files)" />
                  <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <path d="M14 2v6h6"/>
                    <path d="M9 13h6M9 17h6"/>
                  </svg>
                  <div class="kb-copy">Drop PDFs anywhere to add to knowledge</div>
                  <div class="kb-sub">or click to choose files</div>
                </div>
                @if (kbUploads().length) {
                  <ul class="kb-list mt-2">
                    @for (u of kbUploads(); track u.filename) {
                      <li>
                        <span class="kb-name">{{ u.filename }}</span>
                        <span class="kb-status">{{ u.status }}</span>
                      </li>
                    }
                  </ul>
                }
              </div>

              <!-- MCP allow-list moved into right column under knowledge files for cohesion -->
              <div>
                <span class="muted-h">MCP available to AI Chat</span>
                <p class="text-[0.66rem] text-text-secondary m-0 mt-1 mb-2">Check any connected MCP you want the chat to be allowed to call.</p>
                <div class="grid sm:grid-cols-2 gap-1.5">
                  @for (m of connections(); track m.id) {
                    <label class="flex items-center gap-2 p-2 rounded-lg cursor-pointer hover:bg-white/[0.04] border border-white/[0.04]" [title]="m.provider + ' — toggle availability for AI Chat'">
                      <input hlmCheckbox type="checkbox" [checked]="chatMcps().includes(m.provider)" (change)="toggleChatMcp(m.provider)" />
                      <span class="badge">{{ m.provider }}</span>
                      <span class="text-[0.66rem] text-text-secondary flex-1 truncate" [attr.title]="m.display_name || m.provider">{{ m.display_name || m.provider }}</span>
                    </label>
                  }
                  @if (connections().length === 0) {
                    <a routerLink="." [fragment]="'mcp'" class="text-[0.7rem] text-primary underline">+ Connect MCPs in the MCP tab</a>
                  }
                </div>
              </div>
            </div>
          </div>

          <div class="flex justify-end mt-4">
            <button class="btn-primary" data-testid="ai-chat-save" [disabled]="savingChat()" (click)="saveChat()">{{ savingChat() ? 'Saving…' : 'Save AI Chat settings' }}</button>
          </div>
        </section>
      }


      <!-- Theme moved → /admin/user (user-level, not per-project). -->

      <!-- ─────────────────── MCP ─────────────────── -->
      @else if (tab() === 'mcp') {
        <section class="card" appReveal role="tabpanel" id="settings-panel" [attr.aria-labelledby]="'settings-tab-' + tab()">
          <h2 class="m-0 text-base font-semibold text-white mb-1">MCP integrations</h2>
          <p class="text-[0.7rem] text-text-secondary m-0 mb-4">
            Connect the tools your AI form router + custom endpoints can call. Tokens are encrypted at rest (AES-GCM).
            OAuth follows the MCP authorization spec (OAuth 2.1 + PKCE where supported); paste-key for the rest.
          </p>

          <!-- MCPs ALSO receive the project-wide AI variables — convey that + show them. -->
          <div class="mcp-aivars" role="note">
            <div class="mcp-aivars-head">
              <span class="mcp-aivars-title"><span aria-hidden="true">🔑</span> MCPs also use your project AI variables</span>
              <a routerLink="." [fragment]="'env-vars'" class="mcp-aivars-link" data-testid="mcp-aivars-link">Manage in AI Env Vars →</a>
            </div>
            <p class="mcp-aivars-sub">
              Every variable marked <strong class="text-light">exposed to AI</strong> is injected into these MCPs' tool calls — no need to re-enter them per integration.
            </p>
            @if (orgEnvVars().length > 0) {
              <ul class="mcp-aivars-list" aria-label="Project AI variables available to MCPs" data-testid="mcp-aivars-list">
                @for (v of shownOrgEnvVars(); track v.key) {
                  <li class="mcp-aivars-item">
                    <code class="mcp-aivars-key">{{ v.key }}</code>
                    <span class="mcp-aivars-badge" [class.on]="v.exposed_to_ai" [title]="v.exposed_to_ai ? 'Exposed to AI + MCP tool calls' : 'Stored but not exposed to AI'">{{ v.exposed_to_ai ? 'exposed' : 'hidden' }}</span>
                  </li>
                }
              </ul>
              @if (orgEnvVars().length > 8) {
                <button type="button" class="mcp-aivars-toggle" (click)="showAllOrgEnvVars.set(!showAllOrgEnvVars())"
                        [attr.aria-expanded]="showAllOrgEnvVars()" data-testid="mcp-aivars-toggle">
                  {{ showAllOrgEnvVars() ? 'Show fewer' : 'Show all ' + orgEnvVars().length + ' variables' }}
                </button>
              }
            } @else {
              <p class="mcp-aivars-empty">No project AI variables yet — add them in <a routerLink="." [fragment]="'env-vars'" class="text-primary underline">AI Env Vars</a>.</p>
            }
          </div>

          <div class="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
            @for (p of providers; track p.id) {
              <!-- Span the full grid row when the env-vars manager is open — it's a
                   full-width admin component and squishes inside a 1/3-width card. -->
              <article class="card-light p-4 flex flex-col gap-2"
                       [class.col-span-full]="isMcpEnvVarsOpen(p.id)">
                <div class="flex items-start gap-3">
                  <div class="w-10 h-10 rounded-lg flex items-center justify-center font-bold text-[0.9rem]"
                       [style.background]="p.color + '20'" [style.color]="p.color">{{ p.label[0] }}</div>
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                      <div class="font-semibold text-white">{{ p.label }}</div>
                      @if (p.oauth_supported) {
                        <span class="oauth-pill" title="Single-click OAuth supported">OAuth</span>
                      }
                    </div>
                    <div class="text-[0.68rem] text-text-secondary leading-snug">{{ p.desc }}</div>
                  </div>
                </div>
                @if (isConnected(p.id); as c) {
                  <div class="flex items-center justify-between mt-1 text-[0.72rem]">
                    <span class="text-emerald-400">
                      ● Connected · {{ c.connected_at | slice:0:10 }}
                      <span class="via-badge">via {{ isOauthConnection(c) ? 'OAuth' : 'key' }}</span>
                    </span>
                    <div class="flex gap-2">
                      <button class="mcp-btn"
                              (click)="toggleMcpEnvVars(p.id)"
                              [attr.aria-expanded]="isMcpEnvVarsOpen(p.id)"
                              [attr.aria-label]="(isMcpEnvVarsOpen(p.id) ? 'Hide' : 'Show') + ' custom env vars for ' + p.label">
                        {{ isMcpEnvVarsOpen(p.id) ? 'Hide env vars' : 'Env vars' }}
                      </button>
                      <button class="mcp-btn mcp-btn-danger" (click)="disconnect(c)" [disabled]="isDisconnecting(c.id)" [attr.aria-busy]="isDisconnecting(c.id)">{{ isDisconnecting(c.id) ? 'Disconnecting…' : 'Disconnect' }}</button>
                    </div>
                  </div>
                  @if (isMcpEnvVarsOpen(p.id)) {
                    <div class="mt-3">
                      <app-env-vars-manager [scope]="'mcp'" [mcpProvider]="p.id" [showDotenv]="false" />
                    </div>
                  }
                } @else if (!mcpAvailable(p.id)) {
                  <span class="mcp-btn mcp-coming-soon mt-1 self-start" role="note"
                        [attr.aria-label]="p.label + ' integration — coming soon, not yet available'"
                        title="Not yet available — coming soon">Coming soon</span>
                } @else if (pasteMode() === p.id) {
                  <div class="mt-1 flex gap-2">
                    <input hlmInput type="password" class="flex-1 font-mono text-[0.72rem]"
                           [attr.aria-label]="'API key for ' + p.id"
                           [placeholder]="pastePlaceholder(p.id)" [(ngModel)]="pastedKey" />
                    <button class="mcp-btn mcp-btn-solid" (click)="submitPaste(p.id)" [disabled]="pasteSaving()">{{ pasteSaving() ? 'Saving…' : 'Save' }}</button>
                  </div>
                } @else if (p.oauth_supported) {
                  <button class="mcp-btn mcp-btn-oauth mt-1 self-start" (click)="connectOauth(p.id)">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5" />
                      <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" />
                    </svg>
                    Connect with {{ p.label }}
                  </button>
                } @else {
                  <button class="mcp-btn mt-1 self-start" (click)="connect(p)">Add API key</button>
                }
              </article>
            }
          </div>
        </section>
      }

      <!-- ─────────────────── AI ENV VARS ─────────────────── -->
      @else if (tab() === 'env-vars') {
        <section class="card" appReveal role="tabpanel" id="settings-panel" [attr.aria-labelledby]="'settings-tab-' + tab()">
          <header class="mb-4">
            <h2 class="m-0 text-base font-semibold text-white mb-1">AI environment variables</h2>
            <p class="text-[0.7rem] text-text-secondary m-0">
              Env vars marked <strong>Exposed to AI</strong> flow into LLM tool calls + AI endpoints + MCP requests
              for this organization. Values are encrypted at rest (AES-GCM). Org-scope vars apply everywhere;
              per-MCP overrides live in the MCP tab.
            </p>
          </header>
          <app-env-vars-manager [scope]="'org'" />
        </section>
      }
      @else if (tab() === 'webhooks') {
        <!-- Outbound Webhooks moved under Settings (2026-06-07). The standalone
             /admin/webhooks route now redirects to /admin/settings#webhooks. The
             embedded component renders its own surfaces; this wrapper only carries
             the tabpanel a11y contract (role + id + aria-labelledby). -->
        <div appReveal role="tabpanel" id="settings-panel" [attr.aria-labelledby]="'settings-tab-' + tab()" data-testid="settings-webhooks-panel">
          <app-admin-webhooks />
        </div>
      }
      @else if (tab() === 'email') {
        <!-- Email moved under Settings (2026-06-07): the provided-sender allowance,
             bring-your-own-SMTP, and the existing Deliverability (SPF/DKIM/DMARC)
             surface. /admin/deliverability redirects to /admin/settings#email. -->
        <div appReveal role="tabpanel" id="settings-panel" [attr.aria-labelledby]="'settings-tab-' + tab()" data-testid="settings-email-panel">
          <!-- Free transactional-send allowance on the shared sender. -->
          <section class="card" data-testid="email-allowance-card">
            <header class="mb-3 flex items-start gap-3">
              <span class="shrink-0 grid place-items-center w-9 h-9 rounded-lg" style="background:rgba(0,229,255,0.1);border:1px solid rgba(0,229,255,0.25);">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--ps-accent, #00e5ff)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v16H4z"/><path d="m4 7 8 6 8-6"/></svg>
              </span>
              <div>
                <h2 class="m-0 text-base font-semibold text-white mb-1">Email sending</h2>
                <p class="text-[0.72rem] text-text-secondary m-0 leading-relaxed">
                  ProjectSites sends your transactional email — magic links + form notifications —
                  from <strong class="text-accent">{{ providedEmailSender }}</strong> on your behalf.
                </p>
              </div>
            </header>
            <div class="rounded-lg p-3 flex items-center gap-3" style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);">
              <div class="text-[1.35rem] font-bold text-accent tabular-nums leading-none">
                <app-rolling-counter [value]="freeEmailCap" />
              </div>
              <div class="text-[0.7rem] text-text-secondary leading-snug">
                <strong class="text-white">free emails / month</strong>, per site, on the shared sender.<br />
                Need your own branded sender or a higher limit? Bring your own SMTP below.
              </div>
            </div>
          </section>

          <!-- Bring your own SMTP — informative feature-preview (server-side
               persistence of SMTP credentials is a worker-backed change shipping
               next). No dead button: the action is disabled with a clear status
               pill + the benefits + future fields are previewed. -->
          <section class="card mt-4" data-testid="email-smtp-card">
            <header class="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 class="m-0 text-base font-semibold text-white mb-1">Bring your own SMTP</h2>
                <p class="text-[0.7rem] text-text-secondary m-0">
                  Send from your own mail server instead of the shared sender — encrypted credentials, set per project.
                </p>
              </div>
              <span class="coming-soon-pill shrink-0" data-testid="email-smtp-soon">Coming soon</span>
            </header>
            <ul class="smtp-benefits" role="list">
              <li>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ps-accent, #00e5ff)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
                Send from <strong class="text-white">your own domain</strong> — better brand trust + inbox placement.
              </li>
              <li>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ps-accent, #00e5ff)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
                <strong class="text-white">No monthly cap</strong> — your provider's limits apply, not the free {{ freeEmailCap }}.
              </li>
              <li>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ps-accent, #00e5ff)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
                <strong class="text-white">Encrypted at rest</strong> — host · port · username · password · from-address.
              </li>
            </ul>
            <button type="button" class="smtp-soon-btn" disabled aria-disabled="true" data-testid="email-smtp-configure" [brnTooltip]="'Custom SMTP credentials persist server-side — rolling out in the next backend update'">
              Configure SMTP
              <span class="smtp-soon-hint">· available after the next platform update</span>
            </button>
          </section>

          <!-- Deliverability (SPF/DKIM/DMARC) — fully functional, embedded here. -->
          <section class="mt-4">
            <app-admin-deliverability level="h2" />
          </section>
        </div>
      }
      @else if (tab() === 'domains') {
        <!-- Domains moved under Settings (2026-08-12): backup subdomain + connect
             a custom domain + AI domain search, scoped to the selected project.
             The standalone /admin/domains route now redirects to
             /admin/settings#domains. -->
        <div appReveal role="tabpanel" id="settings-panel" [attr.aria-labelledby]="'settings-tab-' + tab()" data-testid="settings-domains-panel">
          <app-admin-domains />
        </div>
      }
      @else if (tab() === 'api-tokens') {
        <!-- API Tokens moved under Settings (2026-08-12): create / list / revoke
             psk_ Public API v1 tokens (org-wide). The standalone /admin/api-tokens
             route now redirects to /admin/settings#api-tokens. The embedded
             component self-gates on the public_api_v1 flag. -->
        <div appReveal role="tabpanel" id="settings-panel" [attr.aria-labelledby]="'settings-tab-' + tab()" data-testid="settings-api-tokens-panel">
          <app-admin-api-tokens />
        </div>
      }

      <!-- Security tab removed entirely:
           · API keys → /admin/user
           · 2FA toggle → Team tab (next to Invite)
           · Session lifetime + idle timeout removed (too complex for our users) -->

      <!-- Danger zone removed — export / transfer / delete-org flows live outside
           the admin shell now. -->
    </div>
  `,
  styles: [`
    :host { display: block; --accent: var(--ps-accent, #00E5FF); }
    /* MCP tab — project-wide AI vars callout (MCPs receive these at tool-call time). */
    .mcp-aivars { margin-bottom: 1rem; padding: 0.9rem 1.05rem; border-radius: var(--ps-radius-md, 12px); background: linear-gradient(135deg, color-mix(in oklch, var(--accent) 7%, transparent), transparent); border: 1px solid color-mix(in oklch, var(--accent) 20%, transparent); }
    .mcp-aivars-head { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; }
    .mcp-aivars-title { font-size: 0.82rem; font-weight: 700; color: var(--ps-ink, #f4f4ff); }
    .mcp-aivars-link { font-size: 0.72rem; color: var(--accent); text-decoration: underline; white-space: nowrap; }
    .mcp-aivars-sub { font-size: 0.68rem; color: rgba(255,255,255,0.6); margin: 0.35rem 0 0; line-height: 1.5; }
    .mcp-aivars-list { list-style: none; margin: 0.7rem 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 0.4rem; }
    .mcp-aivars-item { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.2rem 0.5rem; border-radius: 999px; background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.08); }
    .mcp-aivars-key { font-family: ui-monospace, 'JetBrains Mono', monospace; font-size: 0.68rem; color: rgba(255,255,255,0.85); }
    .mcp-aivars-badge { font-size: 0.56rem; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; padding: 0.05rem 0.35rem; border-radius: 999px; background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.5); }
    .mcp-aivars-badge.on { background: color-mix(in oklch, var(--accent) 22%, transparent); color: var(--accent); }
    .mcp-aivars-toggle { margin-top: 0.6rem; font-size: 0.7rem; color: var(--accent); background: none; border: none; cursor: pointer; text-decoration: underline; padding: 0; }
    .mcp-aivars-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
    .mcp-aivars-empty { font-size: 0.68rem; color: rgba(255,255,255,0.6); margin: 0.5rem 0 0; }
    h2, h3 { font-family: 'Sora', system-ui, sans-serif; font-weight: 600; letter-spacing: -0.02em; }
    .card { background: rgba(255,255,255,0.02); border: 1px solid color-mix(in oklch, var(--accent) 14%, transparent); border-radius: 14px; padding: 1.4rem; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.02); transition: transform 200ms ease, border-color 200ms ease, box-shadow 200ms ease; }
    .card:hover { transform: translateY(-1px); border-color: color-mix(in oklch, var(--accent) 28%, transparent); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.04), 0 8px 24px -16px rgba(0,229,255,0.18); }
    .card-light { background: rgba(255,255,255,0.025); border: 1px solid color-mix(in oklch, var(--accent) 16%, transparent); border-radius: 12px; transition: transform 200ms ease, border-color 200ms ease; }
    .card-light:hover { transform: translateY(-1px); border-color: color-mix(in oklch, var(--accent) 30%, transparent); }
    .empty-state { display: flex; flex-direction: column; align-items: center; gap: 0.6rem; padding: 2rem 1rem; text-align: center; }
    .empty-state .icon { width: 36px; height: 36px; opacity: 0.45; }
    .empty-state h4 { margin: 0; font-family: 'Sora', system-ui, sans-serif; font-weight: 600; color: rgba(255,255,255,0.85); font-size: 0.86rem; letter-spacing: -0.01em; }
    .empty-state p { margin: 0; font-size: 0.74rem; color: rgba(255,255,255,0.5); max-width: 32ch; }
    .skeleton { background: linear-gradient(90deg, rgba(255,255,255,0.04), rgba(255,255,255,0.08), rgba(255,255,255,0.04)); background-size: 200% 100%; animation: shimmer 1.4s linear infinite; border-radius: 8px; }
    @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    @media (prefers-reduced-motion: reduce) {
      .card, .card-light { transition: none; }
      .card:hover, .card-light:hover { transform: none; box-shadow: none; }
      .skeleton { animation: none; background: rgba(255,255,255,0.06); }
    }
    @media (max-width: 640px) {
      .btn-primary, .btn-ghost { width: 100%; }
    }
    /* Local cyan override — the global .text-accent utility renders dim; this
       forces brand cyan for the email-sender + allowance figures (axe contrast). */
    .text-accent { color: var(--ps-accent, #00e5ff); }
    /* Email tab — disabled "Configure SMTP" coming-soon affordance (not a dead button). */
    /* "Coming soon" feature-preview badge — cyan via --ps-accent to match the
       cockpit standard (apps-detail .soon-badge); replaces a hardcoded amber
       inline style (brand-token drift on the cyan/black cockpit). */
    .coming-soon-pill {
      font-size: 0.6rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
      padding: 2px 8px; border-radius: 999px;
      color: var(--ps-accent, #00E5FF);
      background: color-mix(in oklch, var(--ps-accent, #00E5FF) 12%, transparent);
      border: 1px solid color-mix(in oklch, var(--ps-accent, #00E5FF) 30%, transparent);
    }
    .smtp-benefits { list-style: none; margin: 0 0 0.9rem; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
    .smtp-benefits li { display: flex; align-items: flex-start; gap: 0.5rem; font-size: 0.72rem; color: rgba(255,255,255,0.62); line-height: 1.35; }
    .smtp-benefits li svg { flex: 0 0 auto; margin-top: 0.12rem; }
    .smtp-soon-btn { display: inline-flex; align-items: baseline; gap: 0.4rem; padding: 0.45rem 0.9rem; border-radius: 0.55rem; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.12); color: rgba(255,255,255,0.45); font-size: 0.74rem; font-weight: 600; cursor: not-allowed; }
    .smtp-soon-hint { font-size: 0.64rem; font-weight: 500; color: rgba(255,255,255,0.32); }
    .tab { padding: 0.4rem 0.95rem; border-radius: 999px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); color: rgba(255,255,255,0.6); cursor: pointer; font-size: 0.74rem; font-weight: 600; transition: all 120ms ease; }
    .tab:hover { color: #fff; border-color: color-mix(in oklch, var(--accent) 25%, transparent); }
    .tab.active { background: color-mix(in oklch, var(--accent) 12%, transparent); color: var(--accent); border-color: color-mix(in oklch, var(--accent) 35%, transparent); }
    .tab:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .badge { font-size: 0.6rem; text-transform: uppercase; font-weight: 700; padding: 2px 8px; border-radius: 999px; background: rgba(0,229,255,0.1); color: #00E5FF; }
    /* Teammate email = reply target: cyan mailto link (rows aren't clickable). */
    .settings-email-link { color: var(--ps-accent, #00E5FF); text-decoration: none; }
    .settings-email-link:hover { text-decoration: underline; }
    .settings-email-link:focus-visible { outline: 2px solid var(--ps-accent, #00E5FF); outline-offset: 2px; border-radius: 3px; }
    /* All inputs/textareas/selects now carry Spartan hlmInput/hlmSelect — the
       old .input-field / select.input-field rules are gone (fully converged). */
    .btn-primary { padding: 0.5rem 1rem; border-radius: 8px; background: var(--ps-grad-primary); color: #060610; font-weight: 700; border: 1px solid color-mix(in oklch, #00d4ff 40%, transparent); cursor: pointer; font-size: 0.78rem; transition: transform 200ms ease, box-shadow 200ms ease; }
    .btn-primary:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 8px 24px -10px rgba(0,229,255,0.45); }
    .btn-primary:disabled { opacity: 0.55; cursor: not-allowed; }
    .btn-oauth { display: inline-flex; align-items: center; gap: 0.4rem; background: linear-gradient(135deg, #00E5FF, #7C3AED); color: #060610; }
    .btn-oauth:hover:not(:disabled) { box-shadow: 0 8px 24px -10px rgba(124,58,237,0.55); }
    .oauth-pill { font-size: 0.56rem; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 700; padding: 1px 6px; border-radius: 999px; background: linear-gradient(135deg, rgba(0,229,255,0.18), rgba(124,58,237,0.22)); color: #cde9ff; border: 1px solid rgba(0,229,255,0.35); }
    .via-badge { display: inline-block; margin-left: 0.4rem; font-size: 0.58rem; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; padding: 1px 5px; border-radius: 6px; background: rgba(16,185,129,0.12); color: #34d399; border: 1px solid rgba(16,185,129,0.28); }
    .btn-ghost { padding: 0.45rem 0.95rem; border-radius: 8px; background: transparent; color: rgba(255,255,255,0.7); border: 1px solid rgba(255,255,255,0.1); cursor: pointer; font-size: 0.74rem; transition: transform 200ms ease, border-color 200ms ease; }
    .btn-ghost:hover { transform: translateY(-1px); border-color: color-mix(in oklch, var(--accent) 30%, transparent); }
    @media (prefers-reduced-motion: reduce) {
      .btn-primary, .btn-ghost { transition: none; }
      .btn-primary:hover, .btn-ghost:hover { transform: none; box-shadow: none; }
    }
    .muted-h { font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.08em; color: rgba(255,255,255,0.5); font-weight: 700; }
    .theme-card { display: flex; flex-direction: column; align-items: flex-start; gap: 0.4rem; padding: 0.85rem; border-radius: 12px; background: rgba(255,255,255,0.025); border: 1px solid rgba(255,255,255,0.08); cursor: pointer; transition: all 160ms ease; text-align: left; }
    .theme-card:hover { border-color: rgba(0,229,255,0.35); transform: translateY(-1px); }
    .theme-card.active { border-color: rgba(0,229,255,0.6); background: rgba(0,229,255,0.08); box-shadow: 0 0 0 3px rgba(0,229,255,0.12); }
    .theme-swatch { width: 100%; height: 44px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); }
    .theme-swatch.dk { background: linear-gradient(135deg, #06061a, #0a0a28); }
    .theme-swatch.lt { background: linear-gradient(135deg, #f8fafc, #cbd5e1); }
    .theme-swatch.sy { background: linear-gradient(135deg, #06061a 0 50%, #f8fafc 50% 100%); }
    .status-pill { font-size: 0.62rem; padding: 2px 8px; border-radius: 999px; background: rgba(255,255,255,0.05); color: rgba(255,255,255,0.75); border: 1px solid rgba(255,255,255,0.08); }
    .status-pill.is-active { background: rgba(16,185,129,0.12); color: #34d399; border-color: rgba(16,185,129,0.3); }
    .status-pill.is-pending { background: rgba(251,191,36,0.12); color: #fbbf24; border-color: rgba(251,191,36,0.3); }
    .status-pill.is-error { background: rgba(239,68,68,0.12); color: #f87171; border-color: rgba(239,68,68,0.3); }

    /* Team actions — twin rows, matched heights so 2FA and Invite line up visually. */
    .team-actions-grid { display: grid; grid-template-columns: 1fr; gap: 0.75rem; }
    @media (min-width: 768px) { .team-actions-grid { grid-template-columns: 1fr 1fr; } }
    .team-action-row {
      min-height: 64px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      padding: 0.85rem 1.1rem;
      border-radius: var(--ps-radius-md, 10px);
      background: rgba(255,255,255,0.025);
      border: 1px solid rgba(255,255,255,0.08);
      box-shadow: var(--ps-shadow-card, inset 0 0 0 1px rgba(255,255,255,0.02));
      transition: border-color var(--ps-dur-base, 180ms) var(--ps-ease-emphasized, ease);
    }
    .team-action-row:hover { border-color: color-mix(in oklch, var(--accent) 28%, transparent); }
    @media (prefers-reduced-motion: reduce) { .team-action-row { transition: none; } }

    /* AI Chat grid — single column on small screens, two columns at ≥1024px. */
    .ai-chat-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1.25rem; align-items: start; }
    @media (min-width: 1024px) { .ai-chat-grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } }
    .ai-chat-col { display: flex; flex-direction: column; gap: 1.1rem; min-width: 0; }
    .ai-chat-full { grid-column: 1 / -1; }
    /* Cap textareas + inputs in the AI Chat grid at 600px so System Prompt
       does not balloon on ultrawide displays. */
    .ai-chat-textarea { max-width: 600px; }

    /* Knowledge files drop zone — square-ish, dashed, cyan accent on dragover.
       Window-level drag/drop also routes here via @HostListener so PDFs dropped
       ANYWHERE on the AI Chat tab land in this zone. */
    .kb-dropzone {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 0.45rem;
      min-height: 168px;
      padding: 1.4rem 1rem;
      border-radius: 14px;
      border: 1.5px dashed rgba(255,255,255,0.14);
      background: rgba(255,255,255,0.02);
      color: rgba(255,255,255,0.7);
      cursor: pointer;
      text-align: center;
      transition: border-color 160ms ease, background 160ms ease, color 160ms ease, transform 160ms ease;
    }
    .kb-dropzone:hover { border-color: rgba(0,229,255,0.45); color: #fff; }
    .kb-dropzone.drag {
      border-color: #00E5FF;
      background: color-mix(in oklch, #00E5FF 10%, transparent);
      color: #fff;
      transform: translateY(-1px);
    }
    .kb-dropzone svg { opacity: 0.7; }
    .kb-dropzone.drag svg { opacity: 1; color: #00E5FF; }
    .kb-copy { font-size: 0.82rem; font-weight: 600; letter-spacing: -0.005em; }
    .kb-sub { font-size: 0.66rem; color: rgba(255,255,255,0.45); }
    .kb-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.25rem; }
    .kb-list li { display: flex; justify-content: space-between; gap: 0.5rem; font-size: 0.7rem; color: rgba(255,255,255,0.75); padding: 0.3rem 0.55rem; border-radius: 6px; background: rgba(255,255,255,0.03); }
    .kb-list .kb-status { color: rgba(255,255,255,0.5); text-transform: uppercase; font-size: 0.58rem; letter-spacing: 0.06em; }
    @media (prefers-reduced-motion: reduce) { .kb-dropzone { transition: none; } .kb-dropzone.drag { transform: none; } }

    /* Business tab — grouped fieldsets with subtle borders. */
    .biz-group {
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 12px;
      padding: 1.1rem 1.2rem 0.9rem;
      background: rgba(255,255,255,0.015);
    }
    .biz-legend {
      padding: 0 0.4rem;
      font-size: 0.62rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      font-weight: 700;
      color: rgba(255,255,255,0.55);
    }
    .biz-err { font-size: 0.66rem; color: #f87171; margin: 0.3rem 0 0; min-height: 0.66rem; }
    .biz-file-wrap { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; font-size: 0.72rem; color: rgba(255,255,255,0.75); }
    .biz-file-btn {
      padding: 0.35rem 0.75rem;
      border-radius: 6px;
      background: rgba(255,255,255,0.05);
      color: #fff;
      border: 1px solid rgba(255,255,255,0.1);
      font-size: 0.7rem;
      cursor: pointer;
      transition: border-color 0.15s ease;
    }
    .biz-file-btn:hover { border-color: rgba(0,229,255,0.35); }
    .biz-file-btn:focus-visible { outline: 2px solid rgba(0,229,255,0.6); outline-offset: 2px; }
    .biz-file-hint { font-size: 0.66rem; color: rgba(255,255,255,0.6); }
    .biz-file-pill {
      padding: 0.18rem 0.55rem;
      border-radius: 999px;
      background: rgba(0,229,255,0.08);
      color: #cde9ff;
      border: 1px solid rgba(0,229,255,0.22);
      font-size: 0.62rem;
    }

    /* MCP — compact, translucent buttons. No bright primaries on secondary
       connect/key actions; cyan→violet gradient reserved for the "+ Generate"
       primary CTA elsewhere in the admin. */
    .mcp-btn {
      padding: 6px 12px;
      font-size: 0.74rem;
      font-weight: 500;
      border-radius: 7px;
      background: rgba(255,255,255,0.04);
      color: rgba(255,255,255,0.85);
      border: 1px solid rgba(255,255,255,0.1);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      transition: border-color 160ms ease, background 160ms ease, color 160ms ease;
    }
    .mcp-btn:hover { border-color: color-mix(in oklch, var(--accent) 32%, transparent); color: #fff; background: rgba(255,255,255,0.06); }
    .mcp-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .mcp-btn-oauth { color: rgba(255,255,255,0.8); }
    .mcp-btn-oauth svg { opacity: 0.7; }
    .mcp-btn-oauth:hover svg { opacity: 1; color: #00E5FF; }
    /* Built-ahead providers with no worker adapter — honest disabled state
       (a real connect button would 404 "unknown provider"). */
    .mcp-coming-soon { opacity: 0.45; cursor: default; pointer-events: none; font-style: italic; }
    .mcp-btn-solid {
      background: rgba(0,229,255,0.1);
      color: #cdf2ff;
      border-color: rgba(0,229,255,0.3);
    }
    .mcp-btn-solid:hover { background: rgba(0,229,255,0.16); color: #fff; }
    .mcp-btn-danger {
      background: transparent;
      color: rgba(248,113,113,0.85);
      border-color: rgba(248,113,113,0.25);
    }
    .mcp-btn-danger:hover { color: #f87171; border-color: rgba(248,113,113,0.5); background: rgba(248,113,113,0.06); }
    @media (prefers-reduced-motion: reduce) { .mcp-btn { transition: none; } }

    .hidden { display: none; }
  `],
})
export class AdminSettingsComponent implements OnInit {
  state = inject(AdminStateService);
  private api = inject(ApiService);
  private toast = inject(ToastService);
  private confirmSvc = inject(ConfirmService);
  private auth = inject(AuthService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  /**
   * In-flight raw-XHR uploads (knowledge PDFs + brand assets). Tracked so they can
   * be aborted when the component is destroyed — otherwise a navigate-away mid-upload
   * leaves the request running and its onload/ontimeout toast fires on a dead view.
   * Registered once in the constructor via destroyRef.
   */
  private readonly inFlightUploads = new Set<XMLHttpRequest>();

  constructor() {
    this.destroyRef.onDestroy(() => {
      for (const xhr of this.inFlightUploads) xhr.abort();
      this.inFlightUploads.clear();
    });
  }

  tab = signal<Tab>('general');
  /** Static tab list exposed to the template (Cmd-K palette handles search now). */
  tabs = TABS;
  /**
   * Template guard: true when a provider has a live worker adapter (connectable
   * now). Built-ahead catalogue entries (no adapter) render "Coming soon" instead
   * of a connect button that 404s "unknown provider". SSOT: `mcp-providers.ts`.
   */
  protected readonly mcpAvailable = mcpAvailable;
  /** Email tab — free transactional-send allowance + shared sender (template-readonly). */
  readonly freeEmailCap = FREE_EMAIL_CAP_PER_MONTH;
  readonly providedEmailSender = PROVIDED_EMAIL_SENDER;
  savingChat = signal(false);
  inviting = signal(false);
  loadingTeam = signal(false);
  loadingConnections = signal(false);

  // AI Chat tab
  chat: { system_prompt: string; system_prompt_default: string } = { system_prompt: '', system_prompt_default: '' };

  // Web search toggle — persists to /sites/:id/ai-settings (field: allow_web_research).
  allowWebResearch = signal<boolean>(false);
  savingWebResearch = signal<boolean>(false);

  // Knowledge files drop zone — PDFs upload to /sites/:id/ai/context/upload.
  kbDragOver = signal<boolean>(false);
  kbUploads = signal<{ filename: string; status: 'uploading' | 'done' | 'error' }[]>([]);

  toggleWebResearch(next: boolean): void {
    const s = this.state.selectedSite(); if (!s) { this.toast.error('Select a site first'); return; }
    this.allowWebResearch.set(next);
    this.savingWebResearch.set(true);
    this.api.put(`/sites/${s.id}/ai-settings`, { allow_web_research: next }).subscribe({
      next: () => { this.savingWebResearch.set(false); this.toast.success(next ? 'Web search on' : 'Web search off'); },
      error: () => { this.savingWebResearch.set(false); this.allowWebResearch.set(!next); /* api.service already toasted */ },
    });
  }

  // Local drop on the visible zone.
  onKbDragOver(ev: DragEvent): void { ev.preventDefault(); this.kbDragOver.set(true); }
  onKbDrop(ev: DragEvent): void {
    ev.preventDefault(); this.kbDragOver.set(false);
    const files = ev.dataTransfer?.files; if (!files?.length) return;
    this.uploadKnowledgeFiles(files);
  }
  onKbFileInput(files: FileList | null): void { if (files) this.uploadKnowledgeFiles(files); }

  // Window-level drag-over: only show the cyan accent while AI Chat tab is active.
  @HostListener('window:dragover', ['$event'])
  onWindowDragOver(ev: DragEvent): void {
    if (this.tab() !== 'ai-chat') return;
    if (!ev.dataTransfer?.types?.includes('Files')) return;
    ev.preventDefault();
    this.kbDragOver.set(true);
  }
  @HostListener('window:dragleave', ['$event'])
  onWindowDragLeave(ev: DragEvent): void {
    if (this.tab() !== 'ai-chat') return;
    // Only clear when leaving the document entirely.
    if (ev.relatedTarget === null) this.kbDragOver.set(false);
  }
  @HostListener('window:drop', ['$event'])
  onWindowDrop(ev: DragEvent): void {
    if (this.tab() !== 'ai-chat') return;
    const files = ev.dataTransfer?.files; if (!files?.length) return;
    ev.preventDefault();
    this.kbDragOver.set(false);
    this.uploadKnowledgeFiles(files);
  }

  private uploadKnowledgeFiles(files: FileList): void {
    const s = this.state.selectedSite(); if (!s) { this.toast.error('Select a site first'); return; }
    Array.from(files).forEach((file) => {
      if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
        this.toast.error(`${file.name}: only PDFs are accepted here.`);
        return;
      }
      this.kbUploads.update((u) => [...u, { filename: file.name, status: 'uploading' }]);
      const form = new FormData(); form.append('file', file);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/sites/${s.id}/ai/context/upload`, true);
      // Token SSOT — AuthService.getToken() reads the `ps_session` blob. The old
      // `localStorage.getItem('session_token')` key was NEVER written (refactor drift),
      // so this upload sent `Bearer null` → the Bearer-only worker 401'd every upload.
      const token = this.auth.getToken();
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      // A raw XHR bypasses ApiService's 30s timeout — without one, a hung upload leaves
      // the row stuck on "uploading" forever (owner stranded, no feedback). 60s (> the API
      // 30s: a PDF upload is heavier) then fail the row WITH an actionable message.
      xhr.timeout = 60000;
      const markError = () =>
        this.kbUploads.update((u) => u.map((x) => (x.filename === file.name ? { ...x, status: 'error' } : x)));
      const settle = () => this.inFlightUploads.delete(xhr);
      xhr.onload = () => {
        settle();
        const ok = xhr.status >= 200 && xhr.status < 300;
        this.kbUploads.update((u) => u.map((x) => x.filename === file.name ? { ...x, status: ok ? 'done' : 'error' } : x));
        if (ok) this.toast.success(`Saved — ${file.name} added to knowledge`);
        else this.toast.error(`Upload failed: ${file.name}`);
      };
      xhr.onerror = () => {
        settle();
        markError();
        this.toast.error(`Upload failed: ${file.name}`);
      };
      xhr.ontimeout = () => {
        settle();
        markError();
        this.toast.error(`${file.name} timed out — check your connection and try again.`);
      };
      this.inFlightUploads.add(xhr);
      xhr.send(form);
    });
  }

  saveChat(): void {
    const s = this.state.selectedSite(); if (!s) return;
    this.savingChat.set(true);
    this.api.put(`/sites/${s.id}/ai-settings`, { chat_system_prompt: this.chat.system_prompt }).subscribe({
      next: () => { this.toast.success('Saved'); this.savingChat.set(false); },
      error: () => { this.savingChat.set(false); /* api.service already toasted */ },
    });
  }

  // ── Business identity (rendered in the General tab) ──
  business: {
    contact_email: string;
    business_name: string;
    business_address: string;
    business_phone: string;
    logoFile: File | null;
    iconFile: File | null;
  } = { contact_email: '', business_name: '', business_address: '', business_phone: '', logoFile: null, iconFile: null };

  private businessSnapshot = JSON.stringify(this.business);
  businessDirty = signal<boolean>(false);
  savingBusiness = signal<boolean>(false);
  businessErrors = signal<{
    business_name?: string;
    business_address?: string;
    business_phone?: string;
    logo?: string;
    icon?: string;
  }>({});

  markBusinessDirty(): void {
    const cur = JSON.stringify({ ...this.business, logoFile: this.business.logoFile?.name ?? null, iconFile: this.business.iconFile?.name ?? null });
    const snap = JSON.stringify({ ...JSON.parse(this.businessSnapshot), logoFile: null, iconFile: null });
    this.businessDirty.set(cur !== snap);
    // Live-validate the one REQUIRED field so a cleared name EXPLAINS the disabled
    // Save (WCAG 3.3.1 + Social's publishBlockReason pattern) instead of a silent
    // grey-out. Fires on every ngModelChange, so #biz-err-name + aria-invalid
    // appear/clear the moment the name goes empty/valid. Other errors (address /
    // phone / logo / icon) stay untouched — they're still validated on save.
    const name = this.business.business_name;
    const nameErr = !name.trim()
      ? 'Business name is required.'
      : name.length > 200
        ? 'Maximum 200 characters.'
        : undefined;
    this.businessErrors.update((e) => ({ ...e, business_name: nameErr }));
  }

  onBusinessLogo(files: FileList | null): void {
    const f = files?.[0] ?? null;
    this.business.logoFile = f;
    this.businessErrors.update((e) => ({ ...e, logo: f && f.size > 5 * 1024 * 1024 ? 'Logo must be 5 MB or smaller.' : undefined }));
    this.markBusinessDirty();
  }
  onBusinessIcon(files: FileList | null): void {
    const f = files?.[0] ?? null;
    this.business.iconFile = f;
    this.businessErrors.update((e) => ({ ...e, icon: f && f.size > 2 * 1024 * 1024 ? 'App icon must be 2 MB or smaller.' : undefined }));
    this.markBusinessDirty();
  }

  resetBusiness(): void { this.loadGeneral(); }

  private validateBusiness(): boolean {
    const errs: ReturnType<typeof this.businessErrors> = {};
    const b = this.business;
    if (!b.business_name.trim()) errs.business_name = 'Business name is required.';
    else if (b.business_name.length > 200) errs.business_name = 'Maximum 200 characters.';
    if (b.business_address.length > 500) errs.business_address = 'Maximum 500 characters.';
    if (b.business_phone.length > 32) errs.business_phone = 'Maximum 32 characters.';
    this.businessErrors.set(errs);
    // Contact email is optional but must be valid when present (inline field hint).
    return Object.keys(errs).length === 0 && !this.emailInvalid(b.contact_email);
  }

  saveGeneral(ev: Event): void {
    ev.preventDefault();
    const s = this.state.selectedSite(); if (!s) return;
    if (!this.validateBusiness()) return;
    this.savingBusiness.set(true);
    // Contact email persists to ai-settings, MIRRORED to reply_email so the
    // contact-form router (which reads reply_email) uses the same address —
    // one email field, not two.
    const email = this.business.contact_email.trim() || null;
    const payload: Record<string, unknown> = {
      business_name: this.business.business_name.trim(),
      business_address: this.business.business_address.trim() || null,
      business_phone: this.business.business_phone.trim() || null,
    };
    this.api.updateSite(s.id, payload as Partial<typeof s>).subscribe({
      next: () => {
        this.api.put(`/sites/${s.id}/ai-settings`, { contact_email: email, reply_email: email }).subscribe({
          next: () => {
            // Brand assets upload via the existing context-upload route.
            const uploads: Promise<void>[] = [];
            if (this.business.logoFile) uploads.push(this.uploadBrandAsset(s.id, 'logo', this.business.logoFile));
            if (this.business.iconFile) uploads.push(this.uploadBrandAsset(s.id, 'app_icon', this.business.iconFile));
            Promise.all(uploads).finally(() => {
              this.savingBusiness.set(false);
              this.toast.success('Saved');
              this.state.loadData();
              this.businessSnapshot = JSON.stringify({ ...this.business, logoFile: null, iconFile: null });
              this.business.logoFile = null;
              this.business.iconFile = null;
              this.businessDirty.set(false);
            });
          },
          error: () => { this.savingBusiness.set(false); /* api.service already toasted */ },
        });
      },
      error: () => { this.savingBusiness.set(false); /* api.service already toasted */ },
    });
  }

  private uploadBrandAsset(siteId: string, kind: 'logo' | 'app_icon', file: File): Promise<void> {
    return new Promise((resolve) => {
      const form = new FormData(); form.append('file', file); form.append('kind', kind);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/sites/${siteId}/ai/context/upload`, true);
      // Token SSOT (same drift as uploadKnowledgeFiles) — `session_token` was never written.
      const token = this.auth.getToken();
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      // Bound the wait so a hung upload can't leave the caller's `await` pending forever.
      xhr.timeout = 60000;
      const settle = () => {
        this.inFlightUploads.delete(xhr);
        resolve();
      };
      xhr.onload = settle;
      xhr.onerror = settle;
      xhr.ontimeout = settle;
      this.inFlightUploads.add(xhr);
      xhr.send(form);
    });
  }

  // Theme picker moved to /admin/user (user-level, not per-project).
  security: { session_hours: number; idle_minutes: number; allowed_domains: string; require_2fa: boolean } = { session_hours: 168, idle_minutes: 60, allowed_domains: '', require_2fa: false };
  members = signal<Member[]>([]);
  invites = signal<Invite[]>([]);
  invite: { email: string; role: string } = { email: '', role: 'editor' };

  providers = PROVIDERS;
  connections = signal<Conn[]>([]);
  /** Project-wide (org-scope) AI env vars, surfaced READ-ONLY in the MCP tab so
   *  the owner sees what flows into MCP tool calls. Values are never fetched. */
  orgEnvVars = signal<{ key: string; exposed_to_ai: boolean }[]>([]);
  showAllOrgEnvVars = signal(false);
  /** First 8 unless expanded (the >8 toggle). */
  shownOrgEnvVars = computed(() => this.showAllOrgEnvVars() ? this.orgEnvVars() : this.orgEnvVars().slice(0, 8));
  /** Connection ids with an in-flight disconnect — guards the toast-armed action
   *  against a double-DELETE + drives the row's "Disconnecting…" state. */
  private readonly disconnectingIds = signal<ReadonlySet<string>>(new Set());
  isDisconnecting(id: string): boolean { return this.disconnectingIds().has(id); }
  pasteMode = signal<string | null>(null);
  pastedKey = '';
  /** In-flight guard for the paste-key connect POST (prevents double-submit). */
  readonly pasteSaving = signal(false);
  /** Tracks which connected MCPs have the custom-env-vars panel expanded. */
  mcpEnvVarsOpen = signal<Set<string>>(new Set());

  toggleMcpEnvVars(providerId: string): void {
    this.mcpEnvVarsOpen.update((set) => {
      const next = new Set(set);
      if (next.has(providerId)) next.delete(providerId); else next.add(providerId);
      return next;
    });
  }
  isMcpEnvVarsOpen(providerId: string): boolean {
    return this.mcpEnvVarsOpen().has(providerId);
  }

  ngOnInit(): void {
    const child = this.route.firstChild;
    const initial = (child?.snapshot.url[0]?.path ?? this.route.snapshot.fragment ?? 'general') as Tab;
    if (TABS.some((t) => t.id === initial)) this.tab.set(initial);
    // React to fragment-only navigations AFTER init, not just the initial snapshot. The
    // in-app cross-tab links (`routerLink="." [fragment]="'mcp'"` / `'env-vars'`, lines
    // ~374/403/424) change the URL fragment WITHOUT re-running ngOnInit, so a snapshot-only
    // read left them dead — the URL switched to #env-vars but the tab stayed put (confirmed
    // in a real browser, AL-044). This subscription switches the tab on any valid fragment
    // change; setTab's own fragment navigation re-emits harmlessly (guarded by tab()!==frag).
    this.route.fragment.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((frag) => {
      if (frag && this.tab() !== frag && TABS.some((t) => t.id === frag)) this.tab.set(frag as Tab);
    });
    this.loadGeneral();
    this.loadTeam();
    this.loadConnections();
    this.loadOrgEnvVars();
    this.handleMcpReturn();
  }

  setTab(id: Tab): void {
    this.tab.set(id);
    this.router.navigate([], { fragment: id, replaceUrl: true });
    // Lazy-load per-tab data on open.
    if (id === 'team') this.loadSecurity();
  }

  /**
   * Loads org-level 2FA-required flag. Other "security defaults" (session_hours,
   * idle_minutes, allowed_domains) were removed from the UI — backend keeps the
   * columns for forward-compat but the admin no longer surfaces them.
   */
  loadSecurity(): void {
    type Sec = { session_hours: number; idle_minutes: number; allowed_domains: string | null; require_2fa: number };
    this.api.get<{ data: Sec }>('/admin/security').subscribe({
      next: (r) => {
        if (!r.data) return;
        this.security = {
          ...this.security,
          require_2fa: !!r.data.require_2fa,
        };
      },
      error: () => { /* api.service already toasted */ },
    });
  }

  /**
   * 2FA toggle handler on the Team tab. Persists the new value immediately —
   * no separate "Save" button to match the spec ("just enable/disable").
   */
  toggleRequire2FA(ev: Event): void {
    const target = ev.target as HTMLInputElement;
    const next = target.checked;
    this.security = { ...this.security, require_2fa: next };
    this.savingSecurity.set(true);
    this.api.put('/admin/security', { ...this.security, require_2fa: next }).subscribe({
      next: () => {
        this.savingSecurity.set(false);
        this.toast.success(next ? 'Saved — 2FA now required for all members' : 'Saved — 2FA requirement disabled');
      },
      error: () => {
        this.savingSecurity.set(false);
        // Revert optimistic toggle on failure.
        this.security = { ...this.security, require_2fa: !next };
        target.checked = !next;
        /* api.service already toasted */
      },
    });
  }

  loadGeneral(): void {
    const s = this.state.selectedSite(); if (!s) return;
    // Business identity comes from the site record (synchronous); contact email +
    // chat come from ai-settings. contact_email falls back to the legacy reply_email
    // so existing rows keep their address after the two fields were merged into one.
    const identity = {
      business_name: s.business_name ?? '',
      business_address: s.business_address ?? '',
      business_phone: s.business_phone ?? '',
    };
    this.api.get<{ data: { contact_email?: string | null; reply_email?: string | null; chat_system_prompt?: string; chat_system_prompt_default?: string; allow_web_research?: boolean } }>(`/sites/${s.id}/ai-settings`).subscribe({
      next: (r) => {
        this.business = {
          contact_email: r.data?.contact_email ?? r.data?.reply_email ?? '',
          ...identity,
          logoFile: null,
          iconFile: null,
        };
        this.chat = {
          system_prompt: r.data?.chat_system_prompt ?? '',
          system_prompt_default: r.data?.chat_system_prompt_default ?? '',
        };
        this.allowWebResearch.set(!!r.data?.allow_web_research);
        this.businessSnapshot = JSON.stringify({ ...this.business, logoFile: null, iconFile: null });
        this.businessDirty.set(false);
        this.businessErrors.set({});
      },
      error: () => {
        // Still surface identity from the site record if ai-settings fails.
        this.business = { contact_email: '', ...identity, logoFile: null, iconFile: null };
        this.businessSnapshot = JSON.stringify({ ...this.business, logoFile: null, iconFile: null });
        this.businessDirty.set(false);
      },
    });
  }
  /** Per-field: a non-empty value that isn't a valid email (blank = valid; the
   *  contact email is optional). Drives the inline hint + the Save-button gate. */
  emailInvalid(v: string | null | undefined): boolean {
    return !!v && v.trim() !== '' && !this.isValidEmail(v);
  }

  loadTeam(): void {
    this.loadingTeam.set(true);
    this.api.get<{ data: { members: Member[]; invites: Invite[] } }>('/team').subscribe({
      next: (r) => { this.members.set(r.data?.members ?? []); this.invites.set(r.data?.invites ?? []); this.loadingTeam.set(false); },
      error: () => { this.loadingTeam.set(false); /* api.service already toasted */ },
    });
  }
  /** Delegates to the SSOT email validator — a local regex here caused FE/BE parity drift. */
  private isValidEmail(raw: string): boolean {
    return isSharedValidEmail(raw);
  }

  /** True when the invite field holds a non-empty value that isn't a valid email — drives the inline hint + button gate. */
  inviteEmailInvalid(): boolean {
    return this.invite.email.trim() !== '' && !this.isValidEmail(this.invite.email);
  }

  sendInvite(): void {
    // Validate before the POST — a typo'd address otherwise round-trips to a
    // generic server error (the CRUD "real validation + useful errors" bar).
    if (!this.isValidEmail(this.invite.email)) {
      this.toast.error('Enter a valid email address to invite.');
      return;
    }
    this.api.post('/team/invites', this.invite).subscribe({
      next: () => { this.toast.success(`Saved — invited ${this.invite.email}`); this.invite = { email: '', role: 'editor' }; this.inviting.set(false); this.loadTeam(); },
      error: () => { /* api.service already toasted */ },
    });
  }
  async revokeInvite(i: Invite): Promise<void> {
    const ok = await this.confirmSvc.confirm({
      title: 'Revoke invite',
      message: `Revoke the invite for ${i.email}? Their invite link stops working immediately — you can re-invite them later.`,
      confirmLabel: 'Revoke invite',
      danger: true,
    });
    if (!ok) return;
    this.api.delete(`/team/invites/${i.id}`).subscribe({
      next: () => { this.toast.success('Invite revoked'); this.loadTeam(); },
      error: () => { /* api.service already toasted */ },
    });
  }
  /** Transfer org ownership to a member (server enforces owner-only via #8 guard). */
  async makeOwner(m: Member): Promise<void> {
    if (m.role === 'owner') return;
    const ok = await this.confirmSvc.confirm({
      title: 'Transfer ownership',
      message: `Make ${m.email} the owner of this organization? You'll step down to admin. They can transfer it back.`,
      confirmLabel: 'Transfer ownership',
    });
    if (!ok) return;
    this.api.post('/team/transfer-ownership', { targetUserId: m.id }).subscribe({
      next: () => {
        this.toast.success(`Ownership transferred to ${m.email}`);
        this.loadTeam();
      },
      error: () => {
        /* api.service already toasts */
      },
    });
  }
  async removeMember(m: Member): Promise<void> {
    if (this.isLastOwner(m)) {
      this.toast.error('Cannot remove the last owner. Promote another member to owner first.');
      return;
    }
    const ok = await this.confirmSvc.confirm({
      title: 'Remove member',
      message: `Remove ${m.email} from this organization? They lose access immediately.`,
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    this.api.delete(`/team/members/${m.id}`).subscribe({
      next: () => { this.toast.success('Member removed'); this.loadTeam(); },
      error: () => { /* api.service already toasted */ },
    });
  }
  isLastOwner(m: Member): boolean {
    if (m.role !== 'owner') return false;
    return this.members().filter((x) => x.role === 'owner').length <= 1;
  }

  // ── MCP ──
  /** Read-only fetch of the project's org-scope AI vars for the MCP-tab callout. */
  loadOrgEnvVars(): void {
    this.api.get<{ vars: { key: string; exposed_to_ai: boolean }[] }>('/env-vars', { scope: 'org' }).subscribe({
      next: (r) => this.orgEnvVars.set((r.vars ?? []).map((v) => ({ key: v.key, exposed_to_ai: !!v.exposed_to_ai }))),
      error: () => { /* api.service already toasted; leave empty → calm empty state */ },
    });
  }

  loadConnections(): void {
    const s = this.state.selectedSite(); if (!s) return;
    this.loadingConnections.set(true);
    this.api.get<{ data: { connections: Conn[] } }>(`/sites/${s.id}/mcp/connections`).subscribe({
      next: (r) => { this.connections.set(r.data?.connections ?? []); this.loadingConnections.set(false); },
      error: () => { this.loadingConnections.set(false); /* api.service already toasted */ },
    });
  }
  isConnected(provider: string): Conn | null {
    return this.connections().find((c) => c.provider === provider) ?? null;
  }
  pastePlaceholder(provider: string): string {
    switch (provider) {
      case 'resend': return 're_xxx';
      case 'slack': return 'xoxb-xxx (Slack bot token)';
      case 'notion': return 'secret_xxx (Notion integration token)';
      case 'github': return 'ghp_xxx (fine-grained PAT)';
      case 'linear': return 'lin_api_xxx';
      case 'discord': return 'https://discord.com/api/webhooks/…';
      case 'google_calendar': return 'ya29.xxx (OAuth access token)';
      case 'twilio': return 'ACxxxx:yourAuthToken';
      case 'calendly': return 'eyJ… (personal access token)';
      case 'airtable': return 'patxxx';
      case 'zapier': return 'https://hooks.zapier.com/…';
      default: return 'paste API key';
    }
  }
  connect(p: { id: string; needsOauth: boolean }): void {
    const s = this.state.selectedSite(); if (!s) return;
    // This button is only rendered for NON-OAuth providers (paste-key). OAuth
    // providers use connectOauth(). Always open the inline paste-key form.
    this.pasteMode.set(p.id);
  }
  /**
   * Kick off the OAuth dance for `providerId` in a popup window.
   *
   * @remarks
   * The `/api/mcp/:provider/connect` route is BEARER-AUTH-GATED, so a cookie
   * `fetch` or a `window.open` browser navigation can't authenticate — that was
   * the `{"error":{"message":"auth required"}}` 401. We fetch the authorize URL
   * WITH the bearer (ApiService injects it), then open the popup at the
   * provider's authorize page. The route returns:
   *   - `{ data: { mode: 'oauth', authorize_url } }` (happy path), OR
   *   - `{ data: { mode: 'paste_key', … } }` for paste-only adapters, OR
   *   - 501 `{ error: 'oauth_not_configured' }` when the worker has no
   *     `{PROVIDER}_OAUTH_CLIENT_ID` secret yet.
   *
   * 501 / paste_key drop into the inline paste-key flow so the user is never
   * stuck. Connection success comes back via the popup → worker callback
   * (handled by {@link handleMcpReturn}); a popup close reloads the list.
   */
  connectOauth(providerId: string): void {
    const s = this.state.selectedSite(); if (!s) { this.toast.error('Select a site first'); return; }
    const label = MCP_PROVIDERS.find((p) => p.id === providerId)?.label ?? providerId;
    this.api
      .get<{ data?: { mode?: string; authorize_url?: string } }>(
        `/mcp/${providerId}/connect`,
        { site_id: s.id, return_url: '/admin/settings#mcp' },
        { silent: true },
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          const authUrl = res?.data?.authorize_url;
          if (authUrl) {
            const popup = window.open(authUrl, 'mcp_oauth', 'width=560,height=720,menubar=no,toolbar=no');
            if (!popup) { this.toast.error('Popup blocked — allow pop-ups and try again.'); return; }
            // The worker callback posts `ps:mcp:connected` to this window then
            // self-closes. React to the message for an INSTANT live reload (the
            // provider flips to "Connected" without a manual refresh); the
            // popup-closed poll is a belt-and-suspenders fallback.
            let settled = false;
            let interval = 0;
            const finish = (announce: boolean): void => {
              if (settled) return;
              settled = true;
              window.clearInterval(interval);
              window.removeEventListener('message', onMessage);
              this.loadConnections();
              if (announce) this.toast.success(`${label} connected`);
            };
            const onMessage = (ev: MessageEvent): void => {
              if (ev.origin !== window.location.origin) return;
              const d = ev.data as { type?: string; provider?: string } | null;
              if (d && d.type === 'ps:mcp:connected' && d.provider === providerId) {
                try { popup.close(); } catch { /* cross-origin close guard */ }
                finish(true);
              }
            };
            window.addEventListener('message', onMessage);
            interval = window.setInterval(() => {
              if (popup.closed) finish(false);
            }, 600);
            // Safety: never leak the listener if the flow is abandoned.
            window.setTimeout(() => {
              if (!settled) { settled = true; window.clearInterval(interval); window.removeEventListener('message', onMessage); }
            }, 600000);
            // Route-nav teardown: same SILENT cleanup as abandonment (no
            // loadConnections on a destroyed component). Safe to register here
            // because takeUntilDestroyed above guarantees this `next` ran
            // before the component was destroyed.
            this.destroyRef.onDestroy(() => {
              if (!settled) { settled = true; window.clearInterval(interval); window.removeEventListener('message', onMessage); }
            });
            return;
          }
          // Adapter has no OAuth → inline paste-key form.
          if (res?.data?.mode === 'paste_key') { this.pasteMode.set(providerId); return; }
          this.toast.error(`Couldn't start ${label} sign-in — try again.`);
        },
        error: (err: { status?: number; error?: { error?: string } }) => {
          if (err?.status === 501 || err?.error?.error === 'oauth_not_configured') {
            this.toast.info(`OAuth flow for ${label} will land soon — using API key fallback for now.`);
            this.pasteMode.set(providerId);
            return;
          }
          this.toast.error(`Couldn't start ${label} sign-in — try again.`);
        },
      });
  }
  /**
   * Heuristic for whether a saved connection came via OAuth vs paste-key.
   * The worker tags paste-key rows with `display_name = '{provider} (pasted key)'`,
   * everything else is treated as OAuth.
   */
  isOauthConnection(c: Conn): boolean {
    return !/pasted key/i.test(c.display_name ?? '');
  }
  submitPaste(provider: string): void {
    const s = this.state.selectedSite(); if (!s) return;
    if (this.pasteSaving()) return; // guard: no duplicate connect POST while one is in flight
    this.pasteSaving.set(true);
    this.api.post(`/mcp/${provider}/paste?site_id=${s.id}`, { api_key: this.pastedKey }).subscribe({
      next: () => { this.pastedKey = ''; this.pasteMode.set(null); this.pasteSaving.set(false); this.toast.success(`Saved — ${provider} connected`); this.loadConnections(); },
      error: () => { this.pasteSaving.set(false); /* api.service already toasted */ },
    });
  }
  disconnect(c: Conn): void {
    const s = this.state.selectedSite(); if (!s) return;
    // Action-armed toast confirmation (cockpit pattern — avoids native confirm()
    // z-stack/focus break; consistent with mcp/disconnect).
    this.toast.warning(`Disconnect ${c.provider}? The integration will be removed.`, {
      action: { label: 'Disconnect', run: () => this.performDisconnect(c, s.id) },
      duration: 7000,
    });
  }
  private performDisconnect(c: Conn, siteId: string): void {
    if (this.disconnectingIds().has(c.id)) return; // re-armed toast action while in flight = no-op
    this.disconnectingIds.update((s) => new Set(s).add(c.id));
    const done = () => this.disconnectingIds.update((s) => { const n = new Set(s); n.delete(c.id); return n; });
    this.api.delete(`/sites/${siteId}/mcp/connections/${c.id}`).subscribe({
      next: () => { done(); this.toast.success('Disconnected'); this.loadConnections(); },
      error: () => { done(); /* api.service already toasted */ },
    });
  }
  handleMcpReturn(): void {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('connected');
    if (connected) {
      this.toast.success(`${connected} connected`);
      history.replaceState({}, '', '/admin/settings#mcp');
      this.tab.set('mcp');
      setTimeout(() => this.loadConnections(), 200);
    }
  }

  // API keys moved to /admin/user. Domain management moved to /admin/domains.
  // Export / transfer-ownership / delete-org flows removed with the Danger Zone.

  // ── Security defaults (only 2FA toggle is surfaced — see toggleRequire2FA above) ──
  savingSecurity = signal(false);

  // ── AI Chat: Improve system prompt + MCP allow-list ──
  improvingField = signal<'system' | null>(null);
  chatMcps = signal<string[]>(((): string[] => {
    try { return JSON.parse(localStorage.getItem('ps_chat_mcps') ?? '[]'); } catch { return []; }
  })());
  toggleChatMcp(provider: string): void {
    const cur = this.chatMcps();
    const next = cur.includes(provider) ? cur.filter((p) => p !== provider) : [...cur, provider];
    this.chatMcps.set(next);
    try { localStorage.setItem('ps_chat_mcps', JSON.stringify(next)); } catch { /* */ }
  }
  /**
   * "Improve with AI" — an empty system-prompt field loads the v2 best-prompt
   * default for free (no AI credits) as a ready-to-edit starting point, while a
   * non-empty field calls the worker AI to rewrite it.
   */
  improveChatField(field: 'system'): void {
    const s = this.state.selectedSite();
    if (!s) { this.toast.error('Select a site first'); return; }
    const value = this.chat.system_prompt;
    const trimmed = (value ?? '').trim();

    // Shortcut: empty system prompt + v2 default available → seed it locally.
    // Saves an AI round-trip and shows the user the canonical starting point.
    if (trimmed.length === 0 && this.chat.system_prompt_default?.trim()) {
      this.chat.system_prompt = this.chat.system_prompt_default;
      this.toast.success('Loaded v2 best-prompt default — review + save');
      return;
    }

    this.improvingField.set(field);
    this.api.post<{ data: { improved: string; original: string } }>(
      `/sites/${s.id}/ai-settings/improve`,
      { field, value },
    ).subscribe({
      next: (r) => {
        this.improvingField.set(null);
        const improved = r.data?.improved?.trim();
        if (!improved) { this.toast.info('No improvement suggested'); return; }
        this.chat.system_prompt = improved;
        this.toast.success('Improved with AI — review + save');
      },
      error: () => { this.improvingField.set(null); /* api.service already toasted */ },
    });
  }

  // Transfer-ownership flow removed with the Danger Zone.
}
