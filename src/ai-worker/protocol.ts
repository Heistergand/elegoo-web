import { z } from 'zod';

/** Private, versioned HTTP contract; the worker never receives printer credentials. */
export const AI_PROTOCOL_VERSION = 1;
export const AIHealthSchema = z.object({
  version: z.literal(AI_PROTOCOL_VERSION),
  model: z.string(),
  state: z.enum(['loading', 'ready', 'error']),
  error: z.string().nullable(),
});
export const AIRequestSchema = z.object({
  version: z.literal(AI_PROTOCOL_VERSION),
  model: z.string().min(1).max(256),
  image: z
    .string()
    .min(4)
    .max(8_000_000)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  labels: z.array(z.string().min(1).max(2048)).min(1).max(128),
});
export const AIResultSchema = z.object({
  version: z.literal(AI_PROTOCOL_VERSION),
  scores: z
    .array(z.object({ label: z.string(), score: z.number().finite().min(0).max(1) }))
    .min(1)
    .max(128),
});
export type AIScores = z.infer<typeof AIResultSchema>['scores'];
