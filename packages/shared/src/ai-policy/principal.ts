/**
 * @module ai-policy/principal
 * @description
 * Principal resolution — the typed identity every AI entry point resolves
 * BEFORE consulting grants. Campaign §4: principal resolution covers
 * session | API key (psk_ token) | OAuth grant | site agent.
 *
 * This module ships the SCHEMA + the resolver INTERFACE only. The Worker-side
 * implementation (D1 `api_tokens` SHA-256 lookup, session middleware,
 * workers-oauth-provider grants, site-agent credentials) is wired in a later
 * campaign slice — the stub here throws so nothing can silently pass an
 * unresolved principal (fail closed, never fail open).
 */
import { z } from 'zod';
import { concreteIdSchema } from './capability.js';

/** The four principal kinds every entry point must resolve to (§4). */
export const principalKindSchema = z.enum(['session', 'api_key', 'oauth_grant', 'site_agent']);

/**
 * A RESOLVED principal — server-verified identity, never derived from
 * caller-supplied org/site ids (prompts, tool output, session IDs and
 * caller-supplied ids can never expand access).
 */
export const PrincipalSchema = z.discriminatedUnion('kind', [
  /** Signed-in admin/editor browser session. `refId` = session id. */
  z
    .object({
      kind: z.literal('session'),
      refId: concreteIdSchema,
      orgId: concreteIdSchema,
      userId: concreteIdSchema,
    })
    .strict(),
  /** ProjectSites API key (psk_ token, SHA-256 in D1). `refId` = token id — NEVER the plaintext. */
  z
    .object({
      kind: z.literal('api_key'),
      refId: concreteIdSchema,
      orgId: concreteIdSchema,
    })
    .strict(),
  /** OAuth access grant minted by the ProjectSites MCP OAuth provider. `refId` = grant id. */
  z
    .object({
      kind: z.literal('oauth_grant'),
      refId: concreteIdSchema,
      orgId: concreteIdSchema,
      clientId: concreteIdSchema,
    })
    .strict(),
  /** Per-site autonomous agent acting under a site-scoped credential. `refId` = agent id. */
  z
    .object({
      kind: z.literal('site_agent'),
      refId: concreteIdSchema,
      orgId: concreteIdSchema,
      siteId: concreteIdSchema,
    })
    .strict(),
]);

export type PrincipalKind = z.infer<typeof principalKindSchema>;
export type Principal = z.infer<typeof PrincipalSchema>;

/**
 * Raw credential material an entry point extracts from a request. At most one
 * rail should be populated; resolvers must reject ambiguous multi-credential
 * requests rather than guess.
 */
export const PrincipalResolutionContextSchema = z
  .object({
    /** `Authorization` header value — `Bearer psk_…` (API key) or an OAuth access token. */
    authorizationHeader: z.string().optional(),
    /** Anthropic-convention `x-api-key` header value. */
    xApiKey: z.string().optional(),
    /** Admin session credential (cookie / JWT) from the signed-in browser surface. */
    sessionToken: z.string().optional(),
    /** Per-site agent credential presented by scheduled/site-scoped automation. */
    siteAgentToken: z.string().optional(),
  })
  .strict();

export type PrincipalResolutionContext = z.infer<typeof PrincipalResolutionContextSchema>;

/**
 * Contract every entry point uses to turn raw credentials into a verified
 * {@link Principal}. Implementations MUST:
 * - verify against the authoritative store (D1 hashes / session store /
 *   OAuth grant records), never trust caller-supplied org/site ids;
 * - treat expiry + revocation as resolution failures (throw, never a guest);
 * - reject ambiguous contexts (two credential rails populated).
 */
export type ResolvePrincipal = (context: PrincipalResolutionContext) => Promise<Principal>;

/** Thrown by the placeholder resolver until the Worker wiring slice lands. */
export class PrincipalResolutionNotImplementedError extends Error {
  constructor() {
    super(
      'resolvePrincipal is an interface-only stub — the Worker-side implementation ' +
        '(D1 psk_ token lookup, session middleware, OAuth grants, site-agent credentials) ' +
        'lands in a later campaign slice. Fail closed: no principal, no execution.',
    );
    this.name = 'PrincipalResolutionNotImplementedError';
  }
}

/**
 * Interface stub — ALWAYS throws {@link PrincipalResolutionNotImplementedError}.
 * Wiring into the Worker's real credential stores is a later campaign slice;
 * until then any accidental call fails closed instead of minting a principal.
 */
export const resolvePrincipal: ResolvePrincipal = async (_context) => {
  throw new PrincipalResolutionNotImplementedError();
};
