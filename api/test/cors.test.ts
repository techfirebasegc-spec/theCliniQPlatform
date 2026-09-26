import type { Environment } from '../src/config/environment.js';
import { createApp } from '../src/app.js';
import { describe, expect, it } from 'vitest';

const environment: Environment = {
  NODE_ENV: 'production',
  API_PORT: 4000,
  WEB_URL: 'https://thecliniq.co.in',
  DATABASE_URL: 'postgresql://cliniq:cliniq@127.0.0.1:5432/cliniq_platform',
  REDIS_URL: 'redis://127.0.0.1:6379',
  FIREBASE_PROJECT_ID: 'test-project',
  PAYMENT_PROVIDER_KEY: 'RAZORPAY',
  SESSION_IDLE_TTL_SECONDS: 600,
  SESSION_ABSOLUTE_TTL_SECONDS: 3600,
};

function dependencies() {
  return {
    database: {
      ping: async () => {},
      query: async () => ({ rows: [] }),
      transaction: async (operation: (database: { query: () => Promise<{ rows: never[] }> }) => Promise<unknown>) => operation({ query: async () => ({ rows: [] }) }),
      close: async () => {},
    },
    redis: { ping: async () => {}, close: async () => {} },
  };
}

async function corsResponse(origin: string) {
  const { app } = createApp(environment, dependencies());
  const response = await app.inject({
    method: 'OPTIONS',
    url: '/v1/auth/firebase/session',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  await app.close();
  return response;
}

describe('production CORS origins', () => {
  it('allows the apex origin', async () => {
    const response = await corsResponse('https://thecliniq.co.in');
    expect(response.headers['access-control-allow-origin']).toBe('https://thecliniq.co.in');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('allows the www origin', async () => {
    const response = await corsResponse('https://www.thecliniq.co.in');
    expect(response.headers['access-control-allow-origin']).toBe('https://www.thecliniq.co.in');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('allows the explicit local Admin development origin', async () => {
    const response = await corsResponse('http://localhost:3001');
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3001');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('does not allow an unrelated origin', async () => {
    const response = await corsResponse('https://unrelated.example');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
