import { createIdentifier } from '../../shared/identifiers/uuid.js';
import type { DatabaseHealth } from '../../infrastructure/database.js';
import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';
import { payloadHash, type CapturedPayment, type PaymentConfirmationRepository } from './payment-confirmation.js';

type Webhook = { id: string; status: string; eventType: string; payload: Record<string, unknown>; payloadHash: string };
type Context = { intentId: string; intentState: string; reservationId: string; reservationStatus: string; reservationExpiresAt: Date; handoffId: string; allocationId: string; gross: bigint; allocationCurrency: string; paymentIntentId: string; paymentStatus: string; providerOrderId: string | null; amount: bigint; currency: string; appointmentId: string | null; appointmentStatus: string | null };

/** Transaction-aware confirmation adapter. It does not call FinancialService or lifecycle services. */
export class PostgresPaymentConfirmationRepository implements PaymentConfirmationRepository {
  public constructor(private readonly database: DatabaseHealth) {}
  public async ingest(input: CapturedPayment | { providerEventId: string; providerKey: 'RAZORPAY'; eventType: string; payload: Record<string, unknown>; payloadRaw: string }): Promise<{ eventId: string; status: 'PERSISTED' | 'UNKNOWN' | 'PROCESSED' | 'RECONCILIATION_REQUIRED' }> {
    return this.database.transaction(async (db) => {
      const hash = payloadHash(input.payloadRaw);
      await db.query(`INSERT INTO provider_webhook_events (id,provider_key,provider_event_id,event_type,handler_version,status,payload,payload_raw,payload_hash,authenticated_at,persisted_at)
        VALUES ($1,$2,$3,$4,'phase5-step5.3',$5,$6::jsonb,$7,$8,current_timestamp,current_timestamp)
        ON CONFLICT (provider_key,provider_event_id) DO NOTHING`, [createIdentifier(), input.providerKey, input.providerEventId, input.eventType, input.eventType === 'payment.captured' || input.eventType === 'refund.processed' ? 'PERSISTED' : 'UNKNOWN', JSON.stringify(input.payload), input.payloadRaw, hash]);
      const row = (await db.query<Record<string, unknown>>('SELECT id,status,payload_hash FROM provider_webhook_events WHERE provider_key=$1 AND provider_event_id=$2 FOR UPDATE', [input.providerKey, input.providerEventId])).rows[0];
      if (!row || String(row.payload_hash) !== hash) {
        if (row) await this.reconcile(db, String(row.id), input.providerKey, null, 'WEBHOOK_ID_PAYLOAD_CONFLICT');
        return { eventId: row ? String(row.id) : '', status: 'RECONCILIATION_REQUIRED' };
      }
      return { eventId: String(row.id), status: String(row.status) as 'PERSISTED' | 'UNKNOWN' | 'PROCESSED' | 'RECONCILIATION_REQUIRED' };
    });
  }

  public async confirm(providerKey: 'RAZORPAY', providerEventId: string): Promise<{ status: 'CONFIRMED' | 'REPLAYED' | 'RECONCILIATION_REQUIRED' | 'IGNORED' }> {
    return this.database.transaction(async (db) => {
      const preliminary = (await db.query<Record<string, unknown>>('SELECT id,status,event_type,payload,payload_hash FROM provider_webhook_events WHERE provider_key=$1 AND provider_event_id=$2', [providerKey, providerEventId])).rows[0];
      if (!preliminary) return { status: 'IGNORED' };
      if (String(preliminary.status) === 'PROCESSED') return { status: 'REPLAYED' };
      if (String(preliminary.status) !== 'PERSISTED' || String(preliminary.event_type) !== 'payment.captured') return { status: 'IGNORED' };
      const payment = captured(preliminary.payload as Record<string, unknown>);
      if (!payment) return { status: 'IGNORED' };
      const context = await this.lockContext(db, providerKey, payment.orderId);
      const event = await this.lockEvent(db, providerKey, providerEventId); // Final lock in the hierarchy.
      if (!event || event.status === 'PROCESSED') return { status: 'REPLAYED' };
      if (!context || !valid(context, payment)) return this.reconcile(db, event.id, providerKey, context?.paymentIntentId ?? null, 'PAYMENT_CORRELATION_MISMATCH');
      if (context.paymentStatus === 'SUCCEEDED' && context.appointmentStatus === 'CONFIRMED') {
        await this.process(db, event.id); return { status: 'REPLAYED' };
      }
      if (context.paymentStatus !== 'PENDING_PROVIDER' || context.intentState !== 'PAYMENT_PENDING' || context.reservationStatus !== 'HELD' || context.reservationExpiresAt <= new Date()) return this.reconcile(db, event.id, providerKey, context.paymentIntentId, 'PAYMENT_NOT_ELIGIBLE');
      await this.processing(db, event.id);
      await db.query(`INSERT INTO payments (id,payment_intent_id,provider_key,provider_payment_id,status,currency,amount_minor,provider_fact,verified_at)
        VALUES ($1,$2,$3,$4,'SUCCEEDED',$5,$6,$7::jsonb,current_timestamp)
        ON CONFLICT (provider_key,provider_payment_id) DO NOTHING`, [createIdentifier(), context.paymentIntentId, providerKey, payment.paymentId, payment.currency, payment.amount, JSON.stringify({ paymentId: payment.paymentId, orderId: payment.orderId, amountMinor: payment.amount.toString(), currency: payment.currency, eventId: providerEventId })]);
      const fact = (await db.query<Record<string, unknown>>('SELECT id,payment_intent_id,currency,amount_minor,status FROM payments WHERE provider_key=$1 AND provider_payment_id=$2 FOR UPDATE', [providerKey, payment.paymentId])).rows[0];
      if (!fact || String(fact.payment_intent_id) !== context.paymentIntentId || String(fact.currency) !== payment.currency || BigInt(String(fact.amount_minor)) !== payment.amount || String(fact.status) !== 'SUCCEEDED') return this.reconcile(db, event.id, providerKey, context.paymentIntentId, 'PAYMENT_FACT_CONFLICT');
      await db.query(`INSERT INTO provider_references (id,provider_key,reference_type,provider_reference,internal_entity_type,internal_entity_id)
        VALUES ($1,$2,'PAYMENT',$3,'PAYMENT',$4) ON CONFLICT (provider_key,reference_type,provider_reference) DO NOTHING`, [createIdentifier(), providerKey, payment.paymentId, String(fact.id)]);
      const moved = await db.query("UPDATE payment_intents SET status='SUCCEEDED',updated_at=current_timestamp WHERE id=$1 AND status='PENDING_PROVIDER'", [context.paymentIntentId]);
      if (moved.rowCount !== 1) return this.reconcile(db, event.id, providerKey, context.paymentIntentId, 'PAYMENT_STATE_CONFLICT');
      const appointmentId = await this.appointment(db, context);
      if (!context.appointmentId) await this.createParticipants(db, appointmentId, context.intentId);
      const transitioned = await db.query("UPDATE appointments SET status='CONFIRMED' WHERE id=$1 AND status='PAYMENT_PENDING'", [appointmentId]);
      if (transitioned.rowCount !== 1) return this.reconcile(db, event.id, providerKey, context.paymentIntentId, 'APPOINTMENT_STATE_CONFLICT');
      const auditId = createIdentifier();
      await db.query(`INSERT INTO audit_events (id,category,event_type,target_type,target_id,outcome,metadata) VALUES ($1,'BUSINESS','PAYMENT_CAPTURED_APPOINTMENT_CONFIRMED','APPOINTMENT',$2,'SUCCESS','{}'::jsonb)`, [auditId, appointmentId]);
      await db.query(`INSERT INTO appointment_events (id,appointment_id,event_type,previous_status,resulting_status,context,audit_event_id) VALUES ($1,$2,'CONFIRMED','PAYMENT_PENDING','CONFIRMED',$3::jsonb,$4)`, [createIdentifier(), appointmentId, JSON.stringify({ providerEventId }), auditId]);
      await this.process(db, event.id);
      return { status: 'CONFIRMED' };
    });
  }

  /** Refund webhooks converge with the durable refund claim; no appointment lifecycle lock is needed here. */
  public async confirmRefund(providerKey: 'RAZORPAY', providerEventId: string): Promise<{ status: 'REPLAYED' | 'RECONCILIATION_REQUIRED' | 'IGNORED' }> {
    return this.database.transaction(async (db) => {
      const event = await this.lockEvent(db, providerKey, providerEventId);
      if (!event || event.status === 'PROCESSED') return { status: 'REPLAYED' };
      if (event.status !== 'PERSISTED' || event.eventType !== 'refund.processed') return { status: 'IGNORED' };
      const fact = refund(event.payload);
      if (!fact) return this.reconcileRefund(db, event.id, providerKey, null, 'REFUND_EVENT_MALFORMED');
      await this.processing(db, event.id);
      const matches = (await db.query<Record<string, unknown>>(`SELECT refund.id,refund.status,refund.provider_refund_id FROM refunds refund JOIN payments payment ON payment.id=refund.payment_id
        WHERE refund.provider_key=$1 AND payment.provider_payment_id=$2 AND refund.currency=$3 AND refund.amount_minor=$4
          AND (refund.status='PROCESSING' OR refund.provider_refund_id=$5) FOR UPDATE OF refund,payment`, [providerKey,fact.paymentId,fact.currency,fact.amount.toString(),fact.refundId])).rows;
      // An absent or ambiguous correlation is provider evidence only. Never mutate a
      // candidate refund merely because it was first in a query result.
      if (matches.length !== 1) return this.reconcileRefund(db, event.id, providerKey, null, matches.length === 0 ? 'REFUND_CORRELATION_NOT_FOUND' : 'REFUND_CORRELATION_AMBIGUOUS');
      const refundId = String(matches[0].id);
      if (String(matches[0].status)==='SUCCEEDED' && String(matches[0].provider_refund_id)===fact.refundId) { await this.process(db,event.id); return { status: 'REPLAYED' }; }
      if (matches[0].provider_refund_id && String(matches[0].provider_refund_id) !== fact.refundId) {
        return this.reconcileRefund(db, event.id, providerKey, refundId, 'REFUND_PROVIDER_FACT_CONFLICT');
      }
      const reference = (await db.query<{ internal_entity_type: string; internal_entity_id: string }>(`SELECT internal_entity_type,internal_entity_id FROM provider_references
        WHERE provider_key=$1 AND reference_type='REFUND' AND provider_reference=$2 FOR UPDATE`, [providerKey, fact.refundId])).rows[0];
      if (reference && (reference.internal_entity_type !== 'REFUND' || reference.internal_entity_id !== refundId)) {
        return this.reconcileRefund(db, event.id, providerKey, refundId, 'REFUND_PROVIDER_REFERENCE_CONFLICT');
      }
      if (!reference) {
        await db.query("INSERT INTO provider_references (id,provider_key,reference_type,provider_reference,internal_entity_type,internal_entity_id) VALUES ($1,$2,'REFUND',$3,'REFUND',$4)", [createIdentifier(),providerKey,fact.refundId,refundId]);
      }
      await db.query("UPDATE refunds SET status='SUCCEEDED',provider_refund_id=COALESCE(provider_refund_id,$2),updated_at=current_timestamp WHERE id=$1 AND status='PROCESSING'", [refundId,fact.refundId]);
      await db.query("UPDATE refund_attempts SET status='SUCCEEDED',provider_refund_id=COALESCE(provider_refund_id,$2),completed_at=current_timestamp WHERE refund_id=$1 AND status='CLAIMED'", [refundId,fact.refundId]);
      await this.process(db,event.id);
      return { status: 'REPLAYED' };
    });
  }

  private async lockContext(db: PostgresExecutor, providerKey: string, orderId: string): Promise<Context | null> {
    const initial = (await db.query<{ appointment_intent_id: string }>('SELECT handoff.appointment_intent_id FROM payment_intents payment JOIN appointment_financial_handoffs handoff ON handoff.payment_intent_id=payment.id WHERE payment.provider_key=$1 AND payment.provider_order_id=$2', [providerKey, orderId])).rows[0];
    if (!initial) return null;
    const intent = (await db.query<Record<string, unknown>>('SELECT id,state FROM appointment_intents WHERE id=$1 FOR UPDATE', [initial.appointment_intent_id])).rows[0]; if (!intent) return null;
    const reservation = (await db.query<Record<string, unknown>>('SELECT id,status,expires_at FROM slot_reservations WHERE appointment_intent_id=$1 FOR UPDATE', [initial.appointment_intent_id])).rows[0]; if (!reservation) return null;
    const handoff = (await db.query<Record<string, unknown>>(`SELECT handoff.id,handoff.payment_intent_id,handoff.financial_allocation_snapshot_id,allocation.gross_amount_minor,allocation.currency
      FROM appointment_financial_handoffs handoff JOIN financial_allocation_snapshots allocation ON allocation.id=handoff.financial_allocation_snapshot_id WHERE handoff.appointment_intent_id=$1 FOR UPDATE OF handoff`, [initial.appointment_intent_id])).rows[0]; if (!handoff) return null;
    const appointment = (await db.query<Record<string, unknown>>('SELECT id,status FROM appointments WHERE appointment_intent_id=$1 FOR UPDATE', [initial.appointment_intent_id])).rows[0];
    const pi = (await db.query<Record<string, unknown>>('SELECT id,status,provider_order_id,amount_minor,currency FROM payment_intents WHERE id=$1 FOR UPDATE', [handoff.payment_intent_id])).rows[0]; if (!pi) return null;
    return { intentId:String(intent.id),intentState:String(intent.state),reservationId:String(reservation.id),reservationStatus:String(reservation.status),reservationExpiresAt:new Date(String(reservation.expires_at)),handoffId:String(handoff.id),allocationId:String(handoff.financial_allocation_snapshot_id),gross:BigInt(String(handoff.gross_amount_minor)),allocationCurrency:String(handoff.currency),paymentIntentId:String(pi.id),paymentStatus:String(pi.status),providerOrderId:pi.provider_order_id?String(pi.provider_order_id):null,amount:BigInt(String(pi.amount_minor)),currency:String(pi.currency),appointmentId:appointment?String(appointment.id):null,appointmentStatus:appointment?String(appointment.status):null };
  }
  private async lockEvent(db: PostgresExecutor, providerKey: string, eventId: string): Promise<Webhook | null> { const row=(await db.query<Record<string, unknown>>('SELECT id,status,event_type,payload,payload_hash FROM provider_webhook_events WHERE provider_key=$1 AND provider_event_id=$2 FOR UPDATE',[providerKey,eventId])).rows[0]; return row?{id:String(row.id),status:String(row.status),eventType:String(row.event_type),payload:row.payload as Record<string,unknown>,payloadHash:String(row.payload_hash)}:null; }
  private async appointment(db: PostgresExecutor, c: Context): Promise<string> { if (c.appointmentId) return c.appointmentId; const id=createIdentifier(); await db.query(`INSERT INTO appointments (id,appointment_intent_id,slot_reservation_id,appointment_financial_handoff_id,financial_allocation_snapshot_id,payment_intent_id,patient_account_id,booking_actor_account_id,booking_tenant_id,provider_doctor_profile_id,provider_clinic_id,service_exposure_id,service_offering_id,service_offering_version_id,service_offering_price_id,currency,price_amount_minor,provider_timezone,requested_local_at,starts_at,ends_at,service_duration_seconds,buffer_before_seconds,buffer_after_seconds,hold_seconds,status)
    SELECT $1,intent.id,reservation.id,handoff.id,handoff.financial_allocation_snapshot_id,payment.id,intent.patient_account_id,intent.booking_actor_account_id,intent.booking_tenant_id,intent.provider_doctor_profile_id,intent.provider_clinic_id,intent.service_exposure_id,intent.service_offering_id,intent.service_offering_version_id,intent.service_offering_price_id,intent.currency,intent.price_amount_minor,intent.provider_timezone,intent.requested_local_at,intent.starts_at,intent.ends_at,intent.service_duration_seconds,intent.buffer_before_seconds,intent.buffer_after_seconds,intent.hold_seconds,'PAYMENT_PENDING'
    FROM appointment_intents intent JOIN slot_reservations reservation ON reservation.appointment_intent_id=intent.id JOIN appointment_financial_handoffs handoff ON handoff.appointment_intent_id=intent.id JOIN payment_intents payment ON payment.id=handoff.payment_intent_id WHERE intent.id=$2`,[id,c.intentId]); return id; }
  /** Inserts immutable, context-derived evidence within the existing confirmation transaction. */
  private async createParticipants(db: PostgresExecutor, appointmentId: string, intentId: string): Promise<void> {
    const patient = await db.query(`INSERT INTO appointment_participants (id,appointment_id,participant_type,patient_profile_id)
      SELECT $1,$2,'PATIENT',profile.id FROM appointment_intents intent
      JOIN patient_profiles profile ON profile.account_id=intent.patient_account_id
      WHERE intent.id=$3`, [createIdentifier(), appointmentId, intentId]);
    if (patient.rowCount !== 1) throw new Error('appointment patient participant context is missing');
    const doctor = await db.query(`INSERT INTO appointment_participants (id,appointment_id,participant_type,doctor_profile_id)
      SELECT $1,$2,'DOCTOR',intent.provider_doctor_profile_id FROM appointment_intents intent
      WHERE intent.id=$3 AND intent.provider_doctor_profile_id IS NOT NULL`, [createIdentifier(), appointmentId, intentId]);
    const clinic = await db.query(`INSERT INTO appointment_participants (id,appointment_id,participant_type,clinic_id,tenant_id)
      SELECT $1,$2,'CLINIC',clinic.id,clinic.tenant_id FROM appointment_intents intent
      JOIN clinics clinic ON clinic.id=intent.provider_clinic_id
      WHERE intent.id=$3 AND intent.provider_clinic_id IS NOT NULL`, [createIdentifier(), appointmentId, intentId]);
    if ((doctor.rowCount ?? 0) + (clinic.rowCount ?? 0) !== 1) throw new Error('appointment provider participant context is missing');
  }
  private async processing(db: PostgresExecutor,id:string){ await db.query("UPDATE provider_webhook_events SET status='PROCESSING',processing_started_at=current_timestamp WHERE id=$1 AND status='PERSISTED'",[id]); }
  private async process(db: PostgresExecutor,id:string){ await db.query("UPDATE provider_webhook_events SET status='PROCESSED',processed_at=current_timestamp WHERE id=$1 AND status='PROCESSING'",[id]); }
  private async reconcile(db: PostgresExecutor,eventId:string,key:string,paymentIntentId:string|null,reason:string):Promise<{status:'RECONCILIATION_REQUIRED'}>{ await this.processing(db,eventId); await db.query("UPDATE provider_webhook_events SET status='RECONCILIATION_REQUIRED',reconciliation_required_at=current_timestamp WHERE id=$1 AND status='PROCESSING'",[eventId]); if(paymentIntentId) await db.query("UPDATE payment_intents SET status='RECONCILIATION_REQUIRED',reconciliation_required_at=current_timestamp WHERE id=$1 AND status='PENDING_PROVIDER'",[paymentIntentId]); await db.query(`INSERT INTO reconciliation_records (id,status,provider_key,provider_webhook_event_id,internal_entity_type,internal_entity_id,discrepancy_data) VALUES ($1,'MANUAL_REVIEW',$2,$3,'PAYMENT_INTENT',$4,$5::jsonb)`,[createIdentifier(),key,eventId,paymentIntentId,JSON.stringify({reason})]); return {status:'RECONCILIATION_REQUIRED'}; }
  private async reconcileRefund(db: PostgresExecutor,eventId:string,key:string,refundId:string|null,reason:string):Promise<{status:'RECONCILIATION_REQUIRED'}>{ await this.processing(db,eventId); await db.query("UPDATE provider_webhook_events SET status='RECONCILIATION_REQUIRED',reconciliation_required_at=current_timestamp WHERE id=$1 AND status='PROCESSING'",[eventId]); if(refundId) await db.query("UPDATE refunds SET status='RECONCILIATION_REQUIRED',updated_at=current_timestamp WHERE id=$1 AND status='PROCESSING'",[refundId]); await db.query(`INSERT INTO reconciliation_records (id,status,provider_key,provider_webhook_event_id,internal_entity_type,internal_entity_id,discrepancy_data) VALUES ($1,'MANUAL_REVIEW',$2,$3,'REFUND',$4,$5::jsonb)`,[createIdentifier(),key,eventId,refundId,JSON.stringify({reason})]); return {status:'RECONCILIATION_REQUIRED'}; }
}
function captured(payload:Record<string,unknown>):{paymentId:string;orderId:string;amount:bigint;currency:string}|null { try { const p=(payload.payload as Record<string,unknown>).payment as Record<string,unknown>; const e=p.entity as Record<string,unknown>; const amount=e.amount; if(typeof e.id!=='string'||typeof e.order_id!=='string'||typeof e.currency!=='string'||typeof amount!=='number'||!Number.isSafeInteger(amount)||amount<0||e.status!=='captured')return null; return {paymentId:e.id,orderId:e.order_id,amount:BigInt(amount),currency:e.currency}; } catch{return null;} }
function refund(payload:Record<string,unknown>):{refundId:string;paymentId:string;amount:bigint;currency:string}|null { try { const entity=(((payload.payload as Record<string,unknown>).refund as Record<string,unknown>).entity) as Record<string,unknown>; const amount=entity.amount; if(typeof entity.id!=='string'||typeof entity.payment_id!=='string'||typeof entity.currency!=='string'||typeof amount!=='number'||!Number.isSafeInteger(amount)||amount<0||entity.status!=='processed') return null; return {refundId:entity.id,paymentId:entity.payment_id,amount:BigInt(amount),currency:entity.currency}; } catch { return null; } }
function valid(c:Context,p:{orderId:string;amount:bigint;currency:string}){return c.providerOrderId===p.orderId&&c.amount===p.amount&&c.gross===p.amount&&c.currency===p.currency&&c.allocationCurrency===p.currency;}
