/**
 * GET /api/voice/insights
 *
 * Returns org-scoped aggregate KPIs over the `voice_calls` table:
 * - total_calls
 * - by_direction  { inbound, outbound }
 * - avg_duration_seconds
 * - sentiment_breakdown { positive, neutral, negative, escalated_safety, flagged_scam }
 * - total_cost_cents
 *
 * Degrades gracefully (returns zeros) when no rows exist or on DB failure.
 * Auth is org-scoped — always reads the authed orgId, ignoring any query param.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env, Variables } from '../types/env.js';
import { dbQuery } from '../services/db.js';
import { unauthorized } from '@project-sites/shared';

// ─── auth helper (mirrors voice.ts pattern exactly) ────────────────────────

function requireAuth(c: {
  get: (k: string) => string | undefined;
}): { userId: string; orgId: string } {
  const userId = c.get('userId');
  const orgId = c.get('orgId');
  if (!userId || !orgId) throw unauthorized();
  return { userId, orgId };
}

// ─── response schema ────────────────────────────────────────────────────────

const VoiceInsightsDataSchema = z.object({
  total_calls: z.number().int().min(0),
  by_direction: z.object({
    inbound: z.number().int().min(0),
    outbound: z.number().int().min(0),
  }),
  avg_duration_seconds: z.number().min(0),
  sentiment_breakdown: z.object({
    positive: z.number().int().min(0),
    neutral: z.number().int().min(0),
    negative: z.number().int().min(0),
    escalated_safety: z.number().int().min(0),
    flagged_scam: z.number().int().min(0),
  }),
  total_cost_cents: z.number().int().min(0),
});

type VoiceInsightsData = z.infer<typeof VoiceInsightsDataSchema>;

/** Empty/zero response returned when there are no calls or on DB failure */
const EMPTY_INSIGHTS: VoiceInsightsData = {
  total_calls: 0,
  by_direction: { inbound: 0, outbound: 0 },
  avg_duration_seconds: 0,
  sentiment_breakdown: {
    positive: 0,
    neutral: 0,
    negative: 0,
    escalated_safety: 0,
    flagged_scam: 0,
  },
  total_cost_cents: 0,
};

// ─── aggregate SQL ──────────────────────────────────────────────────────────

const AGGREGATE_SQL = `
  SELECT
    COUNT(*)                                               AS total_calls,
    SUM(CASE WHEN direction = 'inbound'  THEN 1 ELSE 0 END) AS inbound,
    SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) AS outbound,
    COALESCE(AVG(duration_seconds), 0)                     AS avg_duration_seconds,
    SUM(CASE WHEN sentiment = 'positive'         THEN 1 ELSE 0 END) AS positive,
    SUM(CASE WHEN sentiment = 'neutral'          THEN 1 ELSE 0 END) AS neutral,
    SUM(CASE WHEN sentiment = 'negative'         THEN 1 ELSE 0 END) AS negative,
    SUM(CASE WHEN sentiment = 'escalated_safety' THEN 1 ELSE 0 END) AS escalated_safety,
    SUM(CASE WHEN sentiment = 'flagged_scam'     THEN 1 ELSE 0 END) AS flagged_scam,
    SUM(COALESCE(cost_cents, 0))                           AS total_cost_cents
  FROM voice_calls
  WHERE org_id = ? AND deleted_at IS NULL
`;

// ─── aggregate row shape (as returned by D1 via dbQuery) ───────────────────

interface AggRow {
  total_calls: number;
  inbound: number;
  outbound: number;
  avg_duration_seconds: number;
  positive: number;
  neutral: number;
  negative: number;
  escalated_safety: number;
  flagged_scam: number;
  total_cost_cents: number;
}

// ─── route ──────────────────────────────────────────────────────────────────

export const voiceInsightsRoutes = new Hono<{
  Bindings: Env;
  Variables: Variables;
}>();

voiceInsightsRoutes.get('/api/voice/insights', async (c) => {
  const { orgId } = requireAuth(c);

  let insights: VoiceInsightsData = EMPTY_INSIGHTS;

  try {
    const result = await dbQuery<AggRow>(c.env.DB, AGGREGATE_SQL, [orgId]);
    const row = result.data[0];

    if (row && row.total_calls > 0) {
      insights = {
        total_calls: row.total_calls,
        by_direction: {
          inbound: row.inbound ?? 0,
          outbound: row.outbound ?? 0,
        },
        avg_duration_seconds: Math.round(row.avg_duration_seconds ?? 0),
        sentiment_breakdown: {
          positive: row.positive ?? 0,
          neutral: row.neutral ?? 0,
          negative: row.negative ?? 0,
          escalated_safety: row.escalated_safety ?? 0,
          flagged_scam: row.flagged_scam ?? 0,
        },
        total_cost_cents: row.total_cost_cents ?? 0,
      };
    }
  } catch (_err) {
    // DB failure → degrade gracefully (return zeros, per fail-soft-prod)
    console.warn('[voice_insights] DB failure, returning empty zeros');
  }

  return c.json({ data: insights });
});
