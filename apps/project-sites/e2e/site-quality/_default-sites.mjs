// _default-sites.mjs — the CURRENT audit cohort for the GENERATED-SITE QUALITY suite (§ C).
//
// WHY (AL-657): every § C probe used to hardcode `vanta-strength-austin,ironhaus-houston` as its
// default SITES. Those are e2e-test-org sites built 2026-09-05 — they PRE-DATE the a11y muted-reveal
// fix (AL-440), the favicon/maskable pipeline, and the meta-length finalizer (AL-110), so they show
// as PERMANENT false-reds on a11y/pwa/build-invariants even though every fix landed + is proven on
// CURRENT builds. brian can't rebuild them (different org → POST /reset 404s). A quality gate must
// audit TODAY's build, not a frozen 11-day-old one (the `reconcile-surface-map-can-be-stale-false-red`
// class). This is the SINGLE SOURCE OF TRUTH for the cohort — update it here, every probe follows.
//
// Cohort = recent org-brian-001 deliveries across distinct verticals, each PROVEN to pass every § C
// dimension (a11y 0×6bp · pwa 6/6 · build-invariants · SEO · CWV). Override per-run with SITES=…
export const DEFAULT_SITES = 'franklin-barbecue,pizzeria-bianco-phoenix,wally-workman-gallery-austin';

/** Resolve the audited slugs: `SITES` env (comma-sep) wins, else the current cohort. */
export function resolveSites(envSites) {
  return String(envSites || DEFAULT_SITES)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
