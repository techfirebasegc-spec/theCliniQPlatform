import type { Environment } from './config/environment.js';
import { createDatabase, type DatabaseHealth } from './infrastructure/database.js';
import { createRedis, type RedisHealth } from './infrastructure/redis.js';
import { registerErrorHandler } from './middleware/errors.js';
import { registerStatusRoutes } from './routes/status.js';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import Fastify from 'fastify';

export interface AppDependencies {
  database: DatabaseHealth;
  redis: RedisHealth;
}

export function createApp(environment: Environment, dependencies?: AppDependencies) {
  const app = Fastify({
    logger: { level: environment.NODE_ENV === 'production' ? 'info' : 'debug', redact: ['req.headers.authorization'] },
    bodyLimit: 1_048_576,
    requestIdHeader: 'x-request-id',
  });
  const services = dependencies ?? { database: createDatabase(environment), redis: createRedis(environment) };

  void app.register(helmet);
  void app.register(cors, { origin: environment.WEB_URL, credentials: true });
  registerErrorHandler(app);
  void app.register(async (instance) => registerStatusRoutes(instance, services));

  return { app, services };
}
