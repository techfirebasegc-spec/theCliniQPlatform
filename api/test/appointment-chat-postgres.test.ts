import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createDatabase, type DatabaseHealth } from '../src/infrastructure/database.js';
import { AppointmentChatError } from '../src/modules/chat/appointment-chat.js';
import { PostgresAppointmentChatRepository } from '../src/modules/chat/postgres-appointment-chat-repository.js';

const databaseUrl = process.env.DATABASE_URL;
let pool: Pool | undefined;
let databaseA: DatabaseHealth | undefined;
let databaseB: DatabaseHealth | undefined;

describe.skipIf(!databaseUrl)('Phase 7.1A PostgreSQL appointment chat lifecycle serialization', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    const current = await pool.query<{ name: string }>('SELECT current_database() AS name');
    if (current.rows[0]?.name !== 'cliniq_phase7_chat_verify') throw new Error('Refusing Phase 7.1A integration tests outside cliniq_phase7_chat_verify.');
    const schema = await pool.query("SELECT to_regclass('conversations') AS conversations,to_regclass('messages') AS messages,to_regclass('appointments') AS appointments");
    if (!schema.rows[0]?.conversations || !schema.rows[0]?.messages || !schema.rows[0]?.appointments) throw new Error('Phase 7.1A migration prerequisites are not applied.');
    databaseA = createDatabase({ DATABASE_URL: databaseUrl! }); databaseB = createDatabase({ DATABASE_URL: databaseUrl! });
  });
  afterAll(async () => { await databaseA?.close(); await databaseB?.close(); await pool?.end(); });

  it('lets a conversation committed before cancellation remain, but blocks a write serialized after cancellation', async () => {
    const fixture = await seed(pool!); const chat = new PostgresAppointmentChatRepository(databaseA!);
    const conversation = await chat.getOrCreate(fixture.appointmentId);
    const beforeCancellation = await chat.send({ conversationId: conversation.id, senderAccountId: fixture.patientAccountId, messageType: 'TEXT', body: 'before cancellation', idempotencyKey: randomUUID() });
    const cancellation = await pool!.connect();
    try {
      await cancellation.query('BEGIN'); await cancellation.query('SELECT id FROM appointments WHERE id=$1 FOR UPDATE', [fixture.appointmentId]); await cancellation.query("UPDATE appointments SET status='CANCELLED' WHERE id=$1", [fixture.appointmentId]);
      const pending = chat.send({ conversationId: conversation.id, senderAccountId: fixture.patientAccountId, messageType: 'TEXT', body: 'after cancellation', idempotencyKey: randomUUID() });
      await new Promise((resolve) => setTimeout(resolve, 25)); await cancellation.query('COMMIT');
      await expect(pending).rejects.toMatchObject({ code: 'CONFLICT' } satisfies Partial<AppointmentChatError>);
    } finally { await cancellation.query('ROLLBACK').catch(() => undefined); cancellation.release(); }
    expect((await chat.list(conversation.id)).map((message) => message.id)).toEqual([beforeCancellation.message.id]);
  });

  it('serializes concurrent creation and rejects creation after cancellation', async () => {
    const fixture = await seed(pool!); const left = new PostgresAppointmentChatRepository(databaseA!); const right = new PostgresAppointmentChatRepository(databaseB!);
    const created = await Promise.all([left.getOrCreate(fixture.appointmentId), right.getOrCreate(fixture.appointmentId)]);
    expect(new Set(created.map((conversation) => conversation.id))).toHaveSize(1);
    await pool!.query("UPDATE appointments SET status='CANCELLED' WHERE id=$1", [fixture.appointmentId]);
    await expect(left.getOrCreate(fixture.appointmentId)).rejects.toMatchObject({ code: 'CONFLICT' } satisfies Partial<AppointmentChatError>);
  });

  it('rejects conversation creation that is serialized after a concurrent cancellation', async () => {
    const fixture = await seed(pool!); const chat = new PostgresAppointmentChatRepository(databaseA!); const cancellation = await pool!.connect();
    try {
      await cancellation.query('BEGIN'); await cancellation.query('SELECT id FROM appointments WHERE id=$1 FOR UPDATE', [fixture.appointmentId]); await cancellation.query("UPDATE appointments SET status='CANCELLED' WHERE id=$1", [fixture.appointmentId]);
      const pending = chat.getOrCreate(fixture.appointmentId);
      await new Promise((resolve) => setTimeout(resolve, 25)); await cancellation.query('COMMIT');
      await expect(pending).rejects.toMatchObject({ code: 'CONFLICT' } satisfies Partial<AppointmentChatError>);
    } finally { await cancellation.query('ROLLBACK').catch(() => undefined); cancellation.release(); }
  });
});

async function seed(pool: Pool): Promise<{ appointmentId: string; patientAccountId: string }> {
  const ids = { patient: randomUUID(), doctorAccount: randomUUID(), doctor: randomUUID(), offering: randomUUID(), exposure: randomUUID(), version: randomUUID(), price: randomUUID(), policy: randomUUID(), intent: randomUUID(), reservation: randomUUID(), allocation: randomUUID(), payment: randomUUID(), handoff: randomUUID(), appointment: randomUUID(), capacity: randomUUID(), confirmationAudit: randomUUID(), confirmationEvent: randomUUID() };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("INSERT INTO accounts (id,status) VALUES ($1,'ACTIVE'),($2,'ACTIVE')", [ids.patient, ids.doctorAccount]);
    await client.query("INSERT INTO patient_profiles (id,account_id,status) VALUES ($1,$1,'ACTIVE')", [ids.patient]);
    await client.query("INSERT INTO doctor_profiles (id,account_id,status,professional_verification_status) VALUES ($1,$2,'ACTIVE','VERIFIED')", [ids.doctor, ids.doctorAccount]);
    await client.query("INSERT INTO service_offerings (id,owner_doctor_profile_id,name,status,created_by_account_id,updated_by_account_id) VALUES ($1,$2,'Chat fixture','ACTIVE',$3,$3)", [ids.offering, ids.doctor, ids.doctorAccount]);
    await client.query("INSERT INTO service_exposures (id,service_offering_id,provider_doctor_profile_id,status,created_by_account_id,updated_by_account_id) VALUES ($1,$2,$3,'DRAFT',$4,$4)", [ids.exposure, ids.offering, ids.doctor, ids.doctorAccount]); await client.query("UPDATE service_exposures SET status='PUBLISHED',updated_by_account_id=$2 WHERE id=$1", [ids.exposure, ids.doctorAccount]);
    await client.query("INSERT INTO service_offering_versions (id,service_offering_id,version_number,status,effective_from,created_by_account_id) VALUES ($1,$2,1,'ACTIVE',clock_timestamp()-interval '1 day',$3)", [ids.version, ids.offering, ids.doctorAccount]);
    await client.query("INSERT INTO service_offering_prices (id,service_offering_version_id,currency,amount_minor,created_by_account_id) VALUES ($1,$2,'INR',10000,$3)", [ids.price, ids.version, ids.doctorAccount]); await client.query('INSERT INTO service_offering_version_reservation_policies (id,service_offering_version_id,hold_seconds,created_by_account_id) VALUES ($1,$2,600,$3)', [ids.policy, ids.version, ids.doctorAccount]);
    await client.query("INSERT INTO appointment_intents (id,patient_account_id,booking_actor_account_id,service_exposure_id,provider_doctor_profile_id,service_offering_id,service_offering_version_id,service_offering_price_id,currency,price_amount_minor,provider_timezone,requested_local_at,starts_at,ends_at,service_duration_seconds,buffer_before_seconds,buffer_after_seconds,hold_seconds,booking_relationship,state,idempotency_key,request_fingerprint,expires_at) VALUES ($1,$2,$2,$3,$4,$5,$6,$7,'INR',10000,'UTC',clock_timestamp()::timestamp,clock_timestamp(),clock_timestamp()+interval '30 minutes',1800,0,0,600,'PATIENT_PROVIDER','SLOT_RESERVED',$8,'chat-fixture',clock_timestamp()+interval '10 minutes')", [ids.intent, ids.patient, ids.exposure, ids.doctor, ids.offering, ids.version, ids.price, `intent-${ids.intent}`]);
    await client.query("INSERT INTO slot_reservations (id,appointment_intent_id,service_offering_version_id,provider_doctor_profile_id,starts_at,ends_at,capacity_units,status,expires_at) VALUES ($1,$2,$3,$4,clock_timestamp(),clock_timestamp()+interval '30 minutes',1,'HELD',clock_timestamp()+interval '10 minutes')", [ids.reservation, ids.intent, ids.version, ids.doctor]);
    const financialInput = { appointmentIntentId: ids.intent, slotReservationId: ids.reservation, serviceExposureId: ids.exposure, serviceOfferingId: ids.offering, serviceOfferingVersionId: ids.version, serviceOfferingPriceId: ids.price, patientAccountId: ids.patient, bookingActorAccountId: ids.patient, currency: 'INR', grossAmountMinor: '10000' };
    await client.query("INSERT INTO financial_allocation_snapshots (id,status,currency,gross_amount_minor,calculation_basis,input_data,selected_rule_versions,created_by_account_id) VALUES ($1,'FINAL','INR',10000,'FIXED',$2::jsonb,'[]'::jsonb,$3)", [ids.allocation, JSON.stringify(financialInput), ids.doctorAccount]);
    await client.query("INSERT INTO payment_intents (id,provider_key,status,currency,amount_minor,allocation_snapshot_id,idempotency_key,created_by_account_id) VALUES ($1,'RAZORPAY','CREATED','INR',10000,$2,$3,$4)", [ids.payment, ids.allocation, `payment-${ids.intent}`, ids.patient]);
    await client.query('INSERT INTO appointment_financial_handoffs (id,appointment_intent_id,slot_reservation_id,financial_allocation_snapshot_id,payment_intent_id,booking_actor_account_id,idempotency_key,request_fingerprint) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [ids.handoff, ids.intent, ids.reservation, ids.allocation, ids.payment, ids.patient, `handoff-${ids.intent}`, 'chat-fixture']);
    await client.query("UPDATE appointment_intents SET state='PAYMENT_PENDING' WHERE id=$1", [ids.intent]); await client.query('SET CONSTRAINTS appointment_intent_payment_pending_integrity IMMEDIATE'); await client.query("UPDATE payment_intents SET status='SUCCEEDED' WHERE id=$1", [ids.payment]);
    await client.query(`INSERT INTO appointments (id,appointment_intent_id,slot_reservation_id,appointment_financial_handoff_id,financial_allocation_snapshot_id,payment_intent_id,patient_account_id,booking_actor_account_id,provider_doctor_profile_id,service_exposure_id,service_offering_id,service_offering_version_id,service_offering_price_id,currency,price_amount_minor,provider_timezone,requested_local_at,starts_at,ends_at,service_duration_seconds,buffer_before_seconds,buffer_after_seconds,hold_seconds,status) SELECT $1,intent.id,reservation.id,handoff.id,handoff.financial_allocation_snapshot_id,handoff.payment_intent_id,intent.patient_account_id,intent.booking_actor_account_id,intent.provider_doctor_profile_id,intent.service_exposure_id,intent.service_offering_id,intent.service_offering_version_id,intent.service_offering_price_id,intent.currency,intent.price_amount_minor,intent.provider_timezone,intent.requested_local_at,intent.starts_at,intent.ends_at,intent.service_duration_seconds,intent.buffer_before_seconds,intent.buffer_after_seconds,intent.hold_seconds,'PAYMENT_PENDING' FROM appointment_intents intent JOIN slot_reservations reservation ON reservation.id=$3 AND reservation.appointment_intent_id=intent.id JOIN appointment_financial_handoffs handoff ON handoff.id=$4 AND handoff.appointment_intent_id=intent.id WHERE intent.id=$2`, [ids.appointment, ids.intent, ids.reservation, ids.handoff]);
    await client.query('INSERT INTO appointment_participants (id,appointment_id,participant_type,patient_profile_id) VALUES ($1,$2,$3,$4)', [randomUUID(), ids.appointment, 'PATIENT', ids.patient]); await client.query('INSERT INTO appointment_participants (id,appointment_id,participant_type,doctor_profile_id) VALUES ($1,$2,$3,$4)', [randomUUID(), ids.appointment, 'DOCTOR', ids.doctor]);
    await client.query('INSERT INTO appointment_committed_capacities (id,appointment_id,slot_reservation_id,service_offering_version_id,starts_at,ends_at,capacity_units) SELECT $1,$2,id,service_offering_version_id,starts_at,ends_at,capacity_units FROM slot_reservations WHERE id=$3', [ids.capacity, ids.appointment, ids.reservation]);
    await client.query("UPDATE appointments SET status='CONFIRMED' WHERE id=$1", [ids.appointment]);
    await client.query("INSERT INTO audit_events (id,category,event_type,target_type,target_id,outcome,metadata) VALUES ($1,'BUSINESS','FIXTURE_APPOINTMENT_TRANSITION','APPOINTMENT',$2,'SUCCESS','{}'::jsonb)", [ids.confirmationAudit, ids.appointment]);
    await client.query("INSERT INTO appointment_events (id,appointment_id,event_type,previous_status,resulting_status,context,audit_event_id) VALUES ($1,$2,'CONFIRMED','PAYMENT_PENDING','CONFIRMED','{}'::jsonb,$3)", [ids.confirmationEvent, ids.appointment, ids.confirmationAudit]);
    await client.query('COMMIT'); return { appointmentId: ids.appointment, patientAccountId: ids.patient };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
