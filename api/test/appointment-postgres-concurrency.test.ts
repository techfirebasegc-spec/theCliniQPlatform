import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createDatabase, type DatabaseHealth } from '../src/infrastructure/database.js';
import { PostgresAuditRepository } from '../src/modules/audit/postgres-audit-repository.js';
import { AppointmentError, AppointmentService } from '../src/modules/appointments/appointments.js';
import { PostgresAppointmentRepository } from '../src/modules/appointments/postgres-appointment-repository.js';

const databaseUrl = process.env.DATABASE_URL;
const enabled = Boolean(databaseUrl);
const ids = Array.from({ length: 13 }, () => randomUUID());
const [patientA, patientB, doctorAccount, doctorProfile, offering, exposure, version, price, policy, configuration, rule, window, unused] = ids;
void unused;
let pool: Pool | undefined;
let databaseA: DatabaseHealth | undefined;
let databaseB: DatabaseHealth | undefined;

describe.skipIf(!enabled)('Phase 5 Step 3.2 real PostgreSQL reservation concurrency', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    const current = await pool.query<{ name: string }>('SELECT current_database() AS name');
    if (current.rows[0]?.name !== 'cliniq_phase5_service_exposure_verify') throw new Error('Refusing PostgreSQL integration tests outside cliniq_phase5_service_exposure_verify.');
    const schema = await pool.query("SELECT to_regclass('appointment_intents') AS intents, to_regclass('slot_reservations') AS reservations, to_regclass('service_exposures') AS exposures");
    if (!schema.rows[0]?.intents || !schema.rows[0]?.reservations || !schema.rows[0]?.exposures) throw new Error('Required Step 3.1 and Service Exposure schemas are not migrated.');
    await seed(pool);
    databaseA = createDatabase({ DATABASE_URL: databaseUrl! }); databaseB = createDatabase({ DATABASE_URL: databaseUrl! });
  });

  afterAll(async () => { if (pool) await cleanup(pool); await databaseA?.close(); await databaseB?.close(); await pool?.end(); });

  it('serializes two genuine concurrent capacity=1 reservations and releases capacity safely', async () => {
    const now = new Date(); const requestedLocalAt = nextMondayLocal(now);
    const serviceA = service(databaseA!, now); const serviceB = service(databaseB!, now);
    const first = await serviceA.create(patientA, { serviceExposureId: exposure, requestedLocalAt, idempotencyKey: 'concurrent-a' });
    const second = await serviceB.create(patientB, { serviceExposureId: exposure, requestedLocalAt, idempotencyKey: 'concurrent-b' });
    const results = await Promise.allSettled([serviceA.reserve(patientA, first.id), serviceB.reserve(patientB, second.id)]);
    const successes = results.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof serviceA.reserve>>> => item.status === 'fulfilled');
    const failures = results.filter((item): item is PromiseRejectedResult => item.status === 'rejected');
    expect(successes).toHaveLength(1); expect(failures).toHaveLength(1); expect(failures[0].reason).toMatchObject({ code: 'CONFLICT' } satisfies Partial<AppointmentError>);
    const held = await pool!.query<{ count: string }>("SELECT count(*)::text AS count FROM slot_reservations WHERE service_offering_version_id=$1 AND status='HELD' AND expires_at > current_timestamp", [version]);
    expect(held.rows[0]?.count).toBe('1');
    const winner = successes[0].value; const winnerAccount = winner.appointmentIntentId === first.id ? patientA : patientB; const loserIntent = winner.appointmentIntentId === first.id ? second : first; const loserService = winner.appointmentIntentId === first.id ? serviceB : serviceA;
    const persisted = await pool!.query<{ requested_local_at: string; starts_at: Date }>('SELECT requested_local_at::text,starts_at FROM appointment_intents WHERE id=$1', [winner.appointmentIntentId]);
    expect(persisted.rows[0]?.requested_local_at.replace(' ', 'T')).toBe(requestedLocalAt);
    expect(persisted.rows[0]!.starts_at.toISOString()).toBe(`${requestedLocalAt.slice(0, 10)}T04:30:00.000Z`);
    const winnerReservationCount = await pool!.query<{ count: string }>('SELECT count(*)::text AS count FROM slot_reservations WHERE appointment_intent_id=$1', [winner.appointmentIntentId]);
    const loserState = await pool!.query<{ state: string; reservation_count: string }>('SELECT intent.state, count(reservation.id)::text AS reservation_count FROM appointment_intents intent LEFT JOIN slot_reservations reservation ON reservation.appointment_intent_id=intent.id WHERE intent.id=$1 GROUP BY intent.state', [loserIntent.id]);
    expect(winnerReservationCount.rows[0]?.count).toBe('1');
    expect(loserState.rows[0]).toMatchObject({ state: 'APPOINTMENT_INTENT', reservation_count: '0' });
    await (winnerAccount === patientA ? serviceA : serviceB).release(winnerAccount, winner.id);
    const afterRelease = await pool!.query<{ count: string }>("SELECT count(*)::text AS count FROM slot_reservations WHERE service_offering_version_id=$1 AND status='HELD'", [version]);
    expect(afterRelease.rows[0]?.count).toBe('0');
    const replacement = await loserService.reserve(loserIntent.patientAccountId, loserIntent.id);
    expect(replacement).toMatchObject({ status: 'HELD', appointmentIntentId: loserIntent.id });
    await expect((winnerAccount === patientA ? serviceA : serviceB).release(winnerAccount, winner.id)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

function service(database: DatabaseHealth, now: Date) { const audit = new PostgresAuditRepository(database); return new AppointmentService(new PostgresAppointmentRepository(database), audit, () => now); }
function nextMondayLocal(now: Date) { const value = new Date(now); const days = (8 - value.getUTCDay()) % 7 || 7; value.setUTCDate(value.getUTCDate() + days); return `${value.toISOString().slice(0, 10)}T10:00:00`; }
async function seed(target: Pool) {
  await target.query('INSERT INTO accounts (id,status) VALUES ($1,\'ACTIVE\'),($2,\'ACTIVE\'),($3,\'ACTIVE\')', [patientA, patientB, doctorAccount]);
  await target.query('INSERT INTO patient_profiles (id,account_id,status) VALUES ($1,$1,\'ACTIVE\'),($2,$2,\'ACTIVE\')', [patientA, patientB]);
  await target.query('INSERT INTO doctor_profiles (id,account_id,status,professional_verification_status) VALUES ($1,$2,\'ACTIVE\',\'VERIFIED\')', [doctorProfile, doctorAccount]);
  await target.query('INSERT INTO service_offerings (id,owner_doctor_profile_id,name,status,created_by_account_id,updated_by_account_id) VALUES ($1,$2,\'Concurrency Verification\',\'ACTIVE\',$3,$3)', [offering, doctorProfile, doctorAccount]);
  await target.query('INSERT INTO service_exposures (id,service_offering_id,provider_doctor_profile_id,status,created_by_account_id,updated_by_account_id) VALUES ($1,$2,$3,\'DRAFT\',$4,$4)', [exposure, offering, doctorProfile, doctorAccount]);
  await target.query("UPDATE service_exposures SET status='PUBLISHED',updated_by_account_id=$2 WHERE id=$1", [exposure, doctorAccount]);
  await target.query('INSERT INTO service_offering_versions (id,service_offering_id,version_number,status,effective_from,created_by_account_id) VALUES ($1,$2,1,\'ACTIVE\',current_timestamp - interval \'1 day\',$3)', [version, offering, doctorAccount]);
  await target.query('INSERT INTO service_offering_prices (id,service_offering_version_id,currency,amount_minor,created_by_account_id) VALUES ($1,$2,\'INR\',10000,$3)', [price, version, doctorAccount]);
  await target.query('INSERT INTO service_offering_version_reservation_policies (id,service_offering_version_id,hold_seconds,created_by_account_id) VALUES ($1,$2,600,$3)', [policy, version, doctorAccount]);
  await target.query('INSERT INTO availability_configurations (id,service_offering_version_id,provider_timezone,slot_duration_seconds,buffer_before_seconds,buffer_after_seconds,capacity,booking_lead_time_seconds,booking_horizon_seconds,status,created_by_account_id) VALUES ($1,$2,\'Asia/Kolkata\',1800,0,0,1,0,1209600,\'ACTIVE\',$3)', [configuration, version, doctorAccount]);
  await target.query('INSERT INTO availability_rules (id,availability_configuration_id,canonical_recurrence,recurrence_identity,effective_from,status,created_by_account_id) VALUES ($1,$2,\'FREQ=WEEKLY;BYDAY=MO\',\'FREQ=WEEKLY;BYDAY=MO\',current_timestamp - interval \'1 day\',\'ACTIVE\',$3)', [rule, configuration, doctorAccount]);
  await target.query('INSERT INTO availability_windows (id,availability_rule_id,kind,weekday,start_seconds,end_seconds,created_by_account_id) VALUES ($1,$2,\'WORKING\',1,36000,37800,$3)', [window, rule, doctorAccount]);
}
async function cleanup(target: Pool) {
  await target.query('DELETE FROM audit_events WHERE actor_account_id = ANY($1::uuid[])', [[patientA, patientB, doctorAccount]]);
  await target.query('DELETE FROM slot_reservations WHERE appointment_intent_id IN (SELECT id FROM appointment_intents WHERE patient_account_id = ANY($1::uuid[]))', [[patientA, patientB]]);
  await target.query('DELETE FROM appointment_intents WHERE patient_account_id = ANY($1::uuid[])', [[patientA, patientB]]);
  await target.query('DELETE FROM availability_windows WHERE id=$1', [window]); await target.query('DELETE FROM availability_rules WHERE id=$1', [rule]); await target.query('DELETE FROM availability_configurations WHERE id=$1', [configuration]);
  await target.query('DELETE FROM service_offering_version_reservation_policies WHERE id=$1', [policy]); await target.query('DELETE FROM service_exposures WHERE id=$1', [exposure]);
  await target.query('DELETE FROM patient_profiles WHERE account_id = ANY($1::uuid[])', [[patientA, patientB]]); await target.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[patientA, patientB]]);
  // The offering/version/price fixture is immutable historical configuration.
  // Retain it in the disposable verification database; each run uses fresh UUIDs.
}
