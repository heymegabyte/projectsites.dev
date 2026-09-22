/**
 * snapshot_to_section.ts — the pure, tested CORE of the "Snapshot-to-Section" feature
 * (flag `snapshot_to_section`). A business owner snaps ONE photo of their real materials
 * (menu / price list / services board / hours sign / business card); a vision model reads
 * it; this module turns that raw model output into a VALIDATED, render-ready site section —
 * or nothing. It never invents data (fabrication-safe per validate-no-fabricated-people +
 * the AI-generation eval dimension-1): only what the model actually read passes through.
 *
 * Bleeding-edge source: v0.dev design-to-code (screenshot → UI) + Framer Workshop, reframed
 * for the NON-TECHNICAL owner — the owner confirms, never configures (embarrassingly-easy +
 * ai-permanence). This module is the classification/normalization seam only; the vision call
 * (Workers AI Llama 4 Scout / AI Gateway), the admin upload surface, and the template section
 * renderer wire into it later WITHOUT changing this contract (contract-first-ai).
 */
import { z } from 'zod';

/** Section kinds a real-world snapshot can become. Ordered by classifier specificity. */
export const SNAPSHOT_KINDS = ['menu', 'price_list', 'services', 'hours', 'contact_card'] as const;
export type SnapshotKind = (typeof SNAPSHOT_KINDS)[number];

/** A raw string is "meaningful" only if it is non-empty and not a placeholder — the first
 *  gate against a vision model echoing "N/A" / "unknown" / "$0.00" into a live section. */
const PLACEHOLDER = /^(n\/?a|none|unknown|tbd|todo|null|undefined|-+|\.+|\$?0(\.0{1,2})?)$/i;
export function isMeaningful(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0 && !PLACEHOLDER.test(v.trim());
}

// Vision output is messy — schemas enforce SHAPE (the right array key + string-ish fields) and let
// normalizeExtraction() enforce CONTENT (drop empty/placeholder rows). A stray empty row must never
// nuke the whole extraction, and a digit-less price ("Free", "Market price") is still a valid price,
// so prices are gated by isMeaningful in the prune step, not by a digit regex in the schema.
const OptStr = z.string().optional();
const MenuItem = z.object({ name: OptStr, price: OptStr, description: OptStr });
const MenuGroup = z.object({ name: OptStr, items: z.array(MenuItem) });

/** Per-kind DATA schemas — SHAPE only; {@link normalizeExtraction} prunes empty/placeholder rows. */
export const SnapshotDataSchemas = {
  menu: z.object({ groups: z.array(MenuGroup) }),
  price_list: z.object({ rows: z.array(z.object({ label: OptStr, price: OptStr, unit: OptStr })) }),
  services: z.object({
    items: z.array(z.object({ name: OptStr, description: OptStr, price: OptStr })),
  }),
  hours: z.object({
    days: z.array(
      z.object({ day: OptStr, open: OptStr, close: OptStr, closed: z.boolean().optional() }),
    ),
  }),
  contact_card: z.object({
    name: OptStr,
    phone: OptStr,
    email: OptStr,
    address: OptStr,
    website: OptStr,
  }),
} as const;

/** A normalized, render-ready section. `confidence` < 0.6 → the UI asks the owner to confirm before publish. */
export interface SnapshotSection {
  kind: SnapshotKind;
  title: string;
  confidence: number;
  data: unknown;
  itemCount: number;
}

/** Thrown when a caller asks to normalize an unknown kind — a programming error, not bad model output. */
export class UnknownSnapshotKindError extends Error {
  constructor(kind: string) {
    super(`unknown snapshot kind: ${kind}`);
    this.name = 'UnknownSnapshotKindError';
  }
}

const HINTS: ReadonlyArray<[SnapshotKind, RegExp]> = [
  ['hours', /\b(hours?|open(ing)?|schedule|closed|mon|tue|wed|thu|fri|sat|sun)\b/i],
  ['price_list', /\b(price|pricing|rate|rates|fee|fees|cost|tariff)\b/i],
  ['menu', /\b(menu|dish|entree|appetizer|dessert|drink|food|plate|special)\b/i],
  ['contact_card', /\b(card|contact|business\s*card|vcard|phone|email|address)\b/i],
  ['services', /\b(service|services|offering|treatment|package)\b/i],
];

/**
 * Classify what a snapshot most likely is, from a caption/filename/owner hint. Deterministic
 * keyword match — the vision call is separate. Defaults to `services` (the safest generic
 * "list of things a business offers"), never guesses `menu` unless food words appear.
 *
 * @example classifySnapshotHint('Our happy-hour drink menu') // 'menu'
 * @example classifySnapshotHint('photo of the front desk') // 'services'
 */
export function classifySnapshotHint(hint: string): SnapshotKind {
  const h = String(hint ?? '');
  for (const [kind, re] of HINTS) if (re.test(h)) return kind;
  return 'services';
}

const TITLES: Record<SnapshotKind, string> = {
  menu: 'Menu',
  price_list: 'Pricing',
  services: 'Services',
  hours: 'Hours',
  contact_card: 'Contact',
};

/**
 * Validate + PRUNE raw vision output into a {@link SnapshotSection}, or `null` when nothing
 * real survives. Fabrication-safe: rows whose required fields are empty/placeholder are
 * dropped; a kind with zero surviving rows returns `null` (better an absent section than a
 * fake one). `confidence` is the caller's model confidence, clamped to [0,1].
 *
 * @throws {UnknownSnapshotKindError} when `kind` is not in {@link SNAPSHOT_KINDS}.
 * @example normalizeExtraction('price_list', { rows: [{ label: 'Oil change', price: '$49' }, { label: '', price: '' }] }, 0.9)
 *   // → { kind:'price_list', title:'Pricing', confidence:0.9, itemCount:1, data:{ rows:[{label:'Oil change',price:'$49'}] } }
 */
export function normalizeExtraction(
  kind: SnapshotKind,
  raw: unknown,
  confidence = 0.5,
): SnapshotSection | null {
  const schema = SnapshotDataSchemas[kind] as z.ZodTypeAny | undefined;
  if (!schema) throw new UnknownSnapshotKindError(kind);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return null;
  const pruned = pruneEmpty(kind, parsed.data);
  const count = countItems(kind, pruned);
  if (count === 0) return null;
  return {
    kind,
    title: TITLES[kind],
    confidence: Math.max(0, Math.min(1, Number(confidence) || 0)),
    data: pruned,
    itemCount: count,
  };
}

/** Drop rows/items whose REQUIRED display field is missing/placeholder — never fabricate. */
function pruneEmpty(kind: SnapshotKind, data: Record<string, unknown>): Record<string, unknown> {
  switch (kind) {
    case 'menu': {
      const groups = (data['groups'] as Array<{ name: string; items: Array<{ name: string }> }>)
        .map((g) => ({ ...g, items: g.items.filter((it) => isMeaningful(it.name)) }))
        .filter((g) => isMeaningful(g.name) && g.items.length > 0);
      return { groups };
    }
    case 'price_list':
      return {
        rows: (data['rows'] as Array<{ label: string; price: string }>).filter(
          (r) => isMeaningful(r.label) && isMeaningful(r.price),
        ),
      };
    case 'services':
      return {
        items: (data['items'] as Array<{ name: string }>).filter((it) => isMeaningful(it.name)),
      };
    case 'hours':
      return { days: (data['days'] as Array<{ day: string }>).filter((d) => isMeaningful(d.day)) };
    case 'contact_card': {
      const src = data as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const k of ['name', 'phone', 'email', 'address', 'website'])
        if (isMeaningful(src[k])) out[k] = String(src[k]).trim();
      return out;
    }
    default:
      return data;
  }
}

/** Count the surviving display rows for a pruned section (drives the "0 → null" rule). */
function countItems(kind: SnapshotKind, data: Record<string, unknown>): number {
  switch (kind) {
    case 'menu':
      return (data['groups'] as Array<{ items: unknown[] }>).reduce(
        (n, g) => n + g.items.length,
        0,
      );
    case 'price_list':
      return (data['rows'] as unknown[]).length;
    case 'services':
      return (data['items'] as unknown[]).length;
    case 'hours':
      return (data['days'] as unknown[]).length;
    case 'contact_card':
      return Object.keys(data).length;
    default:
      return 0;
  }
}

/** Owner-facing prompt for the confirm step — the ONLY thing the owner does. Never technical. */
export function confirmPrompt(section: SnapshotSection): string {
  const noun = section.kind === 'contact_card' ? 'contact details' : section.title.toLowerCase();
  const low =
    section.confidence < 0.6 ? ' A couple entries looked blurry — give them a quick check.' : '';
  return `We read ${section.itemCount} ${noun === 'hours' ? 'day(s) of hours' : `${noun} entr${section.itemCount === 1 ? 'y' : 'ies'}`} from your photo. Look right?${low}`;
}
