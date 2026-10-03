/**
 * Editor↔worker resource-bridge field-name SSOT (admin-relay / frontend side).
 *
 * The bolt editor (`app/`, React) posts `PS_RES_*` messages whose resource discriminant is
 * named `kind` (its `ResDetailRequestMessage` / `ResMutateRequestMessage` interfaces);
 * `resourceKind` is a LEGACY alias. Reading `resourceKind` FIRST was the fire-101 drift that
 * left `kind` undefined → every resource detail drill-in + inline D1 cell-edit short-circuited
 * silently ("Failed to load resource" / "Failed to perform action") before the Worker call.
 *
 * This is the ONE place the admin relay (`bolt-embed.service.ts`) resolves that precedence —
 * every `PS_RES_*` handler MUST call {@link resolveResourceKind}, never re-inline the ternary.
 * The full cross-surface Zod contract (editor + admin import one schema) is the `editor-bridge`
 * backlog item; it waits on the Angular build being able to consume `@project-sites/shared`
 * (the frontend currently MIRRORS shared schemas rather than importing them).
 */

/**
 * Resolve the resource `kind` from an incoming `PS_RES_*` bridge message.
 *
 * @param msg - the bridge message (only `kind`/`resourceKind` are read)
 * @returns the resource kind (e.g. `'d1'`, `'kv'`, `'r2'`), or `undefined` when neither field
 *   carries a non-empty string — handlers treat `undefined` as a hard "cannot resolve" error.
 */
export function resolveResourceKind(
  msg: { readonly kind?: unknown; readonly resourceKind?: unknown } | null | undefined,
): string | undefined {
  if (!msg) return undefined;
  if (typeof msg.kind === 'string' && msg.kind) return msg.kind;
  if (typeof msg.resourceKind === 'string' && msg.resourceKind) return msg.resourceKind;
  return undefined;
}

/** The `PS_RES_*` request types whose kind resolution this SSOT governs. Extend as handlers migrate. */
export const PS_RES_REQUEST_TYPES = ['PS_RES_DETAIL_REQUEST', 'PS_RES_MUTATE_REQUEST'] as const;
export type PsResRequestType = (typeof PS_RES_REQUEST_TYPES)[number];
