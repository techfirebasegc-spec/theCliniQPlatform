import { describe, expect, it } from 'vitest';
import { CancellationError, CancellationService, RefundExecutionService, type CancellationContext, type CancellationDecision, type CancellationRepository, type RefundExecutionRepository, type RefundPolicy } from '../src/modules/appointments/cancellation-refunds.js';
import type { AuditEventInput } from '../src/modules/audit/audit.js';
import type { PostgresExecutor } from '../src/modules/sessions/postgres-session-repository.js';
import { PaymentConfirmationService } from '../src/modules/appointments/payment-confirmation.js';
import { PostgresCancellationRefundRepository } from '../src/modules/appointments/postgres-cancellation-refund-repository.js';

const policy = (id: string, specificity = 0, priority = 0, data: Partial<RefundPolicy['data']> = {}): RefundPolicy => ({ id, specificity, priority, data: { refundOutcome: 'FULL', refundBasis: 'PAYMENT_AMOUNT', cancellationWindowSeconds: 0, paymentStates: ['SUCCEEDED'], allowInProgress: false, ...data } });
const context = (status: CancellationContext['appointmentStatus'] = 'CONFIRMED', paymentStatus = 'SUCCEEDED'): CancellationContext => ({ appointmentId: 'appointment', appointmentStatus: status, appointmentStartsAt: new Date('2030-01-02T12:00:00Z'), appointmentIntentId: 'intent', reservationId: 'reservation', reservationStatus: 'HELD', handoffId: 'handoff', allocationSnapshotId: 'allocation', serviceOfferingId: 'service', providerKey: 'RAZORPAY', currency: 'INR', payment: { id: 'payment', status: paymentStatus, amountMinor: 1000n, currency: 'INR', providerKey: 'RAZORPAY' } });

class Repository implements CancellationRepository {
  public value = context(); public policies: RefundPolicy[] = [policy('global')]; public decision: CancellationDecision | null = null;
  public refunds: unknown[] = []; public consequences: unknown[] = []; public events: unknown[] = []; public audits: AuditEventInput[] = []; public released = 0; public held = 0;
  public async transaction<T>(operation: (database: PostgresExecutor) => Promise<T>): Promise<T> {
    const snapshot = { value: { ...this.value }, decision: this.decision, refunds: [...this.refunds], consequences: [...this.consequences], events: [...this.events], audits: [...this.audits], released: this.released, held: this.held };
    try { return await operation({ query: undefined as never }); } catch (error) { this.value = snapshot.value; this.decision = snapshot.decision; this.refunds = snapshot.refunds; this.consequences = snapshot.consequences; this.events = snapshot.events; this.audits = snapshot.audits; this.released = snapshot.released; this.held = snapshot.held; throw error; }
  }
  public async lockCancellationContext() { return { ...this.value }; }
  public async findCancellation() { return this.decision; }
  public async selectRefundPolicies() { return this.policies; }
  public async transitionAppointment(_db: PostgresExecutor, _id: string, from: typeof this.value.appointmentStatus) { if (this.value.appointmentStatus !== from) return false; this.value.appointmentStatus = 'CANCELLED'; return true; }
  public async releaseReservation() { this.value.reservationStatus = 'RELEASED'; this.released += 1; return true; }
  public async deriveSettlementConsequence() { this.held += 1; return 'NONE' as const; }
  public async appendAudit(_db: PostgresExecutor, event: AuditEventInput) { this.audits.push(event); return `audit-${this.audits.length}`; }
  public async appendAppointmentEvent(_db: PostgresExecutor, event: unknown) { this.events.push(event); }
  public async createDecision(_db: PostgresExecutor, decision: CancellationDecision) { this.decision = decision; }
  public async createRefund(_db: PostgresExecutor, value: unknown) { this.refunds.push(value); }
  public async createFinancialConsequence(_db: PostgresExecutor, value: unknown) { this.consequences.push(value); }
}
function service(repository: Repository, permitted = true) { const authorize = async () => { if (!permitted) throw Object.assign(new Error('FORBIDDEN'), { code: 'FORBIDDEN' }); return { id: 'appointment', participants: [] }; }; return new CancellationService(repository, { authorize, authorizeInTransaction: async () => authorize() }); }
function request(key = 'key', reason = 'PATIENT_REQUEST') { return { appointmentId: 'appointment', reason, idempotencyKey: key }; }

describe('theCliniQ Phase 5.5 cancellation decisions', () => {
  it('persists the locked allocation snapshot, never the refund policy ID, as decision financial evidence', async () => {
    const calls: Array<{ text: string; values: readonly unknown[] }> = [];
    const executor = { query: async (text: string, values: readonly unknown[]) => { calls.push({ text, values }); return { rows: [], rowCount: 1 }; } };
    const repository = new PostgresCancellationRefundRepository({
      query: async (text: string, values: readonly unknown[]) => { calls.push({ text, values }); return { rows: [], rowCount: 1 }; },
      ping: async () => undefined, close: async () => undefined, transaction: async (operation) => operation(executor),
    });
    await repository.createDecision(executor, {
      id: 'decision', appointmentId: 'appointment', actorAccountId: 'actor', idempotencyKey: 'key', requestFingerprint: 'fingerprint', previousStatus: 'CONFIRMED', allocationSnapshotId: 'allocation-snapshot', paymentId: 'payment', refundOutcome: 'REFUND_REQUESTED', refundAmountMinor: 100n, currency: 'INR', capacityReleased: true, settlementConsequence: 'NONE', refundPolicyVersionId: 'policy-version', refundId: 'refund', reason: 'PATIENT_REQUEST', authorizationContext: { operation: 'appointment.cancel' }, at: new Date(), auditEventId: 'audit',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.values).toEqual([
      'decision', 'appointment', 'allocation-snapshot', 'payment', 'actor', 'CONFIRMED',
      'PATIENT_REQUEST', JSON.stringify({ operation: 'appointment.cancel' }), expect.any(Date),
      'policy-version', 'REFUND_REQUESTED', '100', 'INR', true, 'NONE', 'key', 'fingerprint', 'audit',
    ]);
  });
  it('derives a full refund and releases a future confirmed slot atomically', async () => {
    const repository = new Repository(); const result = await service(repository).cancel('patient', request());
    expect(result.replayed).toBe(false); expect(result.decision).toMatchObject({ previousStatus: 'CONFIRMED', refundOutcome: 'REFUND_REQUESTED', refundAmountMinor: 1000n, capacityReleased: true, refundPolicyVersionId: 'global' });
    expect(result.decision.allocationSnapshotId).toBe('allocation');
    expect(repository.value.appointmentStatus).toBe('CANCELLED'); expect(repository.released).toBe(1); expect(repository.refunds).toHaveLength(1); expect(repository.events).toHaveLength(1); expect(repository.consequences).toHaveLength(1);
  });

  it('uses the most-specific refund policy and rejects equally ranked ambiguity', async () => {
    const repository = new Repository(); repository.policies = [policy('global'), policy('provider', 1), policy('service', 2), policy('combined', 3, 0, { refundOutcome: 'PERCENTAGE', percentageBps: 2500 })];
    const result = await service(repository).cancel('patient', request());
    expect(result.decision.refundPolicyVersionId).toBe('combined'); expect(result.decision.refundAmountMinor).toBe(250n);
    const ambiguous = new Repository(); ambiguous.policies = [policy('one', 3), policy('two', 3)];
    await expect(service(ambiguous).cancel('patient', request())).rejects.toMatchObject({ code: 'POLICY_AMBIGUOUS' });
    expect(ambiguous.value.appointmentStatus).toBe('CONFIRMED');
  });

  it('fails closed on missing or invalid refund policy data without lifecycle residue', async () => {
    const missing = new Repository(); missing.policies = [];
    await expect(service(missing).cancel('patient', request())).rejects.toMatchObject({ code: 'POLICY_UNAVAILABLE' });
    expect(missing.events).toHaveLength(0);
    const invalid = new Repository(); invalid.policies = [policy('invalid', 0, 0, { refundOutcome: 'PERCENTAGE' })];
    await expect(service(invalid).cancel('patient', request())).rejects.toMatchObject({ code: 'POLICY_INVALID' });
  });

  it('replays only the exact authorized request and rejects a conflicting retry', async () => {
    const repository = new Repository(); const initial = await service(repository).cancel('patient', request());
    await expect(service(repository).cancel('patient', request())).resolves.toMatchObject({ replayed: true, decision: { id: initial.decision.id } });
    await expect(service(repository).cancel('patient', request('other'))).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(repository.refunds).toHaveLength(1); expect(repository.released).toBe(1);
  });

  it('enforces authorization before the transaction and keeps staff-like denial out of the lifecycle', async () => {
    const repository = new Repository(); await expect(service(repository, false).cancel('staff', request())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(repository.events).toHaveLength(0); expect(repository.decision).toBeNull();
  });

  it('requires an approved in-progress policy and never releases active capacity', async () => {
    const denied = new Repository(); denied.value = context('IN_PROGRESS');
    await expect(service(denied).cancel('doctor', request())).rejects.toMatchObject({ code: 'CANCELLATION_NOT_PERMITTED' });
    const allowed = new Repository(); allowed.value = context('IN_PROGRESS'); allowed.policies = [policy('in-progress', 0, 0, { allowInProgress: true })];
    const result = await service(allowed).cancel('doctor', request());
    expect(result.decision.capacityReleased).toBe(false); expect(allowed.released).toBe(0);
  });

  it('cancels payment-pending appointments without creating a refund and prevents a future resurrection', async () => {
    const repository = new Repository(); repository.value = context('PAYMENT_PENDING', 'PENDING');
    const result = await service(repository).cancel('patient', request());
    expect(result.decision.refundOutcome).toBe('NO_REFUND'); expect(repository.refunds).toHaveLength(0); expect(repository.value.appointmentStatus).toBe('CANCELLED');
  });

  it('rejects completed and terminal appointments', async () => {
    for (const status of ['COMPLETED', 'CANCELLED', 'EXPIRED', 'PAYMENT_FAILED'] as const) {
      const repository = new Repository(); repository.value = context(status);
      await expect(service(repository).cancel('patient', request())).rejects.toBeInstanceOf(CancellationError);
    }
  });
});

describe('theCliniQ Phase 5.5 refund provider boundary', () => {
  it('commits a durable claim before a provider call and treats an unknown provider outcome as reconciliation-required', async () => {
    const calls: string[] = [];
    const repository: RefundExecutionRepository = {
      transaction: async (operation) => operation({ query: undefined as never }),
      claimRefund: async () => ({ refund: { id: 'refund', status: 'REQUESTED', paymentProviderId: 'payment-provider', providerKey: 'RAZORPAY', idempotencyKey: 'idem', amountMinor: 100n, currency: 'INR' }, attempt: { id: 'attempt', attemptNumber: 1 } }),
      finalizeRefund: async (_db, input) => { calls.push(input.status); return input.status; }, appendAudit: async () => 'audit',
    };
    const provider = { key: 'RAZORPAY', createOrder: async () => { throw new Error(); }, findOrderByReceipt: async () => null, verifyPayment: async () => ({ status: 'FAILED' as const }), verifyWebhook: () => false, createRefund: async () => { calls.push('provider'); throw new Error('timeout'); }, createSettlement: async () => { throw new Error(); } };
    await expect(new RefundExecutionService(repository, provider).execute('refund')).resolves.toEqual({ status: 'RECONCILIATION_REQUIRED' });
    expect(calls).toEqual(['provider', 'RECONCILIATION_REQUIRED']);
  });

  it('routes an authenticated refund webhook to the same durable convergence boundary', async () => {
    const calls: string[] = [];
    const provider = { key: 'RAZORPAY' as const, createOrder: async () => { throw new Error(); }, findOrderByReceipt: async () => null, verifyPayment: async () => ({ status: 'FAILED' as const }), verifyWebhook: () => true, createRefund: async () => ({ providerRefundId: 'refund-provider' }), createSettlement: async () => { throw new Error(); } };
    const repository = { ingest: async () => ({ eventId: 'event', status: 'PERSISTED' as const }), confirm: async () => ({ status: 'IGNORED' as const }), confirmRefund: async () => { calls.push('refund'); return { status: 'REPLAYED' as const }; } };
    const result = await new PaymentConfirmationService(provider, repository).receiveRazorpayWebhook(JSON.stringify({ event: 'refund.processed', payload: { refund: { entity: { id: 'refund-provider', payment_id: 'payment-provider', amount: 100, currency: 'INR', status: 'processed' } } } }), 'signature', 'event-a');
    expect(result).toEqual({ status: 'REPLAYED' }); expect(calls).toEqual(['refund']);
  });
});
