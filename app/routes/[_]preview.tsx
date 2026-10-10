/**
 * @file `/_preview` — a NON-authed gallery that mounts every shared workbench panel primitive
 *        so post-deploy visual QA can screenshot the gorgeous panel chrome + the contained Nebula
 *        HEADLESSLY, without the Cloudflare Access wall the real panels live behind.
 *
 * @remarks
 * WHY this exists: the real panels ({@link PanelShell}/{@link PanelHeader}/{@link PanelLoading}/
 * {@link PanelEmpty}) only render inside the admin iframe at `projectsites.dev`, which sits behind
 * Cloudflare Access — so a headless visual-QA run can never reach them. The standalone editor origin
 * (`editor.projectsites.dev`) otherwise shows only the chat/dashboard shell. This leaf route renders
 * the primitives in isolation on the public editor origin, making the whole panel-primitive spine
 * visually regression-gatable (screenshot + AI-vision) with no auth.
 *
 * ROUTE NAME: the filename is `[_]preview.tsx`, NOT `_preview.tsx`. In the Remix v2 flat-routes
 * convention this repo uses, a leading `_` marks a PATHLESS layout segment (it contributes no URL
 * and renders nothing) — verified against `@remix-run/dev`'s `createRoutePath` (`// skip pathless
 * layout segments`). Escaping the underscore with `[_]` emits a LITERAL `_`, so this serves at the
 * intended path **`/_preview`** (editor.projectsites.dev/_preview).
 *
 * NO redirecting loader: `app/root.tsx` has no global auth/redirect guard (the editor's "open from
 * your dashboard" guard is route-scoped to the chat surface), so a leaf route with just a default
 * component export renders fine. We intentionally export NO `loader` — nothing to redirect, nothing
 * to fetch — keeping this a pure, dependency-free (primitives + React) static gallery.
 *
 * Mark the route `noindex` — it's a QA harness, never a public surface.
 */
import type { MetaFunction } from '@remix-run/cloudflare';
import { PanelShell, PanelHeader, PanelLoading, PanelEmpty } from '~/components/workbench/panel';
import {
  BucketsTwoPane,
  BucketAnimationStyles,
  OBJECT_ENTRANCE_CLASS,
  objectEntranceStyle,
} from '~/components/workbench/BucketsPanel';
import { iconForObject, isImageKey, colorForObject } from '~/components/workbench/bucket-icons';

export const meta: MetaFunction = () => [
  { title: 'Panel Primitive Gallery · ProjectSites editor' },
  { name: 'robots', content: 'noindex, nofollow' },
  { name: 'description', content: 'Headless visual-QA gallery of the editor workbench panel primitives.' },
];

/** A single ~360×480 bordered panel frame with a small caption underneath — one primitive per cell. */
function Frame({ caption, children }: { caption: string; children: React.ReactNode }) {
  return (
    <figure className="m-0 flex flex-col gap-2">
      <div className="h-[480px] w-[360px] overflow-hidden rounded-2xl border border-bolt-elements-borderColor shadow-xl shadow-black/40">
        {children}
      </div>
      <figcaption className="text-[11px] font-mono uppercase tracking-wider text-bolt-elements-textSecondary">
        {caption}
      </figcaption>
    </figure>
  );
}

/**
 * Left pane sample — a realistic bucket list with one selected row (mirrors the real Buckets tab's
 * {@link BucketNavRow}: the selected row gets the accent-gradient fill + a glowing left rail + a
 * scaled drive glyph, inactive rows get a hairline card. The headless screenshot is the proof the
 * elevated navigator chrome lands in production.
 */
function BucketListSample() {
  const buckets = [
    { name: 'site-assets', objects: '1,284', selected: true, isDefault: true },
    { name: 'user-uploads', objects: '312', selected: false, isDefault: false },
    { name: 'backups', objects: '48', selected: false, isDefault: false },
  ];

  return (
    <ul className="m-0 list-none p-2 flex flex-col gap-1.5">
      {buckets.map((b) => (
        <li
          key={b.name}
          className={`group relative flex items-center gap-2 rounded-xl border p-2.5 overflow-hidden transition-all ${
            b.selected
              ? 'border-bolt-elements-item-contentAccent/70 bg-[linear-gradient(90deg,color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_16%,transparent),color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_5%,transparent)_60%,transparent)] shadow-[0_0_0_1px_color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_18%,transparent),0_4px_14px_-6px_color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_45%,transparent)]'
              : 'border-bolt-elements-borderColor bg-bolt-elements-background-depth-2'
          }`}
        >
          {b.selected && (
            <span
              aria-hidden="true"
              className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full bg-bolt-elements-item-contentAccent shadow-[0_0_8px_color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_60%,transparent)]"
            />
          )}
          <span
            className={`i-ph:hard-drives-duotone text-base shrink-0 ${
              b.selected ? 'text-bolt-elements-item-contentAccent scale-110' : 'text-bolt-elements-textTertiary'
            }`}
            aria-hidden="true"
          />
          <span
            className={`truncate text-[12px] font-medium ${
              b.selected ? 'text-bolt-elements-textPrimary' : 'text-bolt-elements-textSecondary'
            }`}
          >
            {b.name}
          </span>
          {b.isDefault && (
            <span
              className="inline-flex items-center gap-0.5 rounded-md border border-bolt-elements-item-contentAccent/45 bg-[color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_10%,transparent)] px-1 py-px text-[8px] font-semibold uppercase tracking-wide text-bolt-elements-item-contentAccent shrink-0"
              title="The site's default bucket"
            >
              <span className="i-ph:star-fill text-[7px]" aria-hidden="true" />
              Default
            </span>
          )}
          <span className="ml-auto inline-flex items-center justify-center min-w-[18px] h-[16px] px-1 rounded-full bg-[color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_10%,transparent)] text-[9px] font-semibold tabular-nums text-bolt-elements-item-contentAccent/90">
            {b.objects}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A populated bucket's objects — ONE folder prefix + 16 varied files spanning every distinct file-type
 * family so the headless gallery is the visual-proof surface for the {@link iconForObject} map. The
 * list + grid cells both render from THIS array through the REAL `iconForObject`, so a screenshot
 * proves the distinct duotone glyphs land in production, not hand-rolled placeholders.
 */
const SAMPLE_OBJECTS: { key: string; size: string }[] = [
  { key: 'images/', size: '7 items' }, // folder prefix → folder glyph
  { key: 'hero.webp', size: '284 KB' }, // image
  { key: 'portrait.jpg', size: '198 KB' }, // image
  { key: 'logo.svg', size: '12 KB' }, // image (vector)
  { key: 'report.pdf', size: '1.2 MB' }, // pdf
  { key: 'README.md', size: '4 KB' }, // markdown
  { key: 'data.csv', size: '86 KB' }, // csv
  { key: 'budget.xlsx', size: '44 KB' }, // spreadsheet
  { key: 'proposal.docx', size: '72 KB' }, // doc
  { key: 'deck.pptx', size: '3.4 MB' }, // slides
  { key: 'config.json', size: '2 KB' }, // data
  { key: 'app.tsx', size: '9 KB' }, // typescript
  { key: 'styles.css', size: '18 KB' }, // stylesheet
  { key: 'bundle.zip', size: '5.1 MB' }, // archive
  { key: 'track.mp3', size: '6.8 MB' }, // audio
  { key: 'promo.mp4', size: '48 MB' }, // video
  { key: 'font.woff2', size: '31 KB' }, // font
];

/**
 * Shared breadcrumb + upload affordance for the populated samples (mirrors the real object toolbar:
 * a search field with the magnifier, a pill breadcrumb, and the elevated gradient primary Upload
 * button — top-lit fill + inner highlight ring + accent drop-shadow, the Linear/Stripe pressable look).
 */
function SampleToolbar() {
  return (
    <div className="flex items-center gap-2 border-b border-bolt-elements-borderColor/60 px-3 py-2 text-xs text-bolt-elements-textSecondary shrink-0">
      <span className="inline-flex items-center gap-1 rounded-md bg-[color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_10%,transparent)] px-1 py-0.5 font-medium text-bolt-elements-item-contentAccent">
        <span className="i-ph:hard-drives-duotone text-xs" aria-hidden="true" />
        site-assets
      </span>
      <div className="relative ml-auto hidden sm:block">
        <span
          className="i-ph:magnifying-glass absolute left-2 top-1/2 -translate-y-1/2 text-xs text-bolt-elements-textTertiary"
          aria-hidden="true"
        />
        <span className="inline-flex min-w-[9rem] items-center rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 py-1 pl-7 pr-2 text-[11px] text-bolt-elements-textSecondary">
          Search all files…
        </span>
      </div>
      <button className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1 text-[11px] font-semibold text-[#04121a] ring-1 ring-inset ring-white/15 bg-[linear-gradient(180deg,color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_100%,white_14%),var(--bolt-elements-item-contentAccent))] shadow-[0_1px_0_rgba(255,255,255,0.22)_inset,0_2px_8px_-2px_color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_55%,transparent)]">
        <span className="i-ph:upload-simple-bold text-xs" aria-hidden="true" />
        Upload
      </button>
    </div>
  );
}

/**
 * LIST view of a populated bucket — airy rows, a COLOR-CODED per-type glyph ({@link colorForObject}),
 * and a tabular size. `testId` is optional so the same component serves the probe-scoped sample AND
 * the standalone grid/list showcases without duplicating the `buckets-object-list` testid.
 */
function ObjectListSample({ testId }: { testId?: string }) {
  return (
    <ul className="m-0 list-none p-1" data-testid={testId}>
      {SAMPLE_OBJECTS.map((o, index) => (
        <li
          key={o.key}
          style={objectEntranceStyle(index)}
          className={`group flex items-center gap-3 rounded-lg px-2.5 py-2 hover:bg-[color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_5%,transparent)] motion-safe:hover:translate-x-0.5 ${OBJECT_ENTRANCE_CLASS}`}
        >
          {/* File-type glyph in an inset chip — mirrors the real list row's dimensional "asset" slot. */}
          <span className="flex items-center justify-center h-7 w-7 shrink-0 rounded-lg bg-bolt-elements-background-depth-2/70 ring-1 ring-inset ring-bolt-elements-borderColor/50 group-hover:ring-bolt-elements-item-contentAccent/25">
            <span className={`${iconForObject(o.key)} ${colorForObject(o.key)} text-lg`} aria-hidden="true" />
          </span>
          {/* min-w-0 + truncate: the long key shrinks to the pane and ellipsizes instead of overflowing
              the parent — the exact clip the BucketsTwoPane min-w-0 right pane prevents. */}
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-bolt-elements-textPrimary">{o.key}</span>
          <span className="shrink-0 text-[10px] tabular-nums text-bolt-elements-textSecondary tracking-tight">
            {o.size}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * GRID view of a populated bucket — image types render a cyan thumbnail SLOT; every other type renders
 * its big COLOR-CODED file-type glyph ({@link colorForObject}) so the file type reads at a glance.
 */
function ObjectGridSample({ testId }: { testId?: string }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-2.5 p-3" data-testid={testId}>
      {SAMPLE_OBJECTS.filter((o) => !o.key.endsWith('/')).map((o, index) => (
        <div
          key={o.key}
          style={objectEntranceStyle(index)}
          className={`group flex flex-col gap-1.5 rounded-xl border border-bolt-elements-borderColor/70 bg-bolt-elements-background-depth-2 p-2 hover:border-bolt-elements-item-contentAccent/40 hover:bg-bolt-elements-background-depth-3 hover:shadow-[0_10px_26px_-10px_rgba(0,0,0,0.65)] motion-safe:hover:-translate-y-1 ${OBJECT_ENTRANCE_CLASS}`}
        >
          <div className="relative flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-[radial-gradient(130%_90%_at_50%_0%,color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_7%,transparent),transparent_60%),linear-gradient(180deg,var(--bolt-elements-bg-depth-1),color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_4%,var(--bolt-elements-bg-depth-1)))] ring-1 ring-inset ring-bolt-elements-borderColor/45 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
            {isImageKey(o.key) ? (
              <span
                className="i-ph:image-duotone text-4xl text-sky-300 transition-transform duration-200 motion-reduce:transition-none motion-safe:group-hover:scale-110"
                aria-hidden="true"
              />
            ) : (
              <span
                className={`${iconForObject(o.key)} ${colorForObject(o.key)} text-4xl transition-transform duration-200 motion-reduce:transition-none motion-safe:group-hover:scale-110`}
                aria-hidden="true"
              />
            )}
          </div>
          <p className="min-w-0 truncate font-mono text-[11px] text-bolt-elements-textPrimary" title={o.key}>
            {o.key}
          </p>
          <p className="text-[9px] tabular-nums text-bolt-elements-textSecondary">{o.size}</p>
        </div>
      ))}
    </div>
  );
}

/**
 * Right pane sample — the POPULATED object browser (fire-B5). Renders both a LIST view and a GRID view
 * from {@link SAMPLE_OBJECTS} through the REAL {@link iconForObject} + {@link colorForObject}, so the
 * headless `/_preview` screenshot proves the distinct, color-coded file-type glyphs land. The probe +
 * E2E scope to `buckets-populated-sample`, so the canonical `buckets-object-list`/`buckets-object-grid`
 * testids live HERE (the standalone showcase frames below carry no testid to stay unambiguous).
 */
function ObjectBrowserSample() {
  return (
    <div className="flex flex-col min-h-0" data-testid="buckets-populated-sample">
      <SampleToolbar />
      {/* tabIndex={0} + role/aria-label: a scrollable region with no focusable descendants is
          unreachable by keyboard-only users (axe `scrollable-region-focusable`, WCAG 2.1.1). Making
          the overflow container focusable lets keyboard users scroll it; the label names the region
          for screen readers. Mirrors the real Buckets object pane, so the fix is faithful. */}
      <div
        className="overflow-auto modern-scrollbar focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent/60"
        tabIndex={0}
        role="region"
        aria-label="Bucket objects"
      >
        <ObjectListSample testId="buckets-object-list" />
        <div className="border-t border-bolt-elements-borderColor/40">
          <ObjectGridSample testId="buckets-object-grid" />
        </div>
      </div>
    </div>
  );
}

/**
 * STATIC showcase of the B12 in-editor object PREVIEW modal body — an image preview card beside a
 * text/code preview card — so the headless `/_preview` screenshot proves the sandboxed preview chrome
 * (brand-dark, cyan, mono source block) lands in production. Pure + static (no bridge, no blob URL):
 * the image slot shows the inline SVG data URL it would render; the text slot shows ESCAPED source in
 * a `<pre>` exactly as the live modal does. Carries a `buckets-preview-showcase` testid that does NOT
 * collide with `buckets-populated-sample` / `buckets-object-list` / `buckets-object-grid`.
 */
function PreviewShowcase() {
  // A tiny inert SVG rendered as an <img> (mirrors the modal's inert image element — never executes).
  const sampleImage =
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160">' +
        '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0" stop-color="%2300e5ff"/><stop offset="1" stop-color="%237c3aed"/>' +
        '</linearGradient></defs><rect width="240" height="160" rx="12" fill="url(%23g)"/>' +
        '<text x="120" y="88" font-family="monospace" font-size="18" fill="%23060610" ' +
        'text-anchor="middle">hero.webp</text></svg>',
    );

  const sampleText = `{
  "name": "site-assets",
  "objects": 1284,
  "public": true,
  "preview": "escaped in a <pre> — never executed"
}`;

  return (
    <div className="mt-10 grid gap-8 lg:grid-cols-2 max-w-[940px]" data-testid="buckets-preview-showcase">
      {/* Image preview card */}
      <figure className="m-0 flex flex-col gap-2">
        <div className="w-full overflow-hidden rounded-2xl border border-bolt-elements-borderColor shadow-xl shadow-black/40">
          <PanelShell>
            <PanelHeader icon="i-ph:eye-duotone" title="hero.webp" subtitle="image preview" />
            <div className="p-4">
              <div className="flex items-center justify-center rounded-xl border border-bolt-elements-borderColor/60 bg-bolt-elements-background-depth-1 p-2">
                <img
                  src={sampleImage}
                  alt="Sample image preview"
                  className="max-h-[220px] max-w-full rounded-lg object-contain"
                />
              </div>
              <div className="mt-3 flex items-center justify-end border-t border-bolt-elements-borderColor/40 pt-3">
                <span className="inline-flex items-center gap-1.5 rounded-lg border border-bolt-elements-item-contentAccent/35 bg-[color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_6%,transparent)] px-3 py-1 text-[11px] text-bolt-elements-item-contentAccent">
                  <span className="i-ph:download-simple text-sm" aria-hidden="true" /> Download
                </span>
              </div>
            </div>
          </PanelShell>
        </div>
        <figcaption className="text-[11px] font-mono uppercase tracking-wider text-bolt-elements-textSecondary">
          Object preview (image · inert img)
        </figcaption>
      </figure>

      {/* Text/code preview card */}
      <figure className="m-0 flex flex-col gap-2">
        <div className="w-full overflow-hidden rounded-2xl border border-bolt-elements-borderColor shadow-xl shadow-black/40">
          <PanelShell>
            <PanelHeader icon="i-ph:eye-duotone" title="config.json" subtitle="text preview · escaped" />
            <div className="p-4">
              <pre className="max-h-[240px] overflow-auto modern-scrollbar rounded-xl border border-bolt-elements-borderColor/60 bg-bolt-elements-background-depth-1 p-3 font-mono text-[11px] leading-relaxed text-bolt-elements-textSecondary whitespace-pre-wrap break-words">
                {sampleText}
              </pre>
            </div>
          </PanelShell>
        </div>
        <figcaption className="text-[11px] font-mono uppercase tracking-wider text-bolt-elements-textSecondary">
          Object preview (text/code · escaped pre)
        </figcaption>
      </figure>
    </div>
  );
}

/**
 * The gallery: one frame per primitive, each in a realistic panel chrome, on the brand-dark canvas.
 * Pure + static so a headless browser paints it deterministically (the only dynamic pixel is the
 * contained WebGL nebula inside {@link PanelLoading}, which is the money shot QA screenshots).
 */
export default function PanelPrimitiveGallery() {
  return (
    <div className="min-h-screen bg-[#060610] p-8">
      {/* The one `psBucketRise` keyframe the object-browser entrance rides on — screenshot-verifiable here. */}
      <BucketAnimationStyles />
      <div className="mb-6">
        <h1 className="text-balance text-xl font-semibold tracking-tight text-bolt-elements-textPrimary">
          Panel Primitive Gallery
        </h1>
        <p className="mt-1 text-[12px] text-bolt-elements-textSecondary">
          Headless visual-QA surface for the editor workbench chrome — Buckets navigator, object list &amp; grid, and
          the launchpad states, on the brand-dark canvas.
        </p>
      </div>

      <div className="grid gap-8 [grid-template-columns:repeat(auto-fill,360px)]">
        {/* 1 — PanelShell + PanelHeader: badge icon, title, subtitle, right-aligned action. */}
        <Frame caption="PanelShell + PanelHeader">
          <PanelShell>
            <PanelHeader
              icon="i-ph:stack-duotone"
              title="Resources"
              subtitle="3 tables"
              actions={
                <button className="text-xs px-2 py-1 rounded bg-bolt-elements-item-backgroundAccent">New</button>
              }
            />
            <div className="p-4 text-sm text-bolt-elements-textSecondary">
              Panel body content sits beneath the canonical header — this is the one root wrapper every workbench panel
              composes.
            </div>
          </PanelShell>
        </Frame>

        {/* 2 — PanelLoading: the contained Nebula (the money shot — confirm it paints in a tab). */}
        <Frame caption="PanelLoading (contained Nebula)">
          <PanelShell>
            <PanelHeader icon="i-ph:spinner-gap-duotone" title="Loading" subtitle="in-panel nebula" />
            <PanelLoading label="Loading your resources…" />
          </PanelShell>
        </Frame>

        {/* 3 — PanelEmpty: launchpad empty state (icon + headline + helper + one primary action). */}
        <Frame caption="PanelEmpty (launchpad)">
          <PanelShell>
            <PanelHeader icon="i-ph:hard-drives-duotone" title="Buckets" subtitle="R2 storage" />
            <PanelEmpty
              icon="i-ph:hard-drives-duotone"
              title="No buckets yet"
              description="Create your first bucket to store files."
              action={
                <button className="text-xs px-3 py-1.5 rounded-lg bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent">
                  Create your first bucket
                </button>
              }
            />
          </PanelShell>
        </Frame>

        {/* 4 — PanelHeader detail-nav variant: a `leading` back-button slot + subtitle. */}
        <Frame caption="PanelHeader (detail / back-nav)">
          <PanelShell>
            <PanelHeader
              icon="i-ph:table-duotone"
              title="customers"
              subtitle="42 rows · 6 columns"
              leading={
                <button
                  className="flex items-center justify-center h-7 w-7 rounded-lg border border-bolt-elements-borderColor text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary"
                  aria-label="Back to tables"
                >
                  <span className="i-ph:arrow-left text-base" aria-hidden="true" />
                </button>
              }
            />
            <div className="p-4 text-sm text-bolt-elements-textSecondary">
              The <code className="text-bolt-elements-item-contentAccent">leading</code> slot renders a back affordance
              before the icon badge, so a detail drill-in reads left-to-right.
            </div>
          </PanelShell>
        </Frame>
      </div>

      {/* 5 — BucketsTwoPane: the data-bound two-pane Resources layout, rendered WIDE so the
          lg:flex-row path shows the bucket list (left, fixed 288px) beside the object browser
          (right, min-w-0 flex-fill). This is the headless pixel-proof of the two-pane layout that
          previously needed the authed editor — the min-w-0 right pane keeps long object keys inside
          the panel (truncate) rather than overflowing the overflow-hidden parent (fire-153/160/162). */}
      <figure className="m-0 mt-8 flex max-w-[940px] flex-col gap-2">
        <div className="h-[420px] w-full overflow-hidden rounded-2xl border border-bolt-elements-borderColor shadow-xl shadow-black/40">
          <PanelShell>
            <PanelHeader icon="i-ph:hard-drives-duotone" title="Buckets" subtitle="site-assets · 1,284 objects" />
            <BucketsTwoPane left={<BucketListSample />} right={<ObjectBrowserSample />} />
          </PanelShell>
        </div>
        <figcaption className="text-[11px] font-mono uppercase tracking-wider text-bolt-elements-textSecondary">
          BucketsTwoPane (data-bound two-pane · min-w-0 object pane)
        </figcaption>
      </figure>

      {/* 6 — Populated object browser, FULL-HEIGHT showcases (no clipping) so the headless screenshot
          captures the whole LIST and the whole GRID with their color-coded per-type glyphs. These carry
          NO testid — the canonical `buckets-object-list`/`buckets-object-grid` live inside the two-pane
          `buckets-populated-sample` above, so the probe + E2E stay unambiguous. */}
      <div className="mt-10 grid gap-8 lg:grid-cols-2 max-w-[940px]">
        <figure className="m-0 flex flex-col gap-2">
          <div className="w-full overflow-hidden rounded-2xl border border-bolt-elements-borderColor shadow-xl shadow-black/40">
            <PanelShell>
              <PanelHeader icon="i-ph:list-bullets-duotone" title="Objects" subtitle="list view · color-coded" />
              <SampleToolbar />
              <ObjectListSample />
            </PanelShell>
          </div>
          <figcaption className="text-[11px] font-mono uppercase tracking-wider text-bolt-elements-textSecondary">
            Object list (color-coded file-type glyphs)
          </figcaption>
        </figure>

        <figure className="m-0 flex flex-col gap-2">
          <div className="w-full overflow-hidden rounded-2xl border border-bolt-elements-borderColor shadow-xl shadow-black/40">
            <PanelShell>
              <PanelHeader icon="i-ph:squares-four-duotone" title="Objects" subtitle="grid view · thumbnails" />
              <SampleToolbar />
              <ObjectGridSample />
            </PanelShell>
          </div>
          <figcaption className="text-[11px] font-mono uppercase tracking-wider text-bolt-elements-textSecondary">
            Object grid (thumbnail slot + color-coded glyphs)
          </figcaption>
        </figure>
      </div>

      {/* 7 — B12 object PREVIEW modal body (image + text/code), static + sandbox-faithful. */}
      <PreviewShowcase />

      {/* 8 — Bulk-action bar — the floating selection toolbar (glass depth + accent wash + glowing cyan
          rail). Static mirror of the real `buckets-bulk-bar` so the headless screenshot proves the
          elevated chrome lands. No testid collision (the live bar's testid is only in the panel). */}
      <figure className="m-0 mt-10 flex max-w-[640px] flex-col gap-2" data-testid="buckets-bulk-bar-showcase">
        <div className="overflow-hidden rounded-2xl border border-bolt-elements-borderColor shadow-xl shadow-black/40">
          <PanelShell>
            <PanelHeader icon="i-ph:check-square-duotone" title="Bulk actions" subtitle="3 objects selected" />
            <div
              className="relative flex items-center gap-2 px-3 py-1.5 border-b border-bolt-elements-item-contentAccent/25 bg-[linear-gradient(90deg,color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_12%,transparent),color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_5%,transparent))] shadow-[0_2px_10px_-4px_color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_35%,transparent)]"
              role="toolbar"
              aria-label="3 objects selected — bulk actions"
            >
              <span
                aria-hidden="true"
                className="absolute left-0 top-1 bottom-1 w-[3px] rounded-full bg-bolt-elements-item-contentAccent shadow-[0_0_8px_color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_60%,transparent)]"
              />
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold tabular-nums text-bolt-elements-item-contentAccent">
                <span className="i-ph:check-square-duotone text-sm" aria-hidden="true" />3 selected
              </span>
              <span className="rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-2 py-0.5 text-[10px] text-bolt-elements-textSecondary">
                Clear
              </span>
              <span className="ml-auto inline-flex items-center gap-1 rounded-lg border border-bolt-elements-item-contentAccent/35 bg-[color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_6%,transparent)] px-2 py-0.5 text-[10px] text-bolt-elements-item-contentAccent">
                <span className="i-ph:download-simple text-xs" aria-hidden="true" /> Download
              </span>
              <span className="inline-flex items-center gap-1 rounded-lg border border-red-400/40 bg-bolt-elements-background-depth-1/90 px-2 py-0.5 text-[10px] text-red-400">
                <span className="i-ph:trash text-xs" aria-hidden="true" /> Delete
              </span>
            </div>
            <div className="p-3 text-[11px] text-bolt-elements-textSecondary">
              The floating bar rises in on the shared{' '}
              <code className="text-bolt-elements-item-contentAccent">psBucketRise</code> keyframe (motion-safe, with a
              reduced-motion opt-out) when a selection exists.
            </div>
          </PanelShell>
        </div>
        <figcaption className="text-[11px] font-mono uppercase tracking-wider text-bolt-elements-textSecondary">
          Bulk-action bar (glass depth · glowing cyan rail)
        </figcaption>
      </figure>
    </div>
  );
}
