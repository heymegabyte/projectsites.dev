/**
 * @module libs/features/site_automations/service
 * @description Read-only data layer for the Automations panel — lists a site's
 * workflow/automation instances from the `workflow_jobs` D1 table (the system
 * of record for every dispatched job). Display reconciles with the store: real
 * rows map 1:1 to list items; an honest-empty store yields `[]`
 * (per [[verify-against-source-of-truth]]).
 *
 * @packageDocumentation
 */
import type { Env } from '../../../src/types/env.js';
import { dbQuery } from '../../../src/services/db.js';
import type { Automation } from './schemas.js';

/** Raw `workflow_jobs` row columns this feature reads. */
interface WorkflowJobRow {
  id: string;
  job_name: string;
  status: string;
  created_at: string;
  completed_at: string | null;
}

/** Max rows returned — the panel is a recent-activity list, not a full export. */
const LIMIT = 200;

/**
 * List a site's automation/workflow instances, newest first, shaped for the UI.
 *
 * Ownership is the CALLER's responsibility (`assertSiteOwned` in the handler);
 * this query is still hard-scoped to `site_id = ?` so a bug upstream can't widen
 * the result set beyond the one site.
 *
 * @param env - Worker env (uses `env.DB`).
 * @param siteId - The owned site id from the route param.
 * @returns Automation list items; `[]` when the store has none (honest-empty).
 */
export async function listSiteAutomations(env: Env, siteId: string): Promise<Automation[]> {
  const { data } = await dbQuery<WorkflowJobRow>(
    env.DB,
    `SELECT id, job_name, status, created_at, completed_at
       FROM workflow_jobs
      WHERE site_id = ?
        AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT ${LIMIT}`,
    [siteId],
  );

  return data.map((row) => ({
    id: row.id,
    type: row.job_name,
    status: row.status,
    created_at: row.created_at,
    finished_at: row.completed_at,
  }));
}
