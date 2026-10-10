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

/** Left pane sample — a realistic bucket list with one selected row (mirrors the real Buckets tab). */
function BucketListSample() {
  const buckets = [
    { name: 'site-assets', objects: '1,284', selected: true },
    { name: 'user-uploads', objects: '312', selected: false },
    { name: 'backups', objects: '48', selected: false },
  ];

  return (
    <ul className="m-0 list-none p-2 flex flex-col gap-1">
      {buckets.map((b) => (
        <li
          key={b.name}
          className={`flex items-center gap-2 rounded-lg px-2.5 py-2 ${
            b.selected
              ? 'bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent'
              : 'text-bolt-elements-textSecondary'
          }`}
        >
          <span className="i-ph:hard-drives-duotone text-base shrink-0" aria-hidden="true" />
          <span className="truncate text-sm font-medium">{b.name}</span>
          <span className="ml-auto text-[10px] tabular-nums text-bolt-elements-textSecondary">{b.objects}</span>
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

/** Shared breadcrumb + upload affordance for the populated samples (mirrors the real object toolbar). */
function SampleToolbar() {
  return (
    <div className="flex items-center gap-1.5 border-b border-bolt-elements-borderColor/60 px-3 py-2 text-xs text-bolt-elements-textSecondary shrink-0">
      <span className="i-ph:hard-drives text-xs text-bolt-elements-item-contentAccent" aria-hidden="true" />
      <span className="text-bolt-elements-item-contentAccent">site-assets</span>
      <button className="ml-auto flex items-center gap-1 rounded-md bg-bolt-elements-item-backgroundAccent px-2 py-1 text-[11px] text-bolt-elements-item-contentAccent">
        <span className="i-ph:upload-simple text-xs" aria-hidden="true" />
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
          className={`group flex items-center gap-3 rounded-lg px-2.5 py-2 transition-colors hover:bg-bolt-elements-item-contentAccent/[0.06] ${OBJECT_ENTRANCE_CLASS}`}
        >
          <span className={`${iconForObject(o.key)} ${colorForObject(o.key)} text-lg shrink-0`} aria-hidden="true" />
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
          className={`group flex flex-col gap-1.5 rounded-xl border border-bolt-elements-borderColor/70 bg-bolt-elements-background-depth-2 p-2 transition-all hover:-translate-y-px hover:border-bolt-elements-item-contentAccent/50 hover:bg-bolt-elements-background-depth-3 hover:shadow-sm hover:shadow-black/30 ${OBJECT_ENTRANCE_CLASS}`}
        >
          <div className="flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br from-bolt-elements-background-depth-1 to-bolt-elements-item-contentAccent/[0.04] ring-1 ring-inset ring-bolt-elements-borderColor/40">
            {isImageKey(o.key) ? (
              <span className="i-ph:image-duotone text-4xl text-sky-300" aria-hidden="true" />
            ) : (
              <span className={`${iconForObject(o.key)} ${colorForObject(o.key)} text-4xl`} aria-hidden="true" />
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
                <span className="inline-flex items-center gap-1.5 rounded-lg border border-bolt-elements-item-contentAccent/35 bg-bolt-elements-item-contentAccent/[0.06] px-3 py-1 text-[11px] text-bolt-elements-item-contentAccent">
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
      <h1 className="text-bolt-elements-textPrimary text-lg font-semibold mb-6">Panel Primitive Gallery</h1>

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
    </div>
  );
}
