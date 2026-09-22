/**
 * Tests for the Snapshot-to-Section pure core (flag `snapshot_to_section`).
 * Focus: fabrication-safety (placeholders/empties are pruned, 0 → null — never a fake section)
 * + deterministic hint classification + confidence clamping. No vision call, no I/O.
 */
import {
  SNAPSHOT_KINDS,
  isMeaningful,
  classifySnapshotHint,
  normalizeExtraction,
  confirmPrompt,
  UnknownSnapshotKindError,
} from '../services/snapshot_to_section.js';

describe('snapshot_to_section: kinds + hint classifier', () => {
  it('exposes the five supported kinds', () => {
    expect(SNAPSHOT_KINDS).toEqual(['menu', 'price_list', 'services', 'hours', 'contact_card']);
  });

  it('classifies unambiguous hints to the right kind', () => {
    expect(classifySnapshotHint('our dinner menu with entrees')).toBe('menu');
    expect(classifySnapshotHint('salon pricing sheet')).toBe('price_list');
    expect(classifySnapshotHint('opening times / schedule')).toBe('hours');
    expect(classifySnapshotHint('scan of my business card')).toBe('contact_card');
    expect(classifySnapshotHint('what we offer')).toBe('services');
  });

  it('defaults to services (never guesses menu) for an empty/unknown hint', () => {
    expect(classifySnapshotHint('')).toBe('services');
    expect(classifySnapshotHint('photo of the front desk')).toBe('services');
  });
});

describe('snapshot_to_section: isMeaningful (fabrication gate)', () => {
  it('accepts real values, rejects empties + placeholders', () => {
    expect(isMeaningful('Oil change')).toBe(true);
    expect(isMeaningful('$49')).toBe(true);
    expect(isMeaningful('')).toBe(false);
    expect(isMeaningful('   ')).toBe(false);
    expect(isMeaningful('N/A')).toBe(false);
    expect(isMeaningful('unknown')).toBe(false);
    expect(isMeaningful('$0.00')).toBe(false);
    expect(isMeaningful('---')).toBe(false);
    expect(isMeaningful(0 as unknown)).toBe(false);
  });
});

describe('snapshot_to_section: normalizeExtraction', () => {
  it('keeps real rows, prunes empty ones, counts survivors', () => {
    const s = normalizeExtraction(
      'price_list',
      {
        rows: [
          { label: 'Oil change', price: '$49' },
          { label: '', price: '' },
        ],
      },
      0.9,
    );
    expect(s).not.toBeNull();
    expect(s!.kind).toBe('price_list');
    expect(s!.title).toBe('Pricing');
    expect(s!.itemCount).toBe(1);
    expect((s!.data as { rows: unknown[] }).rows).toHaveLength(1);
  });

  it('returns null when every row is a placeholder (never fabricates a section)', () => {
    const s = normalizeExtraction('price_list', { rows: [{ label: 'N/A', price: '$0.00' }] }, 0.9);
    expect(s).toBeNull();
  });

  it('returns null when the raw shape fails the schema', () => {
    expect(normalizeExtraction('price_list', { rows: [{ label: 'x' }] }, 0.9)).toBeNull(); // price missing
    expect(normalizeExtraction('menu', { wrong: true }, 0.9)).toBeNull();
  });

  it('prunes empty menu groups + items', () => {
    const s = normalizeExtraction(
      'menu',
      {
        groups: [
          { name: 'Tacos', items: [{ name: 'Al Pastor', price: '$4' }, { name: '' }] },
          { name: '', items: [{ name: 'ghost' }] },
        ],
      },
      0.8,
    );
    expect(s).not.toBeNull();
    expect(s!.itemCount).toBe(1);
    expect((s!.data as { groups: unknown[] }).groups).toHaveLength(1);
  });

  it('keeps only meaningful contact fields', () => {
    const s = normalizeExtraction(
      'contact_card',
      { name: 'Joe', phone: '(212) 555-1212', email: 'N/A', address: '' },
      0.7,
    );
    expect(s).not.toBeNull();
    expect(s!.itemCount).toBe(2);
    expect(s!.data).toEqual({ name: 'Joe', phone: '(212) 555-1212' });
  });

  it('clamps confidence to [0,1]', () => {
    expect(normalizeExtraction('services', { items: [{ name: 'Haircut' }] }, 1.5)!.confidence).toBe(
      1,
    );
    expect(
      normalizeExtraction('services', { items: [{ name: 'Haircut' }] }, -0.5)!.confidence,
    ).toBe(0);
  });

  it('throws UnknownSnapshotKindError on an unsupported kind', () => {
    // @ts-expect-error — deliberately passing an invalid kind
    expect(() => normalizeExtraction('bogus', {}, 0.5)).toThrow(UnknownSnapshotKindError);
  });
});

describe('snapshot_to_section: confirmPrompt', () => {
  it('states the count in owner language + flags low confidence', () => {
    const s = normalizeExtraction(
      'services',
      { items: [{ name: 'Haircut' }, { name: 'Shave' }] },
      0.4,
    )!;
    const msg = confirmPrompt(s);
    expect(msg).toContain('2');
    expect(msg.toLowerCase()).toContain('check');
  });

  it('omits the low-confidence nudge when confident', () => {
    const s = normalizeExtraction('services', { items: [{ name: 'Haircut' }] }, 0.95)!;
    expect(confirmPrompt(s).toLowerCase()).not.toContain('blurry');
  });
});
