/**
 * presets.mjs — per-industry WebGL hero THEME presets. Presets are DATA, not forked code:
 * every preset selects one of the core's 4 shader variants (ember/rays/glint/grid) and
 * tunes uniforms (palette from the vertical's brand world, motion character, density).
 *
 * Palettes track the container orchestrator's vertical themes (apps/project-sites/Dockerfile
 * CLAUDE.md overlay step 2): restaurant=warm terracotta+olive, nonprofit=green+coral,
 * retail=DARK slate+safety-orange, legal/professional=navy+gold, etc. The template hero may
 * override `palette`/`background` from live theme tokens (see `resolveWebGLPreset`).
 *
 * Schema (per preset):
 *   variant     'ember'|'rays'|'glint'|'grid'  — shader field (motion character)
 *   background  '#rrggbb'                      — base canvas color (match hero surface)
 *   palette     ['#A','#B','#C']               — A=primary glow, B=particle/accent, C=atmosphere
 *   speed       0.2–2.0                        — global time multiplier
 *   intensity   0.3–1.5                        — effect strength vs background
 *   density     3–18                           — particle/line density
 *   grain       0–0.06                         — film grain amount
 *   mood        prose                          — what it must evoke (gate rubric line)
 */

export const WEBGL_PRESETS = {
  /* ── FLAGSHIP 4 ─────────────────────────────────────────────────────────── */

  /** Warm ember drift — hearth glow, embers rising, soft smoke. */
  restaurant: {
    variant: 'ember',
    background: '#1a0f0a',
    palette: ['#c2572b', '#f0a850', '#6b5a42'],
    speed: 0.55,
    intensity: 1.0,
    density: 8,
    grain: 0.025,
    mood: 'A wood-fired hearth after dusk: warm terracotta glow pooling at the base, embers drifting upward, faint olive-brown smoke. Appetite + warmth, never neon.',
  },

  /** Soft light rays + particle lift — hope, air, generosity. */
  nonprofit: {
    variant: 'rays',
    background: '#edf2e2',
    palette: ['#fffdf4', '#2e7d4f', '#c9dcba'],
    speed: 0.45,
    intensity: 0.9,
    density: 7,
    grain: 0.015,
    mood: 'Morning light through a high window: airy ivory-green field, soft god-rays breathing, dust motes lifting like small acts of care. Light theme, gentle, hopeful.',
  },

  /** Product-glint sweep — dark velvet, periodic specular pass, sparkle. */
  retail: {
    variant: 'glint',
    background: '#171a1e',
    palette: ['#ff7a1a', '#ffd9a8', '#3a4450'],
    speed: 0.8,
    intensity: 1.0,
    density: 10,
    grain: 0.03,
    mood: 'A display case at night: rugged dark slate, a safety-orange specular sweep passing across like light over brushed metal, tiny star glints. Premium product energy.',
  },

  /** Calm depth grid — authority, order, steady horizon. */
  'professional-services': {
    variant: 'grid',
    background: '#f7f5ef',
    palette: ['#1d3557', '#c9a227', '#e8e4d8'],
    speed: 0.5,
    intensity: 0.85,
    density: 6,
    grain: 0.012,
    mood: 'A navy architectural drawing on warm ivory: a calm receding grid with a slow swell, a muted gold glow at the horizon. Composed, credible, unhurried.',
  },

  /* ── REMAINING VERTICALS (nearest variant + their brand world) ──────────── */

  medical: {
    variant: 'rays',
    background: '#f2f9fa',
    palette: ['#ffffff', '#0a8cad', '#cfe9ef'],
    speed: 0.38, intensity: 0.9, density: 5, grain: 0.01,
    mood: 'Clean clinical light: white-cyan air, calm rays, a few crisp teal motes. LIGHT theme — sterile, reassuring, unhurried.',
  },
  wellness: {
    variant: 'rays',
    background: '#f4f1ea',
    palette: ['#fdf6ec', '#7e916e', '#e6d9c5'],
    speed: 0.35, intensity: 0.9, density: 5, grain: 0.015,
    mood: 'Sage-and-clay calm: warm studio light, breath-paced rays, drifting sage motes. LIGHT theme — spa morning, not spotlight.',
  },
  legal: {
    variant: 'grid',
    background: '#f7f5ef',
    palette: ['#1d3557', '#c9a227', '#e8e4d8'],
    speed: 0.5, intensity: 0.85, density: 6, grain: 0.012,
    mood: 'Navy+gold order on ivory — same composed authority as professional-services.',
  },
  'local-service': {
    variant: 'grid',
    background: '#f3f6f9',
    palette: ['#1f5fa8', '#e8650f', '#d3dfe9'],
    speed: 0.6, intensity: 0.95, density: 9, grain: 0.015,
    mood: "Contractor's graph paper: crisp blueprint-blue grid on bright paper, a safety-orange glow on the horizon. LIGHT theme — planned, punctual, hands-on.",
  },
  saas: {
    variant: 'grid',
    background: '#0b0a1a',
    palette: ['#00e5ff', '#7c3aed', '#1b1838'],
    speed: 0.8, intensity: 1.0, density: 9, grain: 0.02,
    mood: 'Violet-indigo tech depth: fine cyan grid rushing forward, violet horizon bloom. DARK theme — launch-night product energy.',
  },
  agency: {
    variant: 'glint',
    background: '#0b0b0d',
    palette: ['#ff2d87', '#e8ff3a', '#2a2a30'],
    speed: 1.1, intensity: 1.1, density: 12, grain: 0.04,
    mood: 'Brutalist magenta/acid: hard stage-light sweeps, loud acid sparkle, zero softness. DARK theme — a studio that shouts.',
  },
  portfolio: {
    variant: 'glint',
    background: '#141020',
    palette: ['#d8b46a', '#f3e3c0', '#2c2440'],
    speed: 0.6, intensity: 0.75, density: 6, grain: 0.03,
    mood: 'Violet velvet + a narrow champagne-gold gallery light drifting past; sparse cream glints. DARK theme — curated, hushed.',
  },
};

/** Container-orchestrator vertical → preset key (identity where names match). */
const VERTICAL_ALIASES = {
  'personal-injury-law': 'legal',
  hvac: 'local-service',
  cafe: 'restaurant',
  bakery: 'restaurant',
  ecommerce: 'retail',
  accounting: 'professional-services',
  consulting: 'professional-services',
  insurance: 'professional-services',
};

/**
 * @typedef {Object} WebGLHeroPreset
 * @property {'ember'|'rays'|'glint'|'grid'} variant
 * @property {string} background
 * @property {string[]} palette
 * @property {number} speed
 * @property {number} intensity
 * @property {number} density
 * @property {number} grain
 * @property {string} [mood]
 */

/**
 * Resolve the preset for a vertical/industry key, with optional overrides from the
 * pack (`vertical.json` → `webgl`) and live site theme tokens.
 *
 * @param {string} [vertical] - container vertical or pack slug (e.g. 'restaurant').
 * @param {{ variant?:string, background?:string, palette?:string[], speed?:number,
 *           intensity?:number, density?:number, grain?:number }} [overrides]
 * @returns {WebGLHeroPreset} merged preset (always sane; default = professional grid).
 */
export function resolveWebGLPreset(vertical, overrides = {}) {
  const key = String(vertical || '').toLowerCase().trim();
  const base =
    WEBGL_PRESETS[key] ||
    WEBGL_PRESETS[VERTICAL_ALIASES[key]] ||
    WEBGL_PRESETS['professional-services'];
  const merged = { ...base, ...overrides };
  if (overrides.palette) {
    // `||` (not `??`): an empty-string slot means "no override for this slot".
    merged.palette = [
      overrides.palette[0] || base.palette[0],
      overrides.palette[1] || base.palette[1],
      overrides.palette[2] || base.palette[2],
    ];
  }
  return /** @type {WebGLHeroPreset} */ (merged);
}

/** Light validation for pack-authored `webgl` blocks (template has no zod). */
export function validateWebGLConfig(cfg) {
  const errors = [];
  if (cfg == null || typeof cfg !== 'object') return ['webgl config must be an object'];
  if (cfg.variant != null && !['ember', 'rays', 'glint', 'grid'].includes(cfg.variant)) {
    errors.push(`variant must be ember|rays|glint|grid (got ${cfg.variant})`);
  }
  const hex = /^#[0-9a-fA-F]{6}$/;
  if (cfg.background != null && !hex.test(cfg.background)) errors.push('background must be #rrggbb');
  if (cfg.palette != null && (!Array.isArray(cfg.palette) || cfg.palette.some((c) => !hex.test(c)))) {
    errors.push('palette must be an array of #rrggbb strings');
  }
  for (const [k, lo, hi] of [['speed', 0.1, 3], ['intensity', 0.1, 2], ['density', 1, 24], ['grain', 0, 0.1]]) {
    if (cfg[k] != null && (typeof cfg[k] !== 'number' || cfg[k] < lo || cfg[k] > hi)) {
      errors.push(`${k} must be a number in [${lo}, ${hi}]`);
    }
  }
  return errors;
}
