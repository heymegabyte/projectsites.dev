/**
 * site_edit_intent.ts — "Chat-to-edit your live site" decision core (feature flag `chat_to_edit`,
 * enabled=0, rollout=0, stage=experimental).
 *
 * Bleeding-edge source (BLEEDING-EDGE loop, 2026-09-21): Lovable / v0 "edit by chat" and MotionFlow
 * AI's conversational editing — plain-language edits like "Make the background darker" with no config,
 * no re-prompt. Sources: https://www.vibecodingacademy.ai/blog/best-ai-website-builder-2026 and
 * https://www.motionflow-ai.co/ . Our embarrassingly-easy version (per embarrassingly-easy-to-use +
 * ai-permanence): the OWNER types a plain-language change ("change my phone to …", "make the headline
 * say …", "swap the hero photo") and the AI proposes ONE typed, reviewable edit they CONFIRM — never a
 * settings panel. AI does the work; the owner confirms a diff.
 *
 * This module is the PURE, SAFE seam of that feature: a natural-language request → a typed
 * {@link EditIntent} resolved against an ALLOWLISTED editable-surface catalog (contract-first — an
 * edit can only ever target a surface the site actually exposes), with boundary-safe values (text is
 * treated as text, a color must be a real color token — user content is NEVER passed through into
 * unsafe HTML/CSS/selectors). A deterministic fast-path handles the common owner phrasings instantly +
 * for free (no LLM); {@link validateLlmEditIntent} is the safety net that validates an LLM's proposal
 * against the same catalog before anything is applied. The LLM call, the apply, and the live preview
 * are the wiring; the decision + safety layer is here, tested + deploy-independent. Pure — never throws.
 */

/** The kinds of edit the owner can request via chat. */
export type EditOp =
  | 'set_text'
  | 'set_color'
  | 'set_hours'
  | 'set_phone'
  | 'set_email'
  | 'swap_image'
  | 'toggle_section'
  | 'unknown';

/** One editable surface the site exposes (the allowlist an edit may target). */
export interface EditableSurface {
  /** Stable dotted key, e.g. `hero.headline`, `contact.phone`, `theme.accent`, `faq`. */
  key: string;
  /** The value kind held here — gates which op can target it + how the value is validated. */
  kind: 'text' | 'color' | 'hours' | 'phone' | 'email' | 'image' | 'section';
  /** Human label for the confirm prompt, e.g. `Hero headline`. */
  label: string;
}

/** Machine reason a request resolved the way it did (drives logs + a typed rejection envelope). */
export type EditReason =
  | 'matched'
  | 'ambiguous_target'
  | 'unknown_op'
  | 'target_not_editable'
  | 'invalid_value'
  | 'empty';

/** The typed, reviewable proposal the owner confirms — the contract the applier consumes. */
export interface EditIntent {
  op: EditOp;
  /** The `EditableSurface.key` this targets, or null when unresolved. */
  target: string | null;
  /** The boundary-safe proposed value (null for image/section ops, or when unresolved). */
  value: string | null;
  /** 0..1 — high for a clean fast-path match, low for unknown/ambiguous. */
  confidence: number;
  /** True when the op is understood but the owner must pick/supply a detail (e.g. upload the photo). */
  needsClarification: boolean;
  /** Plain-language confirm prompt shown to the owner ("Change your Phone number to … ?"). */
  confirmPrompt: string;
  /** Why it resolved this way. */
  reason: EditReason;
}

/** A conservative allowlist of CSS named colors we accept as a color value (no arbitrary strings). */
const NAMED_COLORS = new Set([
  'black',
  'white',
  'gray',
  'grey',
  'silver',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'teal',
  'cyan',
  'blue',
  'navy',
  'indigo',
  'violet',
  'purple',
  'magenta',
  'pink',
  'brown',
  'gold',
  'beige',
  'maroon',
  'olive',
  'coral',
  'salmon',
  'turquoise',
  'lavender',
]);

/**
 * Normalize a color value or reject it. Accepts `#hex` (3/4/6/8), `rgb()/rgba()/hsl()/hsla()`
 * functional forms, and a small named-color allowlist. Returns the normalized token, or null when the
 * value is not a real color — this is the guard that stops arbitrary strings reaching CSS.
 *
 * @param raw - the candidate color
 * @returns a safe color token, or null
 * @example normalizeColor('#FF3366') // '#ff3366'
 * @example normalizeColor('teal') // 'teal'
 * @example normalizeColor('javascript:alert(1)') // null
 */
export function normalizeColor(raw: string): string | null {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!v) return null;
  if (/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(v)) return v;
  if (/^(rgb|rgba|hsl|hsla)\([0-9\s.,%]+\)$/.test(v)) return v;
  if (NAMED_COLORS.has(v)) return v;
  return null;
}

/** Boundary-safe value for an op/kind, or `{ok:false}` when the value is unusable/unsafe. Image +
 *  section ops carry no textual value. Text-ish values reject embedded HTML (`<`/`>`) and cap length. */
function sanitizeValue(
  kind: EditableSurface['kind'],
  raw: string,
): { value: string | null; ok: boolean } {
  if (kind === 'image' || kind === 'section') return { value: null, ok: true };
  const v = String(raw ?? '')
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .trim();
  if (!v) return { value: null, ok: false };
  if (/[<>]/.test(v)) return { value: null, ok: false };
  if (kind === 'color') {
    const c = normalizeColor(v);
    return c ? { value: c, ok: true } : { value: null, ok: false };
  }
  return { value: v.slice(0, 240), ok: true };
}

interface Matcher {
  op: EditOp;
  kind: EditableSurface['kind'];
  test: RegExp;
  /** captures the value in group 1 (or null → op needs the owner to supply it, e.g. image upload). */
  value: RegExp | null;
  keywords: string[];
}

/** Ordered most-specific-first. First hit wins. */
const MATCHERS: Matcher[] = [
  {
    op: 'set_phone',
    kind: 'phone',
    test: /\b(phone|number|call)\b/i,
    value: /(?:to|:)\s*(.+)$/i,
    keywords: ['phone', 'number', 'call'],
  },
  {
    op: 'set_email',
    kind: 'email',
    test: /\be-?mail\b/i,
    value: /(?:to|:)\s*(.+)$/i,
    keywords: ['email'],
  },
  {
    op: 'set_hours',
    kind: 'hours',
    test: /\b(hours|open(?:ing)?)\b/i,
    value: /(?:to|:)\s*(.+)$/i,
    keywords: ['hours', 'open'],
  },
  {
    op: 'set_color',
    kind: 'color',
    test: /\b(colou?r|accent|brand|theme)\b/i,
    value: /(?:to|:)\s*([#\w(),.%\s]+)$/i,
    keywords: ['color', 'colour', 'accent', 'brand', 'theme'],
  },
  {
    op: 'swap_image',
    kind: 'image',
    test: /\b(swap|replace|change|update|new)\b.*\b(photo|image|picture|logo|hero|banner)\b/i,
    value: null,
    keywords: ['photo', 'image', 'picture', 'logo', 'hero', 'banner'],
  },
  {
    op: 'toggle_section',
    kind: 'section',
    test: /\b(hide|remove|show|add|enable|disable)\b.*\b(section|faq|testimonials|gallery|pricing|about|contact|services|menu)\b/i,
    value: null,
    keywords: [
      'faq',
      'testimonials',
      'gallery',
      'pricing',
      'about',
      'contact',
      'services',
      'menu',
      'section',
    ],
  },
  {
    op: 'set_text',
    kind: 'text',
    test: /\b(headline|title|heading|tagline|text|say|copy|wording)\b/i,
    value: /(?:say|to|:)\s*(.+)$/i,
    keywords: ['headline', 'title', 'heading', 'tagline', 'text', 'copy'],
  },
];

/** Resolve which allowlisted surface an op targets: unique-by-kind wins; else disambiguate by keyword
 *  overlap; a tie with no signal is `ambiguous`. Returns `{target:null,ambiguous:false}` when the site
 *  exposes NO surface of that kind (→ target_not_editable). */
function resolveTarget(
  kind: EditableSurface['kind'],
  requestText: string,
  keywords: string[],
  surfaces: readonly EditableSurface[],
): { target: string | null; ambiguous: boolean } {
  const byKind = (surfaces ?? []).filter((s) => s.kind === kind);
  if (byKind.length === 0) return { target: null, ambiguous: false };
  if (byKind.length === 1) return { target: byKind[0].key, ambiguous: false };

  const lc = requestText.toLowerCase();
  const scored = byKind
    .map((s) => {
      const hay = `${s.key} ${s.label}`.toLowerCase();
      const score = keywords.filter((k) => lc.includes(k) && hay.includes(k)).length;
      return { s, score };
    })
    .sort((a, b) => b.score - a.score);

  if (scored[0].score > 0 && (scored.length === 1 || scored[0].score > scored[1].score)) {
    return { target: scored[0].s.key, ambiguous: false };
  }
  return { target: null, ambiguous: true };
}

const OP_VERB: Record<EditOp, string> = {
  set_text: 'update',
  set_color: 'change',
  set_hours: 'update',
  set_phone: 'update',
  set_email: 'update',
  swap_image: 'replace',
  toggle_section: 'update',
  unknown: 'change',
};

function labelFor(target: string | null, surfaces: readonly EditableSurface[]): string {
  return (surfaces ?? []).find((s) => s.key === target)?.label ?? 'this';
}

function reject(op: EditOp, reason: EditReason, confirmPrompt: string): EditIntent {
  return {
    op,
    target: null,
    value: null,
    confidence: reason === 'ambiguous_target' ? 0.4 : 0.1,
    needsClarification: true,
    confirmPrompt,
    reason,
  };
}

/**
 * Classify a plain-language owner edit request into a typed {@link EditIntent} against the site's
 * allowlisted {@link EditableSurface} catalog — the deterministic, LLM-free fast-path for the common
 * phrasings ("change my phone to …", "make the headline say …", "change my accent color to teal",
 * "swap the hero photo", "hide the FAQ section"). Resolves the op, the target surface, and a
 * boundary-safe value, or returns a `needsClarification` intent (unknown op / ambiguous target /
 * not-editable target / invalid value) with an owner-facing prompt. Pure, never throws.
 *
 * @param text - the owner's message
 * @param surfaces - the site's editable-surface allowlist
 * @returns the typed proposal to confirm (or a clarification)
 * @example classifyEditRequest('change my phone to (212) 555-1212', [{key:'contact.phone',kind:'phone',label:'Phone'}]).op // 'set_phone'
 */
export function classifyEditRequest(
  text: string,
  surfaces: readonly EditableSurface[],
): EditIntent {
  const raw = String(text ?? '').trim();
  if (!raw)
    return { ...reject('unknown', 'empty', 'Tell me what you’d like to change.'), confidence: 0 };

  const cat = surfaces ?? [];

  for (const m of MATCHERS) {
    if (!m.test.test(raw)) continue;

    const { target, ambiguous } = resolveTarget(m.kind, raw, m.keywords, cat);
    if (ambiguous) {
      return reject(
        m.op,
        'ambiguous_target',
        `Which one did you mean? I can ${OP_VERB[m.op]} more than one thing here — tap the exact spot and I’ll do it.`,
      );
    }
    if (!target) {
      return reject(
        m.op,
        'target_not_editable',
        `Your site doesn’t have that to ${OP_VERB[m.op]} yet — want me to add it?`,
      );
    }

    let value: string | null = null;
    if (m.value) {
      const captured = raw.match(m.value)?.[1] ?? '';
      const s = sanitizeValue(m.kind, captured);
      if (!s.ok)
        return reject(
          m.op,
          'invalid_value',
          `I didn’t catch a valid ${m.kind} there — try, e.g., “${m.kind === 'color' ? '#00E5FF' : 'a clear new value'}”.`,
        );
      value = s.value;
    }

    const label = labelFor(target, cat);
    const confirmPrompt =
      m.op === 'swap_image'
        ? `Upload a new photo for “${label}” and I’ll place it — you approve before it goes live.`
        : m.op === 'toggle_section'
          ? `Update the “${label}”? You’ll see the change before it publishes.`
          : `${OP_VERB[m.op] === 'change' ? 'Change' : 'Update'} your “${label}” to “${value}”? You confirm, I’ll update your site.`;

    return {
      op: m.op,
      target,
      value,
      confidence: 0.9,
      needsClarification: m.value === null && m.op === 'swap_image',
      confirmPrompt,
      reason: 'matched',
    };
  }

  return reject(
    'unknown',
    'unknown_op',
    'I’m not sure what to change — try “change my phone to …”, “make the headline say …”, or “swap the hero photo”.',
  );
}

/**
 * Contract-first validation of an LLM-proposed edit before anything is applied — the safety net for
 * when the fast-path misses and a model is consulted. The proposal may only target a surface that
 * exists in the catalog (else `target_not_editable`), its op must be known, and its value must pass the
 * same boundary sanitizer (else `invalid_value`). Never trusts the model's target or value blindly.
 * Pure, never throws.
 *
 * @param proposal - the LLM's `{op, target, value}` (unknown-shaped input tolerated)
 * @param surfaces - the site's editable-surface allowlist
 * @returns a validated {@link EditIntent} (reason `matched`) or a typed rejection
 * @example validateLlmEditIntent({ op:'set_text', target:'hero.headline', value:'Hi' }, [{key:'hero.headline',kind:'text',label:'Headline'}]).reason // 'matched'
 * @example validateLlmEditIntent({ op:'set_text', target:'hero.evil', value:'x' }, []).reason // 'target_not_editable'
 */
export function validateLlmEditIntent(
  proposal: { op?: unknown; target?: unknown; value?: unknown } | null | undefined,
  surfaces: readonly EditableSurface[],
): EditIntent {
  const p = proposal ?? {};
  const op = String((p as { op?: unknown }).op ?? '') as EditOp;
  const allowedOps: EditOp[] = [
    'set_text',
    'set_color',
    'set_hours',
    'set_phone',
    'set_email',
    'swap_image',
    'toggle_section',
  ];
  if (!allowedOps.includes(op))
    return reject('unknown', 'unknown_op', 'That change isn’t something I can make safely.');

  const targetKey = String((p as { target?: unknown }).target ?? '');
  const surface = (surfaces ?? []).find((s) => s.key === targetKey);
  if (!surface)
    return reject(op, 'target_not_editable', 'That part of your site can’t be edited that way.');

  let value: string | null = null;
  if (op !== 'swap_image' && op !== 'toggle_section') {
    const s = sanitizeValue(surface.kind, String((p as { value?: unknown }).value ?? ''));
    if (!s.ok) return reject(op, 'invalid_value', `That’s not a valid ${surface.kind} value.`);
    value = s.value;
  }

  const confirmPrompt =
    op === 'swap_image'
      ? `Upload a new photo for “${surface.label}” and I’ll place it — you approve before it goes live.`
      : op === 'toggle_section'
        ? `Update the “${surface.label}”? You’ll see the change before it publishes.`
        : `Update your “${surface.label}” to “${value}”? You confirm, I’ll update your site.`;

  return {
    op,
    target: surface.key,
    value,
    confidence: 0.8,
    needsClarification: op === 'swap_image',
    confirmPrompt,
    reason: 'matched',
  };
}
