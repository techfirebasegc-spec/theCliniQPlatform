import type { Environment } from '../config/environment.js';
import type { PostgresExecutor } from '../modules/sessions/postgres-session-repository.js';
import { Pool } from 'pg';

export interface DatabaseHealth extends PostgresExecutor {
  ping(): Promise<void>;
  transaction<T>(operation: (database: PostgresExecutor) => Promise<T>): Promise<T>;
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
    async transaction(operation) {
      const client = await pool.connect();
      try { await client.query('BEGIN'); const result = await operation({ query: async (text, values) => { const query = await client.query(text, [...values]); return { rows: query.rows, rowCount: query.rowCount }; } }); await client.query('COMMIT'); return result; } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    },
    async close() {
      await pool.end();
    },
  };
}
