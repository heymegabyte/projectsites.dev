import { z } from 'zod';

export const UsageGaugeSchema = z.object({
  metric: z.enum(['sites', 'builds', 'media']),
  label: z.string(),
  used: z.number(),
  limit: z.number(),
  unit: z.string(),
  pct: z.number().min(0).max(100),
});
export type UsageGauge = z.infer<typeof UsageGaugeSchema>;

export const UsageGaugesResponseSchema = z.object({
  data: z.array(UsageGaugeSchema),
  period: z.string(),
});
export type UsageGaugesResponse = z.infer<typeof UsageGaugesResponseSchema>;
