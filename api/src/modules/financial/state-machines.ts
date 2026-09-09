import { FinancialError, type SettlementStatus } from './financial.js';

export type RefundStatus = 'REQUESTED' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'RECONCILIATION_REQUIRED';
export function assertRefundTransition(from: RefundStatus, to: RefundStatus): void {
  if (!({ REQUESTED: ['PROCESSING','FAILED'], PROCESSING: ['SUCCEEDED','FAILED','RECONCILIATION_REQUIRED'] } as Partial<Record<RefundStatus, string[]>>)[from]?.includes(to)) throw new FinancialError('INVALID_REFUND_TRANSITION');
}
export function assertSettlementTransition(from: SettlementStatus, to: SettlementStatus, appointmentCompletedAt?: Date): void {
  if (['ELIGIBLE','SCHEDULED','PROCESSING','SUCCEEDED'].includes(to) && !appointmentCompletedAt) throw new FinancialError('APPOINTMENT_COMPLETION_REQUIRED');
  if (!({ PENDING_ELIGIBILITY: ['ON_HOLD','ELIGIBLE'], ON_HOLD: ['ELIGIBLE'], ELIGIBLE: ['SCHEDULED','REVERSED'], SCHEDULED: ['PROCESSING','FAILED'], PROCESSING: ['SUCCEEDED','FAILED','RECONCILIATION_REQUIRED'], FAILED: ['SCHEDULED','RECONCILIATION_REQUIRED'], SUCCEEDED: ['REVERSED'] } as Partial<Record<SettlementStatus, string[]>>)[from]?.includes(to)) throw new FinancialError('INVALID_SETTLEMENT_TRANSITION');
}
/** Deterministic bounded jitter for persisted retry attempts; policy supplies all timings. */
export function retryAt(now: Date, attempt: number, policy: { baseDelayMs: number; maxDelayMs: number; jitterMs: number }): Date {
  if (!Number.isInteger(attempt) || attempt < 1 || policy.baseDelayMs < 1 || policy.maxDelayMs < policy.baseDelayMs || policy.jitterMs < 0) throw new FinancialError('INVALID_RETRY_POLICY');
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1)); const jitter = (attempt * 2_654_435_761) % (policy.jitterMs + 1);
  return new Date(now.getTime() + exponential + jitter);
}
