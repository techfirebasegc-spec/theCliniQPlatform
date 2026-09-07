import type { Environment } from '../src/config/environment.js';
import { createApp } from '../src/app.js';
import { describe, expect, it } from 'vitest';

const environment: Environment = {
  NODE_ENV: 'test',
  API_PORT: 4000,
  WEB_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://cliniq:cliniq@127.0.0.1:5432/cliniq_platform',
  REDIS_URL: 'redis://127.0.0.1:6379',
};

describe('status routes', () => {
  it('reports process health without dependencies', async () => {
    const { app } = createApp(environment, { database: { ping: async () => {}, query: async () => ({ rows: [] }), transaction: async (operation) => operation({ query: async () => ({ rows: [] }) }), close: async () => {} }, redis: { ping: async () => {}, close: async () => {} } });
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: 'cliniq-core-api' });
    await app.close();
  });

  it('reports unavailable dependencies without leaking details', async () => {
    const { app } = createApp(environment, { database: { ping: async () => { throw new Error('database credentials'); }, query: async () => ({ rows: [] }), transaction: async (operation) => operation({ query: async () => ({ rows: [] }) }), close: async () => {} }, redis: { ping: async () => {}, close: async () => {} } });
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable', dependencies: { database: 'unavailable', redis: 'ok' } });
    await app.close();
  });

  it('reports unavailable Redis without leaking details', async () => {
    const { app } = createApp(environment, { database: { ping: async () => {}, query: async () => ({ rows: [] }), transaction: async (operation) => operation({ query: async () => ({ rows: [] }) }), close: async () => {} }, redis: { ping: async () => { throw new Error('redis connection refused'); }, close: async () => {} } });
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable', dependencies: { database: 'ok', redis: 'unavailable' } });
    await app.close();
  });
});
