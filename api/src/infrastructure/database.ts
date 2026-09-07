import type { Environment } from '../config/environment.js';
import type { PostgresExecutor } from '../modules/sessions/postgres-session-repository.js';
import { Pool } from 'pg';

export interface DatabaseHealth extends PostgresExecutor {
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function createDatabase(environment: Pick<Environment, 'DATABASE_URL'>): DatabaseHealth {
  const pool = new Pool({ connectionString: environment.DATABASE_URL, max: 10 });

  return {
    async ping() {
      await pool.query('SELECT 1');
    },
    async query(text, values) {
      const result = await pool.query(text, [...values]);
      return { rows: result.rows, rowCount: result.rowCount };
    },
    async close() {
      await pool.end();
    },
  };
}
