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
import { BucketsTwoPane } from '~/components/workbench/BucketsTwoPane';

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
      <figcaption className="text-[11px] font-mono uppercase tracking-wider text-bolt-elements-textTertiary">
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
          <span className="ml-auto text-[10px] tabular-nums text-bolt-elements-textTertiary">{b.objects}</span>
        </li>
      ))}
    </ul>
  );
}

/** Right pane sample — a prefix breadcrumb + an object table whose long keys prove the min-w-0 shrink. */
function ObjectBrowserSample() {
  const objects = [
    { key: 'images/2026/hero-background-full-bleed-1920x1080.webp', size: '284 KB' },
    { key: 'images/2026/team/founder-portrait-retouched-final-v3.jpg', size: '198 KB' },
    { key: 'documents/annual-report-2026-accessible-tagged.pdf', size: '1.2 MB' },
  ];

  return (
    <div className="flex flex-col min-h-0">
      <div className="flex items-center gap-1.5 border-b border-bolt-elements-borderColor/60 px-3 py-2 text-xs text-bolt-elements-textSecondary">
        <span className="text-bolt-elements-item-contentAccent">site-assets</span>
        <span className="i-ph:caret-right text-[10px]" aria-hidden="true" />
        <span>images</span>
        <span className="i-ph:caret-right text-[10px]" aria-hidden="true" />
        <span className="text-bolt-elements-textPrimary">2026</span>
        <button className="ml-auto flex items-center gap-1 rounded-md bg-bolt-elements-item-backgroundAccent px-2 py-1 text-[11px] text-bolt-elements-item-contentAccent">
          <span className="i-ph:upload-simple text-xs" aria-hidden="true" />
          Upload
        </button>
      </div>
      <ul className="m-0 list-none overflow-auto p-1 modern-scrollbar">
        {objects.map((o) => (
          <li key={o.key} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-bolt-elements-textSecondary">
            <span className="i-ph:file-duotone text-base shrink-0" aria-hidden="true" />
            {/* min-w-0 + truncate: the long key shrinks to the pane and ellipsizes instead of
                overflowing the parent — the exact clip the BucketsTwoPane min-w-0 right pane prevents. */}
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{o.key}</span>
            <span className="shrink-0 text-[10px] tabular-nums text-bolt-elements-textTertiary">{o.size}</span>
          </li>
        ))}
      </ul>
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
        <figcaption className="text-[11px] font-mono uppercase tracking-wider text-bolt-elements-textTertiary">
          BucketsTwoPane (data-bound two-pane · min-w-0 object pane)
        </figcaption>
      </figure>
    </div>
  );
}
