import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { createDatabase, type DatabaseHealth } from '../src/infrastructure/database.js';
import { PostgresAuditRepository } from '../src/modules/audit/postgres-audit-repository.js';
import { AppointmentAuthorizationService } from '../src/modules/appointments/appointment-authorization.js';
import { AppointmentLifecycleError, AppointmentLifecycleService } from '../src/modules/appointments/appointment-lifecycle.js';
import { PostgresAppointmentAuthorizationRepository } from '../src/modules/appointments/postgres-appointment-authorization-repository.js';
import { PostgresAppointmentLifecycleRepository } from '../src/modules/appointments/postgres-appointment-lifecycle-repository.js';
import type { AuditEventInput } from '../src/modules/audit/audit.js';
import type { AppointmentEventWrite, AppointmentLifecycleRepository, LifecycleAppointment } from '../src/modules/appointments/appointment-lifecycle.js';
import type { AppointmentStatus } from '../src/modules/appointments/appointment-foundation.js';
import type { PostgresExecutor } from '../src/modules/sessions/postgres-session-repository.js';

const databaseUrl = process.env.DATABASE_URL;
let fixturePool: Pool | undefined;
let databaseA: DatabaseHealth | undefined;
let databaseB: DatabaseHealth | undefined;

describe.skipIf(!databaseUrl)('theCliniQ Phase 5.7 real PostgreSQL Start / Completion lifecycle', () => {
  beforeAll(async () => {
    fixturePool = new Pool({ connectionString: databaseUrl });
    const current = await fixturePool.query<{ name: string }>('SELECT current_database() AS name');
    if (current.rows[0]?.name !== 'cliniq_phase5_appointment_start_completion_verify') throw new Error('Refusing appointment Start / Completion integration tests outside cliniq_phase5_appointment_start_completion_verify.');
    const schema = await fixturePool.query("SELECT to_regclass('appointments') AS appointments, to_regclass('appointment_events') AS events, to_regclass('appointment_participants') AS participants, to_regclass('appointment_committed_capacities') AS capacities");
    if (!schema.rows[0]?.appointments || !schema.rows[0]?.events || !schema.rows[0]?.participants || !schema.rows[0]?.capacities) throw new Error('Phase 5.7 prerequisites are not applied.');
    databaseA = createDatabase({ DATABASE_URL: databaseUrl! }); databaseB = createDatabase({ DATABASE_URL: databaseUrl! });
  });
  afterAll(async () => { await databaseA?.close(); await databaseB?.close(); await fixturePool?.end(); });

  it('serializes concurrent Payment Pending to Confirmed transitions and rejects direct event mutation', async () => {
    const fixture = await seedOperationalAppointment(fixturePool!, 'PAYMENT_PENDING');
    const serviceA = operationalService(databaseA!);
    const serviceB = operationalService(databaseB!);
    const request = { appointmentId: fixture.appointmentId, expectedStatus: 'PAYMENT_PENDING' as const, action: 'CONFIRM' as const, actorAccountId: fixture.doctorAccountId };

    const outcomes = await Promise.allSettled([serviceA.lifecycle.transition(request), serviceB.lifecycle.transition(request)]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === 'rejected')).toMatchObject({ reason: { code: 'STALE_TRANSITION' } });

    const state = await fixturePool!.query<{ status: string }>('SELECT status FROM appointments WHERE id=$1', [fixture.appointmentId]);
    const event = await fixturePool!.query<{ id: string; reason: string | null }>("SELECT id,reason FROM appointment_events WHERE appointment_id=$1 AND event_type='CONFIRMED'", [fixture.appointmentId]);
    expect(state.rows[0]?.status).toBe('CONFIRMED');
    expect(event.rows).toHaveLength(1);
    await expect(fixturePool!.query("UPDATE appointment_events SET reason='rewrite' WHERE id=$1", [event.rows[0]!.id])).rejects.toMatchObject({ code: 'P0001' });
    const unchanged = await fixturePool!.query<{ reason: string | null }>('SELECT reason FROM appointment_events WHERE id=$1', [event.rows[0]!.id]);
    expect(unchanged.rows[0]?.reason).toBe(event.rows[0]?.reason);
  });

  it('serializes concurrent Start and preserves the committed capacity', async () => {
    const fixture = await seedOperationalAppointment(fixturePool!, 'CONFIRMED'); const serviceA = operationalService(databaseA!); const serviceB = operationalService(databaseB!);
    await serviceA.authorization.authorize(fixture.doctorAccountId, fixture.appointmentId, 'appointment.start'); await serviceB.authorization.authorize(fixture.doctorAccountId, fixture.appointmentId, 'appointment.start');
    const outcomes = await Promise.allSettled([start(serviceA, fixture), start(serviceB, fixture)]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1); expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1); expect(outcomes.find((outcome) => outcome.status === 'rejected')).toMatchObject({ reason: { code: 'STALE_TRANSITION' } });
    await expectState(fixture, 'IN_PROGRESS', 'STARTED', 2);
  });

  it('serializes concurrent Complete and makes exactly one completion event', async () => {
    const fixture = await seedOperationalAppointment(fixturePool!, 'IN_PROGRESS'); const serviceA = operationalService(databaseA!); const serviceB = operationalService(databaseB!);
    await serviceA.authorization.authorize(fixture.doctorAccountId, fixture.appointmentId, 'appointment.complete'); await serviceB.authorization.authorize(fixture.doctorAccountId, fixture.appointmentId, 'appointment.complete');
    const outcomes = await Promise.allSettled([complete(serviceA, fixture), complete(serviceB, fixture)]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1); expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1); expect(outcomes.find((outcome) => outcome.status === 'rejected')).toMatchObject({ reason: { code: 'TERMINAL_APPOINTMENT' } });
    await expectState(fixture, 'COMPLETED', 'COMPLETED', 3);
  });

  it('rejects Start and Complete after Completed without new evidence', async () => {
    const fixture = await seedOperationalAppointment(fixturePool!, 'IN_PROGRESS'); const service = operationalService(databaseA!);
    await complete(service, fixture);
    await expect(start(service, fixture)).rejects.toMatchObject({ code: 'TERMINAL_APPOINTMENT' } satisfies Partial<AppointmentLifecycleError>);
    await expect(complete(service, fixture)).rejects.toMatchObject({ code: 'TERMINAL_APPOINTMENT' } satisfies Partial<AppointmentLifecycleError>);
    const events = await fixturePool!.query<{ count: string }>('SELECT count(*)::text AS count FROM appointment_events WHERE appointment_id=$1', [fixture.appointmentId]); expect(events.rows[0]?.count).toBe('3');
  });

  it('rolls back a Start transition and its audit when immutable event insertion fails', async () => {
    const fixture = await seedOperationalAppointment(fixturePool!, 'CONFIRMED');
    const database = databaseA!;
    const authorization = operationalService(database).authorization;
    const lifecycle = new AppointmentLifecycleService(new EventInsertFailureRepository(new PostgresAppointmentLifecycleRepository(database)));
    await authorization.authorize(fixture.doctorAccountId, fixture.appointmentId, 'appointment.start');
    await expect(lifecycle.transition({
      appointmentId: fixture.appointmentId,
      expectedStatus: 'CONFIRMED',
      action: 'START',
      actorAccountId: fixture.doctorAccountId,
      authorizeInTransaction: (transaction) => authorization.authorizeInTransaction(transaction, fixture.doctorAccountId, fixture.appointmentId, 'appointment.start').then(() => undefined),
    })).rejects.toMatchObject({ code: 'EVENT_CONFLICT' });

    const state = await fixturePool!.query<{ status: string }>('SELECT status FROM appointments WHERE id=$1', [fixture.appointmentId]);
    const startedEvents = await fixturePool!.query<{ count: string }>("SELECT count(*)::text AS count FROM appointment_events WHERE appointment_id=$1 AND event_type='STARTED'", [fixture.appointmentId]);
    const startedAudits = await fixturePool!.query<{ count: string }>("SELECT count(*)::text AS count FROM audit_events WHERE target_type='APPOINTMENT' AND target_id=$1 AND event_type='APPOINTMENT_STARTED'", [fixture.appointmentId]);
    expect(state.rows[0]?.status).toBe('CONFIRMED');
    expect(startedEvents.rows[0]?.count).toBe('0');
    expect(startedAudits.rows[0]?.count).toBe('0');
  });
});

class EventInsertFailureRepository implements AppointmentLifecycleRepository {
  public constructor(private readonly delegate: PostgresAppointmentLifecycleRepository) {}
  public transaction<T>(operation: (database: PostgresExecutor) => Promise<T>): Promise<T> { return this.delegate.transaction(operation); }
  public lockAppointment(database: PostgresExecutor, appointmentId: string): Promise<LifecycleAppointment | null> { return this.delegate.lockAppointment(database, appointmentId); }
  public transitionAppointment(database: PostgresExecutor, appointmentId: string, from: AppointmentStatus, to: AppointmentStatus): Promise<boolean> { return this.delegate.transitionAppointment(database, appointmentId, from, to); }
  public appendAudit(database: PostgresExecutor, event: AuditEventInput): Promise<string> { return this.delegate.appendAudit(database, event); }
  public appendEvent(database: PostgresExecutor, event: AppointmentEventWrite): Promise<void> { return this.delegate.appendEvent(database, { ...event, actorAccountId: randomUUID() }); }
}

function operationalService(database: DatabaseHealth) {
  const audit = new PostgresAuditRepository(database);
  const authorization = new AppointmentAuthorizationService(new PostgresAppointmentAuthorizationRepository(database), { require: async () => { throw new Error('Tenant authorization is not used for this independent-doctor fixture.'); }, requireInTransaction: async () => { throw new Error('Tenant authorization is not used for this independent-doctor fixture.'); } }, audit);
  return { authorization, lifecycle: new AppointmentLifecycleService(new PostgresAppointmentLifecycleRepository(database)) };
}
type OperationalService = ReturnType<typeof operationalService>;
type Fixture = { appointmentId: string; doctorAccountId: string; capacityId: string };
function start(service: OperationalService, fixture: Fixture) { return service.lifecycle.transition({ appointmentId: fixture.appointmentId, expectedStatus: 'CONFIRMED', action: 'START', actorAccountId: fixture.doctorAccountId, authorizeInTransaction: (database) => service.authorization.authorizeInTransaction(database, fixture.doctorAccountId, fixture.appointmentId, 'appointment.start').then(() => undefined) }); }
function complete(service: OperationalService, fixture: Fixture) { return service.lifecycle.transition({ appointmentId: fixture.appointmentId, expectedStatus: 'IN_PROGRESS', action: 'COMPLETE', actorAccountId: fixture.doctorAccountId, authorizeInTransaction: (database) => service.authorization.authorizeInTransaction(database, fixture.doctorAccountId, fixture.appointmentId, 'appointment.complete').then(() => undefined) }); }

async function expectState(fixture: Fixture, status: string, eventType: string, totalEvents: number): Promise<void> {
  const state = await fixturePool!.query<{ status: string }>('SELECT status FROM appointments WHERE id=$1', [fixture.appointmentId]); const events = await fixturePool!.query<{ count: string }>('SELECT count(*)::text AS count FROM appointment_events WHERE appointment_id=$1', [fixture.appointmentId]); const targetEvents = await fixturePool!.query<{ count: string }>('SELECT count(*)::text AS count FROM appointment_events WHERE appointment_id=$1 AND event_type=$2', [fixture.appointmentId, eventType]); const capacity = await fixturePool!.query<{ status: string }>('SELECT status FROM appointment_committed_capacities WHERE id=$1', [fixture.capacityId]);
  expect(state.rows[0]?.status).toBe(status); expect(events.rows[0]?.count).toBe(String(totalEvents)); expect(targetEvents.rows[0]?.count).toBe('1'); expect(capacity.rows[0]?.status).toBe('ACTIVE');
}

async function seedOperationalAppointment(pool: Pool, status: 'PAYMENT_PENDING' | 'CONFIRMED' | 'IN_PROGRESS'): Promise<Fixture> {
  const ids = { patient: randomUUID(), doctorAccountId: randomUUID(), doctor: randomUUID(), offering: randomUUID(), exposure: randomUUID(), version: randomUUID(), price: randomUUID(), policy: randomUUID(), intent: randomUUID(), reservation: randomUUID(), allocation: randomUUID(), payment: randomUUID(), handoff: randomUUID(), appointmentId: randomUUID(), capacityId: randomUUID() };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("INSERT INTO accounts (id,status) VALUES ($1,'ACTIVE'),($2,'ACTIVE')", [ids.patient, ids.doctorAccountId]); await client.query("INSERT INTO patient_profiles (id,account_id,status) VALUES ($1,$1,'ACTIVE')", [ids.patient]); await client.query("INSERT INTO doctor_profiles (id,account_id,status,professional_verification_status) VALUES ($1,$2,'ACTIVE','VERIFIED')", [ids.doctor, ids.doctorAccountId]);
    await client.query("INSERT INTO service_offerings (id,owner_doctor_profile_id,name,status,created_by_account_id,updated_by_account_id) VALUES ($1,$2,'Start Completion fixture','ACTIVE',$3,$3)", [ids.offering, ids.doctor, ids.doctorAccountId]); await client.query("INSERT INTO service_exposures (id,service_offering_id,provider_doctor_profile_id,status,created_by_account_id,updated_by_account_id) VALUES ($1,$2,$3,'DRAFT',$4,$4)", [ids.exposure, ids.offering, ids.doctor, ids.doctorAccountId]); await client.query("UPDATE service_exposures SET status='PUBLISHED',updated_by_account_id=$2 WHERE id=$1", [ids.exposure, ids.doctorAccountId]);
    await client.query("INSERT INTO service_offering_versions (id,service_offering_id,version_number,status,effective_from,created_by_account_id) VALUES ($1,$2,1,'ACTIVE',clock_timestamp()-interval '1 day',$3)", [ids.version, ids.offering, ids.doctorAccountId]); await client.query("INSERT INTO service_offering_prices (id,service_offering_version_id,currency,amount_minor,created_by_account_id) VALUES ($1,$2,'INR',10000,$3)", [ids.price, ids.version, ids.doctorAccountId]); await client.query('INSERT INTO service_offering_version_reservation_policies (id,service_offering_version_id,hold_seconds,created_by_account_id) VALUES ($1,$2,600,$3)', [ids.policy, ids.version, ids.doctorAccountId]);
    await insertPaymentPendingContext(client, ids);
    await client.query("INSERT INTO appointment_participants (id,appointment_id,participant_type,patient_profile_id) VALUES ($1,$2,'PATIENT',$3)", [randomUUID(), ids.appointmentId, ids.patient]); await client.query("INSERT INTO appointment_participants (id,appointment_id,participant_type,doctor_profile_id) VALUES ($1,$2,'DOCTOR',$3)", [randomUUID(), ids.appointmentId, ids.doctor]); await client.query('INSERT INTO appointment_committed_capacities (id,appointment_id,slot_reservation_id,service_offering_version_id,starts_at,ends_at,capacity_units) SELECT $1,$2,id,service_offering_version_id,starts_at,ends_at,capacity_units FROM slot_reservations WHERE id=$3', [ids.capacityId, ids.appointmentId, ids.reservation]);
    if (status !== 'PAYMENT_PENDING') await transitionFixture(client, ids.appointmentId, 'PAYMENT_PENDING', 'CONFIRMED', 'CONFIRMED');
    if (status === 'IN_PROGRESS') await transitionFixture(client, ids.appointmentId, 'CONFIRMED', 'IN_PROGRESS', 'STARTED');
    await client.query('COMMIT'); return { appointmentId: ids.appointmentId, doctorAccountId: ids.doctorAccountId, capacityId: ids.capacityId };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function insertPaymentPendingContext(client: PoolClient, ids: Record<string, string>): Promise<void> {
  await client.query("INSERT INTO appointment_intents (id,patient_account_id,booking_actor_account_id,service_exposure_id,provider_doctor_profile_id,service_offering_id,service_offering_version_id,service_offering_price_id,currency,price_amount_minor,provider_timezone,requested_local_at,starts_at,ends_at,service_duration_seconds,buffer_before_seconds,buffer_after_seconds,hold_seconds,booking_relationship,state,idempotency_key,request_fingerprint,expires_at) VALUES ($1,$2,$2,$3,$4,$5,$6,$7,'INR',10000,'UTC',clock_timestamp()::timestamp,clock_timestamp(),clock_timestamp()+interval '30 minutes',1800,0,0,600,'PATIENT_PROVIDER','SLOT_RESERVED',$8,'start-completion-fixture',clock_timestamp()+interval '10 minutes')", [ids.intent, ids.patient, ids.exposure, ids.doctor, ids.offering, ids.version, ids.price, `intent-${ids.intent}`]);
  await client.query("INSERT INTO slot_reservations (id,appointment_intent_id,service_offering_version_id,provider_doctor_profile_id,starts_at,ends_at,capacity_units,status,expires_at) VALUES ($1,$2,$3,$4,clock_timestamp(),clock_timestamp()+interval '30 minutes',1,'HELD',clock_timestamp()+interval '10 minutes')", [ids.reservation, ids.intent, ids.version, ids.doctor]);
  const input = { appointmentIntentId: ids.intent, slotReservationId: ids.reservation, serviceExposureId: ids.exposure, serviceOfferingId: ids.offering, serviceOfferingVersionId: ids.version, serviceOfferingPriceId: ids.price, patientAccountId: ids.patient, bookingActorAccountId: ids.patient, currency: 'INR', grossAmountMinor: '10000' };
  await client.query("INSERT INTO financial_allocation_snapshots (id,status,currency,gross_amount_minor,calculation_basis,input_data,selected_rule_versions,created_by_account_id) VALUES ($1,'FINAL','INR',10000,'FIXED',$2::jsonb,'[]'::jsonb,$3)", [ids.allocation, JSON.stringify(input), ids.doctorAccountId]); await client.query("INSERT INTO payment_intents (id,provider_key,status,currency,amount_minor,allocation_snapshot_id,idempotency_key,created_by_account_id) VALUES ($1,'RAZORPAY','CREATED','INR',10000,$2,$3,$4)", [ids.payment, ids.allocation, `payment-${ids.intent}`, ids.patient]); await client.query('INSERT INTO appointment_financial_handoffs (id,appointment_intent_id,slot_reservation_id,financial_allocation_snapshot_id,payment_intent_id,booking_actor_account_id,idempotency_key,request_fingerprint) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [ids.handoff, ids.intent, ids.reservation, ids.allocation, ids.payment, ids.patient, `handoff-${ids.intent}`, 'start-completion-fixture']);
  await client.query("UPDATE appointment_intents SET state='PAYMENT_PENDING' WHERE id=$1", [ids.intent]); await client.query('SET CONSTRAINTS appointment_intent_payment_pending_integrity IMMEDIATE'); await client.query("UPDATE payment_intents SET status='SUCCEEDED' WHERE id=$1", [ids.payment]);
  await client.query(`INSERT INTO appointments (id,appointment_intent_id,slot_reservation_id,appointment_financial_handoff_id,financial_allocation_snapshot_id,payment_intent_id,patient_account_id,booking_actor_account_id,provider_doctor_profile_id,service_exposure_id,service_offering_id,service_offering_version_id,service_offering_price_id,currency,price_amount_minor,provider_timezone,requested_local_at,starts_at,ends_at,service_duration_seconds,buffer_before_seconds,buffer_after_seconds,hold_seconds,status) SELECT $1,intent.id,reservation.id,handoff.id,handoff.financial_allocation_snapshot_id,handoff.payment_intent_id,intent.patient_account_id,intent.booking_actor_account_id,intent.provider_doctor_profile_id,intent.service_exposure_id,intent.service_offering_id,intent.service_offering_version_id,intent.service_offering_price_id,intent.currency,intent.price_amount_minor,intent.provider_timezone,intent.requested_local_at,intent.starts_at,intent.ends_at,intent.service_duration_seconds,intent.buffer_before_seconds,intent.buffer_after_seconds,intent.hold_seconds,'PAYMENT_PENDING' FROM appointment_intents intent JOIN slot_reservations reservation ON reservation.id=$3 AND reservation.appointment_intent_id=intent.id JOIN appointment_financial_handoffs handoff ON handoff.id=$4 AND handoff.appointment_intent_id=intent.id WHERE intent.id=$2`, [ids.appointmentId, ids.intent, ids.reservation, ids.handoff]);
}

async function transitionFixture(client: PoolClient, appointmentId: string, from: string, to: string, eventType: string): Promise<void> {
  const auditId = randomUUID(); await client.query('UPDATE appointments SET status=$3 WHERE id=$1 AND status=$2', [appointmentId, from, to]); await client.query("INSERT INTO audit_events (id,category,event_type,target_type,target_id,outcome,metadata) VALUES ($1,'BUSINESS','FIXTURE_APPOINTMENT_TRANSITION','APPOINTMENT',$2,'SUCCESS','{}'::jsonb)", [auditId, appointmentId]); await client.query("INSERT INTO appointment_events (id,appointment_id,event_type,previous_status,resulting_status,context,audit_event_id) VALUES ($1,$2,$3,$4,$5,'{}'::jsonb,$6)", [randomUUID(), appointmentId, eventType, from, to, auditId]);
}
