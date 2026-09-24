/**
 * Streaming AI agent message renderer — markdown + tool chips + citations
 * + suggested-action chips, designed to plug straight into the admin AI
 * chat dock as the per-message surface.
 *
 * @remarks
 * - Inputs are signal-based via the `input()` API so the host can stream
 *   tokens by mutating the same writable signal — every re-render flows
 *   through `OnPush` change detection cheaply because the heavy lift
 *   (markdown parse + sanitize) is memoized in a `computed()`.
 * - Markdown is pre-processed BEFORE `marked` so two project-specific
 *   sigils survive sanitization:
 *     1. `<tool name="X" args={...} />` → `<span class="agent-tool-chip"
 *        data-tool="X">⚙ X</span>` (preserved through DOMPurify via an
 *        allowlist on `span[class][data-tool]`)
 *     2. `[N]` inline (when `N` matches a citation id) →
 *        `<sup class="agent-citation" data-cite="N">[N]</sup>`
 * - Sanitized HTML is bound through `bypassSecurityTrustHtml` from
 *   `DomSanitizer` — DOMPurify is the actual safety boundary; the
 *   sanitizer bypass is purely to let Angular emit the parsed nodes.
 * - Click delegation is one document-level handler on the host element
 *   so streaming re-renders don't have to re-attach listeners per chip.
 *   Citations open a `<dialog>` (with `<details>` graceful fallback for
 *   browsers without `HTMLDialogElement.showModal`). Tool chips emit
 *   `toolClick`. Suggested-action chips emit `actionClick`.
 * - Code fences keep their `language-X` class so an app-level Prism /
 *   Shiki pass can highlight them post-mount.
 * - Citation typography follows `[[text-contrast]]` + `[[citations]]`:
 *   `font-size: 0.65em; top: -0.4em; line-height: 0;` so the `<sup>`
 *   sits on the same baseline as the value it qualifies.
 * - Honors `prefers-reduced-motion` — the streaming caret stops blinking.
 *
 * @example
 * ```html
 * <app-agent-message
 *   [markdown]="message().content"
 *   [citations]="message().citations"
 *   [tools]="message().tools"
 *   [suggestedActions]="message().suggestions"
 *   [streaming]="message().id === streamingId()"
 *   (toolClick)="onToolClick($event)"
 *   (actionClick)="onActionClick($event)"
 * />
 * ```
 */
import { ChangeDetectionStrategy, Component, computed, ElementRef, HostListener, inject, input, output, signal, ViewChild } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { hardenExternalLinks } from './harden-links';

/** A resolved citation surfaced to the popover when a marker is clicked. */
export interface AgentCitation {
  /** Numeric id that maps to the `[N]` marker inside the markdown body. */
  id: number;
  /** Outbound URL the popover deep-links to. */
  url: string;
  /** Human-readable title rendered as the popover headline. */
  title: string;
}

/** A tool-call indicator rendered as a chip row above the message body. */
export interface AgentTool {
  /** Tool name (e.g. `search_docs`, `read_file`). Echoed in the chip glyph. */
  name: string;
  /** Lifecycle of the call — drives the chip color (pending=amber, ok=cyan, error=red). */
  status: 'pending' | 'ok' | 'error';
  /** Optional truncated args preview used as the chip title attr / tooltip. */
  argsPreview?: string;
}

/** A suggested follow-up action surfaced as a chip beneath the message. */
export interface AgentSuggestedAction {
  /** Visible chip label. */
  label: string;
  /** Opaque action token emitted via `actionClick` when the chip is pressed. */
  action: string;
}

const TOOL_TAG_REGEX = /<tool\s+name="([^"]+)"(?:\s+args=(\{[^}]*\}))?\s*\/>/g;
const CITATION_REGEX = /\[(\d+)\]/g;

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-agent-message',
  standalone: true,
  styles: [
    `
      :host {
        display: block;
        font: inherit;
        color: var(--ps-ink, #f4f4ff);
        line-height: 1.55;
      }
      .am-tools {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-bottom: 8px;
      }
      .am-tool {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 3px 9px 3px 7px;
        font-family: var(--ps-font-mono, 'JetBrains Mono', ui-monospace, monospace);
        font-size: 0.7rem;
        font-weight: 500;
        letter-spacing: 0.02em;
        color: var(--ps-ink, #f4f4ff);
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 8%, transparent);
        border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 22%, transparent);
        border-radius: 6px;
        cursor: pointer;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
        transition: border-color 0.14s, background 0.14s, transform 0.14s;
      }
      .am-tool:hover {
        border-color: color-mix(in oklch, var(--ps-accent, #00e5ff) 45%, transparent);
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 14%, transparent);
        transform: translateY(-1px);
      }
      .am-tool:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
      }
      .am-tool-glyph {
        font-size: 0.78rem;
        line-height: 1;
        color: var(--ps-accent, #00e5ff);
      }
      .am-tool--pending {
        color: #f59e0b;
        background: color-mix(in oklch, #f59e0b 10%, transparent);
        border-color: color-mix(in oklch, #f59e0b 32%, transparent);
      }
      .am-tool--pending .am-tool-glyph { color: #f59e0b; animation: am-spin 1.4s linear infinite; }
      .am-tool--ok {
        color: color-mix(in oklch, var(--ps-accent, #00e5ff) 75%, var(--ps-ink, #f4f4ff) 25%);
      }
      .am-tool--error {
        color: #f87171;
        background: color-mix(in oklch, #f87171 10%, transparent);
        border-color: color-mix(in oklch, #f87171 32%, transparent);
      }
      .am-tool--error .am-tool-glyph { color: #f87171; }
      @keyframes am-spin {
        to { transform: rotate(360deg); }
      }
      .am-body {
        font-size: 0.92rem;
        line-height: 1.55;
        word-wrap: break-word;
        overflow-wrap: anywhere;
      }
      .am-body :first-child { margin-top: 0; }
      .am-body :last-child { margin-bottom: 0; }
      .am-body p { margin: 0 0 10px; }
      .am-body h1, .am-body h2, .am-body h3, .am-body h4 {
        margin: 18px 0 8px;
        font-weight: 600;
        line-height: 1.25;
        color: var(--ps-ink, #f4f4ff);
      }
      .am-body h1 { font-size: 1.25rem; }
      .am-body h2 { font-size: 1.1rem; }
      .am-body h3 { font-size: 1rem; }
      .am-body h4 { font-size: 0.92rem; }
      .am-body ul, .am-body ol { margin: 0 0 10px; padding-left: 20px; }
      .am-body li { margin: 2px 0; }
      .am-body a {
        color: var(--ps-accent, #00e5ff);
        text-decoration: underline;
        text-decoration-color: color-mix(in oklch, var(--ps-accent, #00e5ff) 45%, transparent);
        text-underline-offset: 2px;
      }
      .am-body a:hover { text-decoration-color: var(--ps-accent, #00e5ff); }
      .am-body strong { font-weight: 600; color: var(--ps-ink, #f4f4ff); }
      .am-body em { font-style: italic; }
      .am-body blockquote {
        margin: 8px 0;
        padding: 4px 12px;
        border-left: 2px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 40%, transparent);
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 80%, transparent);
        font-style: italic;
      }
      .am-body code {
        font-family: var(--ps-font-mono, 'JetBrains Mono', ui-monospace, monospace);
        font-size: 0.86em;
        padding: 1px 5px;
        border-radius: 4px;
        background: rgba(0, 0, 0, 0.32);
        color: color-mix(in oklch, var(--ps-accent, #00e5ff) 80%, var(--ps-ink, #f4f4ff) 20%);
        border: 1px solid rgba(255, 255, 255, 0.06);
      }
      .am-body pre {
        margin: 10px 0;
        padding: 12px 14px;
        background: rgba(0, 0, 0, 0.42);
        border: 1px solid rgba(255, 255, 255, 0.06);
        border-radius: 8px;
        overflow-x: auto;
        font-family: var(--ps-font-mono, 'JetBrains Mono', ui-monospace, monospace);
        font-size: 0.82rem;
        line-height: 1.5;
      }
      .am-body pre code {
        background: transparent;
        border: none;
        padding: 0;
        color: var(--ps-ink, #f4f4ff);
        font-size: inherit;
      }
      .am-body table {
        border-collapse: collapse;
        margin: 10px 0;
        font-size: 0.86rem;
      }
      .am-body th, .am-body td {
        padding: 6px 10px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        text-align: left;
      }
      .am-body th { background: rgba(255, 255, 255, 0.04); font-weight: 600; }
      .am-body hr {
        border: none;
        border-top: 1px solid rgba(255, 255, 255, 0.08);
        margin: 14px 0;
      }
      /* Tool chips embedded inline via the pre-processor ([innerHTML]) → ::ng-deep
         to pierce encapsulation; :global() is a CSS-Modules construct that Angular
         leaves invalid, and a plain .am-body .agent-tool-chip can't reach innerHTML. */
      :host ::ng-deep .am-body .agent-tool-chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 1px 7px;
        margin: 0 2px;
        font-family: var(--ps-font-mono, 'JetBrains Mono', ui-monospace, monospace);
        font-size: 0.75em;
        font-weight: 500;
        color: var(--ps-accent, #00e5ff);
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 10%, transparent);
        border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 26%, transparent);
        border-radius: 5px;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
        cursor: pointer;
        vertical-align: baseline;
        transition: background 0.14s, border-color 0.14s;
      }
      .am-body .agent-tool-chip:hover {
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 18%, transparent);
        border-color: var(--ps-accent, #00e5ff);
      }
      /* Citation superscripts — per [[text-contrast]] + [[citations]] spec. */
      .am-body .agent-citation {
        display: inline-flex;
        align-items: baseline;
        font-size: 0.65em;
        line-height: 0;
        position: relative;
        top: -0.4em;
        margin: 0 1px;
        padding: 0 4px;
        font-weight: 600;
        color: var(--ps-accent, #00e5ff);
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 12%, transparent);
        border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 28%, transparent);
        border-radius: 4px;
        cursor: pointer;
        text-decoration: none;
        font-variant-numeric: tabular-nums;
        transition: background 0.14s, border-color 0.14s;
      }
      .am-body .agent-citation:hover {
        background: color-mix(in oklch, var(--ps-accent, #00e5ff) 22%, transparent);
        border-color: var(--ps-accent, #00e5ff);
      }
      .am-body .agent-citation:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 1px;
      }
      /* Streaming caret. */
      .am-caret {
        display: inline-block;
        width: 6px;
        height: 0.95em;
        margin-left: 2px;
        vertical-align: -2px;
        background: var(--ps-accent, #00e5ff);
        box-shadow: 0 0 8px color-mix(in oklch, var(--ps-accent, #00e5ff) 70%, transparent);
        border-radius: 1px;
        animation: am-blink 1s steps(2, end) infinite;
        transform: translateZ(0);
      }
      @keyframes am-blink {
        50% { opacity: 0; }
      }
      /* Suggested-action chip row. */
      .am-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 12px;
      }
      .am-action {
        padding: 5px 12px;
        font-size: 0.78rem;
        font-weight: 500;
        color: var(--ps-ink, #f4f4ff);
        background: linear-gradient(
          135deg,
          color-mix(in oklch, var(--ps-accent, #00e5ff) 12%, transparent),
          color-mix(in oklch, var(--ps-accent-secondary, #7c3aed) 12%, transparent)
        );
        border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 28%, transparent);
        border-radius: 999px;
        cursor: pointer;
        transition: border-color 0.14s, transform 0.14s, box-shadow 0.14s;
      }
      .am-action:hover {
        border-color: var(--ps-accent, #00e5ff);
        transform: translateY(-1px);
        box-shadow: 0 6px 16px -8px color-mix(in oklch, var(--ps-accent, #00e5ff) 55%, transparent);
      }
      .am-action:focus-visible {
        outline: 2px solid var(--ps-accent, #00e5ff);
        outline-offset: 2px;
      }
      /* Citation popover — <dialog> with <details> graceful fallback. */
      .am-popover {
        position: fixed;
        margin: 0;
        padding: 14px 16px;
        max-width: 360px;
        width: min(360px, calc(100vw - 32px));
        color: var(--ps-ink, #f4f4ff);
        background: color-mix(in oklch, var(--ps-bg, #060610) 78%, transparent);
        backdrop-filter: blur(20px) saturate(140%);
        -webkit-backdrop-filter: blur(20px) saturate(140%);
        border: 1px solid color-mix(in oklch, var(--ps-accent, #00e5ff) 22%, transparent);
        border-radius: var(--ps-radius-xl, 22px);
        box-shadow: var(
          --ps-shadow-modal,
          0 24px 64px rgba(0, 0, 0, 0.55),
          0 0 80px rgba(0, 229, 255, 0.06)
        );
        font: inherit;
      }
      .am-popover::backdrop {
        background: rgba(6, 6, 16, 0.42);
      }
      .am-popover-title {
        display: flex;
        align-items: baseline;
        gap: 6px;
        margin: 0 0 6px;
        font-size: 0.86rem;
        font-weight: 600;
        line-height: 1.35;
      }
      .am-popover-tag {
        font-family: var(--ps-font-mono, 'JetBrains Mono', ui-monospace, monospace);
        font-size: 0.66rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        color: var(--ps-accent, #00e5ff);
      }
      .am-popover-url {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        margin-top: 4px;
        font-family: var(--ps-font-mono, 'JetBrains Mono', ui-monospace, monospace);
        font-size: 0.74rem;
        color: var(--ps-accent, #00e5ff);
        text-decoration: none;
        word-break: break-all;
      }
      .am-popover-url:hover { text-decoration: underline; }
      .am-popover-close {
        position: absolute;
        top: 8px;
        right: 8px;
        width: 24px;
        height: 24px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        border: none;
        color: color-mix(in oklch, var(--ps-ink, #f4f4ff) 60%, transparent);
        cursor: pointer;
        border-radius: 4px;
        transition: background 0.14s, color 0.14s;
      }
      .am-popover-close:hover {
        color: var(--ps-ink, #f4f4ff);
        background: rgba(255, 255, 255, 0.05);
      }
      @media (prefers-reduced-motion: reduce) {
        .am-caret { animation: none; opacity: 1; }
        .am-tool--pending .am-tool-glyph { animation: none; }
        .am-tool:hover, .am-action:hover { transform: none; }
      }
    `,
  ],
  template: `
    @if (tools().length > 0) {
      <div class="am-tools" role="list" aria-label="Tool calls">
        @for (t of tools(); track t.name + $index) {
          <button
            type="button"
            role="listitem"
            class="am-tool"
            [class.am-tool--pending]="t.status === 'pending'"
            [class.am-tool--ok]="t.status === 'ok'"
            [class.am-tool--error]="t.status === 'error'"
            [attr.data-tool]="t.name"
            [attr.title]="t.argsPreview || t.name"
            [attr.aria-label]="'Tool ' + t.name + ': ' + t.status"
            (click)="onToolChipClick(t.name)"
          >
            <span class="am-tool-glyph" aria-hidden="true">
              @if (t.status === 'pending') { ◐ }
              @else if (t.status === 'ok') { ⚙ }
              @else { ⚠ }
            </span>
            <span>{{ t.name }}</span>
          </button>
        }
      </div>
    }

    <div #body class="am-body" [innerHTML]="renderedHtml()"></div>

    @if (suggestedActions().length > 0) {
      <div class="am-actions" role="list" aria-label="Suggested actions">
        @for (a of suggestedActions(); track a.action) {
          <button
            type="button"
            role="listitem"
            class="am-action"
            (click)="actionClick.emit(a.action)"
          >
            {{ a.label }}
          </button>
        }
      </div>
    }

    @if (activeCitation(); as c) {
      <dialog
        #popover
        class="am-popover"
        role="dialog"
        [attr.aria-label]="'Citation ' + c.id + ': ' + c.title"
        (click)="onPopoverBackdropClick($event)"
        (close)="activeCitation.set(null)"
      >
        <button
          type="button"
          class="am-popover-close"
          aria-label="Close citation"
          (click)="closePopover()"
        >
          ✕
        </button>
        <div class="am-popover-title">
          <span class="am-popover-tag">[{{ c.id }}]</span>
          <span>{{ c.title }}</span>
        </div>
        <a
          class="am-popover-url"
          [href]="c.url"
          target="_blank"
          rel="noopener noreferrer"
        >
          {{ c.url }}
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
            <polyline points="15 3 21 3 21 9"/>
            <line x1="10" y1="14" x2="21" y2="3"/>
          </svg>
        </a>
      </dialog>
    }
  `,
})
export class AgentMessageComponent {
  private sanitizer = inject(DomSanitizer);
  private host = inject(ElementRef<HTMLElement>);

  /** Streaming raw markdown — re-render fires on every mutation. */
  readonly markdown = input<string>('');
  /** Citation registry — `[N]` markers only render as superscripts when an id matches. */
  readonly citations = input<AgentCitation[]>([]);
  /** Tool-call chips rendered above the message body. */
  readonly tools = input<AgentTool[]>([]);
  /** Suggested follow-up actions rendered as chip row beneath the message. */
  readonly suggestedActions = input<AgentSuggestedAction[]>([]);
  /** When true, a blinking caret is appended to the rendered body. */
  readonly streaming = input<boolean>(false);

  /** Emits the tool name when a tool chip (header or inline) is clicked. */
  readonly toolClick = output<string>();
  /** Emits the opaque action token when a suggested-action chip is clicked. */
  readonly actionClick = output<string>();

  /** Currently-open citation in the popover (null when closed). */
  readonly activeCitation = signal<AgentCitation | null>(null);

  @ViewChild('popover') private popoverEl?: ElementRef<HTMLDialogElement>;

  /**
   * Memoized render pipeline:
   *   raw → pre-process sigils → marked → DOMPurify → bypass → SafeHtml.
   * Streaming caret appended last so it sits outside sanitized output.
   */
  readonly renderedHtml = computed<SafeHtml>(() => {
    const raw = this.markdown() ?? '';
    const citeIds = new Set(this.citations().map((c) => c.id));
    const preprocessed = this.preprocess(raw, citeIds);

    // marked v12+ sync mode — async: false guarantees a string return.
    const parsed = marked.parse(preprocessed, { async: false, breaks: true, gfm: true }) as string;

    const cleaned = DOMPurify.sanitize(parsed, {
      ADD_ATTR: ['data-tool', 'data-cite', 'class'],
      ADD_TAGS: ['sup', 'span'],
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|ftp):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
    });

    // Open external cited links in a new tab (don't navigate the admin SPA away
    // + lose the chat) with a reverse-tabnabbing guard. Static attrs on the
    // already-sanitized string — no injection vector.
    const hardened = hardenExternalLinks(cleaned);
    const withCaret = this.streaming() ? `${hardened}<span class="am-caret" aria-hidden="true"></span>` : hardened;
    return this.sanitizer.bypassSecurityTrustHtml(withCaret);
  });

  // ---------- Pre-processor ----------

  /**
   * Convert project-specific sigils into HTML that survives DOMPurify:
   *   - `<tool name="X" args={...} />`  → tool chip span
   *   - `[N]` (when N is a known citation id) → `<sup>` marker
   * Anything else flows through untouched so marked + sanitizer handle it.
   */
  private preprocess(raw: string, citeIds: Set<number>): string {
    let out = raw.replace(TOOL_TAG_REGEX, (_match, name: string, args?: string) => {
      const safeName = this.escapeAttr(name);
      const argsAttr = args ? ` title="${this.escapeAttr(args)}"` : '';
      return `<span class="agent-tool-chip" data-tool="${safeName}"${argsAttr}>⚙ ${this.escapeText(name)}</span>`;
    });

    out = out.replace(CITATION_REGEX, (match, idStr: string) => {
      const id = Number(idStr);
      if (!citeIds.has(id)) return match;
      return `<sup class="agent-citation" data-cite="${id}" tabindex="0" role="button">[${id}]</sup>`;
    });

    return out;
  }

  private escapeAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private escapeText(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---------- Click delegation ----------

  /**
   * Single document-level handler so streaming re-renders don't have to
   * re-attach listeners per chip. Walks up from the click target to find
   * the nearest `.agent-citation` or `.agent-tool-chip`.
   */
  @HostListener('click', ['$event'])
  onHostClick(ev: MouseEvent): void {
    const target = ev.target as HTMLElement | null;
    if (!target) return;

    const cite = target.closest('.agent-citation') as HTMLElement | null;
    if (cite) {
      const id = Number(cite.dataset['cite']);
      const match = this.citations().find((c) => c.id === id);
      if (match) {
        ev.preventDefault();
        this.openCitation(match);
      }
      return;
    }

    const tool = target.closest('.agent-tool-chip') as HTMLElement | null;
    if (tool) {
      const name = tool.dataset['tool'];
      if (name) {
        ev.preventDefault();
        this.toolClick.emit(name);
      }
    }
  }

  /** Keyboard-equivalent activation for the citation `<sup>` markers. */
  @HostListener('keydown', ['$event'])
  onHostKeydown(ev: KeyboardEvent): void {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const target = ev.target as HTMLElement | null;
    const cite = target?.closest('.agent-citation') as HTMLElement | null;
    if (!cite) return;
    const id = Number(cite.dataset['cite']);
    const match = this.citations().find((c) => c.id === id);
    if (match) {
      ev.preventDefault();
      this.openCitation(match);
    }
  }

  // ---------- Tool-chip header click ----------

  /**
   * Handler for the static chip row above the message body — forwards the
   * tool name through the `toolClick` output. The inline `<tool/>` sigils
   * flow through the host click delegate instead.
   */
  onToolChipClick(name: string): void {
    this.toolClick.emit(name);
  }

  // ---------- Citation popover ----------

  /** Set the active citation and open the `<dialog>` on the next animation frame. */
  private openCitation(c: AgentCitation): void {
    this.activeCitation.set(c);
    // Defer to next frame so the @if block has rendered the <dialog>.
    requestAnimationFrame(() => {
      const dlg = this.popoverEl?.nativeElement;
      if (!dlg) return;
      if (typeof dlg.showModal === 'function') {
        try {
          dlg.showModal();
        } catch {
          dlg.setAttribute('open', '');
        }
      } else {
        dlg.setAttribute('open', '');
      }
    });
  }

  /**
   * Close the citation popover. Uses native `<dialog>.close()` when available
   * so the browser handles `::backdrop` teardown, otherwise falls back to
   * clearing the active citation signal (the `@if` branch unmounts the node).
   */
  closePopover(): void {
    const dlg = this.popoverEl?.nativeElement;
    if (dlg?.open && typeof dlg.close === 'function') {
      dlg.close();
    } else {
      this.activeCitation.set(null);
    }
  }

  /**
   * Dismiss the popover when the user clicks the `::backdrop` (the dialog
   * element receives the event because the backdrop is its pseudo-element,
   * not a child node).
   */
  onPopoverBackdropClick(ev: MouseEvent): void {
    if (ev.target === this.popoverEl?.nativeElement) {
      this.closePopover();
    }
  }
}
