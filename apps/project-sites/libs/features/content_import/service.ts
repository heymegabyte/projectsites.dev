/**
 * content_import feature — the flag-gated wiring that makes the pure export parsers in
 * `src/services/content_import.ts` reachable via an API. The parsing itself lives in the
 * (already unit-tested) parser service; this module owns only the flag key + the endpoint.
 */
export const FLAG_KEY = 'content_import';
