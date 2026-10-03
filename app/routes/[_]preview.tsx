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
            <PanelHeader icon="i-ph:bucket-duotone" title="Buckets" subtitle="R2 storage" />
            <PanelEmpty
              icon="i-ph:bucket-duotone"
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
    </div>
  );
}
