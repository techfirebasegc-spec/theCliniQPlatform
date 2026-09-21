import { loadEnvironment } from '../src/config/environment.js';
import { describe, expect, it } from 'vitest';

describe('environment validation', () => {
  it('accepts a valid development environment', () => {
    expect(loadEnvironment({ NODE_ENV: 'development', API_PORT: '4000', WEB_URL: 'http://localhost:3000', DATABASE_URL: 'postgresql://user:pass@localhost:5432/test', REDIS_URL: 'redis://localhost:6379', FIREBASE_PROJECT_ID: 'test-project', PAYMENT_PROVIDER_KEY: 'RAZORPAY', RAZORPAY_KEY_ID: 'test-key', RAZORPAY_KEY_SECRET: 'test-secret', RAZORPAY_WEBHOOK_SECRET: 'test-webhook-secret', PAYMENT_ORDER_PROVISIONING_LEASE_SECONDS: '60', AIC_S3_ENDPOINT: 'https://s3.example.test', AIC_S3_REGION: 'us-east-1', AIC_S3_BUCKET: 'test-bucket', AIC_S3_ACCESS_KEY_ID: 'test-access-key', AIC_S3_SECRET_ACCESS_KEY: 'test-secret-key', SESSION_IDLE_TTL_SECONDS: '3600', SESSION_ABSOLUTE_TTL_SECONDS: '7200' })).toMatchObject({ API_PORT: 4000 });
  });

  it('requires complete AIC S3 configuration when any AIC field is present', () => {
    expect(() => loadEnvironment({ NODE_ENV: 'development', API_PORT: '4000', WEB_URL: 'http://localhost:3000', DATABASE_URL: 'postgresql://user:pass@localhost:5432/test', REDIS_URL: 'redis://localhost:6379', FIREBASE_PROJECT_ID: 'test-project', PAYMENT_PROVIDER_KEY: 'RAZORPAY', AIC_S3_ENDPOINT: 'https://s3.example.test', SESSION_IDLE_TTL_SECONDS: '3600', SESSION_ABSOLUTE_TTL_SECONDS: '7200' })).toThrow('Invalid environment configuration');
  });

  it('rejects missing infrastructure configuration', () => {
    expect(() => loadEnvironment({ WEB_URL: 'http://localhost:3000' })).toThrow('Invalid environment configuration');
  });
});
