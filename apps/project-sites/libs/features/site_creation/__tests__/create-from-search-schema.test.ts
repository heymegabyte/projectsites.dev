import { createFromSearchSchema } from '../schemas.js';

/**
 * Boundary regression for AL-724 — `POST /api/sites/create-from-search` (the primary
 * conversion funnel) previously read its body via a raw `as CreateFromSearchBody` cast with
 * ZERO runtime narrowing. A wrong-typed field then either crashed 500 (`(12345).trim()` on a
 * numeric name) or lying-success persisted a number into the `business_category` TEXT column
 * that later threw in the vertical classifier. These lock the schema that fail-softs those to 400.
 */
describe('createFromSearchSchema (AL-724 boundary validation)', () => {
  it('accepts a valid v2 nested payload (business object + types array)', () => {
    const r = createFromSearchSchema.safeParse({
      mode: 'business',
      business: { name: 'Hotel Emma', address: '136 E Grayson St', types: ['lodging', 'hotel'] },
      additional_context: 'A boutique hotel',
    });
    expect(r.success).toBe(true);
  });

  it('accepts a valid v1 flat payload (deprecated flat keys)', () => {
    const r = createFromSearchSchema.safeParse({
      business_name: "Vito's Mens Salon",
      business_address: '74 N Beverwyck Rd',
      business_phone: '+19735551234',
      google_place_id: 'ChIJ_xyz',
    });
    expect(r.success).toBe(true);
  });

  it('REJECTS a numeric business_type (the lying-success/downstream-crash defect)', () => {
    const r = createFromSearchSchema.safeParse({ business_name: 'Acme', business_type: 12345 });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path.includes('business_type'))).toBe(true);
  });

  it('REJECTS a numeric business_name (the (12345).trim() 500-crash defect)', () => {
    const r = createFromSearchSchema.safeParse({ business_name: 999 });
    expect(r.success).toBe(false);
  });

  it('REJECTS non-string entries inside business.types', () => {
    const r = createFromSearchSchema.safeParse({ business: { name: 'Acme', types: ['ok', 42] } });
    expect(r.success).toBe(false);
  });

  it('PASSES THROUGH unknown Places fields (rating/user_ratings_total) — never rejects a real submission', () => {
    const r = createFromSearchSchema.safeParse({
      business: { name: 'Acme', rating: 4.7, user_ratings_total: 812 },
    });
    expect(r.success).toBe(true);
  });

  it('accepts an empty body (all fields optional; the handler enforces name presence itself)', () => {
    expect(createFromSearchSchema.safeParse({}).success).toBe(true);
  });
});
