/**
 * @module libs/features/site_analytics/schemas
 * @description Zod schemas for Site Analytics — an owner-facing dashboard that
 * aggregates the lead/engagement data the platform ALREADY captures (contacts,
 * form submissions, newsletter subscribers) per site. No new event
 * pipeline; it reads existing tables, so it ships value immediately and a
 * `visitor_events_core` (pageviews/sessions) can extend it later.
 *
 * @packageDocumentation
 */

import { z } from 'zod';
import { TrafficSummarySchema } from '../visitor_events_core/schemas.js';

/** One `{ source, count }` slice of the contacts breakdown. */
export const SourceCountSchema = z
  .object({ source: z.string(), count: z.number().int().min(0) })
  .strict();
export type SourceCount = z.infer<typeof SourceCountSchema>;

/** Owner-facing analytics summary for a single site. */
export const SiteAnalyticsSummarySchema = z
  .object({
    siteId: z.string().min(1),
    windowDays: z.number().int().positive(),
    contacts: z
      .object({
        total: z.number().int().min(0),
        newInWindow: z.number().int().min(0),
        bySource: z.array(SourceCountSchema),
      })
      .strict(),
    formSubmissions: z
      .object({ total: z.number().int().min(0), newInWindow: z.number().int().min(0) })
      .strict(),
    newsletter: z
      .object({ confirmed: z.number().int().min(0), total: z.number().int().min(0) })
      .strict(),
    traffic: TrafficSummarySchema,
    generatedAt: z.string(),
  })
  .strict();
export type SiteAnalyticsSummary = z.infer<typeof SiteAnalyticsSummarySchema>;

/** One section's conversion attribution row (AN27). */
export const SectionConversionSchema = z
  .object({
    section: z.string(),
    count: z.number().int().min(0),
    /** Share of all attributed conversions, 0–100, one decimal. */
    percent: z.number().min(0).max(100),
    calls: z.number().int().min(0),
    directions: z.number().int().min(0),
    emails: z.number().int().min(0),
  })
  .strict();
export type SectionConversion = z.infer<typeof SectionConversionSchema>;

/**
 * AN27 — section-level conversion attribution ("Services drives 40% of calls").
 * Built on AN18 click-to-call/directions events tagged with the AN26
 * `data-ps-section` and persisted to `analytics_events`.
 */
export const SectionConversionsSchema = z
  .object({
    siteId: z.string().min(1),
    windowDays: z.number().int().positive(),
    totalConversions: z.number().int().min(0),
    sections: z.array(SectionConversionSchema),
    generatedAt: z.string(),
  })
  .strict();
export type SectionConversions = z.infer<typeof SectionConversionsSchema>;

/** One form's completion-rate row (AN17). */
export const FormAnalyticsRowSchema = z
  .object({
    form: z.string(),
    starts: z.number().int().min(0),
    submits: z.number().int().min(0),
    /** submits / starts as 0–100, one decimal (0 when no starts). */
    completionRate: z.number().min(0).max(100),
    /** starts that never submitted (max 0, never negative). */
    abandoned: z.number().int().min(0),
  })
  .strict();
export type FormAnalyticsRow = z.infer<typeof FormAnalyticsRowSchema>;

/**
 * AN17 — per-form completion rate + abandonment. Built on the tracker's
 * `form_start` (first focus) + `form_submit` events keyed by form id/name/section.
 */
export const FormAnalyticsSchema = z
  .object({
    siteId: z.string().min(1),
    windowDays: z.number().int().positive(),
    forms: z.array(FormAnalyticsRowSchema),
    generatedAt: z.string(),
  })
  .strict();
export type FormAnalytics = z.infer<typeof FormAnalyticsSchema>;

/** One stage of the per-site visitor funnel (AN19). */
export const FunnelStageSchema = z
  .object({
    key: z.enum(['landing', 'engaged', 'deeply_engaged', 'converted']),
    label: z.string(),
    sessions: z.number().int().min(0),
    /** Share of the landing (top-of-funnel) sessions, 0–100, one decimal. */
    percentOfLanding: z.number().min(0).max(100),
  })
  .strict();
export type FunnelStage = z.infer<typeof FunnelStageSchema>;

/**
 * AN19 — per-site visitor funnel: landing (≥1 pageview) → engaged (≥2 pageviews)
 * → converted (a conversion event), counted by distinct session.
 */
export const VisitorFunnelSchema = z
  .object({
    siteId: z.string().min(1),
    windowDays: z.number().int().positive(),
    stages: z.array(FunnelStageSchema),
    generatedAt: z.string(),
  })
  .strict();
export type VisitorFunnel = z.infer<typeof VisitorFunnelSchema>;

/** AN48 — response when an owner mints a public read-only analytics share link. */
export const ShareLinkSchema = z
  .object({
    token: z.string().min(1),
    url: z.string().url(),
    /** Absolute expiry (Unix ms). */
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type ShareLink = z.infer<typeof ShareLinkSchema>;
