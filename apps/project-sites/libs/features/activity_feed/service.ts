/**
 * Activity Feed service — aggregates recent events from audit_logs + workflow_jobs.
 *
 * Queries D1 with org-scoping and pagination (cursor-based). Each row is
 * normalized into a unified {@link ActivityEntry} shape regardless of source
 * table. Designed for the admin dashboard live-activity widget.
 *
 * @module libs/features/activity_feed/service
 */
import type { Env } from '../../../src/types/env.js';
import { dbQuery } from '../../../src/services/db.js';
import type { ActivityEntry, ActivityKind } from './schemas.js';

interface AuditRow {
  id: string;
  action: string;
  message: string;
  actor_id: string | null;
  target_type: string | null;
  target_id: string | null;
  metadata_json: string | null;
  created_at: string;
}

/**
 * Map an audit-log `action` to a display `ActivityKind`. The explicit table uses the
 * REAL action strings the worker emits (e.g. `workflow.build_complete`, not the old
 * `build.completed` that never matched); the prefix buckets catch the rest of each
 * family; and an unmapped action falls back to the neutral `'activity'` — NOT the old
 * `'build.completed'`, which mislabeled every settings/snapshot/AI/env event as a green
 * "Build" on the dashboard hub (AL-328). The FE renders `'activity'` as "Activity" + a
 * neutral info dot.
 */
function mapKind(action: string): ActivityKind {
  const a = action.toLowerCase();
  const m: Record<string, ActivityKind> = {
    // builds (real actions are workflow.build_* / workflow.complete)
    'workflow.build_complete': 'build.completed',
    'workflow.complete': 'build.completed',
    'build.completed': 'build.completed',
    'workflow.build_started': 'build.started',
    'build.started': 'build.started',
    'workflow.build_error': 'build.failed',
    'build.failed': 'build.failed',
    // site lifecycle
    'site.published': 'site.published',
    'site.unpublished': 'site.archived',
    'site.archived': 'site.archived',
    'site.deleted': 'site.deleted',
    'site.snapshot.created': 'snapshot.created',
    'site.snapshot.deleted': 'snapshot.deleted',
    // data / config surfaces (the high-frequency real events)
    'site.sql.exec': 'data.query',
    'ai_settings.updated': 'settings.updated',
    'site.updated': 'settings.updated',
    'site.name_changed': 'settings.updated',
    'voice.agent_settings_updated': 'settings.updated',
    'voice.mcp_attachments_updated': 'settings.updated',
    'env_var.upsert': 'settings.updated',
    'env_var.delete': 'settings.updated',
    // domains / billing / members
    'hostname.added': 'domain.added',
    'hostname.deleted': 'domain.removed',
    'billing.subscription_updated': 'billing.plan_changed',
    'billing.payment_failed': 'billing.payment_failed',
    'member.added': 'member.invited',
    'member.removed': 'member.removed',
    'integration.connected': 'integration.connected',
    'integration.disconnected': 'integration.disconnected',
  };
  if (m[a]) return m[a];
  // Family prefix buckets — honest generics, never a false 'build.completed'.
  if (a.startsWith('workflow.')) return 'workflow.started';
  if (a.startsWith('billing.')) return 'billing.plan_changed';
  if (a.startsWith('member.') || a.startsWith('team.')) return 'member.invited';
  if (a.startsWith('hostname.') || a.startsWith('domain.')) return 'domain.added';
  if (a.startsWith('mcp.') || a.startsWith('integration.')) return 'integration.connected';
  if (a.startsWith('env_var.') || a.startsWith('ai_') || a.startsWith('voice.') || a.endsWith('.updated') || a.endsWith('.settings'))
    return 'settings.updated';
  return 'activity';
}

function actorName(row: AuditRow): string | null {
  try {
    if (row.metadata_json) {
      const meta = JSON.parse(row.metadata_json);
      if (meta.actor_email) return meta.actor_email;
      if (meta.actor_name) return meta.actor_name;
    }
  } catch { /* ignore parse errors */ }
  return row.actor_id;
}

/**
 * Fetch the most recent org-scoped activity entries.
 *
 * @param env - Worker bindings (needs D1)
 * @param orgId - Org scope
 * @param limit - Max entries (default 50, max 100)
 * @param cursor - ISO timestamp cursor for pagination (inclusive)
 */
export async function getActivityFeed(
  env: Env,
  orgId: string,
  limit = 50,
  cursor?: string,
): Promise<{ entries: ActivityEntry[]; hasMore: boolean }> {
  const effectiveLimit = Math.min(Math.max(limit, 1), 100);
  const rows = await dbQuery<AuditRow>(
    env.DB,
    `SELECT id, action, message, actor_id, target_type, target_id,
            metadata_json, created_at
     FROM audit_logs
     WHERE org_id = ?
       ${cursor ? 'AND created_at <= ?' : ''}
     ORDER BY created_at DESC
     LIMIT ?`,
    cursor ? [orgId, cursor, effectiveLimit + 1] : [orgId, effectiveLimit + 1],
  );

  const data = rows.data ?? [];
  const hasMore = data.length > effectiveLimit;
  const sliced = data.slice(0, effectiveLimit);

  const entries: ActivityEntry[] = sliced.map((r) => ({
    id: r.id,
    kind: mapKind(r.action),
    summary: r.message ?? r.action,
    actorName: actorName(r),
    targetType: r.target_type,
    targetName: r.target_id,
    siteSlug: null, // populated by a join or the caller
    timestamp: r.created_at,
  }));

  return { entries, hasMore };
}
