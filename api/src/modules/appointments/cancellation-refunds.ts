import { createIdentifier } from '../../shared/identifiers/uuid.js';
import type { AuditEventInput } from '../audit/audit.js';
import type { PaymentProvider } from '../financial/provider.js';
import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';
import type { AppointmentAuthorizationService } from './appointment-authorization.js';
import type { AppointmentStatus } from './appointment-foundation.js';

export type RefundOutcome = 'NO_REFUND' | 'REFUND_REQUESTED' | 'RECONCILIATION_REQUIRED';
export type SettlementConsequence = 'NONE' | 'ON_HOLD' | 'RECONCILIATION_REQUIRED';
export type RefundMode = 'NONE' | 'FULL' | 'PERCENTAGE';

export interface RefundPolicyData {
  refundOutcome: RefundMode;
  refundBasis: 'PAYMENT_AMOUNT';
  cancellationWindowSeconds: number;
  paymentStates: readonly string[];
  allowInProgress: boolean;
  percentageBps?: number;
}
export interface RefundPolicy { id: string; priority: number; specificity: number; data: RefundPolicyData; }
export interface CancellationContext {
  appointmentId: string;
  appointmentStatus: AppointmentStatus;
  appointmentStartsAt: Date;
  appointmentIntentId: string;
  reservationId: string;
  reservationStatus: 'HELD' | 'RELEASED' | 'EXPIRED';
  handoffId: string;
  allocationSnapshotId: string;
  serviceOfferingId: string;
  providerKey: string;
  currency: string;
  payment: { id: string; status: string; amountMinor: bigint; currency: string; providerKey: string } | null;
}
export interface CancellationDecision {
  id: string;
  appointmentId: string;
  actorAccountId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  previousStatus: AppointmentStatus;
  /** Immutable appointment financial evidence selected from the locked appointment context. */
  allocationSnapshotId: string;
  paymentId: string | null;
  refundOutcome: RefundOutcome;
  refundAmountMinor: bigint;
  currency: string;
  capacityReleased: boolean;
  settlementConsequence: SettlementConsequence;
  refundPolicyVersionId: string;
  refundId: string | null;
}
export interface CancellationRepository {
  transaction<T>(operation: (database: PostgresExecutor) => Promise<T>): Promise<T>;
  lockCancellationContext(database: PostgresExecutor, appointmentId: string): Promise<CancellationContext | null>;
  findCancellation(database: PostgresExecutor, appointmentId: string): Promise<CancellationDecision | null>;
  selectRefundPolicies(database: PostgresExecutor, input: { at: Date; providerKey: string; serviceOfferingId: string }): Promise<RefundPolicy[]>;
  transitionAppointment(database: PostgresExecutor, appointmentId: string, from: AppointmentStatus, to: 'CANCELLED'): Promise<boolean>;
  releaseReservation(database: PostgresExecutor, reservationId: string, at: Date): Promise<boolean>;
  deriveSettlementConsequence(database: PostgresExecutor, allocationSnapshotId: string): Promise<SettlementConsequence>;
  appendAudit(database: PostgresExecutor, event: AuditEventInput): Promise<string>;
  appendAppointmentEvent(database: PostgresExecutor, event: { id: string; appointmentId: string; actorAccountId: string; previousStatus: AppointmentStatus; reason: string; context: Record<string, string | number | boolean | null>; auditEventId: string }): Promise<void>;
  createDecision(database: PostgresExecutor, decision: CancellationDecision & { reason: string; authorizationContext: Record<string, string | number | boolean | null>; at: Date; auditEventId: string }): Promise<void>;
  createRefund(database: PostgresExecutor, input: { id: string; decisionId: string; paymentId: string; allocationSnapshotId: string; providerKey: string; currency: string; amountMinor: bigint; idempotencyKey: string; policyVersionId: string; actorAccountId: string }): Promise<void>;
  createFinancialConsequence(database: PostgresExecutor, input: { id: string; decisionId: string; allocationSnapshotId: string; refundId: string | null; outcome: RefundOutcome; amountMinor: bigint; currency: string; settlementConsequence: SettlementConsequence }): Promise<void>;
}

export class CancellationError extends Error {
  public constructor(public readonly code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'POLICY_UNAVAILABLE' | 'POLICY_AMBIGUOUS' | 'POLICY_INVALID' | 'CANCELLATION_NOT_PERMITTED') {
    super(code === 'UNAUTHORIZED' ? 'Authentication is required.' : code === 'FORBIDDEN' ? 'Appointment cancellation is not permitted.' : 'Cancellation cannot be completed.');
    this.name = 'CancellationError';
  }
}

export class CancellationService {
  public constructor(private readonly repository: CancellationRepository, private readonly authorization: Pick<AppointmentAuthorizationService, 'authorize' | 'authorizeInTransaction'>) {}

  public async cancel(actorAccountId: string | undefined, input: { appointmentId: string; reason: string; idempotencyKey: string }): Promise<{ decision: CancellationDecision; replayed: boolean }> {
    if (!actorAccountId) throw new CancellationError('UNAUTHORIZED');
    if (!input.reason.trim() || !input.idempotencyKey.trim()) throw new CancellationError('CONFLICT');
    await this.authorization.authorize(actorAccountId, input.appointmentId, 'appointment.cancel');
    const fingerprint = `${input.appointmentId}:${input.reason.trim()}`;
    return this.repository.transaction(async (database) => {
      const context = await this.repository.lockCancellationContext(database, input.appointmentId);
      if (!context) throw new CancellationError('NOT_FOUND');
      // Request-time authorization is only an early rejection. Revalidate current authority
      // after the lifecycle prefix is locked and before any financial state changes.
      await this.authorization.authorizeInTransaction(database, actorAccountId, context.appointmentId, 'appointment.cancel');
      const existing = await this.repository.findCancellation(database, context.appointmentId);
      if (existing) {
        if (existing.actorAccountId === actorAccountId && existing.idempotencyKey === input.idempotencyKey && existing.requestFingerprint === fingerprint) return { decision: existing, replayed: true };
        throw new CancellationError('CONFLICT');
      }
      if (!['PAYMENT_PENDING', 'CONFIRMED', 'IN_PROGRESS'].includes(context.appointmentStatus)) throw new CancellationError('CANCELLATION_NOT_PERMITTED');
      const now = new Date();
      const policy = selectPolicy(await this.repository.selectRefundPolicies(database, { at: now, providerKey: context.providerKey, serviceOfferingId: context.serviceOfferingId }));
      const decision = decide(context, policy, now);
      const capacityReleased = await releaseCapacity(this.repository, database, context, now);
      const settlementConsequence = await this.repository.deriveSettlementConsequence(database, context.allocationSnapshotId);
      if (!await this.repository.transitionAppointment(database, context.appointmentId, context.appointmentStatus, 'CANCELLED')) throw new CancellationError('CONFLICT');
      const auditEventId = await this.repository.appendAudit(database, {
        category: 'BUSINESS', eventType: 'APPOINTMENT_CANCELLATION_DECIDED', actorAccountId, targetType: 'APPOINTMENT', targetId: context.appointmentId, outcome: 'SUCCESS',
        metadata: { previousStatus: context.appointmentStatus, refundOutcome: decision.outcome, capacityReleased, settlementConsequence, refundPolicyVersionId: policy.id },
      });
      const decisionId = createIdentifier();
      const refundId = decision.outcome === 'REFUND_REQUESTED' ? createIdentifier() : null;
      const stored: CancellationDecision = { id: decisionId, appointmentId: context.appointmentId, actorAccountId, idempotencyKey: input.idempotencyKey, requestFingerprint: fingerprint, previousStatus: context.appointmentStatus, allocationSnapshotId: context.allocationSnapshotId, paymentId: context.payment?.id ?? null, refundOutcome: decision.outcome, refundAmountMinor: decision.amountMinor, currency: context.currency, capacityReleased, settlementConsequence, refundPolicyVersionId: policy.id, refundId };
      await this.repository.createDecision(database, { ...stored, reason: input.reason.trim(), authorizationContext: { operation: 'appointment.cancel' }, at: now, auditEventId });
      await this.repository.appendAppointmentEvent(database, { id: createIdentifier(), appointmentId: context.appointmentId, actorAccountId, previousStatus: context.appointmentStatus, reason: input.reason.trim(), context: { cancellationDecisionId: decisionId, refundOutcome: decision.outcome, refundPolicyVersionId: policy.id, capacityReleased, settlementConsequence }, auditEventId });
      if (refundId && context.payment) await this.repository.createRefund(database, { id: refundId, decisionId, paymentId: context.payment.id, allocationSnapshotId: context.allocationSnapshotId, providerKey: context.payment.providerKey, currency: context.payment.currency, amountMinor: decision.amountMinor, idempotencyKey: `cancellation:${decisionId}`, policyVersionId: policy.id, actorAccountId });
      await this.repository.createFinancialConsequence(database, { id: createIdentifier(), decisionId, allocationSnapshotId: context.allocationSnapshotId, refundId, outcome: decision.outcome, amountMinor: decision.amountMinor, currency: context.currency, settlementConsequence });
      return { decision: stored, replayed: false };
    });
  }
}

export interface RefundExecutionRepository {
  transaction<T>(operation: (database: PostgresExecutor) => Promise<T>): Promise<T>;
  claimRefund(database: PostgresExecutor, refundId: string): Promise<{ refund: { id: string; status: string; paymentProviderId: string; providerKey: string; idempotencyKey: string; amountMinor: bigint; currency: string }; attempt: { id: string; attemptNumber: number } | null } | null>;
  finalizeRefund(database: PostgresExecutor, input: { refundId: string; attemptId: string; status: 'SUCCEEDED' | 'FAILED' | 'RECONCILIATION_REQUIRED'; providerRefundId?: string; failureCode?: string }): Promise<'SUCCEEDED' | 'FAILED' | 'RECONCILIATION_REQUIRED'>;
  appendAudit(database: PostgresExecutor, event: AuditEventInput): Promise<string>;
}

/** A durable provider boundary: its external call always occurs after the claim commits. */
export class RefundExecutionService {
  public constructor(private readonly repository: RefundExecutionRepository, private readonly provider: PaymentProvider) {}
  public async execute(refundId: string): Promise<{ status: 'SUCCEEDED' | 'FAILED' | 'RECONCILIATION_REQUIRED' | 'PROCESSING' }> {
    const claim = await this.repository.transaction((database) => this.repository.claimRefund(database, refundId));
    if (!claim) throw new CancellationError('NOT_FOUND');
    if (!claim.attempt) return { status: claim.refund.status === 'SUCCEEDED' ? 'SUCCEEDED' : claim.refund.status === 'FAILED' ? 'FAILED' : claim.refund.status === 'RECONCILIATION_REQUIRED' ? 'RECONCILIATION_REQUIRED' : 'PROCESSING' };
    if (claim.refund.providerKey !== this.provider.key) {
      await this.repository.transaction(async (database) => this.repository.finalizeRefund(database, { refundId: claim.refund.id, attemptId: claim.attempt!.id, status: 'RECONCILIATION_REQUIRED', failureCode: 'PROVIDER_KEY_MISMATCH' }));
      return { status: 'RECONCILIATION_REQUIRED' };
    }
    try {
      const response = await this.provider.createRefund({ providerPaymentId: claim.refund.paymentProviderId, idempotencyKey: claim.refund.idempotencyKey, amountMinor: claim.refund.amountMinor, currency: claim.refund.currency });
      const finalized = await this.repository.transaction(async (database) => {
        const status = await this.repository.finalizeRefund(database, { refundId: claim.refund.id, attemptId: claim.attempt!.id, status: 'SUCCEEDED', providerRefundId: response.providerRefundId });
        await this.repository.appendAudit(database, status === 'SUCCEEDED'
          ? { category: 'BUSINESS', eventType: 'APPOINTMENT_REFUND_SUCCEEDED', targetType: 'REFUND', targetId: claim.refund.id, outcome: 'SUCCESS' }
          : { category: 'BUSINESS', eventType: 'APPOINTMENT_REFUND_RECONCILIATION_REQUIRED', targetType: 'REFUND', targetId: claim.refund.id, outcome: 'FAILURE' });
        return status;
      });
      return { status: finalized };
    } catch {
      await this.repository.transaction(async (database) => {
        await this.repository.finalizeRefund(database, { refundId: claim.refund.id, attemptId: claim.attempt!.id, status: 'RECONCILIATION_REQUIRED', failureCode: 'PROVIDER_OUTCOME_UNCONFIRMED' });
        await this.repository.appendAudit(database, { category: 'BUSINESS', eventType: 'APPOINTMENT_REFUND_RECONCILIATION_REQUIRED', targetType: 'REFUND', targetId: claim.refund.id, outcome: 'FAILURE' });
      });
      return { status: 'RECONCILIATION_REQUIRED' };
    }
  }
}

function selectPolicy(values: RefundPolicy[]): RefundPolicy {
  if (values.length === 0) throw new CancellationError('POLICY_UNAVAILABLE');
  const ordered = [...values].sort((left, right) => right.specificity - left.specificity || right.priority - left.priority);
  const winner = ordered[0]!;
  if (ordered.filter((value) => value.specificity === winner.specificity && value.priority === winner.priority).length !== 1) throw new CancellationError('POLICY_AMBIGUOUS');
  validatePolicy(winner.data);
  return winner;
}
function validatePolicy(value: RefundPolicyData): void {
  const approvedPaymentStates = ['PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'RECONCILIATION_REQUIRED'];
  const percentageValid = value.refundOutcome === 'PERCENTAGE'
    ? Number.isInteger(value.percentageBps) && value.percentageBps! >= 0 && value.percentageBps! <= 10000
    : value.percentageBps === undefined;
  if (!['NONE', 'FULL', 'PERCENTAGE'].includes(value.refundOutcome) || value.refundBasis !== 'PAYMENT_AMOUNT' || !Number.isInteger(value.cancellationWindowSeconds) || value.cancellationWindowSeconds < 0 || !Array.isArray(value.paymentStates) || value.paymentStates.length === 0 || !value.paymentStates.every((state) => approvedPaymentStates.includes(state)) || typeof value.allowInProgress !== 'boolean' || !percentageValid) throw new CancellationError('POLICY_INVALID');
}
function decide(context: CancellationContext, policy: RefundPolicy, now: Date): { outcome: RefundOutcome; amountMinor: bigint } {
  if (context.appointmentStatus === 'IN_PROGRESS' && !policy.data.allowInProgress) throw new CancellationError('CANCELLATION_NOT_PERMITTED');
  if (context.appointmentStatus !== 'IN_PROGRESS' && now.getTime() > context.appointmentStartsAt.getTime() - policy.data.cancellationWindowSeconds * 1000) throw new CancellationError('CANCELLATION_NOT_PERMITTED');
  if (!context.payment) return { outcome: 'NO_REFUND', amountMinor: 0n };
  if (context.payment.status === 'RECONCILIATION_REQUIRED') return { outcome: 'RECONCILIATION_REQUIRED', amountMinor: 0n };
  if (context.payment.status !== 'SUCCEEDED' || !policy.data.paymentStates.includes(context.payment.status) || policy.data.refundOutcome === 'NONE') return { outcome: 'NO_REFUND', amountMinor: 0n };
  if (policy.data.refundOutcome === 'FULL') return { outcome: 'REFUND_REQUESTED', amountMinor: context.payment.amountMinor };
  // Approved deterministic rounding: truncate fractional minor units toward zero.
  return { outcome: 'REFUND_REQUESTED', amountMinor: context.payment.amountMinor * BigInt(policy.data.percentageBps!) / 10000n };
}
async function releaseCapacity(repository: CancellationRepository, database: PostgresExecutor, context: CancellationContext, now: Date): Promise<boolean> {
  if (context.appointmentStatus === 'IN_PROGRESS' || context.reservationStatus !== 'HELD' || context.appointmentStartsAt <= now) return false;
  if (!await repository.releaseReservation(database, context.reservationId, now)) throw new CancellationError('CONFLICT');
  return true;
}
