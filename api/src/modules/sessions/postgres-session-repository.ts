import type { NewSession } from './session.js';

export interface PostgresExecutor {
  query<T extends Record<string, unknown>>(text: string, values: readonly unknown[]): Promise<{ rows: T[] }>;
}

export class PostgresSessionRepository {
  public constructor(private readonly database: PostgresExecutor) {}

  public async create(accountId: string, session: NewSession): Promise<void> {
    await this.database.query(
      'INSERT INTO sessions (id, account_id, secret_hash, status, created_at, last_seen_at, idle_expires_at, absolute_expires_at, created_by_account_id) VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $2)',
      [session.id, accountId, session.secretHash, 'ACTIVE', session.createdAt, session.idleExpiresAt, session.absoluteExpiresAt],
    );
  }

  public async findBySecretHash(secretHash: string) {
    const result = await this.database.query<{ id: string; account_id: string; status: 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'REPLACED' | 'SUSPICIOUS'; idle_expires_at: Date; absolute_expires_at: Date }>(
      'SELECT id, account_id, status, idle_expires_at, absolute_expires_at FROM sessions WHERE secret_hash = $1',
      [secretHash],
    );
    const session = result.rows[0];
    return session ? { id: session.id, accountId: session.account_id, status: session.status, idleExpiresAt: session.idle_expires_at, absoluteExpiresAt: session.absolute_expires_at } : null;
  }

  public async touch(sessionId: string, at: Date, idleExpiresAt: Date): Promise<void> {
    await this.database.query('UPDATE sessions SET last_seen_at = $2, idle_expires_at = $3, updated_at = $2 WHERE id = $1 AND status = \'ACTIVE\'', [sessionId, at, idleExpiresAt]);
  }

  public async revoke(sessionId: string, accountId: string, reason: string, at: Date): Promise<void> {
    await this.database.query(
      "UPDATE sessions SET status = 'REVOKED', revoked_at = $3, revoked_reason = $4, updated_at = $3 WHERE id = $1 AND account_id = $2 AND status = 'ACTIVE'",
      [sessionId, accountId, at, reason],
    );
  }
}
