import { describe, expect, it } from 'vitest';
import { canTransitionAppointment, type AppointmentFoundationRepository, AppointmentFoundationService } from '../src/modules/appointments/appointment-foundation.js';
import { PostgresAppointmentFoundationRepository } from '../src/modules/appointments/postgres-appointment-foundation-repository.js';

describe('theCliniQ Phase 5 Step 5.1 Appointment foundation', () => {
  it('permits only approved operational state transitions', () => {
    expect(canTransitionAppointment('CONFIRMED', 'IN_PROGRESS')).toBe(true);
    expect(canTransitionAppointment('CONFIRMED', 'CANCELLED')).toBe(true);
    expect(canTransitionAppointment('IN_PROGRESS', 'COMPLETED')).toBe(true);
    expect(canTransitionAppointment('IN_PROGRESS', 'CANCELLED')).toBe(true);
    expect(canTransitionAppointment('CONFIRMED', 'COMPLETED')).toBe(false);
    expect(canTransitionAppointment('COMPLETED', 'IN_PROGRESS')).toBe(false);
    expect(canTransitionAppointment('CANCELLED', 'CONFIRMED')).toBe(false);
  });

  it('delegates lifecycle locking through the Intent → Reservation → Appointment boundary', async () => {
    const calls: unknown[] = [];
    const repository: AppointmentFoundationRepository = { lockLifecycleContext: async (_database, context) => { calls.push(context); return true; } };
    const service = new AppointmentFoundationService(repository);
    await expect(service.lockLifecycleContext({ query: async () => ({ rows: [], rowCount: 0 }) }, { appointmentIntentId: 'intent', slotReservationId: 'reservation', appointmentId: 'appointment' })).resolves.toBe(true);
    expect(calls).toEqual([{ appointmentIntentId: 'intent', slotReservationId: 'reservation', appointmentId: 'appointment' }]);
  });

  it('acquires Intent and Reservation before an existing Appointment', async () => {
    const queries: string[] = [];
    const database = { query: async (text: string) => { queries.push(text); return { rows: [], rowCount: 1 }; } };
    await expect(new PostgresAppointmentFoundationRepository().lockLifecycleContext(database, { appointmentIntentId: 'intent', slotReservationId: 'reservation', appointmentId: 'appointment' })).resolves.toBe(true);
    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain('FOR UPDATE OF intent,reservation');
    expect(queries[1]).toContain('FROM appointments');
    expect(queries[1]).toContain('FOR UPDATE');
  });
});
