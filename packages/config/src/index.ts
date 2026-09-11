import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  WEB_URL: z.url(),
  DATABASE_URL: z.url().startsWith('postgresql://'),
  REDIS_URL: z.url().startsWith('redis://'),
  FIREBASE_PROJECT_ID: z.string().trim().min(1),
  PAYMENT_PROVIDER_KEY: z.string().trim().min(1),
  RAZORPAY_KEY_ID: z.string().trim().min(1),
  RAZORPAY_KEY_SECRET: z.string().trim().min(1),
  RAZORPAY_WEBHOOK_SECRET: z.string().trim().min(1),
  PAYMENT_ORDER_PROVISIONING_LEASE_SECONDS: z.coerce.number().int().positive(),
  SESSION_IDLE_TTL_SECONDS: z.coerce.number().int().positive(),
  SESSION_ABSOLUTE_TTL_SECONDS: z.coerce.number().int().positive(),
}).refine((environment) => environment.SESSION_ABSOLUTE_TTL_SECONDS >= environment.SESSION_IDLE_TTL_SECONDS, {
  message: 'SESSION_ABSOLUTE_TTL_SECONDS must be greater than or equal to SESSION_IDLE_TTL_SECONDS',
  path: ['SESSION_ABSOLUTE_TTL_SECONDS'],
});

export type Environment = z.infer<typeof environmentSchema>;

export type EnvironmentSource = Record<string, string | undefined>;

export function loadEnvironment(source: EnvironmentSource): Environment {
  const result = environmentSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment configuration: ${result.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
  }
  return result.data;
}
