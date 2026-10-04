/**
 * resource-launchpad-logic.spec.ts — TDD spec for the Resources-tab EmptyLaunchpad's
 * create-FIRST action (RES-OVERVIEW-EMPTY-CTA, Editor EPIC part A).
 *
 * The empty Resources inventory used to show ONLY a passive "watching for new resources"
 * pulse — a dead end: a busy owner sees "nothing here" and has no obvious next step. Per
 * `embarrassingly-easy-to-use` (empty states are launchpads) + `ai-permanence` (AI does the
 * work), the launchpad now offers ONE real action: ask the editor AI to add the owner's first
 * platform resource. It is NOT a manual Reconcile/Refresh button (the surface self-updates,
 * per `real-time-data-no-manual-refresh`); it REUSES the editor AI chat via a `PS_SUBMIT_PROMPT`
 * bridge message (same pattern as sql-explain-logic.ts) — no new endpoint, no model call here.
 *
 * These helpers are PURE (no React, no bridge, no fetch) so they unit-test in isolation: the
 * composed prompt text and the `PS_SUBMIT_PROMPT` dispatch shape (`siteId`/`slug` default to ''
 * because the chat handler reads only `prompt`).
 */
import { describe, it, expect } from 'vitest';
import {
  RESOURCE_LAUNCHPAD_PROMPT,
  composeAddResourcePrompt,
  buildAddResourceDispatch,
} from '../resource-launchpad-logic';

describe('resource-launchpad-logic', () => {
  describe('composeAddResourcePrompt', () => {
    it('returns a non-empty, owner-friendly add-a-resource prompt', () => {
      const prompt = composeAddResourcePrompt();

      expect(prompt).toBe(RESOURCE_LAUNCHPAD_PROMPT);
      expect(prompt.length).toBeGreaterThan(20);
      // Speaks the owner's words — names the real primitives, not internal jargon.
      expect(prompt.toLowerCase()).toContain('database');
      expect(prompt.toLowerCase()).toMatch(/storage|bucket/);
    });
  });

  describe('buildAddResourceDispatch', () => {
    it('builds a PS_SUBMIT_PROMPT dispatch carrying the composed prompt', () => {
      const dispatch = buildAddResourceDispatch();

      expect(dispatch).toEqual({
        type: 'PS_SUBMIT_PROMPT',
        prompt: RESOURCE_LAUNCHPAD_PROMPT,
        siteId: '',
        slug: '',
      });
    });

    it('threads siteId/slug through when the caller knows them', () => {
      const dispatch = buildAddResourceDispatch('site_123', 'acme');

      expect(dispatch.siteId).toBe('site_123');
      expect(dispatch.slug).toBe('acme');
      expect(dispatch.prompt).toBe(RESOURCE_LAUNCHPAD_PROMPT);
    });

    it('never carries a transport correlationId (the caller mints that)', () => {
      expect(buildAddResourceDispatch()).not.toHaveProperty('correlationId');
    });
  });
});
