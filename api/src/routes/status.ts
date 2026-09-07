import type { HealthResponse, ReadinessResponse } from '@cliniq/contracts';
import type { FastifyInstance } from 'fastify';
import type { DatabaseHealth } from '../infrastructure/database.js';
import type { RedisHealth } from '../infrastructure/redis.js';

export interface StatusDependencies {
  database: DatabaseHealth;
  redis: RedisHealth;
}

export async function registerStatusRoutes(app: FastifyInstance, dependencies: StatusDependencies): Promise<void> {
  app.get('/health', async (): Promise<HealthResponse> => ({ status: 'ok', service: 'cliniq-core-api' }));

  app.get('/ready', async (_request, reply): Promise<ReadinessResponse> => {
    const [database, redis] = await Promise.allSettled([dependencies.database.ping(), dependencies.redis.ping()]);
    const response: ReadinessResponse = {
      status: database.status === 'fulfilled' && redis.status === 'fulfilled' ? 'ok' : 'unavailable',
      dependencies: {
        database: database.status === 'fulfilled' ? 'ok' : 'unavailable',
        redis: redis.status === 'fulfilled' ? 'ok' : 'unavailable',
      },
    };
    if (response.status !== 'ok') reply.code(503);
    return response;
  });
}
