import type { Environment } from '../config/environment.js';
import { Pool } from 'pg';

export interface DatabaseHealth {
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function createDatabase(environment: Pick<Environment, 'DATABASE_URL'>): DatabaseHealth {
  const pool = new Pool({ connectionString: environment.DATABASE_URL, max: 10 });

  return {
    async ping() {
      await pool.query('SELECT 1');
    },
    async close() {
      await pool.end();
    },
  };
}
