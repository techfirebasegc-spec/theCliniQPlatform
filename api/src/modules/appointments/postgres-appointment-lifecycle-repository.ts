import { createIdentifier } from '../../shared/identifiers/uuid.js';
import type { AuditEventInput } from '../audit/audit.js';
import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';
import type { DatabaseHealth } from '../../infrastructure/database.js';
import type { AppointmentEventWrite, AppointmentLifecycleRepository, LifecycleAppointment } from './appointment-lifecycle.js';
import type { AppointmentStatus } from './appointment-foundation.js';

export class PostgresAppointmentLifecycleRepository implements AppointmentLifecycleRepository {
  public constructor(private readonly database: DatabaseHealth) {}
  public transaction<T>(operation: (database: PostgresExecutor) => Promise<T>) { return this.database.transaction(operation); }
  public async lockAppointment(database: PostgresExecutor, appointmentId: string): Promise<LifecycleAppointment | null> {
    const row = (await database.query<{ id: string; status: AppointmentStatus }>('SELECT id,status FROM appointments WHERE id=$1 FOR UPDATE', [appointmentId])).rows[0];
    return row ? { id: row.id, status: row.status } : null;
  }
  public async transitionAppointment(database: PostgresExecutor, appointmentId: string, from: AppointmentStatus, to: AppointmentStatus): Promise<boolean> {
    return (await database.query('UPDATE appointments SET status=$3 WHERE id=$1 AND status=$2', [appointmentId, from, to])).rowCount === 1;
  }
  public async appendEvent(database: PostgresExecutor, event: AppointmentEventWrite): Promise<void> {
    await database.query('INSERT INTO appointment_events (id,appointment_id,event_type,actor_account_id,previous_status,resulting_status,reason,context,audit_event_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)', [event.id,event.appointmentId,event.eventType,event.actorAccountId ?? null,event.previousStatus,event.resultingStatus,event.reason ?? null,JSON.stringify(event.context),event.auditEventId ?? null]);
  }
  public async appendAudit(database: PostgresExecutor, event: AuditEventInput): Promise<string> {
    const id = createIdentifier();
    await database.query('INSERT INTO audit_events (id,category,event_type,actor_account_id,tenant_id,target_type,target_id,outcome,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)', [id,event.category,event.eventType,event.actorAccountId ?? null,event.tenantId ?? null,event.targetType,event.targetId ?? null,event.outcome,JSON.stringify(event.metadata ?? {})]);
    return id;
  }
}
