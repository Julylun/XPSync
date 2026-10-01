import { z } from 'zod';
export const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9_-]+$/)
  .refine(
    (value) => !['__proto__', 'prototype', 'constructor'].includes(value),
    'Reserved identifier',
  );
export const patchSchema = z
  .object({
    title: z.string().min(1).max(2000),
    isDone: z.boolean(),
    notes: z.string().max(100000),
    timeSpent: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    timeEstimate: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    parentId: id.nullable(),
  })
  .partial()
  .strict();
export const mutationSchema = z
  .object({
    type: z.literal('task:push_mutation'),
    mutationId: id,
    taskId: id,
    operation: z.enum(['upsert', 'delete']),
    timestamp: z.number().int().positive(),
    changes: patchSchema.default({}),
  })
  .strict();
export const joinSchema = z
  .object({
    type: z.literal('join'),
    projectApiKey: z.string().min(20).max(200),
    username: z.string().trim().min(1).max(80),
    originId: id,
    clientVersion: z.literal('1.0.0'),
  })
  .strict();
export type Mutation = z.infer<typeof mutationSchema>;
export type TaskData = {
  title: string;
  isDone: boolean;
  notes: string;
  timeSpent: number;
  timeEstimate: number;
  parentId: string | null;
};
export type Version = [number, string];
export interface SyncTask {
  id: string;
  projectId: string;
  data: TaskData;
  versions: Record<string, Version>;
  deleted: boolean;
  updatedAt: number;
  lastUpdatedBy: string;
}
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
