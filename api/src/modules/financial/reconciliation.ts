export interface ProviderFact { providerKey: string; paymentId?: string; orderId?: string; refundId?: string; settlementId?: string; eventId?: string; amountMinor?: bigint; currency?: string; }
export type ReconciliationOutcome = 'MATCHED' | 'MISMATCH' | 'AMBIGUOUS' | 'MANUAL_REVIEW';
export function reconcile(provider: ProviderFact, candidates: readonly ProviderFact[]): ReconciliationOutcome {
  const matches = candidates.filter((candidate) => candidate.providerKey === provider.providerKey && identifiersMatch(provider, candidate) && amountMatches(provider, candidate));
  return matches.length === 1 ? 'MATCHED' : matches.length === 0 ? 'MISMATCH' : 'AMBIGUOUS';
}
function identifiersMatch(left: ProviderFact, right: ProviderFact): boolean { return Boolean((left.paymentId && left.paymentId === right.paymentId) || (left.orderId && left.orderId === right.orderId) || (left.refundId && left.refundId === right.refundId) || (left.settlementId && left.settlementId === right.settlementId) || (left.eventId && left.eventId === right.eventId)); }
function amountMatches(left: ProviderFact, right: ProviderFact): boolean { return (left.amountMinor === undefined || right.amountMinor === undefined || left.amountMinor === right.amountMinor) && (left.currency === undefined || right.currency === undefined || left.currency === right.currency); }
