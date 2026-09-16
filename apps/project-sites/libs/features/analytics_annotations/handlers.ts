import type { Context } from 'hono';
import type { Env, Variables } from '../../../src/types/env.js';
import { requireOrgId } from '../../../src/middleware/require_org.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import { CreateAnnotationSchema } from './schemas.js';
import { listAnnotations, createAnnotation, deleteAnnotation } from './service.js';

export async function handleListAnnotations(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<Response> {
  if (!(await isFlagOn(c.env, 'activity_feed', { orgId: requireOrgId(c) }))) return c.notFound();
  return c.json({ data: await listAnnotations(c.env, c.req.param('siteId')) });
}

export async function handleCreateAnnotation(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<Response> {
  if (!(await isFlagOn(c.env, 'activity_feed', { orgId: requireOrgId(c) }))) return c.notFound();
  const body = CreateAnnotationSchema.parse(await c.req.json());
  try { return c.json(await createAnnotation(c.env, requireOrgId(c), body.siteId, body.date, body.note, body.category), 201); }
  catch (e: unknown) {
    const m = e instanceof Error ? e.message : String(e);
    // site_not_found → 404; a dropped INSERT (annotation_create_failed) → 500 (an honest
    // error, not a lying 201 with a phantom id).
    return c.json({ error: m }, m === 'site_not_found' ? 404 : 500);
  }
}

export async function handleDeleteAnnotation(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<Response> {
  if (!(await isFlagOn(c.env, 'activity_feed', { orgId: requireOrgId(c) }))) return c.notFound();
  try {
    // Org-scoped delete: 204 only when a row was actually soft-deleted; 404 when the id
    // matched nothing in the caller's org (was a lying 204 + an IDOR on the id-only WHERE).
    const ok = await deleteAnnotation(c.env, requireOrgId(c), c.req.param('id'));
    return ok ? c.body(null, 204) : c.json({ error: 'not_found' }, 404);
  } catch (e: unknown) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}
