// @vitest-environment jsdom
/**
 * ResourcesPanel.a11y.spec.tsx — TDD spec for RES-A11Y-FOCUS (Editor EPIC, part A residual):
 * make the editor Resources tab bar fully keyboard + screen-reader accessible per the WCAG APG
 * Tabs pattern. An a11y completeness gate for "Editor finished".
 *
 * We render the whole `ResourcesPanel` (jsdom) with the cross-origin bridge stubbed, and assert the
 * APG Tabs contract on the SECTION tab bar + its env switcher:
 *   1. the section container is a `role="tablist"`; each tab is `role="tab"` with `aria-selected`
 *      tracking the active section + an `id` + an `aria-controls` pointing at the panel;
 *   2. the content region is a `role="tabpanel"` with `aria-labelledby` = the active tab's id;
 *   3. ROVING tabindex — only the active tab is `tabindex=0`, the rest `-1`;
 *   4. ArrowRight / ArrowLeft (+ Home / End) MOVE selection (roving) and wrap;
 *   5. the env switcher is a `role="radiogroup"`; each option is a `role="radio"` with `aria-checked`
 *      + roving tabindex; ArrowRight moves the checked env.
 *
 * All existing behavior (section switching, testids, env `aria-pressed`→`aria-checked`, styling) is
 * preserved — this slice is ADDITIVE semantics + keyboard wiring, not a rewrite.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';

// The panel imports the cross-origin bridge at module-eval; stub it so nothing real fires here.
vi.mock('~/lib/embed/embedded-mode', () => ({
  isEmbedded: true,
  onParentMessage: () => () => {},
  postToastToParent: vi.fn(),
  requestResMedia: vi.fn().mockResolvedValue({ ok: true, assets: [], usage: {} }),
  requestMediaUpload: vi.fn(),
  requestResSiteFiles: vi.fn().mockResolvedValue({ ok: true, files: [] }),
  requestAutomations: vi.fn().mockResolvedValue({ ok: true, automations: [] }),
  requestAutomationRetry: vi.fn(),
}));

import { ResourcesPanel } from './ResourcesPanel';

afterEach(() => cleanup());

/** The four section tabs, in render order. */
const SECTIONS = ['media', 'files', 'buckets', 'automations'] as const;

function sectionTablist(): HTMLElement {
  return screen.getByRole('tablist', { name: /resource sections/i });
}

function sectionTab(value: (typeof SECTIONS)[number]): HTMLElement {
  return screen.getByTestId(`resources-section-${value}`);
}

describe('ResourcesPanel — Resources tab bar is an APG tablist', () => {
  it('exposes a role=tablist with one role=tab per section', () => {
    render(<ResourcesPanel />);
    const list = sectionTablist();
    const tabs = within(list).getAllByRole('tab');
    expect(tabs).toHaveLength(SECTIONS.length);
    for (const value of SECTIONS) {
      expect(sectionTab(value).getAttribute('role')).toBe('tab');
    }
  });

  it('tracks aria-selected on the active tab (media is active first)', () => {
    render(<ResourcesPanel />);
    expect(sectionTab('media').getAttribute('aria-selected')).toBe('true');
    expect(sectionTab('files').getAttribute('aria-selected')).toBe('false');
    expect(sectionTab('buckets').getAttribute('aria-selected')).toBe('false');
    expect(sectionTab('automations').getAttribute('aria-selected')).toBe('false');
  });

  it('each tab has an id + aria-controls, and the active panel is labelled by the active tab', () => {
    render(<ResourcesPanel />);
    const media = sectionTab('media');
    const id = media.getAttribute('id');
    const controls = media.getAttribute('aria-controls');
    expect(id).toBeTruthy();
    expect(controls).toBeTruthy();

    // The content region is a tabpanel whose aria-labelledby points back at the active tab.
    const panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('id')).toBe(controls);
    expect(panel.getAttribute('aria-labelledby')).toBe(id);
  });

  it('implements roving tabindex — only the active tab is tabbable', () => {
    render(<ResourcesPanel />);
    expect(sectionTab('media').getAttribute('tabindex')).toBe('0');
    expect(sectionTab('files').getAttribute('tabindex')).toBe('-1');
    expect(sectionTab('buckets').getAttribute('tabindex')).toBe('-1');
    expect(sectionTab('automations').getAttribute('tabindex')).toBe('-1');
  });

  it('ArrowRight moves selection to the next tab (roving)', () => {
    render(<ResourcesPanel />);
    const media = sectionTab('media');
    media.focus();
    fireEvent.keyDown(media, { key: 'ArrowRight' });

    // Selection + the roving tabstop moved to Files.
    expect(sectionTab('files').getAttribute('aria-selected')).toBe('true');
    expect(sectionTab('media').getAttribute('aria-selected')).toBe('false');
    expect(sectionTab('files').getAttribute('tabindex')).toBe('0');
    expect(sectionTab('media').getAttribute('tabindex')).toBe('-1');
    // And the live panel now reflects the Files tab.
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(sectionTab('files').getAttribute('id'));
  });

  it('ArrowLeft from the first tab wraps to the last (automations)', () => {
    render(<ResourcesPanel />);
    const media = sectionTab('media');
    media.focus();
    fireEvent.keyDown(media, { key: 'ArrowLeft' });
    expect(sectionTab('automations').getAttribute('aria-selected')).toBe('true');
    expect(sectionTab('automations').getAttribute('tabindex')).toBe('0');
  });

  it('Home / End jump to the first / last tab', () => {
    render(<ResourcesPanel />);
    const media = sectionTab('media');
    media.focus();
    fireEvent.keyDown(media, { key: 'End' });
    expect(sectionTab('automations').getAttribute('aria-selected')).toBe('true');

    const last = sectionTab('automations');
    fireEvent.keyDown(last, { key: 'Home' });
    expect(sectionTab('media').getAttribute('aria-selected')).toBe('true');
  });
});

describe('ResourcesPanel — env switcher is an APG radiogroup', () => {
  it('exposes a role=radiogroup with a role=radio per environment + aria-checked', () => {
    render(<ResourcesPanel />);
    const group = screen.getByRole('radiogroup', { name: /environment/i });
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(2);

    const prod = screen.getByTestId('resources-env-production');
    const preview = screen.getByTestId('resources-env-preview');
    expect(prod.getAttribute('role')).toBe('radio');
    expect(preview.getAttribute('role')).toBe('radio');
    // Production is the default persisted env.
    expect(prod.getAttribute('aria-checked')).toBe('true');
    expect(preview.getAttribute('aria-checked')).toBe('false');
    // Roving: only the checked radio is tabbable.
    expect(prod.getAttribute('tabindex')).toBe('0');
    expect(preview.getAttribute('tabindex')).toBe('-1');
  });

  it('ArrowRight moves the checked environment (roving)', () => {
    render(<ResourcesPanel />);
    const prod = screen.getByTestId('resources-env-production');
    prod.focus();
    fireEvent.keyDown(prod, { key: 'ArrowRight' });
    const preview = screen.getByTestId('resources-env-preview');
    expect(preview.getAttribute('aria-checked')).toBe('true');
    expect(prod.getAttribute('aria-checked')).toBe('false');
    expect(preview.getAttribute('tabindex')).toBe('0');
  });
});
