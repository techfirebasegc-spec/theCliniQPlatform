import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';
import type { AppointmentFoundationRepository, AppointmentLifecycleContext } from './appointment-foundation.js';

export class PostgresAppointmentFoundationRepository implements AppointmentFoundationRepository {
  public async lockLifecycleContext(database: PostgresExecutor, context: AppointmentLifecycleContext): Promise<boolean> {
    const lifecycle = await database.query(`
      SELECT intent.id
      FROM appointment_intents intent
      JOIN slot_reservations reservation ON reservation.id=$2::uuid AND reservation.appointment_intent_id=intent.id
      WHERE intent.id=$1::uuid
      FOR UPDATE OF intent,reservation
    `, [context.appointmentIntentId, context.slotReservationId]);
    if (lifecycle.rowCount !== 1) return false;
    if (!context.appointmentId) return true;
    const appointment = await database.query(`
      SELECT id FROM appointments
      WHERE id=$1::uuid AND appointment_intent_id=$2::uuid
      FOR UPDATE
    `, [context.appointmentId, context.appointmentIntentId]);
    return appointment.rowCount === 1;
  }
}
