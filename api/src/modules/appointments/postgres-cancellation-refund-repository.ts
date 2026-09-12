import { createIdentifier } from '../../shared/identifiers/uuid.js';
import type { DatabaseHealth } from '../../infrastructure/database.js';
import type { AuditEventInput } from '../audit/audit.js';
import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';
import type { AppointmentStatus } from './appointment-foundation.js';
import type { CancellationContext, CancellationDecision, CancellationRepository, RefundExecutionRepository, RefundOutcome, RefundPolicy, SettlementConsequence } from './cancellation-refunds.js';

export class PostgresCancellationRefundRepository implements CancellationRepository, RefundExecutionRepository {
  public constructor(private readonly database: DatabaseHealth) {}
  public transaction<T>(operation: (database: PostgresExecutor) => Promise<T>) { return this.database.transaction(operation); }

  /** Locks the common lifecycle prefix sequentially: Intent → Reservation → Handoff → Appointment → Payment Intent → Payment. */
  public async lockCancellationContext(database: PostgresExecutor, appointmentId: string): Promise<CancellationContext | null> {
    const identity = (await database.query<Record<string, unknown>>('SELECT appointment_intent_id FROM appointments WHERE id=$1', [appointmentId])).rows[0];
    if (!identity) return null;
    const intent = (await database.query<Record<string, unknown>>('SELECT id FROM appointment_intents WHERE id=$1 FOR UPDATE', [identity.appointment_intent_id])).rows[0];
    if (!intent) return null;
    const reservation = (await database.query<Record<string, unknown>>('SELECT id,status FROM slot_reservations WHERE appointment_intent_id=$1 FOR UPDATE', [intent.id])).rows[0];
    if (!reservation) return null;
    const handoff = (await database.query<Record<string, unknown>>('SELECT id,payment_intent_id,financial_allocation_snapshot_id FROM appointment_financial_handoffs WHERE appointment_intent_id=$1 FOR UPDATE', [intent.id])).rows[0];
    if (!handoff) return null;
    const appointment = (await database.query<Record<string, unknown>>(`SELECT id,status,starts_at,appointment_intent_id,slot_reservation_id,appointment_financial_handoff_id,financial_allocation_snapshot_id,service_offering_id,payment_intent_id
      FROM appointments WHERE id=$1 AND appointment_intent_id=$2 AND slot_reservation_id=$3 AND appointment_financial_handoff_id=$4 AND financial_allocation_snapshot_id=$5 AND payment_intent_id=$6 FOR UPDATE`, [appointmentId, intent.id, reservation.id, handoff.id, handoff.financial_allocation_snapshot_id, handoff.payment_intent_id])).rows[0];
    if (!appointment) return null;
    const paymentIntent = (await database.query<Record<string, unknown>>('SELECT id,provider_key FROM payment_intents WHERE id=$1 FOR UPDATE', [handoff.payment_intent_id])).rows[0];
    if (!paymentIntent) return null;
    const allocation = (await database.query<Record<string, unknown>>('SELECT id,currency FROM financial_allocation_snapshots WHERE id=$1', [handoff.financial_allocation_snapshot_id])).rows[0];
    if (!allocation) return null;
    const payment = (await database.query<Record<string, unknown>>(`SELECT id,status,amount_minor,currency,provider_key,provider_payment_id
      FROM payments WHERE payment_intent_id=$1 ORDER BY created_at,id FOR UPDATE`, [paymentIntent.id])).rows[0];
    return {
      appointmentId: String(appointment.id), appointmentStatus: appointment.status as AppointmentStatus, appointmentStartsAt: new Date(String(appointment.starts_at)),
      appointmentIntentId: String(appointment.appointment_intent_id), reservationId: String(appointment.slot_reservation_id),
      reservationStatus: reservation.status as 'HELD' | 'RELEASED' | 'EXPIRED',
      handoffId: String(appointment.appointment_financial_handoff_id), allocationSnapshotId: String(appointment.financial_allocation_snapshot_id),
      serviceOfferingId: String(appointment.service_offering_id), providerKey: String(paymentIntent.provider_key), currency: String(allocation.currency),
      payment: payment ? { id: String(payment.id), status: String(payment.status), amountMinor: BigInt(String(payment.amount_minor)), currency: String(payment.currency), providerKey: String(payment.provider_key) } : null,
    };
  }

  public async findCancellation(database: PostgresExecutor, appointmentId: string): Promise<CancellationDecision | null> {
    const row = (await database.query<Record<string, unknown>>('SELECT * FROM appointment_cancellation_decisions WHERE appointment_id=$1 FOR UPDATE', [appointmentId])).rows[0];
    return row ? decision(row) : null;
  }
  public async selectRefundPolicies(database: PostgresExecutor, input: { at: Date; providerKey: string; serviceOfferingId: string }): Promise<RefundPolicy[]> {
    const result = await database.query<Record<string, unknown>>(`
      SELECT version.id,version.priority,version.policy_data,scope.scope_kind,
        CASE scope.scope_kind WHEN 'SERVICE_PROVIDER' THEN 3 WHEN 'SERVICE' THEN 2 WHEN 'PROVIDER' THEN 1 ELSE 0 END AS specificity
      FROM refund_policy_versions version
      LEFT JOIN refund_policy_scopes scope ON scope.refund_policy_version_id=version.id
      WHERE version.status='APPROVED' AND version.effective_from <= $1 AND (version.effective_until IS NULL OR version.effective_until > $1)
        AND (
          scope.id IS NULL OR scope.scope_kind='GLOBAL' OR
          (scope.scope_kind='PROVIDER' AND scope.provider_key=$2) OR
          (scope.scope_kind='SERVICE' AND scope.service_offering_id=$3) OR
          (scope.scope_kind='SERVICE_PROVIDER' AND scope.provider_key=$2 AND scope.service_offering_id=$3)
        )
      FOR UPDATE OF version
    `, [input.at, input.providerKey, input.serviceOfferingId]);
    return result.rows.map((row) => ({ id: String(row.id), priority: Number(row.priority), specificity: Number(row.specificity), data: row.policy_data as RefundPolicy['data'] }));
  }
  public async transitionAppointment(database: PostgresExecutor, appointmentId: string, from: AppointmentStatus, to: 'CANCELLED'): Promise<boolean> {
    return (await database.query('UPDATE appointments SET status=$3 WHERE id=$1 AND status=$2', [appointmentId, from, to])).rowCount === 1;
  }
  public async releaseReservation(database: PostgresExecutor, reservationId: string, at: Date): Promise<boolean> {
    return (await database.query("UPDATE slot_reservations SET status='RELEASED',released_at=$2 WHERE id=$1 AND status='HELD'", [reservationId, at])).rowCount === 1;
  }
  public async deriveSettlementConsequence(database: PostgresExecutor, allocationSnapshotId: string): Promise<SettlementConsequence> {
    const rows = (await database.query<{ status: string }>('SELECT status FROM settlements WHERE allocation_snapshot_id=$1 FOR UPDATE', [allocationSnapshotId])).rows;
    // Phase 4 has no approved cancellation settlement-policy field. Preserve historical
    // settlement rows and route every existing settlement relationship to reconciliation.
    return rows.length ? 'RECONCILIATION_REQUIRED' : 'NONE';
  }
  public async appendAudit(database: PostgresExecutor, event: AuditEventInput): Promise<string> {
    const id = createIdentifier();
    await database.query('INSERT INTO audit_events (id,category,event_type,actor_account_id,tenant_id,target_type,target_id,outcome,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)', [id,event.category,event.eventType,event.actorAccountId ?? null,event.tenantId ?? null,event.targetType,event.targetId ?? null,event.outcome,JSON.stringify(event.metadata ?? {})]);
    return id;
  }
  public async appendAppointmentEvent(database: PostgresExecutor, event: { id: string; appointmentId: string; actorAccountId: string; previousStatus: AppointmentStatus; reason: string; context: Record<string, string | number | boolean | null>; auditEventId: string }): Promise<void> {
    await database.query("INSERT INTO appointment_events (id,appointment_id,event_type,actor_account_id,previous_status,resulting_status,reason,context,audit_event_id) VALUES ($1,$2,'CANCELLED',$3,$4,'CANCELLED',$5,$6::jsonb,$7)", [event.id,event.appointmentId,event.actorAccountId,event.previousStatus,event.reason,JSON.stringify(event.context),event.auditEventId]);
  }
  public async createDecision(database: PostgresExecutor, value: CancellationDecision & { reason: string; authorizationContext: Record<string, string | number | boolean | null>; at: Date; auditEventId: string }): Promise<void> {
    await database.query(`INSERT INTO appointment_cancellation_decisions
      (id,appointment_id,slot_reservation_id,financial_allocation_snapshot_id,payment_id,actor_account_id,previous_appointment_status,resulting_appointment_status,reason_category,authorization_context,cancellation_at,refund_policy_version_id,refund_outcome,refund_amount_minor,currency,capacity_released,settlement_consequence,idempotency_key,request_fingerprint,audit_event_id)
      VALUES ($1,$2,(SELECT slot_reservation_id FROM appointments WHERE id=$2),$3,$4,$5,$6,'CANCELLED',$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [value.id,value.appointmentId,value.allocationSnapshotId,value.paymentId,value.actorAccountId,value.previousStatus,value.reason,JSON.stringify(value.authorizationContext),value.at,value.refundPolicyVersionId,value.refundOutcome,value.refundAmountMinor.toString(),value.currency,value.capacityReleased,value.settlementConsequence,value.idempotencyKey,value.requestFingerprint,value.auditEventId]);
  }
  public async createRefund(database: PostgresExecutor, input: { id: string; decisionId: string; paymentId: string; allocationSnapshotId: string; providerKey: string; currency: string; amountMinor: bigint; idempotencyKey: string; policyVersionId: string; actorAccountId: string }): Promise<void> {
    await database.query("INSERT INTO refunds (id,payment_id,allocation_snapshot_id,appointment_cancellation_decision_id,provider_key,status,currency,amount_minor,idempotency_key,refund_policy_version_id,created_by_account_id) VALUES ($1,$2,$3,$4,$5,'REQUESTED',$6,$7,$8,$9,$10)", [input.id,input.paymentId,input.allocationSnapshotId,input.decisionId,input.providerKey,input.currency,input.amountMinor.toString(),input.idempotencyKey,input.policyVersionId,input.actorAccountId]);
  }
  public async createFinancialConsequence(database: PostgresExecutor, input: { id: string; decisionId: string; allocationSnapshotId: string; refundId: string | null; outcome: RefundOutcome; amountMinor: bigint; currency: string; settlementConsequence: SettlementConsequence }): Promise<void> {
    await database.query('INSERT INTO appointment_cancellation_financial_consequences (id,appointment_cancellation_decision_id,financial_allocation_snapshot_id,refund_id,consequence_status,amount_minor,currency,settlement_consequence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [input.id,input.decisionId,input.allocationSnapshotId,input.refundId,input.outcome,input.amountMinor.toString(),input.currency,input.settlementConsequence]);
  }

  public async claimRefund(database: PostgresExecutor, refundId: string): Promise<{ refund: { id: string; status: string; paymentProviderId: string; providerKey: string; idempotencyKey: string; amountMinor: bigint; currency: string }; attempt: { id: string; attemptNumber: number } | null } | null> {
    const row = (await database.query<Record<string, unknown>>(`SELECT refund.id,refund.status,refund.provider_key,refund.idempotency_key,refund.amount_minor,refund.currency,payment.provider_payment_id
      FROM refunds refund JOIN payments payment ON payment.id=refund.payment_id WHERE refund.id=$1 FOR UPDATE OF refund,payment`, [refundId])).rows[0];
    if (!row) return null;
    const refund = { id: String(row.id), status: String(row.status), paymentProviderId: String(row.provider_payment_id), providerKey: String(row.provider_key), idempotencyKey: String(row.idempotency_key), amountMinor: BigInt(String(row.amount_minor)), currency: String(row.currency) };
    if (refund.status !== 'REQUESTED') return { refund, attempt: null };
    // The refund row above is already locked, serializing attempt-number allocation.
    const attemptNumber = Number((await database.query<{ value: string }>('SELECT COALESCE(MAX(attempt_number),0)+1 AS value FROM refund_attempts WHERE refund_id=$1', [refundId])).rows[0]?.value ?? 1);
    const id = createIdentifier();
    await database.query("UPDATE refunds SET status='PROCESSING',updated_at=current_timestamp WHERE id=$1 AND status='REQUESTED'", [refundId]);
    await database.query("INSERT INTO refund_attempts (id,refund_id,attempt_number,status,provider_key,idempotency_key) VALUES ($1,$2,$3,'CLAIMED',$4,$5)", [id,refundId,attemptNumber,refund.providerKey,`${refund.idempotencyKey}:attempt:${attemptNumber}`]);
    return { refund: { ...refund, status: 'PROCESSING' }, attempt: { id, attemptNumber } };
  }
  public async finalizeRefund(database: PostgresExecutor, input: { refundId: string; attemptId: string; status: 'SUCCEEDED' | 'FAILED' | 'RECONCILIATION_REQUIRED'; providerRefundId?: string; failureCode?: string }): Promise<'SUCCEEDED' | 'FAILED' | 'RECONCILIATION_REQUIRED'> {
    const refund = (await database.query<{ status: string; provider_key: string; provider_refund_id: string | null }>('SELECT status,provider_key,provider_refund_id FROM refunds WHERE id=$1 FOR UPDATE', [input.refundId])).rows[0];
    if (!refund || refund.status !== 'PROCESSING') return 'RECONCILIATION_REQUIRED';
    let status = input.status;
    let providerRefundId = input.providerRefundId;
    let failureCode = input.failureCode;
    if (providerRefundId && refund.provider_refund_id && refund.provider_refund_id !== providerRefundId) {
      status = 'RECONCILIATION_REQUIRED'; providerRefundId = undefined; failureCode = 'PROVIDER_FACT_CONFLICT';
    } else if (providerRefundId) {
      const reference = (await database.query<{ internal_entity_type: string; internal_entity_id: string }>(`SELECT internal_entity_type,internal_entity_id FROM provider_references
        WHERE provider_key=$1 AND reference_type='REFUND' AND provider_reference=$2 FOR UPDATE`, [refund.provider_key, providerRefundId])).rows[0];
      if (reference && (reference.internal_entity_type !== 'REFUND' || reference.internal_entity_id !== input.refundId)) {
        status = 'RECONCILIATION_REQUIRED'; providerRefundId = undefined; failureCode = 'PROVIDER_REFERENCE_CONFLICT';
      } else if (!reference) {
        await database.query("INSERT INTO provider_references (id,provider_key,reference_type,provider_reference,internal_entity_type,internal_entity_id) VALUES ($1,$2,'REFUND',$3,'REFUND',$4)", [createIdentifier(), refund.provider_key, providerRefundId, input.refundId]);
      }
    }
    await database.query('UPDATE refunds SET status=$2,provider_refund_id=COALESCE(provider_refund_id,$3),updated_at=current_timestamp WHERE id=$1', [input.refundId,status,providerRefundId ?? null]);
    await database.query('UPDATE refund_attempts SET status=$2,provider_refund_id=COALESCE(provider_refund_id,$3),failure_code=$4,completed_at=current_timestamp,reconciliation_required_at=CASE WHEN $2=\'RECONCILIATION_REQUIRED\' THEN current_timestamp ELSE NULL END WHERE id=$1 AND status=\'CLAIMED\'', [input.attemptId,status,providerRefundId ?? null,failureCode ?? null]);
    return status;
  }
}

function decision(row: Record<string, unknown>): CancellationDecision {
  return { id:String(row.id),appointmentId:String(row.appointment_id),actorAccountId:String(row.actor_account_id),idempotencyKey:String(row.idempotency_key),requestFingerprint:String(row.request_fingerprint),previousStatus:row.previous_appointment_status as AppointmentStatus,allocationSnapshotId:String(row.financial_allocation_snapshot_id),paymentId:row.payment_id ? String(row.payment_id) : null,refundOutcome:row.refund_outcome as RefundOutcome,refundAmountMinor:BigInt(String(row.refund_amount_minor)),currency:String(row.currency),capacityReleased:Boolean(row.capacity_released),settlementConsequence:row.settlement_consequence as SettlementConsequence,refundPolicyVersionId:String(row.refund_policy_version_id),refundId:null };
}
