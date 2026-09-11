import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import Fastify from 'fastify';
import { createDatabase, type DatabaseHealth } from '../src/infrastructure/database.js';
import { PaymentHandoffService } from '../src/modules/appointments/payment-handoffs.js';
import { PostgresPaymentHandoffRepository } from '../src/modules/appointments/postgres-payment-handoff-repository.js';
import { PaymentOrderProvisioningService } from '../src/modules/appointments/payment-order-provisioning.js';
import { PostgresPaymentOrderProvisioningRepository } from '../src/modules/appointments/postgres-payment-order-provisioning-repository.js';
import { PaymentConfirmationService } from '../src/modules/appointments/payment-confirmation.js';
import { PostgresPaymentConfirmationRepository } from '../src/modules/appointments/postgres-payment-confirmation-repository.js';
import { resolvePaymentProviderKey } from '../src/modules/financial/provider-registry.js';
import type { PaymentProvider, ProviderOrder } from '../src/modules/financial/provider.js';
import { registerRazorpayWebhookRoutes } from '../src/routes/razorpay-webhooks.js';

const databaseUrl = process.env.DATABASE_URL;
const enabled = Boolean(databaseUrl);
const webhookSecret = 'phase5-step5.3-test-webhook-secret';
let pool: Pool | undefined;
let databaseA: DatabaseHealth | undefined;
let databaseB: DatabaseHealth | undefined;

class DeterministicProvider implements PaymentProvider {
  public readonly key = 'RAZORPAY';
  public readonly orders = new Map<string, ProviderOrder>();
  public createCalls = 0; public lookupCalls = 0;
  public constructor(public readonly orderId: string) {}
  public async findOrderByReceipt({ receipt }: { receipt: string }) { this.lookupCalls += 1; return this.orders.get(receipt) ?? null; }
  public async createOrder(input: { receipt: string; amountMinor: bigint; currency: string }) { this.createCalls += 1; const existing = this.orders.get(input.receipt); if (existing) return existing; const order = { providerOrderId: this.orderId, ...input }; this.orders.set(input.receipt, order); return order; }
  public verifyWebhook({ payload, signature }: { payload: string; signature: string }) { return createHmac('sha256', webhookSecret).update(payload).digest('hex') === signature; }
  public async verifyPayment() { return { status: 'SUCCEEDED' as const }; }
  public async createRefund() { throw new Error('out of scope'); }
  public async createSettlement() { throw new Error('out of scope'); }
}

describe.skipIf(!enabled)('theCliniQ Phase 5 Step 5.3 real PostgreSQL provisioning and confirmation', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    const current = await pool.query<{ name: string }>('SELECT current_database() AS name');
    if (current.rows[0]?.name !== 'cliniq_phase5_payment_order_provisioning_verify') throw new Error('Refusing Step 5.3 integration tests outside cliniq_phase5_payment_order_provisioning_verify.');
    const schema = await pool.query("SELECT to_regclass('payment_order_provisioning_attempts') AS attempts, to_regclass('appointments') AS appointments");
    if (!schema.rows[0]?.attempts || !schema.rows[0]?.appointments) throw new Error('Phase 5 Step 5.3 migration is not applied.');
    databaseA = createDatabase({ DATABASE_URL: databaseUrl! }); databaseB = createDatabase({ DATABASE_URL: databaseUrl! });
  });
  afterAll(async () => { await databaseA?.close(); await databaseB?.close(); await pool?.end(); });

  it('persists one provider order, exact-replays provisioning, then confirms exactly once from payment.captured', async () => {
    const fixture = await seed(pool!); const provider = new DeterministicProvider(providerOrderId(fixture.intent));
    await handoff(databaseA!, fixture);
    const first = await provisioning(databaseA!, provider).provision(fixture.patient, fixture.intent);
    expect(first).toMatchObject({ state: 'PENDING_PROVIDER', providerOrderId: provider.orderId, amountMinor: 10_000n, currency: 'INR' });
    const retry = await provisioning(databaseA!, provider).provision(fixture.patient, fixture.intent);
    expect(retry).toEqual(first);
    expect(provider.lookupCalls).toBe(1); expect(provider.createCalls).toBe(1);
    await expectProvisioning(pool!, fixture.intent, provider.orderId);

    const eventId = webhookEventId(fixture.intent, 'captured');
    const raw = captured(`pay_${fixture.intent}`, provider.orderId, 10_000, 'INR'); const signature = createHmac('sha256', webhookSecret).update(raw).digest('hex');
    const confirmation = confirm(databaseA!, provider);
    await expect(confirmation.receiveRazorpayWebhook(raw, signature, eventId)).resolves.toEqual({ status: 'CONFIRMED' });
    await expect(confirmation.receiveRazorpayWebhook(raw, signature, eventId)).resolves.toEqual({ status: 'REPLAYED' });
    const counts = await pool!.query<{ payments: string; events: string; appointments: string; appointment_events: string; audit: string; state: string; payment_state: string }>(`
      SELECT count(DISTINCT payment.id)::text AS payments,count(DISTINCT webhook.id)::text AS events,count(DISTINCT appointment.id)::text AS appointments,
        count(DISTINCT event.id)::text AS appointment_events,count(DISTINCT audit.id)::text AS audit,max(intent.state) AS state,max(payment_intent.status) AS payment_state
      FROM appointment_intents intent JOIN appointment_financial_handoffs handoff ON handoff.appointment_intent_id=intent.id
      JOIN payment_intents payment_intent ON payment_intent.id=handoff.payment_intent_id
      LEFT JOIN payments payment ON payment.payment_intent_id=payment_intent.id LEFT JOIN provider_webhook_events webhook ON webhook.provider_event_id=$2
      LEFT JOIN appointments appointment ON appointment.appointment_intent_id=intent.id LEFT JOIN appointment_events event ON event.appointment_id=appointment.id
      LEFT JOIN audit_events audit ON audit.target_id=appointment.id WHERE intent.id=$1 GROUP BY intent.id`, [fixture.intent, eventId]);
    expect(counts.rows[0]).toMatchObject({ payments: '1', events: '1', appointments: '1', appointment_events: '1', state: 'PAYMENT_PENDING', payment_state: 'SUCCEEDED' });
  });

  it('serializes concurrent provisioning with one authoritative order relationship', async () => {
    const fixture = await seed(pool!); const provider = new DeterministicProvider(providerOrderId(fixture.intent)); await handoff(databaseA!, fixture);
    const results = await Promise.allSettled([provisioning(databaseA!, provider).provision(fixture.patient, fixture.intent), provisioning(databaseB!, provider).provision(fixture.patient, fixture.intent)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    const fulfilled = results.filter((result): result is PromiseFulfilledResult<{ state: string; providerOrderId?: string }> => result.status === 'fulfilled').map((result) => result.value);
    expect(fulfilled.map((result) => result.state)).toEqual(['PENDING_PROVIDER', 'PENDING_PROVIDER']);
    expect(new Set(fulfilled.map((result) => result.providerOrderId))).toEqual(new Set([provider.orderId]));
    await expect(provisioning(databaseB!, provider).provision(fixture.patient, fixture.intent)).resolves.toMatchObject({ state: 'PENDING_PROVIDER', providerOrderId: provider.orderId });
    await expectProvisioning(pool!, fixture.intent, provider.orderId);
    expect(provider.createCalls).toBe(1);
  });

  it('does not confirm an amount/currency/order mismatch or an invalid signature', async () => {
    const fixture = await seed(pool!); const provider = new DeterministicProvider(providerOrderId(fixture.intent)); await handoff(databaseA!, fixture);
    await provisioning(databaseA!, provider).provision(fixture.patient, fixture.intent);
    const confirmation = confirm(databaseA!, provider);
    const invalid = captured(`pay_bad_signature_${fixture.intent}`, provider.orderId, 10_000, 'INR');
    await expect(confirmation.receiveRazorpayWebhook(invalid, 'invalid', webhookEventId(fixture.intent, 'invalid'))).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
    const mismatch = captured(`pay_mismatch_${fixture.intent}`, provider.orderId, 9_999, 'INR'); const signature = createHmac('sha256', webhookSecret).update(mismatch).digest('hex');
    await expect(confirmation.receiveRazorpayWebhook(mismatch, signature, webhookEventId(fixture.intent, 'mismatch'))).resolves.toEqual({ status: 'RECONCILIATION_REQUIRED' });
    const status = await pool!.query<{ payment: string; appointments: string }>(`SELECT payment.status AS payment,count(appointment.id)::text AS appointments FROM appointment_financial_handoffs handoff JOIN payment_intents payment ON payment.id=handoff.payment_intent_id LEFT JOIN appointments appointment ON appointment.appointment_intent_id=handoff.appointment_intent_id WHERE handoff.appointment_intent_id=$1 GROUP BY payment.status`, [fixture.intent]);
    expect(status.rows[0]).toEqual({ payment: 'RECONCILIATION_REQUIRED', appointments: '0' });
  });

  it('authenticates raw HMAC at the actual webhook route before provider facts reach PostgreSQL', async () => {
    const fixture = await seed(pool!); const provider = new DeterministicProvider(providerOrderId(fixture.intent)); await handoff(databaseA!, fixture); await provisioning(databaseA!, provider).provision(fixture.patient, fixture.intent);
    const app = Fastify(); await registerRazorpayWebhookRoutes(app, { confirmation: confirm(databaseA!, provider) }); await app.ready();
    try {
      const raw = captured(`pay_route_${fixture.intent}`, provider.orderId, 10_000, 'INR'); const signature = createHmac('sha256', webhookSecret).update(raw).digest('hex');
      const eventId = webhookEventId(fixture.intent, 'route'); const invalidEventId = webhookEventId(fixture.intent, 'invalid-route');
      await expect(app.inject({ method: 'POST', url: '/v1/providers/razorpay/webhook', headers: { 'content-type': 'application/json', 'x-razorpay-event-id': eventId, 'x-razorpay-signature': signature }, payload: raw })).resolves.toMatchObject({ statusCode: 200 });
      const invalid = await app.inject({ method: 'POST', url: '/v1/providers/razorpay/webhook', headers: { 'content-type': 'application/json', 'x-razorpay-event-id': invalidEventId, 'x-razorpay-signature': 'invalid' }, payload: raw });
      expect(invalid.statusCode).toBe(401);
      const events = await pool!.query<{ count: string }>('SELECT count(*)::text AS count FROM provider_webhook_events WHERE provider_event_id=$1', [invalidEventId]);
      expect(events.rows[0]?.count).toBe('0');
    } finally { await app.close(); }
  });
});

function provisioning(database: DatabaseHealth, provider: PaymentProvider) { return new PaymentOrderProvisioningService(new PostgresPaymentOrderProvisioningRepository(database), provider, 60); }
function confirm(database: DatabaseHealth, provider: PaymentProvider) { return new PaymentConfirmationService(provider, new PostgresPaymentConfirmationRepository(database)); }
async function handoff(database: DatabaseHealth, fixture: Awaited<ReturnType<typeof seed>>) { await new PaymentHandoffService(new PostgresPaymentHandoffRepository(database), resolvePaymentProviderKey('RAZORPAY')).create(fixture.patient, fixture.intent, { idempotencyKey: `handoff-${fixture.intent}` }); }
async function expectProvisioning(target: Pool, intentId: string, orderId: string) {
  const row = await target.query<{ attempts: string; references: string; status: string; order: string | null; receipt: string }>(`SELECT count(DISTINCT attempt.id)::text AS attempts,count(DISTINCT reference.id)::text AS references,max(payment.status) AS status,max(payment.provider_order_id) AS "order",max(attempt.provider_receipt) AS receipt FROM appointment_financial_handoffs handoff JOIN payment_intents payment ON payment.id=handoff.payment_intent_id LEFT JOIN payment_order_provisioning_attempts attempt ON attempt.payment_intent_id=payment.id LEFT JOIN provider_references reference ON reference.internal_entity_id=payment.id AND reference.reference_type='ORDER' WHERE handoff.appointment_intent_id=$1 GROUP BY handoff.appointment_intent_id`, [intentId]);
  expect(row.rows[0]).toMatchObject({ attempts: '1', references: '1', status: 'PENDING_PROVIDER', order: orderId }); expect(row.rows[0]?.receipt).toMatch(/^clqpi_[a-f0-9]{32}$/);
}
function captured(paymentId: string, orderId: string, amount: number, currency: string) { return JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: paymentId, order_id: orderId, amount, currency, status: 'captured' } } } }); }
function providerOrderId(intentId: string) { return `order_${intentId.replace(/-/g, '')}`; }
function webhookEventId(intentId: string, kind: string) { return `evt_${kind}_${intentId.replace(/-/g, '')}`; }
async function seed(target: Pool) {
  const patient = randomUUID(), doctorAccount = randomUUID(), doctor = randomUUID(), offering = randomUUID(), exposure = randomUUID(), version = randomUUID(), price = randomUUID(), policy = randomUUID(), intent = randomUUID(), reservation = randomUUID(), commercialRule = randomUUID(), commercialVersion = randomUUID(), scope = randomUUID();
  await target.query("INSERT INTO accounts (id,status) VALUES ($1,'ACTIVE'),($2,'ACTIVE')", [patient, doctorAccount]); await target.query("INSERT INTO patient_profiles (id,account_id,status) VALUES ($1,$1,'ACTIVE')", [patient]); await target.query("INSERT INTO doctor_profiles (id,account_id,status,professional_verification_status) VALUES ($1,$2,'ACTIVE','VERIFIED')", [doctor, doctorAccount]);
  await target.query("INSERT INTO service_offerings (id,owner_doctor_profile_id,name,status,created_by_account_id,updated_by_account_id) VALUES ($1,$2,'Step 5.3 test','ACTIVE',$3,$3)", [offering, doctor, doctorAccount]); await target.query("INSERT INTO service_exposures (id,service_offering_id,provider_doctor_profile_id,status,created_by_account_id,updated_by_account_id) VALUES ($1,$2,$3,'DRAFT',$4,$4)", [exposure, offering, doctor, doctorAccount]); await target.query("UPDATE service_exposures SET status='PUBLISHED',updated_by_account_id=$2 WHERE id=$1", [exposure, doctorAccount]);
  await target.query("INSERT INTO service_offering_versions (id,service_offering_id,version_number,status,effective_from,created_by_account_id) VALUES ($1,$2,1,'ACTIVE',clock_timestamp()-interval '1 day',$3)", [version, offering, doctorAccount]); await target.query("INSERT INTO service_offering_prices (id,service_offering_version_id,currency,amount_minor,created_by_account_id) VALUES ($1,$2,'INR',10000,$3)", [price, version, doctorAccount]); await target.query('INSERT INTO service_offering_version_reservation_policies (id,service_offering_version_id,hold_seconds,created_by_account_id) VALUES ($1,$2,600,$3)', [policy, version, doctorAccount]);
  await target.query("INSERT INTO appointment_intents (id,patient_account_id,booking_actor_account_id,service_exposure_id,provider_doctor_profile_id,service_offering_id,service_offering_version_id,service_offering_price_id,currency,price_amount_minor,provider_timezone,requested_local_at,starts_at,ends_at,service_duration_seconds,buffer_before_seconds,buffer_after_seconds,hold_seconds,booking_relationship,state,idempotency_key,request_fingerprint,expires_at) VALUES ($1,$2,$2,$3,$4,$5,$6,$7,'INR',10000,'UTC',clock_timestamp()::timestamp,clock_timestamp(),clock_timestamp()+interval '30 minutes',1800,0,0,600,'PATIENT_PROVIDER','SLOT_RESERVED',$8,'seed',clock_timestamp()+interval '10 minutes')", [intent, patient, exposure, doctor, offering, version, price, `seed-${intent}`]);
  await target.query("INSERT INTO slot_reservations (id,appointment_intent_id,service_offering_version_id,provider_doctor_profile_id,starts_at,ends_at,capacity_units,status,expires_at) VALUES ($1,$2,$3,$4,clock_timestamp(),clock_timestamp()+interval '30 minutes',1,'HELD',clock_timestamp()+interval '10 minutes')", [reservation, intent, version, doctor]);
  await target.query("INSERT INTO commercial_rules (id,status,rule_type,created_by_account_id) VALUES ($1,'ACTIVE','FIXED',$2)", [commercialRule, doctorAccount]); await target.query("INSERT INTO commercial_rule_versions (id,commercial_rule_id,version_number,status,priority,effective_from,calculation_basis,processing_fee_bearer,policy_data,approved_by_account_id,approved_at) VALUES ($1,$2,1,'APPROVED',1,clock_timestamp()-interval '1 day','FIXED','THECLINIQ','{\"fixedAmountMinor\":500}'::jsonb,$3,clock_timestamp())", [commercialVersion, commercialRule, doctorAccount]); await target.query("INSERT INTO commercial_rule_scopes (id,commercial_rule_version_id,scope_kind,scope_reference_id) VALUES ($1,$2,'SERVICE',$3)", [scope, commercialVersion, offering]);
  return { patient, intent, reservation };
}
