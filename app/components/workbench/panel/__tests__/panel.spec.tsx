/**
 * Regression lock for the shared workbench panel primitives (PanelShell + PanelHeader).
 * Renders to static markup (no DOM/testing-library dependency) and asserts the invariants the
 * re-architecture depends on: ONE dark brand-accented shell root, and ONE canonical header
 * (single <h2>, accent icon badge, optional subtitle + actions). If a future edit drifts the
 * chrome, this fails here instead of shipping an off-brand panel.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PanelShell, PanelHeader } from '../index';

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
});
