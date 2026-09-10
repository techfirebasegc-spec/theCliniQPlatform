import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createDatabase, type DatabaseHealth } from '../src/infrastructure/database.js';
import { PaymentHandoffService } from '../src/modules/appointments/payment-handoffs.js';
import { PostgresPaymentHandoffRepository } from '../src/modules/appointments/postgres-payment-handoff-repository.js';
import { resolvePaymentProviderKey } from '../src/modules/financial/provider-registry.js';

const databaseUrl = process.env.DATABASE_URL;
let poolA: Pool | undefined;
let poolB: Pool | undefined;
let database: DatabaseHealth | undefined;

describe.skipIf(!databaseUrl)('theCliniQ Phase 5 Step 5.1 real PostgreSQL Appointment foundation', () => {
  beforeAll(async () => {
    poolA = new Pool({ connectionString: databaseUrl });
    poolB = new Pool({ connectionString: databaseUrl });
    const current = await poolA.query<{ name: string }>('SELECT current_database() AS name');
    if (current.rows[0]?.name !== 'cliniq_phase5_appointment_foundation_verify') throw new Error('Refusing Appointment foundation integration tests outside cliniq_phase5_appointment_foundation_verify.');
    const schema = await poolA.query("SELECT to_regclass('appointments') AS appointments, to_regclass('appointment_events') AS events");
    if (!schema.rows[0]?.appointments || !schema.rows[0]?.events) throw new Error('Phase 5 Step 5.1 migration is not applied.');
    database = createDatabase({ DATABASE_URL: databaseUrl! });
  });

  afterAll(async () => { await database?.close(); await poolA?.end(); await poolB?.end(); });

  it('rejects mismatched context, preserves immutable events, and serializes duplicate Appointment creation', async () => {
    const fixture = await seed(poolA!);
    await new PaymentHandoffService(new PostgresPaymentHandoffRepository(database!), resolvePaymentProviderKey('RAZORPAY')).create(fixture.patient, fixture.intent, { idempotencyKey: 'appointment-foundation-handoff' });
    const handoff = await poolA!.query<{ id: string }>('SELECT id FROM appointment_financial_handoffs WHERE appointment_intent_id=$1', [fixture.intent]);
    const handoffId = handoff.rows[0]?.id;
    if (!handoffId) throw new Error('Expected payment handoff.');
    await poolA!.query("UPDATE payment_intents SET status='SUCCEEDED' WHERE id=(SELECT payment_intent_id FROM appointment_financial_handoffs WHERE id=$1)", [handoffId]);

    await expect(poolA!.query(mismatchedAppointmentInsert(), [randomUUID(), fixture.intent, fixture.reservation, handoffId, fixture.doctorAccount])).rejects.toMatchObject({ code: 'P0001' });

    const appointmentId = randomUUID();
    const concurrent = await Promise.allSettled([
      poolA!.query(appointmentInsert(), [appointmentId, fixture.intent, fixture.reservation, handoffId]),
      poolB!.query(appointmentInsert(), [randomUUID(), fixture.intent, fixture.reservation, handoffId]),
    ]);
    expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const persisted = await poolA!.query<{ count: string; status: string }>("SELECT count(*)::text AS count,max(status) AS status FROM appointments WHERE appointment_intent_id=$1", [fixture.intent]);
    expect(persisted.rows[0]).toEqual({ count: '1', status: 'PAYMENT_PENDING' });

    const stored = await poolA!.query<{ id: string }>('SELECT id FROM appointments WHERE appointment_intent_id=$1', [fixture.intent]);
    const appointment = stored.rows[0]?.id;
    if (!appointment) throw new Error('Expected persisted Appointment.');
    const event = randomUUID();
    const transitionClient = await poolA!.connect();
    try {
      await transitionClient.query('BEGIN');
      await transitionClient.query("UPDATE appointments SET status='CONFIRMED' WHERE id=$1", [appointment]);
      await transitionClient.query("INSERT INTO appointment_events (id,appointment_id,event_type,previous_status,resulting_status) VALUES ($1,$2,'CONFIRMED','PAYMENT_PENDING','CONFIRMED')", [event, appointment]);
      await transitionClient.query('COMMIT');
    } catch (error) {
      await transitionClient.query('ROLLBACK');
      throw error;
    } finally {
      transitionClient.release();
    }
    await expect(poolA!.query("UPDATE appointment_events SET reason='rewrite' WHERE id=$1", [event])).rejects.toMatchObject({ code: 'P0001' });
    await expect(poolA!.query('DELETE FROM appointment_events WHERE id=$1', [event])).rejects.toMatchObject({ code: 'P0001' });
    await expect(poolA!.query("UPDATE appointments SET status='COMPLETED' WHERE id=$1", [appointment])).rejects.toMatchObject({ code: 'P0001' });
    await expect(poolA!.query("UPDATE appointments SET service_offering_id=$2 WHERE id=$1", [appointment, randomUUID()])).rejects.toMatchObject({ code: 'P0001' });
  });
});

function appointmentInsert() {
  return `INSERT INTO appointments
    (id,appointment_intent_id,slot_reservation_id,appointment_financial_handoff_id,financial_allocation_snapshot_id,payment_intent_id,patient_account_id,booking_actor_account_id,booking_tenant_id,provider_doctor_profile_id,provider_clinic_id,service_exposure_id,service_offering_id,service_offering_version_id,service_offering_price_id,currency,price_amount_minor,provider_timezone,requested_local_at,starts_at,ends_at,service_duration_seconds,buffer_before_seconds,buffer_after_seconds,hold_seconds,status)
    SELECT $1::uuid,intent.id,reservation.id,handoff.id,handoff.financial_allocation_snapshot_id,handoff.payment_intent_id,intent.patient_account_id,intent.booking_actor_account_id,intent.booking_tenant_id,intent.provider_doctor_profile_id,intent.provider_clinic_id,intent.service_exposure_id,intent.service_offering_id,intent.service_offering_version_id,intent.service_offering_price_id,intent.currency,intent.price_amount_minor,intent.provider_timezone,intent.requested_local_at,intent.starts_at,intent.ends_at,intent.service_duration_seconds,intent.buffer_before_seconds,intent.buffer_after_seconds,intent.hold_seconds,'PAYMENT_PENDING'
    FROM appointment_intents intent
    JOIN slot_reservations reservation ON reservation.id=$3::uuid AND reservation.appointment_intent_id=intent.id
    JOIN appointment_financial_handoffs handoff ON handoff.appointment_intent_id=intent.id
    WHERE intent.id=$2::uuid AND handoff.id=$4::uuid`;
}

function mismatchedAppointmentInsert() {
  return appointmentInsert().replace('intent.patient_account_id,intent.booking_actor_account_id', '$5::uuid,intent.booking_actor_account_id');
}

async function seed(target: Pool) {
  const patient = randomUUID(), doctorAccount = randomUUID(), doctor = randomUUID(), offering = randomUUID(), exposure = randomUUID(), version = randomUUID(), price = randomUUID(), policy = randomUUID(), intent = randomUUID(), reservation = randomUUID(), commercialRule = randomUUID(), commercialVersion = randomUUID(), scope = randomUUID();
  await target.query("INSERT INTO accounts (id,status) VALUES ($1,'ACTIVE'),($2,'ACTIVE')", [patient, doctorAccount]);
  await target.query("INSERT INTO patient_profiles (id,account_id,status) VALUES ($1,$1,'ACTIVE')", [patient]);
  await target.query("INSERT INTO doctor_profiles (id,account_id,status,professional_verification_status) VALUES ($1,$2,'ACTIVE','VERIFIED')", [doctor, doctorAccount]);
  await target.query("INSERT INTO service_offerings (id,owner_doctor_profile_id,name,status,created_by_account_id,updated_by_account_id) VALUES ($1,$2,'Appointment foundation','ACTIVE',$3,$3)", [offering, doctor, doctorAccount]);
  await target.query("INSERT INTO service_exposures (id,service_offering_id,provider_doctor_profile_id,status,created_by_account_id,updated_by_account_id) VALUES ($1,$2,$3,'DRAFT',$4,$4)", [exposure, offering, doctor, doctorAccount]);
  await target.query("UPDATE service_exposures SET status='PUBLISHED',updated_by_account_id=$2 WHERE id=$1", [exposure, doctorAccount]);
  await target.query("INSERT INTO service_offering_versions (id,service_offering_id,version_number,status,effective_from,created_by_account_id) VALUES ($1,$2,1,'ACTIVE',clock_timestamp()-interval '1 day',$3)", [version, offering, doctorAccount]);
  await target.query("INSERT INTO service_offering_prices (id,service_offering_version_id,currency,amount_minor,created_by_account_id) VALUES ($1,$2,'INR',10000,$3)", [price, version, doctorAccount]);
  await target.query('INSERT INTO service_offering_version_reservation_policies (id,service_offering_version_id,hold_seconds,created_by_account_id) VALUES ($1,$2,600,$3)', [policy, version, doctorAccount]);
  await target.query("INSERT INTO appointment_intents (id,patient_account_id,booking_actor_account_id,service_exposure_id,provider_doctor_profile_id,service_offering_id,service_offering_version_id,service_offering_price_id,currency,price_amount_minor,provider_timezone,requested_local_at,starts_at,ends_at,service_duration_seconds,buffer_before_seconds,buffer_after_seconds,hold_seconds,booking_relationship,state,idempotency_key,request_fingerprint,expires_at) VALUES ($1,$2,$2,$3,$4,$5,$6,$7,'INR',10000,'UTC',clock_timestamp()::timestamp,clock_timestamp(),clock_timestamp()+interval '30 minutes',1800,0,0,600,'PATIENT_PROVIDER','SLOT_RESERVED',$8,'seed',clock_timestamp()+interval '10 minutes')", [intent, patient, exposure, doctor, offering, version, price, `seed-${intent}`]);
  await target.query("INSERT INTO slot_reservations (id,appointment_intent_id,service_offering_version_id,provider_doctor_profile_id,starts_at,ends_at,capacity_units,status,expires_at) VALUES ($1,$2,$3,$4,clock_timestamp(),clock_timestamp()+interval '30 minutes',1,'HELD',clock_timestamp()+interval '10 minutes')", [reservation, intent, version, doctor]);
  await target.query("INSERT INTO commercial_rules (id,status,rule_type,created_by_account_id) VALUES ($1,'ACTIVE','FIXED',$2)", [commercialRule, doctorAccount]);
  await target.query("INSERT INTO commercial_rule_versions (id,commercial_rule_id,version_number,status,priority,effective_from,calculation_basis,processing_fee_bearer,policy_data,approved_by_account_id,approved_at) VALUES ($1,$2,1,'APPROVED',1,clock_timestamp()-interval '1 day','FIXED','THECLINIQ','{\"fixedAmountMinor\":500}'::jsonb,$3,clock_timestamp())", [commercialVersion, commercialRule, doctorAccount]);
  await target.query("INSERT INTO commercial_rule_scopes (id,commercial_rule_version_id,scope_kind,scope_reference_id) VALUES ($1,$2,'SERVICE',$3)", [scope, commercialVersion, offering]);
  return { patient, doctorAccount, intent, reservation };
}
