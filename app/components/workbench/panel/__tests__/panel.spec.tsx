/**
 * Regression lock for the shared workbench panel primitives (PanelShell + PanelHeader).
 * Renders to static markup (no DOM/testing-library dependency) and asserts the invariants the
 * re-architecture depends on: ONE dark brand-accented shell root, and ONE canonical header
 * (single <h2>, accent icon badge, optional subtitle + actions). If a future edit drifts the
 * chrome, this fails here instead of shipping an off-brand panel.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PanelShell, PanelHeader, PanelLoading, PanelEmpty } from '../index';

describe('workbench panel primitives', () => {
  it('PanelShell renders the dark, brand-accented column with the testId + children', () => {
    const html = renderToStaticMarkup(<PanelShell testId="panel-x">body</PanelShell>);
    expect(html).toContain('data-testid="panel-x"');
    expect(html).toContain('bg-bolt-elements-background-depth-1');
    expect(html).toContain('[color-scheme:dark]');
    expect(html).toContain('body');
  });

  it('PanelHeader renders exactly ONE <h2> title + accent icon + subtitle + actions', () => {
    const html = renderToStaticMarkup(
      <PanelHeader
        icon="i-ph:stack-duotone"
        title="Resources"
        subtitle="3 tables"
        actions={<button type="button">Act</button>}
      />,
    );
    expect((html.match(/<h2/g) || []).length).toBe(1);
    expect(html).toContain('Resources');
    expect(html).toContain('i-ph:stack-duotone');
    expect(html).toContain('text-bolt-elements-item-contentAccent');
    expect(html).toContain('3 tables');
    expect(html).toContain('Act');
  });

  it('PanelHeader omits the subtitle row when no subtitle is given', () => {
    const html = renderToStaticMarkup(<PanelHeader icon="i-ph:table-duotone" title="New table" />);
    expect(html).toContain('New table');
    // the subtitle <p> carries the tertiary text token — absent when no subtitle
    expect(html).not.toContain('text-bolt-elements-textTertiary');
  });

  it('PanelHeader renders the leading slot BEFORE the icon badge (detail back-nav)', () => {
    const html = renderToStaticMarkup(
      <PanelHeader
        icon="i-ph:table-duotone"
        title="customers"
        leading={<button type="button">Back</button>}
      />,
    );
    // leading content present, and ordered before the accent icon badge
    expect(html).toContain('Back');
    expect(html.indexOf('Back')).toBeLessThan(html.indexOf('i-ph:table-duotone'));
  });

  it('PanelLoading renders the contained Nebula + status label (never a generic spinner)', () => {
    const html = renderToStaticMarkup(<PanelLoading label="Loading your resources…" />);
    expect(html).toContain('data-testid="panel-loading"');
    expect(html).toContain('role="status"');
    // the living nebula canvas, not an animate-spin circle-notch
    expect(html).toContain('ps-nebula-canvas');
    expect(html).not.toContain('animate-spin');
    expect(html).toContain('Loading your resources…');
  });

  it('PanelEmpty renders a launchpad: icon badge + title + description + the one action', () => {
    const html = renderToStaticMarkup(
      <PanelEmpty
        testId="buckets-empty"
        icon="i-ph:bucket-duotone"
        title="No buckets yet"
        description="Create your first bucket to store files."
        action={<button type="button">Create your first bucket</button>}
      />,
    );
    expect(html).toContain('data-testid="buckets-empty"');
    expect(html).toContain('i-ph:bucket-duotone');
    expect(html).toContain('text-bolt-elements-item-contentAccent');
    expect(html).toContain('No buckets yet');
    expect(html).toContain('Create your first bucket to store files.');
    expect(html).toContain('Create your first bucket');
  });

  it('PanelEmpty omits the description + action when not provided', () => {
    const html = renderToStaticMarkup(<PanelEmpty icon="i-ph:folder-duotone" title="Nothing here" />);
    expect(html).toContain('Nothing here');
    expect(html).not.toContain('max-w-[320px]');
  });
});
