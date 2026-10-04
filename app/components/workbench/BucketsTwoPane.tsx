/**
 * @file BucketsTwoPane — the Buckets Resources tab's two-pane LAYOUT primitive, extracted from the
 * ~2000-line bridge-coupled `BucketsPanel` so it is pure, reusable, independently render-testable,
 * AND importable by the dependency-light `/_preview` visual-QA gallery without pulling the whole
 * panel (and its postMessage bridge) into that chunk.
 *
 * Shape: bucket LIST (left, fixed-width on wide screens) + object BROWSER (right, flex-fill). The
 * right pane carries `min-w-0` so it can shrink to its flex share inside the narrow (~600px) editor
 * panel and scroll INTERNALLY instead of overflowing the `overflow-hidden` parent — the clip fix
 * from fire-153, regression-locked in `__tests__/buckets-empty-states.render.spec.tsx` and pixel-
 * proved in the `/_preview` gallery (fire-160 extract → fire-162 own-module + gallery frame).
 *
 * Pure (props → JSX), no bridge / no state / no side effects — safe to mount in a static route.
 */
import React from 'react';

export function BucketsTwoPane({ left, right }: { left: React.ReactNode; right: React.ReactNode }) {
  return (
    <div className="relative flex-1 overflow-hidden flex flex-col lg:flex-row min-h-0" data-testid="buckets-two-pane">
      {/* Left: bucket list (fixed width on wide screens). */}
      <div className="lg:w-72 shrink-0 border-b lg:border-b-0 lg:border-r border-bolt-elements-borderColor/60 overflow-auto modern-scrollbar">
        {left}
      </div>
      {/* Right: object browser. `min-w-0` lets the pane shrink to its flex share inside the narrow
          (~600px) editor panel so the browser scrolls internally instead of overflowing the
          `overflow-hidden` parent (was clipped at the panel edge — fire-153). */}
      <div className="flex-1 min-h-0 min-w-0 flex flex-col" data-testid="buckets-object-pane">
        {right}
      </div>
    </div>
  );
}
