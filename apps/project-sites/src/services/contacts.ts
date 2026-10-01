/**
 * @module services/contacts
 *
 * @description
 * The ONE write path for the `contacts` CRM table. `contacts` is a DEDUPE table
 * by design — `uniq_contacts_org_email` UNIQUE (org_id, lower(email)) WHERE
 * email IS NOT NULL AND deleted_at IS NULL, with first_seen_at/last_seen_at
 * lifecycle columns — so a blind INSERT is WRONG for every repeat submitter:
 * the unique index rejects, callers swallow the error into a log line, and the
 * repeat touch is silently lost (stale last_seen_at, lost latest message; in
 * `handleContactForm` a false `persisted=false` that could hard-error an
 * innocent visitor when the email rail also hiccups). Discovered live in the
 * fire-61 long-trail Phase E journey; locked by `__tests__/contacts_upsert.test.ts`.
 *
 * Semantics: first touch INSERTS (first_seen_at = last_seen_at = now); repeat
 * touch UPDATES the existing identity — latest `metadata`/`source`, advanced
 * `last_seen_at`, identity fields ENRICHED never erased (COALESCE), immutable
 * `id`/`first_seen_at`/`created_at`. The conflict target matches the PARTIAL
 * unique index exactly (expression + WHERE), per SQLite upsert rules.
 */
import type { Env } from '../types/env.js';

/** One CRM touch — a validated submission attributable to an org (and optionally a site). */
export interface ContactTouch {
  /** Row id used ONLY on first touch (repeat touches keep the existing id). */
  id: string;
  org_id: string;
  site_id: string | null;
  name: string | null;
  /** Dedupe key (org_id + lower(email)). Callers validate format upstream. */
  email: string;
  phone: string | null;
  source: string;
  /** JSON string — the LATEST touch's payload wins on repeat. */
  metadata: string;
}

/**
 * Insert-or-update a contact identity, honoring the org-scoped email dedupe.
 *
 * @param db - D1 (or the real-SQLite test facade).
 * @param touch - The submission being captured.
 * @returns `{ error: null }` on success (insert OR update), `{ error }` with the
 *   message on genuine failure — callers keep their log-don't-throw stance.
 *
 * @example
 * const { error } = await upsertContact(env.DB, { id: crypto.randomUUID(), org_id, site_id,
 *   name, email, phone: phone ?? null, source: 'form', metadata: JSON.stringify({ message }) });
 */
export async function upsertContact(
  db: Env['DB'],
  touch: ContactTouch,
): Promise<{ error: string | null }> {
  const now = new Date().toISOString();
  try {
    await db
      .prepare(
        `INSERT INTO contacts (
           id, org_id, site_id, name, email, phone, source, metadata,
           first_seen_at, last_seen_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (org_id, lower(email)) WHERE email IS NOT NULL AND deleted_at IS NULL
         DO UPDATE SET
           name         = COALESCE(excluded.name, contacts.name),
           phone        = COALESCE(excluded.phone, contacts.phone),
           site_id      = COALESCE(excluded.site_id, contacts.site_id),
           source       = excluded.source,
           metadata     = excluded.metadata,
           last_seen_at = excluded.last_seen_at,
           updated_at   = excluded.updated_at`,
      )
      .bind(
        touch.id,
        touch.org_id,
        touch.site_id,
        touch.name,
        touch.email,
        touch.phone,
        touch.source,
        touch.metadata,
        now,
        now,
        now,
        now,
      )
      .run();
    return { error: null };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
