import { createIdentifier } from '../../shared/identifiers/uuid.js';
import type { DatabaseHealth } from '../../infrastructure/database.js';
import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';
import { PaymentOrderProvisioningError, type PaymentOrderProvisioningRepository, providerReceipt, newClaimToken, type ProvisioningAttempt, type ProvisioningClaim } from './payment-order-provisioning.js';
import type { ProviderOrder } from '../financial/provider.js';

type Context = {
  intentId: string; patientAccountId: string; bookingActorAccountId: string; intentState: string;
  reservationId: string; reservationStatus: string; reservationExpiresAt: Date;
  handoffId: string; allocationId: string; allocationStatus: string; allocationAmountMinor: bigint; allocationCurrency: string;
  paymentIntentId: string; providerKey: string; paymentStatus: string; paymentOrderId: string | null; paymentAmountMinor: bigint; paymentCurrency: string;
};

export class PostgresPaymentOrderProvisioningRepository implements PaymentOrderProvisioningRepository {
  public constructor(private readonly database: DatabaseHealth) {}

  public async claim(accountId: string, appointmentIntentId: string, leaseSeconds: number, now: Date): Promise<ProvisioningClaim> {
    return this.database.transaction(async (database) => {
      const context = await this.lockContext(database, appointmentIntentId);
      if (!context || context.patientAccountId !== accountId || context.bookingActorAccountId !== accountId) throw new PaymentOrderProvisioningError('UNAUTHORIZED');
      if (!eligible(context, now)) throw new PaymentOrderProvisioningError('CONFLICT');
      if (context.paymentStatus === 'PENDING_PROVIDER' && context.paymentOrderId) return { kind: 'PENDING_PROVIDER', paymentIntentId: context.paymentIntentId, providerOrderId: context.paymentOrderId, amountMinor: context.paymentAmountMinor, currency: context.paymentCurrency };
      if (context.paymentStatus !== 'CREATED' || context.paymentOrderId) throw new PaymentOrderProvisioningError('CONFLICT');

      let attempt = await this.lockAttempt(database, context.paymentIntentId);
      if (!attempt) {
        const receipt = providerReceipt(context.paymentIntentId);
        await database.query(`INSERT INTO payment_order_provisioning_attempts
          (id,payment_intent_id,provider_key,provider_receipt,status,attempt_count)
          VALUES ($1,$2,$3,$4,'READY',0)`, [createIdentifier(), context.paymentIntentId, context.providerKey, receipt]);
        attempt = await this.lockAttempt(database, context.paymentIntentId);
      }
      if (!attempt) throw new PaymentOrderProvisioningError('CONFLICT');
      if (attempt.status === 'RECONCILIATION_REQUIRED') return { kind: 'RECONCILIATION_REQUIRED', paymentIntentId: context.paymentIntentId };
      if (attempt.status === 'FINALIZED') throw new PaymentOrderProvisioningError('CONFLICT');
      if (attempt.status === 'CLAIMED' && attempt.leaseExpiresAt && attempt.leaseExpiresAt > now) return { kind: 'PROCESSING', paymentIntentId: context.paymentIntentId };
      const token = newClaimToken();
      const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1_000);
      const claimed = await database.query(`UPDATE payment_order_provisioning_attempts
        SET status='CLAIMED',claim_token=$2,lease_expires_at=$3,attempt_count=attempt_count+1,updated_at=current_timestamp
        WHERE id=$1 AND (status='READY' OR (status='CLAIMED' AND lease_expires_at <= $4))`, [attempt.id, token, leaseExpiresAt, now]);
      if (claimed.rowCount !== 1) return { kind: 'PROCESSING', paymentIntentId: context.paymentIntentId };
      await this.audit(database, 'PAYMENT_ORDER_PROVISIONING_CLAIMED', context.paymentIntentId, 'SUCCESS');
      return { kind: 'CLAIMED', paymentIntentId: context.paymentIntentId, receipt: attempt.receipt, claimToken: token, amountMinor: context.paymentAmountMinor, currency: context.paymentCurrency };
    });
  }

  public async finalize(input: { accountId: string; paymentIntentId: string; claimToken: string; order: ProviderOrder; now: Date }): Promise<{ providerOrderId: string; amountMinor: bigint; currency: string }> {
    return this.database.transaction(async (database) => {
      const context = await this.lockContextByPaymentIntent(database, input.paymentIntentId);
      if (!context || context.patientAccountId !== input.accountId || context.bookingActorAccountId !== input.accountId || !eligible(context, input.now)) throw new PaymentOrderProvisioningError('CONFLICT');
      const attempt = await this.lockAttempt(database, context.paymentIntentId);
      if (!attempt || attempt.status !== 'CLAIMED' || attempt.claimToken !== input.claimToken || !attempt.leaseExpiresAt || attempt.leaseExpiresAt <= input.now) throw new PaymentOrderProvisioningError('CONFLICT');
      if (context.paymentStatus === 'PENDING_PROVIDER' && context.paymentOrderId === input.order.providerOrderId) return { providerOrderId: context.paymentOrderId, amountMinor: context.paymentAmountMinor, currency: context.paymentCurrency };
      if (context.paymentStatus !== 'CREATED' || context.paymentOrderId || input.order.receipt !== attempt.receipt || input.order.amountMinor !== context.paymentAmountMinor || input.order.currency !== context.paymentCurrency || context.providerKey !== 'RAZORPAY') {
        throw new PaymentOrderProvisioningError('CONFLICT');
      }
      await database.query(`INSERT INTO provider_references
        (id,provider_key,reference_type,provider_reference,internal_entity_type,internal_entity_id)
        VALUES ($1,$2,'ORDER',$3,'PAYMENT_INTENT',$4)
        ON CONFLICT (provider_key,reference_type,provider_reference) DO NOTHING`, [createIdentifier(), context.providerKey, input.order.providerOrderId, context.paymentIntentId]);
      const reference = await database.query<{ internal_entity_type: string; internal_entity_id: string }>(`SELECT internal_entity_type,internal_entity_id FROM provider_references
        WHERE provider_key=$1 AND reference_type='ORDER' AND provider_reference=$2 FOR UPDATE`, [context.providerKey, input.order.providerOrderId]);
      if (reference.rowCount !== 1 || reference.rows[0]?.internal_entity_type !== 'PAYMENT_INTENT' || reference.rows[0]?.internal_entity_id !== context.paymentIntentId) {
        throw new PaymentOrderProvisioningError('CONFLICT');
      }
      const payment = await database.query(`UPDATE payment_intents SET provider_order_id=$2,status='PENDING_PROVIDER',updated_at=current_timestamp
        WHERE id=$1 AND status='CREATED' AND provider_order_id IS NULL`, [context.paymentIntentId, input.order.providerOrderId]);
      if (payment.rowCount !== 1) throw new PaymentOrderProvisioningError('CONFLICT');
      await database.query(`UPDATE payment_order_provisioning_attempts SET status='FINALIZED',claim_token=NULL,lease_expires_at=NULL,finalized_at=current_timestamp,updated_at=current_timestamp
        WHERE id=$1 AND status='CLAIMED' AND claim_token=$2`, [attempt.id, input.claimToken]);
      await this.audit(database, 'PAYMENT_ORDER_PROVISIONED', context.paymentIntentId, 'SUCCESS');
      return { providerOrderId: input.order.providerOrderId, amountMinor: context.paymentAmountMinor, currency: context.paymentCurrency };
    });
  }

  public async reconcile(input: { paymentIntentId: string; claimToken: string; reason: string; now: Date }): Promise<void> {
    await this.database.transaction(async (database) => {
      const context = await this.lockContextByPaymentIntent(database, input.paymentIntentId);
      const attempt = await this.lockAttempt(database, input.paymentIntentId);
      if (!attempt || attempt.status !== 'CLAIMED' || attempt.claimToken !== input.claimToken) return;
      await database.query(`UPDATE payment_order_provisioning_attempts SET status='RECONCILIATION_REQUIRED',claim_token=NULL,lease_expires_at=NULL,reconciliation_details=$2::jsonb,updated_at=current_timestamp
        WHERE id=$1 AND claim_token=$3`, [attempt.id, JSON.stringify({ reason: input.reason }), input.claimToken]);
      await database.query(`INSERT INTO reconciliation_records
        (id,status,provider_key,internal_entity_type,internal_entity_id,discrepancy_data)
        VALUES ($1,'MANUAL_REVIEW',$2,'PAYMENT_INTENT',$3,$4::jsonb)`, [createIdentifier(), context?.providerKey ?? attempt.providerKey, input.paymentIntentId, JSON.stringify({ reason: input.reason })]);
      await this.audit(database, 'PAYMENT_ORDER_PROVISIONING_RECONCILIATION_REQUIRED', input.paymentIntentId, 'FAILURE');
    });
  }

  private async lockContext(database: PostgresExecutor, appointmentIntentId: string): Promise<Context | null> {
    const intent = (await database.query<Record<string, unknown>>('SELECT id,patient_account_id,booking_actor_account_id,state FROM appointment_intents WHERE id=$1 FOR UPDATE', [appointmentIntentId])).rows[0];
    if (!intent) return null;
    const reservation = (await database.query<Record<string, unknown>>('SELECT id,status,expires_at FROM slot_reservations WHERE appointment_intent_id=$1 FOR UPDATE', [appointmentIntentId])).rows[0];
    if (!reservation) return null;
    const handoff = (await database.query<Record<string, unknown>>(`SELECT handoff.id,handoff.financial_allocation_snapshot_id,handoff.payment_intent_id,allocation.status AS allocation_status,allocation.gross_amount_minor,allocation.currency AS allocation_currency
      FROM appointment_financial_handoffs handoff JOIN financial_allocation_snapshots allocation ON allocation.id=handoff.financial_allocation_snapshot_id
      WHERE handoff.appointment_intent_id=$1 FOR UPDATE OF handoff`, [appointmentIntentId])).rows[0];
    if (!handoff) return null;
    const payment = (await database.query<Record<string, unknown>>('SELECT id,provider_key,status,provider_order_id,amount_minor,currency FROM payment_intents WHERE id=$1 FOR UPDATE', [handoff.payment_intent_id])).rows[0];
    if (!payment) return null;
    return context(intent, reservation, handoff, payment);
  }
  private async lockContextByPaymentIntent(database: PostgresExecutor, paymentIntentId: string): Promise<Context | null> {
    const row = (await database.query<{ appointment_intent_id: string }>('SELECT appointment_intent_id FROM appointment_financial_handoffs WHERE payment_intent_id=$1', [paymentIntentId])).rows[0];
    return row ? this.lockContext(database, row.appointment_intent_id) : null;
  }
  private async lockAttempt(database: PostgresExecutor, paymentIntentId: string): Promise<ProvisioningAttempt | null> {
    const row = (await database.query<Record<string, unknown>>('SELECT id,payment_intent_id,provider_key,provider_receipt,status,claim_token,lease_expires_at FROM payment_order_provisioning_attempts WHERE payment_intent_id=$1 FOR UPDATE', [paymentIntentId])).rows[0];
    return row ? { id: String(row.id), paymentIntentId: String(row.payment_intent_id), providerKey: String(row.provider_key), receipt: String(row.provider_receipt), status: row.status as ProvisioningAttempt['status'], claimToken: row.claim_token ? String(row.claim_token) : null, leaseExpiresAt: row.lease_expires_at ? new Date(String(row.lease_expires_at)) : null } : null;
  }
  private async audit(database: PostgresExecutor, eventType: string, targetId: string, outcome: 'SUCCESS' | 'FAILURE'): Promise<void> {
    await database.query('INSERT INTO audit_events (id,category,event_type,target_type,target_id,outcome,metadata) VALUES ($1,\'BUSINESS\',$2,\'PAYMENT_INTENT\',$3,$4,$5::jsonb)', [createIdentifier(), eventType, targetId, outcome, JSON.stringify({})]);
  }
}

function eligible(context: Context, now: Date): boolean {
  return context.intentState === 'PAYMENT_PENDING' && context.reservationStatus === 'HELD' && context.reservationExpiresAt > now
    && context.allocationStatus === 'FINAL' && context.allocationAmountMinor === context.paymentAmountMinor && context.allocationCurrency === context.paymentCurrency;
}
function context(intent: Record<string, unknown>, reservation: Record<string, unknown>, handoff: Record<string, unknown>, payment: Record<string, unknown>): Context {
  return { intentId: String(intent.id), patientAccountId: String(intent.patient_account_id), bookingActorAccountId: String(intent.booking_actor_account_id), intentState: String(intent.state), reservationId: String(reservation.id), reservationStatus: String(reservation.status), reservationExpiresAt: new Date(String(reservation.expires_at)), handoffId: String(handoff.id), allocationId: String(handoff.financial_allocation_snapshot_id), allocationStatus: String(handoff.allocation_status), allocationAmountMinor: BigInt(String(handoff.gross_amount_minor)), allocationCurrency: String(handoff.allocation_currency), paymentIntentId: String(payment.id), providerKey: String(payment.provider_key), paymentStatus: String(payment.status), paymentOrderId: payment.provider_order_id ? String(payment.provider_order_id) : null, paymentAmountMinor: BigInt(String(payment.amount_minor)), paymentCurrency: String(payment.currency) };
}
