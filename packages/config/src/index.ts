import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  WEB_URL: z.url(),
  DATABASE_URL: z.url().startsWith('postgresql://'),
  REDIS_URL: z.url().startsWith('redis://'),
  FIREBASE_PROJECT_ID: z.string().trim().min(1),
  PAYMENT_PROVIDER_KEY: z.string().trim().min(1),
  RAZORPAY_KEY_ID: z.string().trim().min(1).optional(),
  RAZORPAY_KEY_SECRET: z.string().trim().min(1).optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().trim().min(1).optional(),
  PAYMENT_ORDER_PROVISIONING_LEASE_SECONDS: z.coerce.number().int().positive().optional(),
  SESSION_IDLE_TTL_SECONDS: z.coerce.number().int().positive(),
  SESSION_ABSOLUTE_TTL_SECONDS: z.coerce.number().int().positive(),
}).refine((environment) => environment.SESSION_ABSOLUTE_TTL_SECONDS >= environment.SESSION_IDLE_TTL_SECONDS, {
  message: 'SESSION_ABSOLUTE_TTL_SECONDS must be greater than or equal to SESSION_IDLE_TTL_SECONDS',
  path: ['SESSION_ABSOLUTE_TTL_SECONDS'],
}).superRefine((environment, context) => {
  const credentials = [environment.RAZORPAY_KEY_ID, environment.RAZORPAY_KEY_SECRET, environment.RAZORPAY_WEBHOOK_SECRET];
  const configured = credentials.filter((value) => value !== undefined).length;
  if (configured !== 0 && configured !== credentials.length) {
    for (const [index, value] of credentials.entries()) {
      if (value === undefined) context.addIssue({ code: 'custom', path: [['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'][index]], message: 'Razorpay credentials must be configured together.' });
    }
  }
  if (configured === credentials.length && environment.PAYMENT_ORDER_PROVISIONING_LEASE_SECONDS === undefined) {
    context.addIssue({ code: 'custom', path: ['PAYMENT_ORDER_PROVISIONING_LEASE_SECONDS'], message: 'PAYMENT_ORDER_PROVISIONING_LEASE_SECONDS is required when Razorpay is configured.' });
  }
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
