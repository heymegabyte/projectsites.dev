/**
 * @module meta_tags.test
 * @description Brand color regression coverage (server-side artifacts).
 *
 * Historical note: this file once tested the legacy vanilla marketing
 * homepage at `public/index.html`. That static SPA was replaced by the
 * Angular admin shell, which now ships from R2 (`marketing/index.html`
 * uploaded by `frontend/scripts/deploy-r2.mjs`). The Angular bundle's
 * head structure is asserted live against the deploy via
 * `frontend/scripts/verify-deploy.mjs` (CI hard gate). The remaining
 * unit assertions here cover server-side artifacts only.
 */

import * as fs from 'fs';
import * as path from 'path';

describe('Email Template Brand Colors', () => {
  it('auth magic link email uses #00d4ff accent', () => {
    const authTs = fs.readFileSync(path.resolve(__dirname, '../services/auth.ts'), 'utf-8');
    expect(authTs).toContain('#00d4ff');
  });

  it('contact email templates use #50a5db accent and drop legacy #64ffda', () => {
    const contactTs = fs.readFileSync(path.resolve(__dirname, '../services/contact.ts'), 'utf-8');
    expect(contactTs).toContain('#50a5db');
    expect(contactTs).not.toContain('#64ffda');
  });
});
