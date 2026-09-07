import { loadEnvironment } from '../src/config/environment.js';
import { describe, expect, it } from 'vitest';

describe('environment validation', () => {
  it('accepts a valid development environment', () => {
    expect(loadEnvironment({ NODE_ENV: 'development', API_PORT: '4000', WEB_URL: 'http://localhost:3000', DATABASE_URL: 'postgresql://user:pass@localhost:5432/test', REDIS_URL: 'redis://localhost:6379' })).toMatchObject({ API_PORT: 4000 });
  });

  it('rejects missing infrastructure configuration', () => {
    expect(() => loadEnvironment({ WEB_URL: 'http://localhost:3000' })).toThrow('Invalid environment configuration');
  });
});
