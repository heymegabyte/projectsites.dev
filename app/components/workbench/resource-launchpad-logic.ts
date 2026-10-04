/**
 * @file Resources EmptyLaunchpad — compose the create-FIRST action that turns the empty platform
 * inventory from a dead "nothing here" into a one-click launchpad (RES-OVERVIEW-EMPTY-CTA).
 *
 * @remarks
 * When a site has no platform resources yet, the Resources tab should not dead-end on a passive
 * "watching for new resources" pulse — a busy, non-technical owner needs ONE obvious next step
 * (per `embarrassingly-easy-to-use`: empty states are launchpads). It is NOT a manual Reconcile or
 * Refresh button — the inventory already self-updates (per `real-time-data-no-manual-refresh`).
 * Instead, per `ai-permanence` (AI does the work, the owner confirms), the launchpad asks the
 * editor AI to add the owner's first resource. It adds NO new AI endpoint and calls NO model
 * directly — it REUSES the editor's own chat by posting a `PS_SUBMIT_PROMPT` bridge message to the
 * parent admin, which round-trips it straight back into `Chat.client.tsx`'s `append({ role:'user' })`
 * (the exact pattern `sql-explain-logic.ts` uses for "Explain this").
 *
 * These helpers are PURE (no React, no bridge, no fetch) so they unit-test in isolation: the prompt
 * text and the dispatch shape. The component ({@link module:app/components/workbench/ResourceOverviewPanel})
 * owns only the button + the `postToParent` call (it mints the transport `correlationId`).
 */

/**
 * The owner-friendly prompt the launchpad hands to the editor AI chat. Speaks the owner's words
 * (database / storage / email / form), never internal jargon, and asks the AI to recommend + wire
 * the right first resource rather than making the owner configure anything.
 */
export const RESOURCE_LAUNCHPAD_PROMPT =
  'Help me add my first resource to this site. Recommend what would be most useful ' +
  '(for example a database for saving records, storage for files and images, an email sender, ' +
  'or a contact form), then set it up for me.';

/** The composed natural-language prompt sent to the editor AI chat. Pure — always the same text. */
export function composeAddResourcePrompt(): string {
  return RESOURCE_LAUNCHPAD_PROMPT;
}

/** The `PS_SUBMIT_PROMPT` payload minus the transport-owned `correlationId` (the caller mints that). */
export interface AddResourceDispatch {
  type: 'PS_SUBMIT_PROMPT';
  prompt: string;
  siteId: string;
  slug: string;
}

/**
 * Build the bridge payload that hands the launchpad prompt to the EXISTING editor AI chat. The caller
 * adds a `correlationId` and posts it via `postToParent` — the parent admin relays it back into the
 * chat's `PS_SUBMIT_PROMPT` handler (`append({ role:'user', ... })`). `siteId`/`slug` default to `''`
 * (the chat handler reads only `prompt`); pass them through when known.
 *
 * @example
 * buildAddResourceDispatch()
 * // { type: 'PS_SUBMIT_PROMPT', prompt: RESOURCE_LAUNCHPAD_PROMPT, siteId: '', slug: '' }
 */
export function buildAddResourceDispatch(siteId = '', slug = ''): AddResourceDispatch {
  return { type: 'PS_SUBMIT_PROMPT', prompt: composeAddResourcePrompt(), siteId, slug };
}
