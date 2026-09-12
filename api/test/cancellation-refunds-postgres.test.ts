import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

const databaseUrl = process.env.DATABASE_URL;
const enabled = Boolean(databaseUrl);
let pool: Pool | undefined;

/**
 * This suite is deliberately restricted to a disposable database. It verifies real
 * PostgreSQL guards rather than migration source text; lifecycle/concurrency fixtures
 * are run only after the full Phase 5.5 migration chain has been applied there.
 */
describe.skipIf(!enabled)('theCliniQ Phase 5.5 PostgreSQL cancellation/refund guards', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    const current = await pool.query<{ name: string }>('SELECT current_database() AS name');
    if (current.rows[0]?.name !== 'cliniq_phase5_cancellation_refunds_verify') {
      throw new Error('Refusing Phase 5.5 integration tests outside cliniq_phase5_cancellation_refunds_verify.');
    }
    const schema = await pool.query(`SELECT to_regclass('appointment_cancellation_decisions') AS decisions,
      to_regclass('appointment_cancellation_financial_consequences') AS consequences,
      to_regclass('refund_attempts') AS attempts`);
    if (!schema.rows[0]?.decisions || !schema.rows[0]?.consequences || !schema.rows[0]?.attempts) {
      throw new Error('Phase 5.5 cancellation/refund migration is not applied.');
    }
  });

  afterAll(async () => { await pool?.end(); });

  it('enforces integer structured policy values and the approved payment-state vocabulary', async () => {
    const client = await pool!.connect();
    try {
      await client.query('BEGIN');
      await client.query('SAVEPOINT invalid_fractional_window');
      await expect(client.query(`INSERT INTO refund_policy_versions (id,status,version_number,effective_from,policy_data)
        VALUES (gen_random_uuid(),'DRAFT',900001,current_timestamp,
          '{"refundOutcome":"FULL","refundBasis":"PAYMENT_AMOUNT","cancellationWindowSeconds":0.5,"paymentStates":["SUCCEEDED"],"allowInProgress":false}'::jsonb)`)).rejects.toThrow(/invalid structured refund policy data/);
      await client.query('ROLLBACK TO SAVEPOINT invalid_fractional_window');
      await client.query('SAVEPOINT invalid_payment_state');
      await expect(client.query(`INSERT INTO refund_policy_versions (id,status,version_number,effective_from,policy_data)
        VALUES (gen_random_uuid(),'DRAFT',900002,current_timestamp,
          '{"refundOutcome":"FULL","refundBasis":"PAYMENT_AMOUNT","cancellationWindowSeconds":0,"paymentStates":["UNAPPROVED"],"allowInProgress":false}'::jsonb)`)).rejects.toThrow(/unsupported payment state/);
      await client.query('ROLLBACK TO SAVEPOINT invalid_payment_state');
    } finally { await client.query('ROLLBACK'); client.release(); }
  });

  it('has deferred direct-SQL financial-context guards and immutable provider-reference protection', async () => {
    const result = await pool!.query<{ guard: string }>(`SELECT trigger.tgname AS guard
      FROM pg_trigger trigger
      JOIN pg_class relation ON relation.oid=trigger.tgrelid
      WHERE NOT trigger.tgisinternal
        AND trigger.tgname IN ('appointment_cancellation_financial_context_integrity','refund_cancellation_financial_integrity','cancellation_consequence_financial_integrity','refund_provider_references_immutable','refunds_provider_reference_integrity','provider_references_refund_integrity')
      ORDER BY trigger.tgname`);
    expect(result.rows.map((row) => row.guard)).toEqual([
      'appointment_cancellation_financial_context_integrity',
      'cancellation_consequence_financial_integrity',
      'provider_references_refund_integrity',
      'refund_cancellation_financial_integrity',
      'refund_provider_references_immutable',
      'refunds_provider_reference_integrity',
    ]);
  });

  it('enforces cancellation-decision payment evidence for no, matching, absent, wrong, and ambiguous payment facts', async () => {
    await expect(expectDecisionCommit({ paymentFactCount: 0, decisionPayment: 'NULL' })).resolves.toBeUndefined();
    await expect(expectDecisionCommit({ paymentFactCount: 1, decisionPayment: 'MATCHING' })).resolves.toBeUndefined();
    await expect(expectDecisionCommit({ paymentFactCount: 1, decisionPayment: 'NULL' })).rejects.toThrow(/payment context is inconsistent/);
    await expect(expectDecisionCommit({ paymentFactCount: 1, decisionPayment: 'WRONG' })).rejects.toThrow(/payment context is inconsistent/);
    await expect(expectDecisionCommit({ paymentFactCount: 2, decisionPayment: 'NULL' })).rejects.toThrow(/payment context is ambiguous/);
  });

  it('enforces the immutable refund provider-reference relationship in both directions', async () => {
    await expect(expectRefundReferenceCommit('MATCHING')).resolves.toBeUndefined();
    await expect(expectRefundReferenceCommit('MISSING')).rejects.toThrow(/provider reference evidence is inconsistent/);
    await expect(expectRefundReferenceCommit('WRONG_KEY')).rejects.toThrow(/provider reference evidence is inconsistent/);
    await expect(expectRefundReferenceCommit('WRONG_REFERENCE')).rejects.toThrow(/provider reference evidence is inconsistent/);
    await expect(expectRefundReferenceCommit('WRONG_ENTITY')).rejects.toThrow(/provider reference evidence is inconsistent/);
    await expect(expectRefundReferenceCommit('DUPLICATE')).rejects.toThrow();
  });
});

type DecisionCase = { paymentFactCount: 0 | 1 | 2; decisionPayment: 'NULL' | 'MATCHING' | 'WRONG' };

async function expectDecisionCommit(testCase: DecisionCase): Promise<void> {
  const client = await pool!.connect();
  try {
    await client.query('BEGIN');
    const fixture = await seedAppointment(client);
    const payments: string[] = [];
    for (let index = 0; index < testCase.paymentFactCount; index += 1) {
      const id = randomUUID();
      payments.push(id);
      await client.query("INSERT INTO payments (id,payment_intent_id,provider_key,provider_payment_id,status,currency,amount_minor) VALUES ($1,$2,'RAZORPAY',$3,'SUCCEEDED','INR',10000)", [id, fixture.paymentIntent, `payment-${id}`]);
    }
    let paymentId: string | null = testCase.decisionPayment === 'MATCHING' ? payments[0]! : null;
    if (testCase.decisionPayment === 'WRONG') {
      const otherIntent = randomUUID(); paymentId = randomUUID();
      await client.query("INSERT INTO payment_intents (id,provider_key,status,currency,amount_minor,allocation_snapshot_id,idempotency_key,created_by_account_id) VALUES ($1,'RAZORPAY','CREATED','INR',10000,$2,$3,$4)", [otherIntent, fixture.allocation, `other-${otherIntent}`, fixture.patient]);
      await client.query("INSERT INTO payments (id,payment_intent_id,provider_key,provider_payment_id,status,currency,amount_minor) VALUES ($1,$2,'RAZORPAY',$3,'SUCCEEDED','INR',10000)", [paymentId, otherIntent, `payment-${paymentId}`]);
    }
    await insertCancellationDecision(client, fixture, paymentId);
    await client.query('COMMIT');
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

async function expectRefundReferenceCommit(mode: 'MATCHING' | 'MISSING' | 'WRONG_KEY' | 'WRONG_REFERENCE' | 'WRONG_ENTITY' | 'DUPLICATE'): Promise<void> {
  const client = await pool!.connect();
  try {
    await client.query('BEGIN');
    const account = randomUUID(), allocation = randomUUID(), paymentIntent = randomUUID(), payment = randomUUID(), refund = randomUUID();
    await client.query("INSERT INTO accounts (id,status) VALUES ($1,'ACTIVE')", [account]);
    await client.query("INSERT INTO financial_allocation_snapshots (id,status,currency,gross_amount_minor,calculation_basis,input_data,selected_rule_versions,created_by_account_id) VALUES ($1,'FINAL','INR',10000,'FIXED','{}'::jsonb,'[]'::jsonb,$2)", [allocation, account]);
    await client.query("INSERT INTO payment_intents (id,provider_key,status,currency,amount_minor,allocation_snapshot_id,idempotency_key,created_by_account_id) VALUES ($1,'RAZORPAY','SUCCEEDED','INR',10000,$2,$3,$4)", [paymentIntent, allocation, `refund-pi-${paymentIntent}`, account]);
    await client.query("INSERT INTO payments (id,payment_intent_id,provider_key,provider_payment_id,status,currency,amount_minor) VALUES ($1,$2,'RAZORPAY',$3,'SUCCEEDED','INR',10000)", [payment, paymentIntent, `payment-${payment}`]);
    const providerRefund = `refund-${refund}`;
    await client.query("INSERT INTO refunds (id,payment_id,allocation_snapshot_id,provider_key,provider_refund_id,status,currency,amount_minor,idempotency_key,created_by_account_id) VALUES ($1,$2,$3,'RAZORPAY',$4,'PROCESSING','INR',10000,$5,$6)", [refund, payment, allocation, providerRefund, `refund-${refund}`, account]);
    if (mode !== 'MISSING') {
      const referenceKey = mode === 'WRONG_KEY' ? 'OTHER_PROVIDER' : 'RAZORPAY';
      const referenceValue = mode === 'WRONG_REFERENCE' ? `other-${providerRefund}` : providerRefund;
      const entityType = mode === 'WRONG_ENTITY' ? 'PAYMENT' : 'REFUND';
      const entityId = mode === 'WRONG_ENTITY' ? payment : refund;
      await client.query('INSERT INTO provider_references (id,provider_key,reference_type,provider_reference,internal_entity_type,internal_entity_id) VALUES ($1,$2,\'REFUND\',$3,$4,$5)', [randomUUID(), referenceKey, referenceValue, entityType, entityId]);
      if (mode === 'DUPLICATE') {
        await client.query('INSERT INTO provider_references (id,provider_key,reference_type,provider_reference,internal_entity_type,internal_entity_id) VALUES ($1,\'RAZORPAY\',\'REFUND\',$2,\'REFUND\',$3)', [randomUUID(), providerRefund, payment]);
      }
    }
    await client.query('COMMIT');
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

async function seedAppointment(client: import('pg').PoolClient) {
  const patient = randomUUID(), doctorAccount = randomUUID(), doctor = randomUUID(), offering = randomUUID(), exposure = randomUUID(), version = randomUUID(), price = randomUUID(), intent = randomUUID(), reservation = randomUUID(), allocation = randomUUID(), paymentIntent = randomUUID(), handoff = randomUUID(), appointment = randomUUID(), refundPolicyVersion = randomUUID();
  await client.query("INSERT INTO accounts (id,status) VALUES ($1,'ACTIVE'),($2,'ACTIVE')", [patient, doctorAccount]);
  await client.query("INSERT INTO patient_profiles (id,account_id,status) VALUES ($1,$1,'ACTIVE')", [patient]);
  await client.query("INSERT INTO doctor_profiles (id,account_id,status,professional_verification_status) VALUES ($1,$2,'ACTIVE','VERIFIED')", [doctor, doctorAccount]);
  await client.query("INSERT INTO service_offerings (id,owner_doctor_profile_id,name,status,created_by_account_id,updated_by_account_id) VALUES ($1,$2,'Cancellation test','ACTIVE',$3,$3)", [offering, doctor, doctorAccount]);
  await client.query("INSERT INTO service_exposures (id,service_offering_id,provider_doctor_profile_id,status,created_by_account_id,updated_by_account_id) VALUES ($1,$2,$3,'DRAFT',$4,$4)", [exposure, offering, doctor, doctorAccount]);
  await client.query("UPDATE service_exposures SET status='PUBLISHED',updated_by_account_id=$2 WHERE id=$1", [exposure, doctorAccount]);
  await client.query("INSERT INTO service_offering_versions (id,service_offering_id,version_number,status,effective_from,created_by_account_id) VALUES ($1,$2,1,'ACTIVE',clock_timestamp()-interval '1 day',$3)", [version, offering, doctorAccount]);
  await client.query("INSERT INTO service_offering_prices (id,service_offering_version_id,currency,amount_minor,created_by_account_id) VALUES ($1,$2,'INR',10000,$3)", [price, version, doctorAccount]);
  await client.query('INSERT INTO service_offering_version_reservation_policies (id,service_offering_version_id,hold_seconds,created_by_account_id) VALUES ($1,$2,600,$3)', [randomUUID(), version, doctorAccount]);
  await client.query("INSERT INTO appointment_intents (id,patient_account_id,booking_actor_account_id,service_exposure_id,provider_doctor_profile_id,service_offering_id,service_offering_version_id,service_offering_price_id,currency,price_amount_minor,provider_timezone,requested_local_at,starts_at,ends_at,service_duration_seconds,buffer_before_seconds,buffer_after_seconds,hold_seconds,booking_relationship,state,idempotency_key,request_fingerprint,expires_at) VALUES ($1,$2,$2,$3,$4,$5,$6,$7,'INR',10000,'UTC',clock_timestamp()::timestamp,clock_timestamp(),clock_timestamp()+interval '30 minutes',1800,0,0,600,'PATIENT_PROVIDER','SLOT_RESERVED',$8,'cancellation-fixture',clock_timestamp()+interval '10 minutes')", [intent, patient, exposure, doctor, offering, version, price, `intent-${intent}`]);
  await client.query("INSERT INTO slot_reservations (id,appointment_intent_id,service_offering_version_id,provider_doctor_profile_id,starts_at,ends_at,capacity_units,status,expires_at) VALUES ($1,$2,$3,$4,clock_timestamp(),clock_timestamp()+interval '30 minutes',1,'HELD',clock_timestamp()+interval '10 minutes')", [reservation, intent, version, doctor]);
  const input = JSON.stringify({ appointmentIntentId: intent, slotReservationId: reservation, serviceExposureId: exposure, serviceOfferingId: offering, serviceOfferingVersionId: version, serviceOfferingPriceId: price, patientAccountId: patient, bookingActorAccountId: patient, currency: 'INR', grossAmountMinor: '10000' });
  await client.query("INSERT INTO financial_allocation_snapshots (id,status,currency,gross_amount_minor,calculation_basis,input_data,selected_rule_versions,created_by_account_id) VALUES ($1,'FINAL','INR',10000,'FIXED',$2::jsonb,'[]'::jsonb,$3)", [allocation, input, doctorAccount]);
  await client.query('SELECT pg_advisory_xact_lock($1)', [5_500_003]);
  const refundPolicyVersionNumber = await client.query<{ version_number: string }>('SELECT COALESCE(MAX(version_number), 0) + 1 AS version_number FROM refund_policy_versions');
  await client.query(`INSERT INTO refund_policy_versions (id,status,version_number,effective_from,policy_data)
    VALUES ($1,'DRAFT',$2,clock_timestamp(),
      '{"refundOutcome":"NONE","refundBasis":"PAYMENT_AMOUNT","cancellationWindowSeconds":0,"paymentStates":["SUCCEEDED"],"allowInProgress":false}'::jsonb)`, [refundPolicyVersion, refundPolicyVersionNumber.rows[0]!.version_number]);
  await client.query("INSERT INTO payment_intents (id,provider_key,status,currency,amount_minor,allocation_snapshot_id,idempotency_key,created_by_account_id) VALUES ($1,'RAZORPAY','CREATED','INR',10000,$2,$3,$4)", [paymentIntent, allocation, `pi-${paymentIntent}`, patient]);
  await client.query('INSERT INTO appointment_financial_handoffs (id,appointment_intent_id,slot_reservation_id,financial_allocation_snapshot_id,payment_intent_id,booking_actor_account_id,idempotency_key,request_fingerprint) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [handoff, intent, reservation, allocation, paymentIntent, patient, `handoff-${intent}`, 'cancellation-fingerprint']);
  await client.query("UPDATE appointment_intents SET state='PAYMENT_PENDING' WHERE id=$1", [intent]);
  // Validate the handoff while its payment intent is still CREATED.  The
  // appointment fixture below legitimately needs that intent to be SUCCEEDED,
  // and this keeps the Phase 4 prerequisite separate from the Phase 5.5
  // payment-fact cases exercised by this test.
  await client.query('SET CONSTRAINTS appointment_intent_payment_pending_integrity IMMEDIATE');
  await client.query("UPDATE payment_intents SET status='SUCCEEDED' WHERE id=$1", [paymentIntent]);
  await client.query(`INSERT INTO appointments (id,appointment_intent_id,slot_reservation_id,appointment_financial_handoff_id,financial_allocation_snapshot_id,payment_intent_id,patient_account_id,booking_actor_account_id,provider_doctor_profile_id,service_exposure_id,service_offering_id,service_offering_version_id,service_offering_price_id,currency,price_amount_minor,provider_timezone,requested_local_at,starts_at,ends_at,service_duration_seconds,buffer_before_seconds,buffer_after_seconds,hold_seconds,status)
    SELECT $1,intent.id,reservation.id,handoff.id,handoff.financial_allocation_snapshot_id,handoff.payment_intent_id,intent.patient_account_id,intent.booking_actor_account_id,intent.provider_doctor_profile_id,intent.service_exposure_id,intent.service_offering_id,intent.service_offering_version_id,intent.service_offering_price_id,intent.currency,intent.price_amount_minor,intent.provider_timezone,intent.requested_local_at,intent.starts_at,intent.ends_at,intent.service_duration_seconds,intent.buffer_before_seconds,intent.buffer_after_seconds,intent.hold_seconds,'PAYMENT_PENDING' FROM appointment_intents intent JOIN slot_reservations reservation ON reservation.id=$3 AND reservation.appointment_intent_id=intent.id JOIN appointment_financial_handoffs handoff ON handoff.id=$4 AND handoff.appointment_intent_id=intent.id WHERE intent.id=$2`, [appointment, intent, reservation, handoff]);
  await client.query("INSERT INTO appointment_participants (id,appointment_id,participant_type,patient_profile_id) VALUES ($1,$2,'PATIENT',$3)", [randomUUID(), appointment, patient]);
  await client.query("INSERT INTO appointment_participants (id,appointment_id,participant_type,doctor_profile_id) VALUES ($1,$2,'DOCTOR',$3)", [randomUUID(), appointment, doctor]);
  await client.query("UPDATE appointments SET status='CANCELLED' WHERE id=$1", [appointment]);
  return { appointment, reservation, allocation, paymentIntent, patient, refundPolicyVersion };
}

async function insertCancellationDecision(client: import('pg').PoolClient, fixture: Awaited<ReturnType<typeof seedAppointment>>, paymentId: string | null) {
  const decision = randomUUID();
  await client.query(`INSERT INTO appointment_cancellation_decisions (id,appointment_id,slot_reservation_id,financial_allocation_snapshot_id,payment_id,actor_account_id,previous_appointment_status,reason_category,cancellation_at,refund_policy_version_id,refund_outcome,refund_amount_minor,currency,capacity_released,settlement_consequence,idempotency_key,request_fingerprint)
    VALUES ($1,$2,$3,$4,$5,$6,'PAYMENT_PENDING','test',clock_timestamp(),$7,'NO_REFUND',0,'INR',false,'NONE',$8,$9)`, [decision, fixture.appointment, fixture.reservation, fixture.allocation, paymentId, fixture.patient, fixture.refundPolicyVersion, `decision-${decision}`, `fingerprint-${decision}`]);
  await client.query("INSERT INTO appointment_events (id,appointment_id,event_type,actor_account_id,previous_status,resulting_status,reason,context) VALUES ($1,$2,'CANCELLED',$3,'PAYMENT_PENDING','CANCELLED','test',jsonb_build_object('cancellationDecisionId',$4::text))", [randomUUID(), fixture.appointment, fixture.patient, decision]);
}
