import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createDatabase, type DatabaseHealth } from '../src/infrastructure/database.js';
import { PaymentHandoffService } from '../src/modules/appointments/payment-handoffs.js';
import { AppointmentService } from '../src/modules/appointments/appointments.js';
import { PostgresAppointmentRepository } from '../src/modules/appointments/postgres-appointment-repository.js';
import { PostgresAuditRepository } from '../src/modules/audit/postgres-audit-repository.js';
import { PostgresPaymentHandoffRepository } from '../src/modules/appointments/postgres-payment-handoff-repository.js';
import { resolvePaymentProviderKey } from '../src/modules/financial/provider-registry.js';

const databaseUrl = process.env.DATABASE_URL;
const enabled = Boolean(databaseUrl);
let pool: Pool | undefined;
let databaseA: DatabaseHealth | undefined;
let databaseB: DatabaseHealth | undefined;

describe.skipIf(!enabled)('Phase 5 Step 4 real PostgreSQL payment-handoff concurrency', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    const current = await pool.query<{ name: string }>('SELECT current_database() AS name');
    if (current.rows[0]?.name !== 'cliniq_phase5_payment_handoff_verify') throw new Error('Refusing payment-handoff integration tests outside cliniq_phase5_payment_handoff_verify.');
    const schema = await pool.query("SELECT to_regclass('appointment_financial_handoffs') AS handoffs");
    if (!schema.rows[0]?.handoffs) throw new Error('Phase 5 Step 4 migration is not applied.');
    databaseA = createDatabase({ DATABASE_URL: databaseUrl! }); databaseB = createDatabase({ DATABASE_URL: databaseUrl! });
  });

  afterAll(async () => { await databaseA?.close(); await databaseB?.close(); await pool?.end(); });

  it('persists one real financial handoff with its selected commercial rule version', async () => {
    const fixture = await seed(pool!);
    await expect(service(databaseA!).create(fixture.patient, fixture.intent, { idempotencyKey: 'single-handoff-key' })).resolves.toMatchObject({ replayed: false, handoff: { appointmentIntentId: fixture.intent, state: 'PAYMENT_PENDING' } });
    await expectCounts(pool!, fixture.intent, 1);
    const snapshot = await pool!.query<{ selected: unknown; components: string }>(`
      SELECT allocation.selected_rule_versions AS selected,count(component.id)::text AS components
      FROM appointment_financial_handoffs handoff
      JOIN financial_allocation_snapshots allocation ON allocation.id=handoff.financial_allocation_snapshot_id
      JOIN financial_allocation_components component ON component.allocation_snapshot_id=allocation.id
      WHERE handoff.appointment_intent_id=$1
      GROUP BY allocation.selected_rule_versions`, [fixture.intent]);
    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0]).toMatchObject({ selected: [fixture.commercialVersion], components: '3' });
  });

  it('serializes equal-key and different-key concurrent requests without duplicate financial records', async () => {
    const same = await seed(pool!); const serviceA = service(databaseA!); const serviceB = service(databaseB!);
    const equal = await Promise.allSettled([serviceA.create(same.patient, same.intent, { idempotencyKey: 'same-key' }), serviceB.create(same.patient, same.intent, { idempotencyKey: 'same-key' })]);
    expect(equal.filter((item) => item.status === 'fulfilled')).toHaveLength(2);
    expect(equal.filter((item) => item.status === 'fulfilled').map((item) => (item as PromiseFulfilledResult<{ replayed: boolean }>).value.replayed).sort()).toEqual([false, true]);
    await expectCounts(pool!, same.intent, 1);

    const different = await seed(pool!);
    const unequal = await Promise.allSettled([serviceA.create(different.patient, different.intent, { idempotencyKey: 'first-key' }), serviceB.create(different.patient, different.intent, { idempotencyKey: 'second-key' })]);
    expect(unequal.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(unequal.filter((item) => item.status === 'rejected')).toHaveLength(1);
    expect((unequal.find((item) => item.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'CONFLICT' });
    await expectCounts(pool!, different.intent, 1);
  });

  it('serializes handoff against release and expiry without financial residue', async () => {
    const releaseFixture = await seed(pool!);
    const release = appointmentService(databaseB!, new Date());
    const releaseRace = await Promise.allSettled([service(databaseA!).create(releaseFixture.patient, releaseFixture.intent, { idempotencyKey: 'release-race' }), release.release(releaseFixture.patient, releaseFixture.reservation)]);
    expect(releaseRace.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const releaseHandoffWon = releaseRace[0]?.status === 'fulfilled';
    await expectCounts(pool!, releaseFixture.intent, releaseHandoffWon ? 1 : 0, releaseHandoffWon ? 'PAYMENT_PENDING' : 'SLOT_RESERVED');
    const released = await pool!.query<{ status: string; state: string }>('SELECT reservation.status,intent.state FROM slot_reservations reservation JOIN appointment_intents intent ON intent.id=reservation.appointment_intent_id WHERE reservation.id=$1', [releaseFixture.reservation]);
    expect(released.rows[0]).toMatchObject(releaseHandoffWon ? { status: 'HELD', state: 'PAYMENT_PENDING' } : { status: 'RELEASED', state: 'SLOT_RESERVED' });

    const expiryFixture = await seed(pool!, { expired: true });
    const expiryRace = await Promise.allSettled([service(databaseA!).create(expiryFixture.patient, expiryFixture.intent, { idempotencyKey: 'expiry-race' }), appointmentService(databaseB!, new Date()).expire(expiryFixture.reservation)]);
    expect(expiryRace[0]?.status).toBe('rejected');
    await expectCounts(pool!, expiryFixture.intent, 0, 'EXPIRED');
    const expired = await pool!.query<{ status: string; state: string }>('SELECT reservation.status,intent.state FROM slot_reservations reservation JOIN appointment_intents intent ON intent.id=reservation.appointment_intent_id WHERE reservation.id=$1', [expiryFixture.reservation]);
    expect(expired.rows[0]).toMatchObject({ status: 'EXPIRED', state: 'EXPIRED' });
    const locks = await pool!.query<{ count: string }>("SELECT count(*)::text AS count FROM pg_locks WHERE pid = pg_backend_pid() AND granted AND locktype='advisory'");
    expect(locks.rows[0]?.count).toBe('0');
  });
});

function service(database: DatabaseHealth) { return new PaymentHandoffService(new PostgresPaymentHandoffRepository(database), resolvePaymentProviderKey('RAZORPAY')); }
function appointmentService(database: DatabaseHealth, now: Date) { return new AppointmentService(new PostgresAppointmentRepository(database), new PostgresAuditRepository(database), () => now); }
async function expectCounts(target: Pool, intent: string, expected: number, state = 'PAYMENT_PENDING') {
  const rows = await target.query<{ handoffs: string; allocations: string; payments: string; components: string; state: string }>(`
    SELECT count(DISTINCT h.id)::text AS handoffs,count(DISTINCT h.financial_allocation_snapshot_id)::text AS allocations,
      count(DISTINCT h.payment_intent_id)::text AS payments,count(component.id)::text AS components,max(intent.state) AS state
    FROM appointment_intents intent LEFT JOIN appointment_financial_handoffs h ON h.appointment_intent_id=intent.id
    LEFT JOIN financial_allocation_components component ON component.allocation_snapshot_id=h.financial_allocation_snapshot_id
    WHERE intent.id=$1 GROUP BY intent.id`, [intent]);
  expect(rows.rows[0]).toMatchObject({ handoffs: String(expected), allocations: String(expected), payments: String(expected), components: String(expected * 3), state });
}
async function seed(target: Pool, options: { expired?: boolean } = {}) {
  const patient = randomUUID(), doctorAccount = randomUUID(), doctor = randomUUID(), offering = randomUUID(), exposure = randomUUID(), version = randomUUID(), price = randomUUID(), policy = randomUUID(), intent = randomUUID(), reservation = randomUUID(), commercialRule = randomUUID(), commercialVersion = randomUUID(), scope = randomUUID();
  await target.query("INSERT INTO accounts (id,status) VALUES ($1,'ACTIVE'),($2,'ACTIVE')", [patient, doctorAccount]);
  await target.query("INSERT INTO patient_profiles (id,account_id,status) VALUES ($1,$1,'ACTIVE')", [patient]);
  await target.query("INSERT INTO doctor_profiles (id,account_id,status,professional_verification_status) VALUES ($1,$2,'ACTIVE','VERIFIED')", [doctor, doctorAccount]);
  await target.query("INSERT INTO service_offerings (id,owner_doctor_profile_id,name,status,created_by_account_id,updated_by_account_id) VALUES ($1,$2,'Handoff test','ACTIVE',$3,$3)", [offering, doctor, doctorAccount]);
  await target.query("INSERT INTO service_exposures (id,service_offering_id,provider_doctor_profile_id,status,created_by_account_id,updated_by_account_id) VALUES ($1,$2,$3,'DRAFT',$4,$4)", [exposure, offering, doctor, doctorAccount]);
  await target.query("UPDATE service_exposures SET status='PUBLISHED',updated_by_account_id=$2 WHERE id=$1", [exposure, doctorAccount]);
  await target.query("INSERT INTO service_offering_versions (id,service_offering_id,version_number,status,effective_from,created_by_account_id) VALUES ($1,$2,1,'ACTIVE',clock_timestamp()-interval '1 day',$3)", [version, offering, doctorAccount]);
  await target.query("INSERT INTO service_offering_prices (id,service_offering_version_id,currency,amount_minor,created_by_account_id) VALUES ($1,$2,'INR',10000,$3)", [price, version, doctorAccount]);
  await target.query('INSERT INTO service_offering_version_reservation_policies (id,service_offering_version_id,hold_seconds,created_by_account_id) VALUES ($1,$2,600,$3)', [policy, version, doctorAccount]);
  await target.query("INSERT INTO appointment_intents (id,patient_account_id,booking_actor_account_id,service_exposure_id,provider_doctor_profile_id,service_offering_id,service_offering_version_id,service_offering_price_id,currency,price_amount_minor,provider_timezone,requested_local_at,starts_at,ends_at,service_duration_seconds,buffer_before_seconds,buffer_after_seconds,hold_seconds,booking_relationship,state,idempotency_key,request_fingerprint,expires_at) VALUES ($1,$2,$2,$3,$4,$5,$6,$7,'INR',10000,'UTC',clock_timestamp()::timestamp,clock_timestamp(),clock_timestamp()+interval '30 minutes',1800,0,0,600,'PATIENT_PROVIDER','SLOT_RESERVED',$8,'seed',clock_timestamp()+interval '10 minutes')", [intent, patient, exposure, doctor, offering, version, price, `seed-${intent}`]);
  await target.query("INSERT INTO slot_reservations (id,appointment_intent_id,service_offering_version_id,provider_doctor_profile_id,starts_at,ends_at,capacity_units,status,created_at,expires_at) VALUES ($1,$2,$3,$4,clock_timestamp(),clock_timestamp()+interval '30 minutes',1,'HELD',CASE WHEN $5::boolean THEN clock_timestamp()-interval '601 seconds' ELSE clock_timestamp() END,CASE WHEN $5::boolean THEN clock_timestamp()-interval '1 second' ELSE clock_timestamp()+interval '10 minutes' END)", [reservation, intent, version, doctor, options.expired ?? false]);
  await target.query("INSERT INTO commercial_rules (id,status,rule_type,created_by_account_id) VALUES ($1,'ACTIVE','FIXED',$2)", [commercialRule, doctorAccount]);
  await target.query("INSERT INTO commercial_rule_versions (id,commercial_rule_id,version_number,status,priority,effective_from,calculation_basis,processing_fee_bearer,policy_data,approved_by_account_id,approved_at) VALUES ($1,$2,1,'APPROVED',1,clock_timestamp()-interval '1 day','FIXED','THECLINIQ','{\"fixedAmountMinor\":500}'::jsonb,$3,clock_timestamp())", [commercialVersion, commercialRule, doctorAccount]);
  await target.query("INSERT INTO commercial_rule_scopes (id,commercial_rule_version_id,scope_kind,scope_reference_id) VALUES ($1,$2,'SERVICE',$3)", [scope, commercialVersion, offering]);
  return { patient, intent, reservation, commercialVersion };
}
