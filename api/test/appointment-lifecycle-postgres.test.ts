import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createDatabase, type DatabaseHealth } from '../src/infrastructure/database.js';
import { AppointmentLifecycleError, AppointmentLifecycleService, type AppointmentEventWrite, type AppointmentLifecycleRepository, type LifecycleAppointment } from '../src/modules/appointments/appointment-lifecycle.js';
import { PostgresAppointmentLifecycleRepository } from '../src/modules/appointments/postgres-appointment-lifecycle-repository.js';
import type { AuditEventInput } from '../src/modules/audit/audit.js';
import type { AppointmentStatus } from '../src/modules/appointments/appointment-foundation.js';
import type { PostgresExecutor } from '../src/modules/sessions/postgres-session-repository.js';

const databaseUrl = process.env.DATABASE_URL;
let fixturePool: Pool | undefined;
let databaseA: DatabaseHealth | undefined;
let databaseB: DatabaseHealth | undefined;

describe.skipIf(!databaseUrl)('theCliniQ Phase 5 Step 5.2 real PostgreSQL appointment lifecycle', () => {
  beforeAll(async () => {
    fixturePool = new Pool({ connectionString: databaseUrl });
    const current = await fixturePool.query<{ name: string }>('SELECT current_database() AS name');
    if (current.rows[0]?.name !== 'cliniq_phase5_appointment_lifecycle_verify') {
      throw new Error('Refusing appointment lifecycle integration tests outside cliniq_phase5_appointment_lifecycle_verify.');
    }
    const schema = await fixturePool.query("SELECT to_regclass('appointments') AS appointments, to_regclass('appointment_events') AS events");
    if (!schema.rows[0]?.appointments || !schema.rows[0]?.events) throw new Error('Phase 5 Step 5.2 migration is not applied.');
    databaseA = createDatabase({ DATABASE_URL: databaseUrl! });
    databaseB = createDatabase({ DATABASE_URL: databaseUrl! });
  });

  afterAll(async () => { await databaseA?.close(); await databaseB?.close(); await fixturePool?.end(); });

  it('serializes concurrent transitions and leaves exactly one immutable event', async () => {
    const fixture = await seedPaymentPendingAppointment(fixturePool!);
    const serviceA = new AppointmentLifecycleService(new PostgresAppointmentLifecycleRepository(databaseA!));
    const serviceB = new AppointmentLifecycleService(new PostgresAppointmentLifecycleRepository(databaseB!));
    const request = { appointmentId: fixture.appointment, expectedStatus: 'PAYMENT_PENDING' as const, action: 'CONFIRM' as const, actorAccountId: fixture.doctorAccount, context: { source: 'postgres-concurrency-test' } };

    const outcomes = await Promise.allSettled([serviceA.transition(request), serviceB.transition(request)]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === 'rejected')).toMatchObject({ reason: { code: 'STALE_TRANSITION' } });

    const state = await fixturePool!.query<{ status: string }>('SELECT status FROM appointments WHERE id=$1', [fixture.appointment]);
    expect(state.rows[0]?.status).toBe('CONFIRMED');
    const events = await fixturePool!.query<{ count: string }>('SELECT count(*)::text AS count FROM appointment_events WHERE appointment_id=$1', [fixture.appointment]);
    expect(events.rows[0]?.count).toBe('1');
    const event = await fixturePool!.query<{ id: string }>('SELECT id FROM appointment_events WHERE appointment_id=$1', [fixture.appointment]);
    await expect(fixturePool!.query("UPDATE appointment_events SET reason='rewrite' WHERE id=$1", [event.rows[0]?.id])).rejects.toMatchObject({ code: 'P0001' });
  });

  it('rejects concurrent attempts against a terminal appointment without another event', async () => {
    const fixture = await seedPaymentPendingAppointment(fixturePool!);
    const serviceA = new AppointmentLifecycleService(new PostgresAppointmentLifecycleRepository(databaseA!));
    const serviceB = new AppointmentLifecycleService(new PostgresAppointmentLifecycleRepository(databaseB!));
    await serviceA.transition({ appointmentId: fixture.appointment, expectedStatus: 'PAYMENT_PENDING', action: 'EXPIRE', actorAccountId: fixture.doctorAccount });

    const outcomes = await Promise.allSettled([
      serviceA.transition({ appointmentId: fixture.appointment, expectedStatus: 'EXPIRED', action: 'CONFIRM', actorAccountId: fixture.doctorAccount }),
      serviceB.transition({ appointmentId: fixture.appointment, expectedStatus: 'EXPIRED', action: 'CONFIRM', actorAccountId: fixture.doctorAccount }),
    ]);
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((outcome) => outcome.status === 'rejected' && outcome.reason instanceof AppointmentLifecycleError && outcome.reason.code === 'TERMINAL_APPOINTMENT')).toBe(true);
    const events = await fixturePool!.query<{ count: string }>('SELECT count(*)::text AS count FROM appointment_events WHERE appointment_id=$1', [fixture.appointment]);
    expect(events.rows[0]?.count).toBe('1');
  });

  it('rolls back state and audit evidence when the real event insert fails', async () => {
    const fixture = await seedPaymentPendingAppointment(fixturePool!);
    const repository = new EventInsertFailureRepository(new PostgresAppointmentLifecycleRepository(databaseA!));
    const service = new AppointmentLifecycleService(repository);
    await expect(service.transition({ appointmentId: fixture.appointment, expectedStatus: 'PAYMENT_PENDING', action: 'CONFIRM', actorAccountId: fixture.doctorAccount })).rejects.toMatchObject({ code: 'EVENT_CONFLICT' });
    const state = await fixturePool!.query<{ status: string }>('SELECT status FROM appointments WHERE id=$1', [fixture.appointment]);
    const events = await fixturePool!.query<{ count: string }>('SELECT count(*)::text AS count FROM appointment_events WHERE appointment_id=$1', [fixture.appointment]);
    const audits = await fixturePool!.query<{ count: string }>("SELECT count(*)::text AS count FROM audit_events WHERE target_type='APPOINTMENT' AND target_id=$1", [fixture.appointment]);
    expect(state.rows[0]?.status).toBe('PAYMENT_PENDING');
    expect(events.rows[0]?.count).toBe('0');
    expect(audits.rows[0]?.count).toBe('0');
  });
});

class EventInsertFailureRepository implements AppointmentLifecycleRepository {
  public constructor(private readonly delegate: PostgresAppointmentLifecycleRepository) {}
  public transaction<T>(operation: (database: PostgresExecutor) => Promise<T>): Promise<T> {
    return this.delegate.transaction(operation);
  }
  public lockAppointment(database: PostgresExecutor, appointmentId: string): Promise<LifecycleAppointment | null> {
    return this.delegate.lockAppointment(database, appointmentId);
  }
  public transitionAppointment(database: PostgresExecutor, appointmentId: string, from: AppointmentStatus, to: AppointmentStatus): Promise<boolean> {
    return this.delegate.transitionAppointment(database, appointmentId, from, to);
  }
  public appendAudit(database: PostgresExecutor, event: AuditEventInput): Promise<string> {
    return this.delegate.appendAudit(database, event);
  }
  public async appendEvent(database: PostgresExecutor, event: AppointmentEventWrite): Promise<void> {
    return this.delegate.appendEvent(database, { ...event, actorAccountId: randomUUID() });
  }
}

async function seedPaymentPendingAppointment(target: Pool) {
  const patient = randomUUID(), doctorAccount = randomUUID(), doctor = randomUUID(), offering = randomUUID(), exposure = randomUUID(), version = randomUUID(), price = randomUUID(), policy = randomUUID(), intent = randomUUID(), reservation = randomUUID(), allocation = randomUUID(), payment = randomUUID(), handoff = randomUUID(), appointment = randomUUID();
  await target.query("INSERT INTO accounts (id,status) VALUES ($1,'ACTIVE'),($2,'ACTIVE')", [patient, doctorAccount]);
  await target.query("INSERT INTO patient_profiles (id,account_id,status) VALUES ($1,$1,'ACTIVE')", [patient]);
  await target.query("INSERT INTO doctor_profiles (id,account_id,status,professional_verification_status) VALUES ($1,$2,'ACTIVE','VERIFIED')", [doctor, doctorAccount]);
  await target.query("INSERT INTO service_offerings (id,owner_doctor_profile_id,name,status,created_by_account_id,updated_by_account_id) VALUES ($1,$2,'Lifecycle test','ACTIVE',$3,$3)", [offering, doctor, doctorAccount]);
  await target.query("INSERT INTO service_exposures (id,service_offering_id,provider_doctor_profile_id,status,created_by_account_id,updated_by_account_id) VALUES ($1,$2,$3,'DRAFT',$4,$4)", [exposure, offering, doctor, doctorAccount]);
  await target.query("UPDATE service_exposures SET status='PUBLISHED',updated_by_account_id=$2 WHERE id=$1", [exposure, doctorAccount]);
  await target.query("INSERT INTO service_offering_versions (id,service_offering_id,version_number,status,effective_from,created_by_account_id) VALUES ($1,$2,1,'ACTIVE',clock_timestamp()-interval '1 day',$3)", [version, offering, doctorAccount]);
  await target.query("INSERT INTO service_offering_prices (id,service_offering_version_id,currency,amount_minor,created_by_account_id) VALUES ($1,$2,'INR',10000,$3)", [price, version, doctorAccount]);
  await target.query('INSERT INTO service_offering_version_reservation_policies (id,service_offering_version_id,hold_seconds,created_by_account_id) VALUES ($1,$2,600,$3)', [policy, version, doctorAccount]);
  await target.query("INSERT INTO appointment_intents (id,patient_account_id,booking_actor_account_id,service_exposure_id,provider_doctor_profile_id,service_offering_id,service_offering_version_id,service_offering_price_id,currency,price_amount_minor,provider_timezone,requested_local_at,starts_at,ends_at,service_duration_seconds,buffer_before_seconds,buffer_after_seconds,hold_seconds,booking_relationship,state,idempotency_key,request_fingerprint,expires_at) VALUES ($1,$2,$2,$3,$4,$5,$6,$7,'INR',10000,'UTC',clock_timestamp()::timestamp,clock_timestamp(),clock_timestamp()+interval '30 minutes',1800,0,0,600,'PATIENT_PROVIDER','SLOT_RESERVED',$8,'lifecycle-fixture',clock_timestamp()+interval '10 minutes')", [intent, patient, exposure, doctor, offering, version, price, `lifecycle-${intent}`]);
  await target.query("INSERT INTO slot_reservations (id,appointment_intent_id,service_offering_version_id,provider_doctor_profile_id,starts_at,ends_at,capacity_units,status,expires_at) VALUES ($1,$2,$3,$4,clock_timestamp(),clock_timestamp()+interval '30 minutes',1,'HELD',clock_timestamp()+interval '10 minutes')", [reservation, intent, version, doctor]);
  const input = { appointmentIntentId: intent, slotReservationId: reservation, serviceExposureId: exposure, serviceOfferingId: offering, serviceOfferingVersionId: version, serviceOfferingPriceId: price, patientAccountId: patient, bookingActorAccountId: patient, currency: 'INR', grossAmountMinor: '10000' };
  await target.query("INSERT INTO financial_allocation_snapshots (id,status,currency,gross_amount_minor,calculation_basis,input_data,selected_rule_versions,created_by_account_id) VALUES ($1,'FINAL','INR',10000,'FIXED',$2::jsonb,'[]'::jsonb,$3)", [allocation, JSON.stringify(input), doctorAccount]);
  await target.query("INSERT INTO payment_intents (id,provider_key,status,currency,amount_minor,allocation_snapshot_id,idempotency_key,created_by_account_id) VALUES ($1,'RAZORPAY','CREATED','INR',10000,$2,$3,$4)", [payment, allocation, `lifecycle-payment-${intent}`, patient]);
  await target.query('INSERT INTO appointment_financial_handoffs (id,appointment_intent_id,slot_reservation_id,financial_allocation_snapshot_id,payment_intent_id,booking_actor_account_id,idempotency_key,request_fingerprint) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [handoff, intent, reservation, allocation, payment, patient, `lifecycle-handoff-${intent}`, 'lifecycle-fingerprint']);
  await target.query("UPDATE appointment_intents SET state='PAYMENT_PENDING' WHERE id=$1", [intent]);
  await target.query("UPDATE payment_intents SET status='SUCCEEDED' WHERE id=$1", [payment]);
  await target.query(`INSERT INTO appointments
    (id,appointment_intent_id,slot_reservation_id,appointment_financial_handoff_id,financial_allocation_snapshot_id,payment_intent_id,patient_account_id,booking_actor_account_id,provider_doctor_profile_id,service_exposure_id,service_offering_id,service_offering_version_id,service_offering_price_id,currency,price_amount_minor,provider_timezone,requested_local_at,starts_at,ends_at,service_duration_seconds,buffer_before_seconds,buffer_after_seconds,hold_seconds,status)
    SELECT $1,intent.id,reservation.id,handoff.id,handoff.financial_allocation_snapshot_id,handoff.payment_intent_id,intent.patient_account_id,intent.booking_actor_account_id,intent.provider_doctor_profile_id,intent.service_exposure_id,intent.service_offering_id,intent.service_offering_version_id,intent.service_offering_price_id,intent.currency,intent.price_amount_minor,intent.provider_timezone,intent.requested_local_at,intent.starts_at,intent.ends_at,intent.service_duration_seconds,intent.buffer_before_seconds,intent.buffer_after_seconds,intent.hold_seconds,'PAYMENT_PENDING'
    FROM appointment_intents intent JOIN slot_reservations reservation ON reservation.id=$3 AND reservation.appointment_intent_id=intent.id JOIN appointment_financial_handoffs handoff ON handoff.id=$4 AND handoff.appointment_intent_id=intent.id WHERE intent.id=$2`, [appointment, intent, reservation, handoff]);
  return { appointment, doctorAccount };
}
