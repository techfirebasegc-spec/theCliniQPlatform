import { createIdentifier } from '../../shared/identifiers/uuid.js';
import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';
import type { AuditEventInput, TransactionalAuditRepository } from './audit.js';

export class PostgresAuditRepository implements TransactionalAuditRepository {
  public constructor(private readonly database: PostgresExecutor) {}

  public async append(event: AuditEventInput): Promise<void> {
    await this.appendTo(this.database, event);
  }

  public async appendInTransaction(database: PostgresExecutor, event: AuditEventInput): Promise<void> {
    await this.appendTo(database, event);
  }

  private async appendTo(database: PostgresExecutor, event: AuditEventInput): Promise<void> {
    await database.query(
      'INSERT INTO audit_events (id, category, event_type, actor_account_id, tenant_id, target_type, target_id, outcome, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [createIdentifier(), event.category, event.eventType, event.actorAccountId ?? null, event.tenantId ?? null, event.targetType, event.targetId ?? null, event.outcome, event.metadata ?? {}],
    );
  }
}
