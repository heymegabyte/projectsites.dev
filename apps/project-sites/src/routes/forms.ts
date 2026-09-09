/**
 * @module routes/forms
 * @description Standardized forms + newsletter integrations API.
 *
 * Two surfaces:
 *
 * 1. **Public ingest** — `POST /api/v1/forms/submit`
 *    Any *.projectsites.dev site (or external client) posts here with the
 *    `X-Site-Slug` header. We capture the submission to D1 and fan out to
 *    every active newsletter integration on that site.
 *
 * 2. **Auth-gated CRUD** — `/api/sites/:siteId/{forms,integrations}`
 *    Used by the Dashboard E-mail tab to list submissions, connect/disconnect
 *    providers, and toggle integrations.
 *
 * Provider-specific dispatch lives in `services/newsletter_dispatch.ts`.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import {
  badRequest,
  forbidden,
  notFound,
  unauthorized,
  internalError,
  createIntegrationSchema,
  updateIntegrationSchema,
  formSubmissionInputSchema,
  DOMAINS,
} from '@project-sites/shared';
import type { Env, Variables } from '../types/env.js';
import { dbExecute, dbInsert, dbQuery, dbQueryOne } from '../services/db.js';
import { encrypt, decrypt } from '../services/ai_crypto.js';
import { requireOwnedSite } from '../services/site_ownership.js';
import { dispatchToIntegrations, type IntegrationRow } from '../services/newsletter_dispatch.js';
import { improveRouterPrompt } from '../services/form_router.js';
import * as auditService from '../services/audit.js';
import { getEmailProvider } from '../platform/email-router.js';

/** Workers AI model used for reply drafting. NEVER use the bare alias. */
const REPLY_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast' as const;

/**
 * Approximate USD cost per 1M output tokens for Llama 3.3 70B fp8-fast on
 * Workers AI (Nov 2025 published rate, $0.50/M for input, $0.75/M for
 * output — we use the output rate as a worst-case). Used purely for the
 * UI breakdown — never gates anything.
 */
const REPLY_COST_PER_MTOK_USD = 0.75;

const sendReplyBody = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(20_000),
  override_to: z.string().email().optional(),
});

const forms = new Hono<{ Bindings: Env; Variables: Variables }>();

// ─── Public ingest ───────────────────────────────────────────

forms.post('/api/v1/forms/submit', async (c) => {
  const slug = c.req.header('x-site-slug') ?? c.req.query('slug');
  if (!slug) throw badRequest('Missing X-Site-Slug header');

  const site = await dbQueryOne<{ id: string; org_id: string; slug: string }>(
    c.env.DB,
    'SELECT id, org_id, slug FROM sites WHERE slug = ? AND deleted_at IS NULL',
    [slug],
  );
  if (!site) throw notFound('Site not found');

  // Origin allow-list: default subdomain + any provisioned hostname for the site.
  const origin = c.req.header('origin') ?? '';
  const allowed = new Set<string>([
    `https://${site.slug}${DOMAINS.SITES_SUFFIX}`,
    `https://${DOMAINS.SITES_BASE}`,
  ]);
  const hostnames = await dbQuery<{ hostname: string }>(
    c.env.DB,
    'SELECT hostname FROM hostnames WHERE site_id = ? AND deleted_at IS NULL',
    [site.id],
  );
  for (const row of hostnames.data) {
    allowed.add(`https://${row.hostname}`);
  }
  // Allow no-origin (curl, server-side) and localhost dev origins.
  const isAllowed =
    !origin ||
    allowed.has(origin) ||
    origin.startsWith('http://localhost:') ||
    origin.startsWith('http://127.0.0.1:');
  if (!isAllowed) throw forbidden(`Origin not allowed for site ${slug}`);

  const body = await c.req.json().catch(() => null);
  const validated = formSubmissionInputSchema.parse(body ?? {});

  const ip =
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    null;
  const userAgent = c.req.header('user-agent')?.slice(0, 512) ?? null;

  const submissionId = crypto.randomUUID();
  const submittedAt = new Date().toISOString();

  // Active integrations get fanned out in parallel.
  const integrationsResult = await dbQuery<IntegrationRow>(
    c.env.DB,
    `SELECT id, site_id, provider, api_key_encrypted, list_id, webhook_url, config
     FROM newsletter_integrations
     WHERE site_id = ? AND active = 1 AND deleted_at IS NULL`,
    [site.id],
  );

  // Decrypt each integration's API key (encrypted at rest) to plaintext before
  // fan-out; legacy plaintext rows pass through via resolveApiKey's fallback.
  const integrations = await Promise.all(
    integrationsResult.data.map(async (row) => ({
      ...row,
      api_key_encrypted: await resolveApiKey(c.env, row.api_key_encrypted),
    })),
  );

  const dispatchResults = await dispatchToIntegrations(
    {
      site_id: site.id,
      site_slug: site.slug,
      form_name: validated.form_name,
      // Normalize null→undefined: the schema now accepts `email: null` (public endpoint),
      // but dispatch treats a missing email as undefined (skips email-only integrations).
      email: validated.email ?? undefined,
      fields: validated.fields,
      origin_url: validated.origin_url ?? c.req.header('referer') ?? undefined,
      ip_address: ip ?? undefined,
      user_agent: userAgent ?? undefined,
      submitted_at: submittedAt,
    },
    integrations,
  );

  const successful = dispatchResults.filter((r) => r.ok);
  const failures = dispatchResults.filter((r) => !r.ok);
  const status: 'received' | 'forwarded' | 'partial' | 'failed' =
    integrationsResult.data.length === 0
      ? 'received'
      : failures.length === 0
        ? 'forwarded'
        : successful.length === 0
          ? 'failed'
          : 'partial';

  const { error: insertError } = await dbInsert(c.env.DB, 'form_submissions', {
    id: submissionId,
    site_id: site.id,
    org_id: site.org_id,
    form_name: validated.form_name,
    email: validated.email ?? null,
    payload: JSON.stringify(validated.fields),
    ip_address: ip,
    user_agent: userAgent,
    origin_url: validated.origin_url ?? c.req.header('referer') ?? null,
    forwarded_to: JSON.stringify(successful.map((r) => `${r.provider}:${r.integration_id}`)),
    status,
    created_at: submittedAt,
  });
  // Never return a lying-success: a failed persist means the submission is LOST (the
  // owner would never see it in /admin/forms). Surface a 500 so the visitor can retry
  // + the operator sees it — instead of silently dropping the row behind a 200.
  if (insertError) {
    console.warn(
      JSON.stringify({
        level: 'error',
        service: 'forms-submit',
        message: 'form_submissions insert failed — submission NOT recorded',
        error: insertError,
        site_id: site.id,
        slug: site.slug,
      }),
    );
    throw new Error('Failed to record the submission. Please try again.');
  }

  // Audit: form submission processed (routes to integrations or just recorded)
  const successfulProviders = successful.map((r) => r.provider).join(', ');
  const auditMsg =
    integrationsResult.data.length === 0
      ? `Form submission received for '${validated.form_name}' on '${site.slug}' (no integrations configured)`
      : status === 'forwarded'
        ? `Form submission routed to '${successfulProviders}' for '${validated.form_name}' on '${site.slug}'`
        : status === 'partial'
          ? `Form submission partially routed (${successful.length}/${integrationsResult.data.length} succeeded) for '${validated.form_name}' on '${site.slug}'`
          : `Form submission failed to route to any integration for '${validated.form_name}' on '${site.slug}'`;
  c.executionCtx.waitUntil(
    auditService.writeAuditLog(c.env.DB, {
      org_id: site.org_id,
      actor_id: null,
      action: 'form.submission_received',
      message: auditMsg,
      target_type: 'form_submission',
      target_id: submissionId,
      metadata_json: {
        site_id: site.id,
        slug: site.slug,
        form_name: validated.form_name,
        status,
        forwarded_count: successful.length,
        failed_count: failures.length,
        providers: successful.map((r) => r.provider),
      },
      request_id: c.get('requestId'),
    }),
  );

  // ── AI Form Router ──
  // Run the customer's single router prompt over this submission. The LLM
  // picks one MCP tool (Mailchimp/Stripe/Resend/HubSpot) or "noop"; the
  // worker executes it server-side and writes one ai_form_logs row.
  c.executionCtx.waitUntil(
    (async () => {
      const { buildPrompt, parseRouterAction, executeRouterAction } =
        await import('../services/form_router.js');
      const { loadAvailableTools } = await import('../services/mcp_client.js');
      const { writeAiLog, estTokens } = await import('../services/ai_logger.js');
      const { debitCredits, getBalance, maybeFireAlerts } = await import('../services/credits.js');
      const bal = await getBalance(c.env, site.org_id as string);
      if (bal <= 0) {
        await writeAiLog(c.env, {
          orgId: site.org_id as string,
          siteId: site.id,
          submissionId,
          traceKind: 'form',
          status: 'rate_limited',
          errorMessage: 'AI credits exhausted',
        });
        return;
      }
      const settings = await c.env.DB.prepare(
        `SELECT form_router_prompt, reply_email, enabled_mcps_json FROM ai_site_settings WHERE site_id = ?`,
      )
        .bind(site.id)
        .first<{
          form_router_prompt: string | null;
          reply_email: string | null;
          enabled_mcps_json: string | null;
        }>();
      const contextRows = await c.env.DB.prepare(
        `SELECT extracted_text FROM ai_chat_context_files WHERE site_id = ? AND enabled = 1
         AND extracted_text IS NOT NULL ORDER BY created_at DESC LIMIT 5`,
      )
        .bind(site.id)
        .all<{ extracted_text: string }>();
      // The operator's per-site MCP selection (forms designer "enable for routing"
      // pills) gates which connected MCPs the router may use. Empty/absent = all.
      const enabledMcps = ((): string[] => {
        try {
          const arr = JSON.parse(settings?.enabled_mcps_json ?? '[]');
          return Array.isArray(arr) ? arr.filter((v): v is string => typeof v === 'string') : [];
        } catch {
          return [];
        }
      })();
      const tools = await loadAvailableTools(c.env, site.id as string, enabledMcps);
      const businessName =
        (site as { business_name?: string }).business_name ?? (site.slug as string);
      // ── Assemble the template context exposed to `{{ }}` placeholders in
      // the customer's router prompt. Kept in sync with the variable list
      // surfaced in the Dashboard UI (see services/template.ts → TEMPLATE_VARIABLES).
      const query = c.req.query() as Record<string, string>;
      const templateContext = {
        form: {
          form_name: validated.form_name,
          email: validated.email ?? '',
          fields: validated.fields,
        },
        query,
        meta: {
          ip,
          user_agent: userAgent ?? '',
          origin_url: validated.origin_url ?? c.req.header('referer') ?? '',
          referer: c.req.header('referer') ?? '',
          timestamp: submittedAt,
          submission_id: submissionId,
        },
      };
      const prompt = buildPrompt({
        customPrompt: settings?.form_router_prompt ?? null,
        businessName,
        contextSnippets: (contextRows.results ?? []).map((r) => r.extracted_text.slice(0, 1200)),
        availableTools: tools,
        templateContext,
      });
      const userMessage = JSON.stringify({
        form_name: validated.form_name,
        email: validated.email,
        fields: validated.fields,
      });
      const model = '@cf/meta/llama-3.1-8b-instruct-fp8';
      const started = Date.now();
      let outText = '';
      let action: ReturnType<typeof parseRouterAction> | null = null;
      let toolResult: Awaited<ReturnType<typeof executeRouterAction>> | null = null;
      let logStatus: 'ok' | 'error' = 'ok';
      let errorMessage: string | undefined;
      try {
        const ai = (await c.env.AI.run(model as Parameters<typeof c.env.AI.run>[0], {
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: userMessage },
          ],
          max_tokens: 300,
        })) as { response?: string };
        outText = (ai.response ?? '').trim();
        action = parseRouterAction(outText);
        if (action) {
          toolResult = await executeRouterAction(c.env, site.id as string, action, {
            replyEmail: settings?.reply_email ?? null,
          });
          if (toolResult.status === 'error') {
            logStatus = 'error';
            errorMessage = toolResult.error;
          }
        } else {
          logStatus = 'error';
          errorMessage = 'router output was not valid JSON';
        }
      } catch (err) {
        logStatus = 'error';
        errorMessage = err instanceof Error ? err.message : String(err);
      }
      const logId = await writeAiLog(c.env, {
        orgId: site.org_id as string,
        siteId: site.id,
        submissionId,
        traceKind: 'form',
        promptTemplate: prompt,
        input: { form_name: validated.form_name, fields: validated.fields, email: validated.email },
        outputText: outText,
        outputJson: action ?? undefined,
        toolName: action?.tool,
        toolArgs: action?.args,
        toolResult: toolResult ?? undefined,
        toolStatus: toolResult?.status,
        model,
        status: logStatus,
        errorMessage,
        latencyMs: Date.now() - started,
        tokensInput: estTokens(prompt + userMessage),
        tokensOutput: estTokens(outText),
        creditsDebited: 1,
      });
      const newBal = await debitCredits(c.env, {
        orgId: site.org_id as string,
        siteId: site.id,
        amount: 1,
        reason: 'form_router',
        aiLogId: logId,
      });
      await maybeFireAlerts(c.env, site.org_id as string, newBal);
    })(),
  );

  // Update integration health metadata — best-effort telemetry. A failed health
  // write must NOT fail the visitor's form submission; log a dropped write so it's
  // observable instead of silently swallowed.
  for (const result of dispatchResults) {
    const health = result.ok
      ? {
          sql: 'UPDATE newsletter_integrations SET last_dispatch_at = ?, last_error = NULL, updated_at = ? WHERE id = ?',
          params: [submittedAt, submittedAt, result.integration_id],
        }
      : {
          sql: 'UPDATE newsletter_integrations SET last_error = ?, updated_at = ? WHERE id = ?',
          params: [String(result.error ?? '').slice(0, 1024), submittedAt, result.integration_id],
        };
    const { error: healthErr } = await dbExecute(c.env.DB, health.sql, health.params);
    if (healthErr) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          service: 'forms',
          message: 'integration_health_write_failed',
          integration_id: result.integration_id,
          error: healthErr,
        }),
      );
    }
  }

  // Meter form submission through the billing provider (free metric, analytics only).
  void (async () => {
    try {
      const { meterFormSubmission } = await import('../services/usage_metering.js');
      await meterFormSubmission(c.env, { orgId: site.org_id, siteId: site.id });
    } catch {
      /* fail-soft */
    }
  })();

  return c.json({
    data: {
      id: submissionId,
      status,
      forwarded: successful.length,
      failed: failures.length,
      received_at: submittedAt,
    },
  });
});

// ─── Auth-gated CRUD ─────────────────────────────────────────

async function loadOwnedSite(
  c: { env: Env; req: { param: (key: string) => string | undefined } },
  orgId: string,
): Promise<{ id: string; slug: string }> {
  const siteId = c.req.param('siteId');
  if (!siteId) throw badRequest('Missing siteId');
  // Canonical org-ownership guard (404 never 403 — fires 30-36 protocol).
  const site = await requireOwnedSite<{ id: string; slug: string }>(
    c.env,
    orgId,
    siteId,
    'id, slug',
  );
  return site;
}

forms.get('/api/sites/:siteId/forms', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized('Must be authenticated');
  const site = await loadOwnedSite(c, orgId);

  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50), 1), 200);
  const result = await dbQuery<{
    id: string;
    site_id: string;
    form_name: string;
    email: string | null;
    payload: string;
    ip_address: string | null;
    user_agent: string | null;
    origin_url: string | null;
    forwarded_to: string | null;
    status: string;
    created_at: string;
    replied_at: string | null;
    reply_subject: string | null;
  }>(
    c.env.DB,
    `SELECT id, site_id, form_name, email, payload, ip_address, user_agent, origin_url, forwarded_to, status, created_at, replied_at, reply_subject
     FROM form_submissions
     WHERE site_id = ?
     ORDER BY created_at DESC
     LIMIT ?`,
    [site.id, limit],
  );

  // Total stored count (worker COUNT(*)) so a consumer can tell a LIMIT-capped page
  // from the whole set — closes the paginated-silent-cap lying-UI (a site with >limit
  // submissions otherwise returns a partial list with NO signal more exist). Mirrors
  // the sibling GET /form-submissions `meta.total` the admin inbox already relies on.
  const totalRow = await dbQueryOne<{ n: number }>(
    c.env.DB,
    `SELECT COUNT(*) AS n FROM form_submissions WHERE site_id = ?`,
    [site.id],
  );
  const total = Number(totalRow?.n ?? result.data.length);

  return c.json({
    data: result.data.map((r) => ({
      id: r.id,
      site_id: r.site_id,
      form_name: r.form_name,
      email: r.email,
      payload: safeJson(r.payload, {}),
      ip_address: r.ip_address,
      user_agent: r.user_agent,
      origin_url: r.origin_url,
      forwarded_to: safeJson<string[]>(r.forwarded_to, []),
      status: r.status,
      created_at: r.created_at,
      replied_at: r.replied_at,
      reply_subject: r.reply_subject,
    })),
    meta: { total, limit, returned: result.data.length },
  });
});

forms.get('/api/sites/:siteId/integrations', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized('Must be authenticated');
  const site = await loadOwnedSite(c, orgId);

  const result = await dbQuery<{
    id: string;
    site_id: string;
    provider: string;
    list_id: string | null;
    webhook_url: string | null;
    api_key_preview: string | null;
    active: number;
    last_dispatch_at: string | null;
    last_error: string | null;
    config: string | null;
    created_at: string;
    updated_at: string;
  }>(
    c.env.DB,
    `SELECT id, site_id, provider, list_id, webhook_url, api_key_preview, active,
            last_dispatch_at, last_error, config, created_at, updated_at
     FROM newsletter_integrations
     WHERE site_id = ? AND deleted_at IS NULL
     ORDER BY created_at DESC`,
    [site.id],
  );

  return c.json({
    data: result.data.map((r) => ({
      id: r.id,
      site_id: r.site_id,
      provider: r.provider,
      list_id: r.list_id,
      webhook_url: r.webhook_url,
      api_key_preview: r.api_key_preview,
      active: r.active === 1,
      last_dispatch_at: r.last_dispatch_at,
      last_error: r.last_error,
      config: safeJson(r.config, null),
      created_at: r.created_at,
      updated_at: r.updated_at,
    })),
  });
});

forms.post('/api/sites/:siteId/integrations', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized('Must be authenticated');
  const site = await loadOwnedSite(c, orgId);

  const body = await c.req.json().catch(() => ({}));
  const validated = createIntegrationSchema.parse(body);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  // Customer provider API keys are AES-GCM encrypted at rest (the column name has
  // always promised it; it previously stored plaintext). The masked preview is
  // derived from the plaintext so the UI still shows a recognizable tail.
  const encryptedKey = validated.api_key ? await encrypt(c.env, validated.api_key) : null;
  const { error: insErr } = await dbInsert(c.env.DB, 'newsletter_integrations', {
    id,
    site_id: site.id,
    org_id: orgId,
    provider: validated.provider,
    api_key_encrypted: encryptedKey,
    api_key_preview: validated.api_key ? previewKey(validated.api_key) : null,
    list_id: validated.list_id ?? null,
    webhook_url: validated.webhook_url ?? null,
    config: validated.config ? JSON.stringify(validated.config) : null,
    active: 1,
    created_at: now,
    updated_at: now,
  });
  // Surface a genuine insert failure instead of a lying-success (the row would be
  // silently dropped and the caller told the integration saved).
  if (insErr) throw internalError(`Failed to save newsletter integration: ${insErr}`);

  c.executionCtx.waitUntil(
    auditService.writeAuditLog(c.env.DB, {
      org_id: orgId,
      actor_id: c.get('userId') ?? null,
      action: 'integration.created',
      message: `Newsletter integration '${validated.provider}' connected to site '${site.slug}'`,
      target_type: 'newsletter_integration',
      target_id: id,
      metadata_json: {
        site_id: site.id,
        slug: site.slug,
        provider: validated.provider,
        list_id: validated.list_id ?? null,
        has_webhook: !!validated.webhook_url,
      },
      request_id: c.get('requestId'),
    }),
  );

  return c.json({
    data: {
      id,
      site_id: site.id,
      provider: validated.provider,
      list_id: validated.list_id ?? null,
      webhook_url: validated.webhook_url ?? null,
      api_key_preview: validated.api_key ? previewKey(validated.api_key) : null,
      active: true,
      last_dispatch_at: null,
      last_error: null,
      config: validated.config ?? null,
      created_at: now,
      updated_at: now,
    },
  });
});

forms.patch('/api/sites/:siteId/integrations/:id', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized('Must be authenticated');
  const site = await loadOwnedSite(c, orgId);

  const id = c.req.param('id');
  const existing = await dbQueryOne<{ id: string }>(
    c.env.DB,
    'SELECT id FROM newsletter_integrations WHERE id = ? AND site_id = ? AND deleted_at IS NULL',
    [id, site.id],
  );
  if (!existing) throw notFound('Integration not found');

  const body = await c.req.json().catch(() => ({}));
  const validated = updateIntegrationSchema.parse(body);

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (validated.active !== undefined) updates['active'] = validated.active ? 1 : 0;
  if (validated.api_key !== undefined) {
    updates['api_key_encrypted'] = await encrypt(c.env, validated.api_key);
    updates['api_key_preview'] = previewKey(validated.api_key);
  }
  if (validated.list_id !== undefined) updates['list_id'] = validated.list_id;
  if (validated.webhook_url !== undefined) updates['webhook_url'] = validated.webhook_url;
  if (validated.config !== undefined) updates['config'] = JSON.stringify(validated.config);

  const keys = Object.keys(updates);
  const setClause = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => updates[k]);
  const { error: updErr } = await dbExecute(
    c.env.DB,
    `UPDATE newsletter_integrations SET ${setClause} WHERE id = ?`,
    [...values, id],
  );
  // Ownership pre-guarded above (loadOwnedSite + existing-integration check) →
  // changes===0 unreachable; surface a real DB failure, never a lying "updated".
  if (updErr) throw internalError(`Failed to update integration: ${updErr}`);

  return c.json({ data: { id, updated: true } });
});

forms.delete('/api/sites/:siteId/integrations/:id', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized('Must be authenticated');
  const site = await loadOwnedSite(c, orgId);

  const id = c.req.param('id');
  const integration = await dbQueryOne<{ provider: string }>(
    c.env.DB,
    'SELECT provider FROM newsletter_integrations WHERE id = ? AND site_id = ? AND deleted_at IS NULL',
    [id, site.id],
  );
  const result = await dbExecute(
    c.env.DB,
    "UPDATE newsletter_integrations SET deleted_at = datetime('now'), active = 0 WHERE id = ? AND site_id = ?",
    [id, site.id],
  );
  if (result.changes === 0) throw notFound('Integration not found');

  c.executionCtx.waitUntil(
    auditService.writeAuditLog(c.env.DB, {
      org_id: orgId,
      actor_id: c.get('userId') ?? null,
      action: 'integration.deleted',
      message: `Newsletter integration '${integration?.provider ?? 'unknown'}' removed from site '${site.slug}'`,
      target_type: 'newsletter_integration',
      target_id: id,
      metadata_json: {
        site_id: site.id,
        slug: site.slug,
        provider: integration?.provider ?? null,
      },
      request_id: c.get('requestId'),
    }),
  );

  return c.json({ data: { deleted: true } });
});

// ─── AI auto-reply for form submissions (Item #4) ────────────

/**
 * Load a single submission scoped to the authenticated org. Used by both
 * the draft-reply and send-reply routes — keeps the auth + 404 logic
 * symmetric so a 404 from one always implies a 404 from the other.
 */
async function loadOwnedSubmission(
  c: { env: Env; req: { param: (k: string) => string | undefined } },
  orgId: string,
): Promise<{
  submission: {
    id: string;
    site_id: string;
    form_name: string;
    email: string | null;
    payload: string;
    origin_url: string | null;
    created_at: string;
    replied_at: string | null;
  };
  site: { id: string; slug: string };
}> {
  const site = await loadOwnedSite(c, orgId);
  const submissionId = c.req.param('submissionId');
  if (!submissionId) throw badRequest('Missing submissionId');
  const submission = await dbQueryOne<{
    id: string;
    site_id: string;
    form_name: string;
    email: string | null;
    payload: string;
    origin_url: string | null;
    created_at: string;
    replied_at: string | null;
  }>(
    c.env.DB,
    `SELECT id, site_id, form_name, email, payload, origin_url, created_at, replied_at
     FROM form_submissions
     WHERE id = ? AND site_id = ?`,
    [submissionId, site.id],
  );
  if (!submission) throw notFound('Submission not found');
  return { submission, site };
}

/**
 * POST /api/sites/:siteId/form-submissions/:submissionId/draft-reply
 *
 * Call Workers AI Llama 3.3 70B fp8-fast to draft a warm, concise reply
 * as the business owner. Stateless — no D1 writes. Returns the draft
 * (subject + body) so the dashboard can show it in editable textareas.
 *
 * @returns 200 OK `{ data: { subject, body, model, ms, cost_usd } }`
 */
forms.post('/api/sites/:siteId/form-submissions/:submissionId/draft-reply', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized('Must be authenticated');
  const { submission, site } = await loadOwnedSubmission(c, orgId);

  let fieldsObj: Record<string, unknown> = {};
  try {
    fieldsObj = JSON.parse(submission.payload) as Record<string, unknown>;
  } catch {
    /* fall through with empty fields */
  }
  const fieldsText = Object.entries(fieldsObj)
    .filter(([k]) => k !== 'cf-turnstile-response' && k !== '_token')
    .map(([k, v]) => `${k}: ${String(v).slice(0, 500)}`)
    .join('\n');

  const systemPrompt =
    `You are the owner of "${site.slug}". A visitor just submitted the "${submission.form_name}" form. ` +
    `Draft a warm, concise, personal reply as the business owner. ` +
    `Address them by first name when known. Acknowledge what they asked, ` +
    `answer if you can, and propose ONE clear next step (reply with a time, book a call, ` +
    `visit the location). Keep it under 120 words. No marketing fluff, no "Thank you for ` +
    `reaching out!" preamble. Return STRICT JSON: ` +
    `{"subject":"...","body":"...<html-safe, paragraph tags allowed>"}`;
  const userPrompt = `Visitor email: ${submission.email ?? 'unknown'}\n` + fieldsText;

  const started = Date.now();
  let raw = '';
  try {
    const result = (await c.env.AI.run(
      REPLY_MODEL as Parameters<typeof c.env.AI.run>[0],
      {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 600,
        temperature: 0.55,
      } as Parameters<typeof c.env.AI.run>[1],
    )) as { response?: string };
    raw = (result?.response ?? '').trim();
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'error',
        service: 'forms.draft_reply',
        message: 'Workers AI draft failed',
        submission_id: submission.id,
        err: String(err).slice(0, 300),
      }),
    );
    throw badRequest('AI drafting failed — try again or write the reply manually');
  }

  const ms = Date.now() - started;
  // Strip code fences / accidental preamble.
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  let subject = `Re: ${submission.form_name} — ${site.slug}`;
  let body = '';
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { subject?: string; body?: string };
      if (typeof parsed.subject === 'string' && parsed.subject.trim())
        subject = parsed.subject.trim();
      if (typeof parsed.body === 'string') body = parsed.body.trim();
    } catch {
      body = raw;
    }
  } else {
    body = raw;
  }
  if (!body) throw badRequest('AI returned an empty reply — try again');

  // Cost estimate (output tokens only — Workers AI input is cheaper but the
  // worst-case output-rate is the right CYA number for a draft preview).
  const outTokens = Math.ceil(body.length / 4) + Math.ceil(subject.length / 4);
  const cost_usd = (outTokens / 1_000_000) * REPLY_COST_PER_MTOK_USD;

  return c.json({
    data: {
      subject,
      body,
      model: REPLY_MODEL,
      ms,
      cost_usd: Number(cost_usd.toFixed(6)),
    },
  });
});

/**
 * POST /api/sites/:siteId/form-submissions/:submissionId/send-reply
 *
 * Send the (potentially edited) reply via Amazon SES, write the audit log
 * `form.reply_sent`, and mark the submission `replied_at = now`. Uses the
 * SES seam in platform/email-router.ts (getEmailProvider) via a direct fetch
 * so we control the from-address + reply-to per submission.
 *
 * @body `{ subject, body, override_to? }`
 */
forms.post('/api/sites/:siteId/form-submissions/:submissionId/send-reply', async (c) => {
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  if (!orgId) throw unauthorized('Must be authenticated');
  const { submission, site } = await loadOwnedSubmission(c, orgId);

  const json = (await c.req.json().catch(() => ({}))) as unknown;
  const parsed = sendReplyBody.parse(json);

  const to = parsed.override_to ?? submission.email ?? '';
  if (!to) throw badRequest('Submission has no email and no override_to provided');

  // ADR-0019 Resend→SES: SES is the sole provider when configured; the per-site
  // friendly from-address rides through `from` (Resend removed 2026-09-09 — the
  // else-branch throws when SES is unset). Yields a providerRequestId for the audit trail.
  const fromAddr = `${site.slug} <noreply@projectsites.dev>`;
  let providerRequestId: string | null = null;

  if (c.env.AWS_ACCESS_KEY_ID && c.env.AWS_SECRET_ACCESS_KEY && c.env.SES_FROM_EMAIL) {
    const sent = await getEmailProvider(c.env).sendTransactional({
      kind: 'transactional',
      from: fromAddr,
      to,
      subject: parsed.subject,
      html: parsed.body,
    });
    providerRequestId = sent.id;
  } else {
    // Resend removed 2026-09-09 (Brian directive) — Amazon SES is the required provider.
    throw badRequest('Email delivery is not configured (Amazon SES is required).');
  }
  console.warn(
    JSON.stringify({
      level: 'info',
      service: 'forms.send_reply',
      message: 'Form reply sent',
      to,
      site_slug: site.slug,
      submission_id: submission.id,
      request_id: providerRequestId,
    }),
  );

  const nowIso = new Date().toISOString();
  const { error: replyErr } = await dbExecute(
    c.env.DB,
    `UPDATE form_submissions
       SET reply_subject = ?, reply_body = ?, replied_at = ?
       WHERE id = ? AND site_id = ?`,
    [parsed.subject, parsed.body, nowIso, submission.id, site.id],
  );
  // The reply email was ALREADY sent (irreversible) — do NOT throw (that would make
  // the operator resend → a duplicate email). Log the dropped record-write; the audit
  // log below still captures that the reply went out.
  if (replyErr) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'forms.send_reply',
        message: 'reply_record_write_failed',
        submission_id: submission.id,
        error: replyErr,
      }),
    );
  }

  c.executionCtx.waitUntil(
    auditService.writeAuditLog(c.env.DB, {
      org_id: orgId,
      actor_id: userId ?? null,
      action: 'form.reply_sent',
      message: `Reply sent to '${to}' for submission '${submission.id}' on site '${site.slug}'`,
      target_type: 'form_submission',
      target_id: submission.id,
      metadata_json: {
        site_id: site.id,
        slug: site.slug,
        form_name: submission.form_name,
        to,
        subject: parsed.subject,
        resend_request_id: providerRequestId,
      },
      request_id: c.get('requestId'),
    }),
  );

  return c.json({
    data: {
      sent: true,
      to,
      replied_at: nowIso,
      resend_request_id: providerRequestId,
    },
  });
});

/**
 * Improve OR seed the form-router prompt.
 *
 * @remarks
 * - When the request body `value` is empty/missing/whitespace → returns the
 *   built-in {@link SAMPLE_ROUTER_PROMPT} seed (no LLM call, no credit cost,
 *   never 500s).
 * - When `value` is non-empty → asks Workers AI to tighten it while
 *   preserving every routing rule the customer already wrote.
 *
 * The endpoint is intentionally permissive on input shape — `value` is
 * optional, body may be empty `{}`, and any AI failure falls back to the
 * seed prompt so the UI always gets a usable response.
 *
 * @example
 * POST /api/sites/abc/form-router/improve  {}
 * → 200 { data: { mode: 'seed', text: '<seed prompt>' } }
 */
forms.post('/api/sites/:siteId/form-router/improve', async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) throw unauthorized('Must be authenticated');
  await loadOwnedSite(c, orgId);
  const body = (await c.req.json().catch(() => ({}))) as { value?: unknown };
  const value = typeof body.value === 'string' ? body.value : '';
  const out = await improveRouterPrompt(c.env, value);
  return c.json({ data: out });
});

// ── helpers ──────────────────────────────────────────────────

function previewKey(key: string): string {
  if (key.length <= 8) return `${key.slice(0, 2)}…${key.slice(-2)}`;
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/**
 * Resolve a stored newsletter-integration API key to plaintext for dispatch.
 *
 * @remarks
 * New keys are AES-GCM encrypted at rest ({@link encrypt}); rows created before
 * encryption landed hold plaintext. Decrypt-with-fallback keeps those legacy rows
 * working with no data migration — a plaintext value fails AES-GCM decryption and is
 * returned as-is (it re-encrypts on the owner's next save).
 */
async function resolveApiKey(env: Env, stored: string | null): Promise<string | null> {
  if (!stored) return null;
  try {
    return await decrypt(env, stored);
  } catch {
    return stored; // legacy plaintext (pre-encryption row)
  }
}

function safeJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export { forms };
