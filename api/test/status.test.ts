import type { Environment } from '../src/config/environment.js';
import { loadEnvironment } from '../src/config/environment.js';
import { createApp } from '../src/app.js';
import { describe, expect, it } from 'vitest';

const environment: Environment = {
  NODE_ENV: 'test',
  API_PORT: 4000,
  WEB_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://cliniq:cliniq@127.0.0.1:5432/cliniq_platform',
  REDIS_URL: 'redis://127.0.0.1:6379',
  FIREBASE_PROJECT_ID: 'test-project',
  PAYMENT_PROVIDER_KEY: 'RAZORPAY',
  SESSION_IDLE_TTL_SECONDS: 600,
  SESSION_ABSOLUTE_TTL_SECONDS: 3600,
};

describe('status routes', () => {
  it('starts without Razorpay credentials when Razorpay is unconfigured', async () => {
    const source = {
      NODE_ENV: 'test', API_PORT: '4000', WEB_URL: 'http://localhost:3000',
      DATABASE_URL: 'postgresql://cliniq:cliniq@127.0.0.1:5432/cliniq_platform', REDIS_URL: 'redis://127.0.0.1:6379',
      FIREBASE_PROJECT_ID: 'test-project', PAYMENT_PROVIDER_KEY: 'RAZORPAY', SESSION_IDLE_TTL_SECONDS: '600', SESSION_ABSOLUTE_TTL_SECONDS: '3600',
    };
    const unconfigured = loadEnvironment(source);
    expect(unconfigured.RAZORPAY_KEY_ID).toBeUndefined();
    const dependencies = { database: { ping: async () => {}, query: async () => ({ rows: [] }), transaction: async (operation: (database: { query: () => Promise<{ rows: never[] }> }) => Promise<unknown>) => operation({ query: async () => ({ rows: [] }) }), close: async () => {} }, redis: { ping: async () => {}, close: async () => {} } };
    const { app } = createApp(unconfigured, dependencies);
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
    const webhook = await app.inject({ method: 'POST', url: '/v1/providers/razorpay/webhook', headers: { 'content-type': 'application/json' }, payload: '{}' });
    expect(webhook.statusCode).toBe(503);
    expect(webhook.json()).toEqual({ error: { code: 'PROVIDER_NOT_CONFIGURED', message: 'Payment provider is not configured.' } });
    await app.close();
  });

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
