import type { Environment } from '../config/environment.js';
import { Redis } from 'ioredis';

export interface RedisHealth {
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function createRedis(environment: Pick<Environment, 'REDIS_URL'>): RedisHealth {
  const client = new Redis(environment.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
  client.on('error', () => undefined);

  return {
    async ping() {
      if (client.status === 'wait') await client.connect();
      await client.ping();
    },
    async close() {
      await client.quit();
    },
  };
}
