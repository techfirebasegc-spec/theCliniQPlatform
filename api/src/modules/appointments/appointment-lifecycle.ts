import { createIdentifier } from '../../shared/identifiers/uuid.js';
import type { AuditEventInput } from '../audit/audit.js';
import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';
import { canTransitionAppointment, type AppointmentEventType, type AppointmentStatus } from './appointment-foundation.js';

export type AppointmentTransitionAction = 'CONFIRM' | 'PAYMENT_FAIL' | 'EXPIRE' | 'START' | 'COMPLETE' | 'CANCEL';
export interface AppointmentTransitionRequest {
  appointmentId: string;
  expectedStatus: AppointmentStatus;
  action: AppointmentTransitionAction;
  actorAccountId?: string;
  reason?: string;
  context?: Record<string, string | number | boolean | null>;
}
export interface LifecycleAppointment { id: string; status: AppointmentStatus; }
export interface AppointmentEventWrite {
  id: string;
  appointmentId: string;
  eventType: AppointmentEventType;
  actorAccountId?: string;
  previousStatus: AppointmentStatus;
  resultingStatus: AppointmentStatus;
  reason?: string;
  context: Record<string, string | number | boolean | null>;
  auditEventId?: string;
}

export interface AppointmentLifecycleRepository {
  transaction<T>(operation: (database: PostgresExecutor) => Promise<T>): Promise<T>;
  lockAppointment(database: PostgresExecutor, appointmentId: string): Promise<LifecycleAppointment | null>;
  transitionAppointment(database: PostgresExecutor, appointmentId: string, from: AppointmentStatus, to: AppointmentStatus): Promise<boolean>;
  appendEvent(database: PostgresExecutor, event: AppointmentEventWrite): Promise<void>;
  appendAudit(database: PostgresExecutor, event: AuditEventInput): Promise<string>;
}

export class AppointmentLifecycleError extends Error {
  public constructor(public readonly code: 'APPOINTMENT_NOT_FOUND' | 'INVALID_TRANSITION' | 'TERMINAL_APPOINTMENT' | 'STALE_TRANSITION' | 'EVENT_CONFLICT') {
    super(code);
    this.name = 'AppointmentLifecycleError';
  }
}

/**
 * Internal lifecycle boundary. Authorization and provider-fact verification are
 * deliberately deferred to their workflow services; this service never accepts
 * a client-controlled status value or calls an external provider.
 */
export class AppointmentLifecycleService {
  public constructor(private readonly repository: AppointmentLifecycleRepository) {}

  public async transition(request: AppointmentTransitionRequest): Promise<{ appointmentId: string; previousStatus: AppointmentStatus; resultingStatus: AppointmentStatus; eventId: string }> {
    const target = targetFor(request.action);
    return this.repository.transaction(async (database) => {
      const appointment = await this.repository.lockAppointment(database, request.appointmentId);
      if (!appointment) throw new AppointmentLifecycleError('APPOINTMENT_NOT_FOUND');
      if (terminal(appointment.status)) throw new AppointmentLifecycleError('TERMINAL_APPOINTMENT');
      if (appointment.status !== request.expectedStatus) throw new AppointmentLifecycleError('STALE_TRANSITION');
      if (!canTransitionAppointment(appointment.status, target.status)) throw new AppointmentLifecycleError('INVALID_TRANSITION');
      if (!await this.repository.transitionAppointment(database, appointment.id, appointment.status, target.status)) throw new AppointmentLifecycleError('STALE_TRANSITION');
      const auditEventId = await this.repository.appendAudit(database, {
        category: 'BUSINESS', eventType: `APPOINTMENT_${target.eventType}`, actorAccountId: request.actorAccountId,
        targetType: 'APPOINTMENT', targetId: appointment.id, outcome: 'SUCCESS',
        metadata: { previousStatus: appointment.status, resultingStatus: target.status },
      });
      const event: AppointmentEventWrite = {
        id: createIdentifier(), appointmentId: appointment.id, eventType: target.eventType, actorAccountId: request.actorAccountId,
        previousStatus: appointment.status, resultingStatus: target.status, reason: request.reason, context: request.context ?? {}, auditEventId,
      };
      try {
        await this.repository.appendEvent(database, event);
      } catch {
        throw new AppointmentLifecycleError('EVENT_CONFLICT');
      }
      return { appointmentId: appointment.id, previousStatus: appointment.status, resultingStatus: target.status, eventId: event.id };
    });
  }
}

function targetFor(action: AppointmentTransitionAction): { status: AppointmentStatus; eventType: AppointmentEventType } {
  const values: Record<AppointmentTransitionAction, { status: AppointmentStatus; eventType: AppointmentEventType }> = {
    CONFIRM: { status: 'CONFIRMED', eventType: 'CONFIRMED' }, PAYMENT_FAIL: { status: 'PAYMENT_FAILED', eventType: 'PAYMENT_FAILED' },
    EXPIRE: { status: 'EXPIRED', eventType: 'EXPIRED' }, START: { status: 'IN_PROGRESS', eventType: 'STARTED' },
    COMPLETE: { status: 'COMPLETED', eventType: 'COMPLETED' }, CANCEL: { status: 'CANCELLED', eventType: 'CANCELLED' },
  };
  return values[action];
}
function terminal(status: AppointmentStatus) { return status === 'COMPLETED' || status === 'CANCELLED' || status === 'EXPIRED' || status === 'PAYMENT_FAILED'; }
