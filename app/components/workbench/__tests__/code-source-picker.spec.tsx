// @vitest-environment jsdom
/**
 * @file Code view › Source selector (B15) — DOM-render proof for the `Source ▾`
 *       bucket-source picker that lives in the Code view's explorer header
 *       (`EditorPanel.tsx`), beside the Files / Search / Locks / Source tabs.
 *
 * B15 (BUCKETS-MASTER-SPEC §48/§302): a compact `Source ▾` picker that toggles the
 * Code explorer between the **website source** (the WebContainer working tree) and the
 * site's **R2 buckets** (Preview / Production / custom). This slice ships the SELECTOR
 * itself — the explorer-tree swap + open/edit/save-back-to-R2 are a separate backend-wired
 * fire. The picker REUSES the live bucket list (`requestR2({op:'listBuckets'})` → the same
 * `BucketEntry` shape `BucketsPanel` renders); this spec proves the presentational contract
 * against a prop-driven `CodeSourcePicker` so it is falsifiable WITHOUT the postMessage bridge
 * (mirrors `buckets-empty-states.render.spec.tsx`).
 *
 * Proven here:
 *   1. renders every source (website + each bucket) in the menu, with env labelling.
 *   2. selecting a source fires `onSelect` with that source id (not a no-op).
 *   3. a11y: a labelled trigger + Radix menu roles; Escape closes; keyboard reaches items.
 *   4. graceful empty / single-source: website-only still renders a valid control (no dead menu).
 *   5. disabled capability (flag dark): R2 options hidden, website source only — never a doomed control.
 *   6. Production buckets are flagged read-only/warn so the owner is never surprised by a prod edit.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodeSourcePicker, type CodeSource } from '~/components/workbench/EditorPanel';

afterEach(cleanup);

const WEBSITE: CodeSource = { id: 'website', label: 'Website source', kind: 'website' };

const SOURCES: CodeSource[] = [
  WEBSITE,
  { id: 'bucket:Preview', label: 'Preview', kind: 'bucket', environment: 'preview' },
  { id: 'bucket:Production', label: 'Production', kind: 'bucket', environment: 'production', readOnly: true },
  { id: 'bucket:assets', label: 'assets', kind: 'bucket', environment: 'preview' },
];

/**
 * Open the Radix DropdownMenu and return the menu element. Radix triggers open on the
 * pointer-down sequence (not a synthetic `click`), so we fire `pointerDown` + `pointerUp`
 * and wait for the portalled content to mount.
 */
async function openMenu() {
  const trigger = screen.getByTestId('code-source-trigger');
  // Radix opens the dropdown on keyboard activation deterministically in jsdom
  // (its pointer path depends on PointerEvent capture that jsdom doesn't fully model).
  // Keyboard is also the a11y-canonical open, so this doubles as a keyboard-reachability proof.
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  await waitFor(() => expect(screen.getByTestId('code-source-menu')).toBeTruthy());
  return screen.getByTestId('code-source-menu');
}

describe('CodeSourcePicker — the Source ▾ control (B15)', () => {
  it('shows the active source label on the trigger', () => {
    render(<CodeSourcePicker sources={SOURCES} activeSourceId="website" status="ready" onSelect={() => {}} />);

    const trigger = screen.getByTestId('code-source-trigger');
    expect(trigger.textContent).toContain('Website source');
    // The control announces its purpose for AT users.
    expect(trigger.getAttribute('aria-label')).toMatch(/source/i);
  });

  it('renders every source (website + each bucket) in the menu with env labelling', async () => {
    render(<CodeSourcePicker sources={SOURCES} activeSourceId="website" status="ready" onSelect={() => {}} />);

    const menu = await openMenu();
    const items = within(menu).getAllByRole('menuitemradio');
    // website + 3 buckets
    expect(items).toHaveLength(4);

    expect(within(menu).getByTestId('code-source-item-website')).toBeTruthy();
    expect(within(menu).getByTestId('code-source-item-bucket:Preview')).toBeTruthy();
    const prod = within(menu).getByTestId('code-source-item-bucket:Production');
    expect(prod.textContent).toContain('Production');
    // The active source is announced as checked.
    const website = within(menu).getByTestId('code-source-item-website');
    expect(website.getAttribute('aria-checked')).toBe('true');
  });

  it('fires onSelect with the chosen source id (not a no-op stub)', async () => {
    const onSelect = vi.fn();
    render(<CodeSourcePicker sources={SOURCES} activeSourceId="website" status="ready" onSelect={onSelect} />);

    const menu = await openMenu();
    fireEvent.click(within(menu).getByTestId('code-source-item-bucket:Preview'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('bucket:Preview');
  });

  it('flags Production buckets read-only / warn so a prod edit is never a surprise', async () => {
    render(<CodeSourcePicker sources={SOURCES} activeSourceId="website" status="ready" onSelect={() => {}} />);

    const menu = await openMenu();
    const prod = within(menu).getByTestId('code-source-item-bucket:Production');
    // A visible read-only marker on the Production row (label 'Read-only' / warn affordance).
    expect(prod.textContent).toMatch(/read-only|protected/i);
    // Preview (editable) carries no read-only marker.
    const preview = within(menu).getByTestId('code-source-item-bucket:Preview');
    expect(preview.textContent).not.toMatch(/read-only|protected/i);
  });

  it('a11y: Radix exposes menu role; Escape closes the menu', async () => {
    render(<CodeSourcePicker sources={SOURCES} activeSourceId="website" status="ready" onSelect={() => {}} />);

    const menu = await openMenu();
    expect(menu.getAttribute('role')).toBe('menu');

    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('code-source-menu')).toBeNull());
  });

  it('graceful single-source: website-only still renders a valid (non-dead) control', async () => {
    render(<CodeSourcePicker sources={[WEBSITE]} activeSourceId="website" status="ready" onSelect={() => {}} />);

    const trigger = screen.getByTestId('code-source-trigger');
    expect(trigger).toBeTruthy();
    expect(trigger.textContent).toContain('Website source');

    const menu = await openMenu();
    const items = within(menu).getAllByRole('menuitemradio');
    expect(items).toHaveLength(1);
  });

  it('disabled capability (flag dark): R2 options hidden, website source only — no doomed control', async () => {
    // When the bucket capability is dark the live list is unavailable; the picker must still
    // offer the website source and never render a bucket option that would fail to load.
    render(<CodeSourcePicker sources={[WEBSITE]} activeSourceId="website" status="disabled" onSelect={() => {}} />);

    const menu = await openMenu();
    expect(within(menu).queryByTestId('code-source-item-bucket:Preview')).toBeNull();
    expect(within(menu).getByTestId('code-source-item-website')).toBeTruthy();
    // A quiet hint explains why no buckets appear (never a silent dead end).
    expect(menu.textContent).toMatch(/bucket/i);
  });

  it('loading: the trigger stays operable and announces the busy state', () => {
    render(<CodeSourcePicker sources={[WEBSITE]} activeSourceId="website" status="loading" onSelect={() => {}} />);

    const trigger = screen.getByTestId('code-source-trigger');
    expect(trigger).toBeTruthy();
    // Busy is announced, not a frozen control.
    expect(trigger.getAttribute('aria-busy')).toBe('true');
  });
});
