import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';

export type AppointmentStatus = 'PAYMENT_PENDING' | 'CONFIRMED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED' | 'PAYMENT_FAILED';
export type AppointmentEventType = 'CONFIRMED' | 'STARTED' | 'COMPLETED' | 'CANCELLED' | 'RESCHEDULE_REQUESTED' | 'RESCHEDULED' | 'EXPIRED' | 'PAYMENT_FAILED' | 'SUPPORT_EXCEPTION';

export interface AppointmentLifecycleContext {
  appointmentIntentId: string;
  slotReservationId: string;
  appointmentId?: string;
}

export interface AppointmentFoundationRepository {
  lockLifecycleContext(database: PostgresExecutor, context: AppointmentLifecycleContext): Promise<boolean>;
}

/**
 * Step 5.1 exposes only the lock-order boundary; confirmation and operational
 * transitions remain deferred to later Step 5 slices.
 */
export class AppointmentFoundationService {
  public constructor(private readonly repository: AppointmentFoundationRepository) {}

  public async lockLifecycleContext(database: PostgresExecutor, context: AppointmentLifecycleContext): Promise<boolean> {
    return this.repository.lockLifecycleContext(database, context);
  }
}

export function canTransitionAppointment(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return (from === 'PAYMENT_PENDING' && (to === 'CONFIRMED' || to === 'PAYMENT_FAILED' || to === 'EXPIRED'))
    || (from === 'CONFIRMED' && (to === 'IN_PROGRESS' || to === 'CANCELLED'))
    || (from === 'IN_PROGRESS' && (to === 'COMPLETED' || to === 'CANCELLED'));
}
