export type FinancialRetentionCategory = 'PAYMENT' | 'REFUND' | 'SETTLEMENT' | 'RECONCILIATION' | 'ADJUSTMENT' | 'AUDIT' | 'WEBHOOK';
export interface RetentionDecision { category: FinancialRetentionCategory; action: 'DELETE' | 'ANONYMIZE' | 'RETAIN'; legalHold: boolean; }
/** A legal hold always prevents an automated retention action. */
export function retentionAction(decision: RetentionDecision): RetentionDecision['action'] | 'HOLD' { return decision.legalHold ? 'HOLD' : decision.action; }
