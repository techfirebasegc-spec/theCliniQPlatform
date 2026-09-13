import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { createDatabase, type DatabaseHealth } from '../src/infrastructure/database.js';
import { PostgresAuditRepository } from '../src/modules/audit/postgres-audit-repository.js';
import { AppointmentAuthorizationService } from '../src/modules/appointments/appointment-authorization.js';
import { PostgresAppointmentRepository } from '../src/modules/appointments/postgres-appointment-repository.js';
import { PostgresAppointmentAuthorizationRepository } from '../src/modules/appointments/postgres-appointment-authorization-repository.js';
import { PostgresRescheduleRepository } from '../src/modules/appointments/postgres-rescheduling-repository.js';
import { RescheduleError, RescheduleService } from '../src/modules/appointments/rescheduling.js';

const databaseUrl = process.env.DATABASE_URL;
const enabled = Boolean(databaseUrl);
const ids = Array.from({ length: 17 }, () => randomUUID());
const [patientA, patientB, doctorAccount, doctorProfile, offering, exposure, version, price, policy, configuration, rule, window, sourceA, sourceB, sourceIntentA, sourceIntentB, unused] = ids;
void unused;
let pool: Pool | undefined;
let databaseA: DatabaseHealth | undefined;
let databaseB: DatabaseHealth | undefined;

describe.skipIf(!enabled)('theCliniQ Phase 5.6 real PostgreSQL rescheduling concurrency', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    const current = await pool.query<{ name: string }>('SELECT current_database() AS name');
    if (current.rows[0]?.name !== 'cliniq_phase5_rescheduling_verify') {
      throw new Error('Refusing PostgreSQL rescheduling tests outside cliniq_phase5_rescheduling_verify.');
    }
    const schema = await pool.query("SELECT to_regclass('appointment_committed_capacities') AS capacities, to_regclass('appointment_reschedules') AS reschedules, to_regclass('appointments') AS appointments");
    if (!schema.rows[0]?.capacities || !schema.rows[0]?.reschedules || !schema.rows[0]?.appointments) {
      throw new Error('Phase 5.6 rescheduling schema is not migrated.');
    }
    await seed(pool);
    databaseA = createDatabase({ DATABASE_URL: databaseUrl! });
    databaseB = createDatabase({ DATABASE_URL: databaseUrl! });
  });

  afterAll(async () => {
    // appointment/reschedule/event evidence is intentionally immutable. Retain only
    // this fixture's immutable history in the dedicated disposable database.
    await databaseA?.close();
    await databaseB?.close();
    await pool?.end();
  });

  it('serializes two sources competing for one target capacity without orphaning the loser', async () => {
    const target = nextMondayLocal(new Date());
    const serviceA = service(databaseA!);
    const serviceB = service(databaseB!);
    const outcomes = await Promise.allSettled([
      serviceA.reschedule(patientA, sourceA, { requestedLocalAt: target, reason: 'patient request', idempotencyKey: 'reschedule-a' }),
      serviceB.reschedule(patientB, sourceB, { requestedLocalAt: target, reason: 'patient request', idempotencyKey: 'reschedule-b' }),
    ]);
    const successes = outcomes.filter((outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof serviceA.reschedule>>> => outcome.status === 'fulfilled');
    const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toMatchObject({ code: 'CONFLICT' } satisfies Partial<RescheduleError>);

    const winner = successes[0]!.value;
    const loser = winner.sourceAppointmentId === sourceA ? sourceB : sourceA;
    const sourceCapacities = await pool!.query<{ appointment_id: string; status: string }>(
      'SELECT appointment_id,status FROM appointment_committed_capacities WHERE appointment_id = ANY($1::uuid[]) ORDER BY appointment_id',
      [[sourceA, sourceB]],
    );
    expect(sourceCapacities.rows).toEqual(expect.arrayContaining([
      { appointment_id: winner.sourceAppointmentId, status: 'RELEASED' },
      { appointment_id: loser, status: 'ACTIVE' },
    ]));
    const successors = await pool!.query<{ count: string }>('SELECT count(*)::text AS count FROM appointments WHERE reschedule_source_appointment_id = ANY($1::uuid[])', [[sourceA, sourceB]]);
    const reschedules = await pool!.query<{ count: string }>('SELECT count(*)::text AS count FROM appointment_reschedules WHERE source_appointment_id = ANY($1::uuid[])', [[sourceA, sourceB]]);
    const targetCapacity = await pool!.query<{ count: string }>(`SELECT count(*)::text AS count FROM appointment_committed_capacities capacity
      JOIN appointments appointment ON appointment.id=capacity.appointment_id
      WHERE appointment.reschedule_source_appointment_id = ANY($1::uuid[]) AND capacity.status='ACTIVE'`, [[sourceA, sourceB]]);
    const sourceStates = await pool!.query<{ id: string; status: string }>('SELECT id,status FROM appointments WHERE id = ANY($1::uuid[])', [[sourceA, sourceB]]);
    expect(successors.rows[0]?.count).toBe('1');
    expect(reschedules.rows[0]?.count).toBe('1');
    expect(targetCapacity.rows[0]?.count).toBe('1');
    expect(sourceStates.rows).toEqual(expect.arrayContaining([{ id: sourceA, status: 'CONFIRMED' }, { id: sourceB, status: 'CONFIRMED' }]));

    const loserOrphans = await pool!.query<{ count: string }>(`SELECT count(*)::text AS count FROM appointments appointment
      JOIN appointment_reschedules reschedule ON reschedule.successor_appointment_id=appointment.id
      WHERE reschedule.source_appointment_id=$1`, [loser]);
    expect(loserOrphans.rows[0]?.count).toBe('0');
  });
});

function service(database: DatabaseHealth): RescheduleService {
  const audit = new PostgresAuditRepository(database);
  const authorization = new AppointmentAuthorizationService(
    new PostgresAppointmentAuthorizationRepository(database),
    { require: async () => { throw new Error('Tenant authorization is not used for independent doctor appointments.'); }, requireInTransaction: async () => { throw new Error('Tenant authorization is not used for independent doctor appointments.'); } },
    audit,
  );
  return new RescheduleService(new PostgresAppointmentRepository(database), new PostgresRescheduleRepository(database), authorization);
}

function nextMondayLocal(now: Date): string {
  const target = new Date(now);
  target.setUTCDate(target.getUTCDate() + ((8 - target.getUTCDay()) % 7 || 7));
  return `${target.toISOString().slice(0, 10)}T11:00:00`;
}

async function seed(target: Pool): Promise<void> {
  const client = await target.connect();
  try {
    await client.query('BEGIN');
    await client.query("INSERT INTO accounts (id,status) VALUES ($1,'ACTIVE'),($2,'ACTIVE'),($3,'ACTIVE')", [patientA, patientB, doctorAccount]);
    await client.query("INSERT INTO patient_profiles (id,account_id,status) VALUES ($1,$1,'ACTIVE'),($2,$2,'ACTIVE')", [patientA, patientB]);
    await client.query("INSERT INTO doctor_profiles (id,account_id,status,professional_verification_status) VALUES ($1,$2,'ACTIVE','VERIFIED')", [doctorProfile, doctorAccount]);
    await client.query("INSERT INTO service_offerings (id,owner_doctor_profile_id,name,status,created_by_account_id,updated_by_account_id) VALUES ($1,$2,'Rescheduling concurrency fixture','ACTIVE',$3,$3)", [offering, doctorProfile, doctorAccount]);
    await client.query("INSERT INTO service_exposures (id,service_offering_id,provider_doctor_profile_id,status,created_by_account_id,updated_by_account_id) VALUES ($1,$2,$3,'DRAFT',$4,$4)", [exposure, offering, doctorProfile, doctorAccount]);
    await client.query("UPDATE service_exposures SET status='PUBLISHED',updated_by_account_id=$2 WHERE id=$1", [exposure, doctorAccount]);
    await client.query("INSERT INTO service_offering_versions (id,service_offering_id,version_number,status,effective_from,created_by_account_id) VALUES ($1,$2,1,'ACTIVE',current_timestamp-interval '1 day',$3)", [version, offering, doctorAccount]);
    await client.query("INSERT INTO service_offering_prices (id,service_offering_version_id,currency,amount_minor,created_by_account_id) VALUES ($1,$2,'INR',10000,$3)", [price, version, doctorAccount]);
    await client.query("INSERT INTO service_offering_version_reservation_policies (id,service_offering_version_id,hold_seconds,created_by_account_id) VALUES ($1,$2,600,$3)", [policy, version, doctorAccount]);
    await client.query("INSERT INTO availability_configurations (id,service_offering_version_id,provider_timezone,slot_duration_seconds,buffer_before_seconds,buffer_after_seconds,capacity,booking_lead_time_seconds,booking_horizon_seconds,status,created_by_account_id) VALUES ($1,$2,'Asia/Kolkata',1800,0,0,1,0,1209600,'ACTIVE',$3)", [configuration, version, doctorAccount]);
    await client.query("INSERT INTO availability_rules (id,availability_configuration_id,canonical_recurrence,recurrence_identity,effective_from,status,created_by_account_id) VALUES ($1,$2,'FREQ=WEEKLY;BYDAY=MO','FREQ=WEEKLY;BYDAY=MO',current_timestamp-interval '1 day','ACTIVE',$3)", [rule, configuration, doctorAccount]);
    await client.query("INSERT INTO availability_windows (id,availability_rule_id,kind,weekday,start_seconds,end_seconds,created_by_account_id) VALUES ($1,$2,'WORKING',1,32400,61200,$3)", [window, rule, doctorAccount]);
    await seedSource(client, sourceA, sourceIntentA, patientA, '09:00:00');
    await seedSource(client, sourceB, sourceIntentB, patientB, '10:00:00');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function seedSource(client: PoolClient, appointmentId: string, intentId: string, patientId: string, localTime: string): Promise<void> {
  const reservationId = randomUUID(), allocationId = randomUUID(), paymentId = randomUUID(), handoffId = randomUUID(), capacityId = randomUUID(), auditId = randomUUID(), eventId = randomUUID();
  const monday = nextMondayLocal(new Date());
  const local = `${monday.slice(0, 10)}T${localTime}`;
  await client.query(`INSERT INTO appointment_intents (id,patient_account_id,booking_actor_account_id,service_exposure_id,provider_doctor_profile_id,service_offering_id,service_offering_version_id,service_offering_price_id,currency,price_amount_minor,provider_timezone,requested_local_at,starts_at,ends_at,service_duration_seconds,buffer_before_seconds,buffer_after_seconds,hold_seconds,booking_relationship,state,idempotency_key,request_fingerprint,expires_at)
    VALUES ($1,$2,$2,$3,$4,$5,$6,$7,'INR',10000,'Asia/Kolkata',$8,($8::timestamp AT TIME ZONE 'Asia/Kolkata'),($8::timestamp AT TIME ZONE 'Asia/Kolkata')+interval '30 minutes',1800,0,0,600,'PATIENT_PROVIDER','SLOT_RESERVED',$9,'fixture',current_timestamp+interval '1 day')`, [intentId, patientId, exposure, doctorProfile, offering, version, price, local, `source-${intentId}`]);
  await client.query("INSERT INTO slot_reservations (id,appointment_intent_id,service_offering_version_id,provider_doctor_profile_id,starts_at,ends_at,capacity_units,status,expires_at) SELECT $1,id,service_offering_version_id,provider_doctor_profile_id,starts_at,ends_at,1,'HELD',current_timestamp+interval '1 day' FROM appointment_intents WHERE id=$2", [reservationId, intentId]);
  const input = { appointmentIntentId: intentId, slotReservationId: reservationId, serviceExposureId: exposure, serviceOfferingId: offering, serviceOfferingVersionId: version, serviceOfferingPriceId: price, patientAccountId: patientId, bookingActorAccountId: patientId, currency: 'INR', grossAmountMinor: '10000' };
  await client.query("INSERT INTO financial_allocation_snapshots (id,status,currency,gross_amount_minor,calculation_basis,input_data,selected_rule_versions,created_by_account_id) VALUES ($1,'FINAL','INR',10000,'FIXED',$2::jsonb,'[]'::jsonb,$3)", [allocationId, JSON.stringify(input), doctorAccount]);
  await client.query("INSERT INTO payment_intents (id,provider_key,status,currency,amount_minor,allocation_snapshot_id,idempotency_key,created_by_account_id) VALUES ($1,'RAZORPAY','CREATED','INR',10000,$2,$3,$4)", [paymentId, allocationId, `payment-${intentId}`, patientId]);
  await client.query('INSERT INTO appointment_financial_handoffs (id,appointment_intent_id,slot_reservation_id,financial_allocation_snapshot_id,payment_intent_id,booking_actor_account_id,idempotency_key,request_fingerprint) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [handoffId, intentId, reservationId, allocationId, paymentId, patientId, `handoff-${intentId}`, 'fixture']);
  await client.query("UPDATE appointment_intents SET state='PAYMENT_PENDING' WHERE id=$1", [intentId]);
  await client.query("UPDATE payment_intents SET status='SUCCEEDED' WHERE id=$1", [paymentId]);
  await client.query(`INSERT INTO appointments (id,appointment_intent_id,slot_reservation_id,appointment_financial_handoff_id,financial_allocation_snapshot_id,payment_intent_id,patient_account_id,booking_actor_account_id,provider_doctor_profile_id,service_exposure_id,service_offering_id,service_offering_version_id,service_offering_price_id,currency,price_amount_minor,provider_timezone,requested_local_at,starts_at,ends_at,service_duration_seconds,buffer_before_seconds,buffer_after_seconds,hold_seconds,status)
    SELECT $1,intent.id,reservation.id,handoff.id,handoff.financial_allocation_snapshot_id,handoff.payment_intent_id,intent.patient_account_id,intent.booking_actor_account_id,intent.provider_doctor_profile_id,intent.service_exposure_id,intent.service_offering_id,intent.service_offering_version_id,intent.service_offering_price_id,intent.currency,intent.price_amount_minor,intent.provider_timezone,intent.requested_local_at,intent.starts_at,intent.ends_at,intent.service_duration_seconds,intent.buffer_before_seconds,intent.buffer_after_seconds,intent.hold_seconds,'PAYMENT_PENDING'
    FROM appointment_intents intent JOIN slot_reservations reservation ON reservation.id=$3 JOIN appointment_financial_handoffs handoff ON handoff.id=$4 WHERE intent.id=$2`, [appointmentId, intentId, reservationId, handoffId]);
  await client.query("INSERT INTO appointment_participants (id,appointment_id,participant_type,patient_profile_id) VALUES ($1,$2,'PATIENT',$3)", [randomUUID(), appointmentId, patientId]);
  await client.query("INSERT INTO appointment_participants (id,appointment_id,participant_type,doctor_profile_id) VALUES ($1,$2,'DOCTOR',$3)", [randomUUID(), appointmentId, doctorProfile]);
  await client.query('INSERT INTO appointment_committed_capacities (id,appointment_id,slot_reservation_id,service_offering_version_id,starts_at,ends_at,capacity_units) SELECT $1,$2,id,service_offering_version_id,starts_at,ends_at,capacity_units FROM slot_reservations WHERE id=$3', [capacityId, appointmentId, reservationId]);
  await client.query("UPDATE appointments SET status='CONFIRMED' WHERE id=$1 AND status='PAYMENT_PENDING'", [appointmentId]);
  await client.query("INSERT INTO audit_events (id,category,event_type,target_type,target_id,outcome,metadata) VALUES ($1,'BUSINESS','FIXTURE_APPOINTMENT_CONFIRMED','APPOINTMENT',$2,'SUCCESS','{}'::jsonb)", [auditId, appointmentId]);
  await client.query("INSERT INTO appointment_events (id,appointment_id,event_type,previous_status,resulting_status,context,audit_event_id) VALUES ($1,$2,'CONFIRMED','PAYMENT_PENDING','CONFIRMED','{}'::jsonb,$3)", [eventId, appointmentId, auditId]);
}
