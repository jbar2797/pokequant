import { z } from 'zod';

// Central place to define and reuse Zod schemas for request validation.
// Pattern: export schema & a helper validate(schema, data) returning { ok, data } or { ok:false, errors }.

// Relaxed URL schema: accept any http/https URL (legacy tests used minimal host forms)
export const UrlSchema = z.string().regex(/^https?:\/\//, 'must start with http:// or https://');

export const PortfolioLotSchema = z.object({
  card_id: z.string().min(1),
  qty: z.number().positive(),
  cost_usd: z.number().nonnegative(),
  acquired_at: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/).optional().nullable()
});

export const WebhookCreateSchema = z.object({
  url: UrlSchema,
  secret: z.string().min(8).max(128).optional(),
});

export const AlertCreateSchema = z.object({
  // Legacy allowed local-part only before @ without domain TLD; relax to any string containing '@'
  email: z.string().min(3).regex(/@/, 'must contain @'),
  card_id: z.string().min(1),
  kind: z.string().default('price_below'),
  threshold: z.number(),
  snooze_minutes: z.number().int().positive().max(24*60).optional()
});

export const FactorWeightsSchema = z.object({
  version: z.string().min(1).max(64).optional(),
  weights: z.array(z.object({ factor: z.string().min(1), weight: z.number() })).min(1)
});

export const FactorConfigSchema = z.object({
  factor: z.string().regex(/^[-_a-zA-Z0-9]{2,32}$/),
  enabled: z.boolean().optional(),
  display_name: z.string().min(1).max(64).optional()
});

export const FactorToggleSchema = z.object({
  factor: z.string().min(1),
  enabled: z.boolean()
});

export const FactorDeleteSchema = z.object({ factor: z.string().min(1) });

export const IngestionScheduleSetSchema = z.object({
  dataset: z.string().min(1),
  frequency_minutes: z.number().int().positive().max(24*60)
});

export const PortfolioTargetsSchema = z.object({
  factors: z.record(z.number()).optional()
});

export const PortfolioOrderExecuteSchema = z.object({ id: z.string().min(1) });

export const SLOSetSchema = z.object({
  route_slug: z.string().min(1),
  threshold_ms: z.number().int().positive().max(10000)
});

export function validate<T>(schema: z.ZodSchema<T>, input: unknown): { ok:true; data:T } | { ok:false; errors:string[] } {
  const result = schema.safeParse(input);
  if (result.success) return { ok:true, data: result.data };
  return { ok:false, errors: result.error.issues.map(i => `${i.path.join('.')||'(root)'}: ${i.message}`) };
}
