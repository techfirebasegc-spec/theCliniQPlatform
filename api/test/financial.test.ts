import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { evaluateCommercialRule, type CommercialRuleVersion } from '../src/modules/financial/commercial.js';
import { FinancialError, FinancialService, type FinancialAdjustment, type FinancialRepository, type PaymentIntent, type PaymentIntentStatus, type WebhookEvent, type WebhookStatus } from '../src/modules/financial/financial.js';
import { money } from '../src/modules/financial/money.js';
import { RazorpayPaymentProvider } from '../src/modules/financial/provider.js';
import { reconcile } from '../src/modules/financial/reconciliation.js';
import { assertBalancedLedger } from '../src/modules/financial/ledger.js';
import { retentionAction } from '../src/modules/financial/retention.js';
import { assertRefundTransition, assertSettlementTransition, retryAt } from '../src/modules/financial/state-machines.js';

class Repository implements FinancialRepository {
  readonly allocations = new Map<string, unknown>(); readonly intents = new Map<string, PaymentIntent>(); readonly webhooks = new Map<string, WebhookEvent>(); readonly adjustments = new Map<string, FinancialAdjustment>();
  async transaction<T>(operation: (repository: FinancialRepository) => Promise<T>): Promise<T> { return operation(this); }
  async saveAllocation(value: { id: string }): Promise<void> { if (this.allocations.has(value.id)) throw new Error('immutable'); this.allocations.set(value.id, Object.freeze(value)); }
  async findIntent(provider: string, key: string) { return [...this.intents.values()].find((value) => value.providerKey === provider && value.idempotencyKey === key) ?? null; }
  async saveIntent(value: PaymentIntent) { if (await this.findIntent(value.providerKey, value.idempotencyKey)) throw new Error('duplicate'); this.intents.set(value.id, value); }
  async updateIntent(id: string, from: PaymentIntentStatus, to: PaymentIntentStatus) { const value = this.intents.get(id); if (!value || value.status !== from) return false; this.intents.set(id, { ...value, status: to }); return true; }
  async findWebhook(provider: string, eventId: string) { return [...this.webhooks.values()].find((value) => value.providerKey === provider && value.providerEventId === eventId) ?? null; }
  async saveWebhook(value: WebhookEvent) { if (await this.findWebhook(value.providerKey, value.providerEventId)) throw new Error('duplicate'); this.webhooks.set(value.id, Object.freeze(value)); }
  async transitionWebhook(id: string, from: WebhookStatus, to: WebhookStatus) { const value = this.webhooks.get(id); if (!value || value.status !== from) return false; this.webhooks.set(id, { ...value, status: to }); return true; }
  async saveAdjustment(value: FinancialAdjustment) { this.adjustments.set(value.id, value); }
  async findAdjustment(id: string) { return this.adjustments.get(id) ?? null; }
  async approveAdjustment(id: string, approver: string) { const value = this.adjustments.get(id); if (!value || value.status !== 'REQUESTED') return false; this.adjustments.set(id, { ...value, status: 'APPROVED' }); void approver; return true; }
}
function rule(partial: Partial<CommercialRuleVersion> = {}): CommercialRuleVersion { return { id: 'rule-1', ruleType: 'PERCENTAGE', priority: 10, effectiveFrom: new Date('2026-01-01T00:00:00Z'), scopes: [{ kind: 'GLOBAL' }], policy: { percentageBasisPoints: 1_000n }, ...partial }; }
function setup() { const repository = new Repository(); const audit = { events: [] as unknown[], append: async (event: unknown) => { audit.events.push(event); } }; const denied = new Set<string>(); const authorizer = { authorize: async (accountId: string) => { if (denied.has(accountId)) throw new Error('FORBIDDEN'); } }; return { repository, audit, denied, service: new FinancialService(repository, audit, authorizer) }; }

describe('theCliniQ Phase 4 financial foundation', () => {
  it('evaluates percentage, fixed, fixed plus percentage, zero, priority, dates, and ambiguity deterministically', () => {
    const context = { at: new Date('2026-02-01T00:00:00Z'), currency: 'INR', grossAmountMinor: 10_000n, scopes: {} };
    expect(evaluateCommercialRule([rule()], context).platformCommission.amountMinor).toBe(1_000n);
    expect(evaluateCommercialRule([rule({ ruleType: 'FIXED', policy: { fixedAmountMinor: 500n } })], context).platformCommission.amountMinor).toBe(500n);
    expect(evaluateCommercialRule([rule({ ruleType: 'FIXED_PLUS_PERCENTAGE', policy: { fixedAmountMinor: 500n, percentageBasisPoints: 1_000n } })], context).platformCommission.amountMinor).toBe(1_500n);
    expect(evaluateCommercialRule([rule({ ruleType: 'ZERO_COMMISSION', policy: {} })], context).platformCommission.amountMinor).toBe(0n);
    expect(evaluateCommercialRule([rule({ id: 'low', priority: 1 }), rule({ id: 'high', priority: 2, policy: { fixedAmountMinor: 1n } })], context).rule.id).toBe('high');
    expect(() => evaluateCommercialRule([rule({ id: 'one' }), rule({ id: 'two' })], context)).toThrow('AMBIGUOUS_RULE');
    expect(() => evaluateCommercialRule([rule({ effectiveUntil: new Date('2026-01-02T00:00:00Z') })], context)).toThrow('NO_APPLICABLE_RULE');
  });
  it('creates an immutable allocation snapshot using exact minor units and selected rule version', async () => {
    const { service, repository } = setup(); const allocation = await service.allocate('actor', [rule()], { at: new Date('2026-02-01T00:00:00Z'), currency: 'INR', grossAmountMinor: 10_000n, scopes: {} });
    expect(allocation).toMatchObject({ selectedRuleVersionId: 'rule-1', platformCommission: { amountMinor: 1_000n }, providerPayable: { amountMinor: 9_000n } });
    expect(Object.isFrozen(repository.allocations.get(allocation.id))).toBe(true); expect(() => money(1n, 'inr')).toThrow('INVALID_MONEY');
  });
  it('makes payment intent creation idempotent and rejects invalid transitions', async () => {
    const { service, repository } = setup(); const input = { providerKey: 'RAZORPAY', idempotencyKey: 'key', amount: money(10_000n, 'INR') };
    const first = await service.createPaymentIntent('actor', input); const second = await service.createPaymentIntent('actor', input);
    expect(second.id).toBe(first.id); expect(repository.intents.size).toBe(1);
    await expect(service.transitionPaymentIntent('actor', first.id, 'CREATED', 'SUCCEEDED')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await service.transitionPaymentIntent('actor', first.id, 'CREATED', 'PENDING_PROVIDER');
  });
  it('deduplicates authenticated webhook events, preserves unknown events, and rejects invalid/replayed transitions', async () => {
    const { service, repository } = setup();
    await expect(service.receiveWebhook('system', { providerKey: 'RAZORPAY', providerEventId: 'event-invalid', eventType: 'payment', payload: '{}', authenticated: false, knownType: true, handlerVersion: '1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const unknown = await service.receiveWebhook('system', { providerKey: 'RAZORPAY', providerEventId: 'event-unknown', eventType: 'future', payload: '{}', authenticated: true, knownType: false, handlerVersion: '1' });
    expect(unknown.status).toBe('UNKNOWN'); expect((await service.receiveWebhook('system', { providerKey: 'RAZORPAY', providerEventId: 'event-unknown', eventType: 'future', payload: '{}', authenticated: true, knownType: false, handlerVersion: '1' })).id).toBe(unknown.id);
    const event = await service.receiveWebhook('system', { providerKey: 'RAZORPAY', providerEventId: 'event-known', eventType: 'payment', payload: '{"a":1}', authenticated: true, knownType: true, handlerVersion: '1' });
    await service.transitionWebhook('system', event.id, 'PERSISTED', 'PROCESSING'); await service.transitionWebhook('system', event.id, 'PROCESSING', 'PROCESSED');
    await expect(service.transitionWebhook('system', event.id, 'PROCESSED', 'PROCESSING')).rejects.toBeInstanceOf(FinancialError); expect(repository.webhooks.size).toBe(2);
  });
  it('validates the Razorpay signature through a server-only provider boundary', async () => {
    const provider = new RazorpayPaymentProvider('server-key-id', 'server-key-secret', 'server-only-secret'); const payload = '{"id":"evt"}';
    const signature = createHmac('sha256', 'server-only-secret').update(payload).digest('hex');
    expect(provider.verifyWebhook({ payload, signature })).toBe(true); expect(provider.verifyWebhook({ payload, signature: '' })).toBe(false);
  });
  it('requires a second account to approve an adjustment and audits denials', async () => {
    const { service, audit } = setup(); const adjustment = await service.requestAdjustment({ allocationSnapshotId: 'snapshot', requestedByAccountId: 'requester', amountMinor: -100n, category: 'FEE_CORRECTION', component: 'PLATFORM_COMMISSION', reason: 'approved correction', reference: 'case' });
    await expect(service.approveAdjustment('requester', adjustment.id)).rejects.toMatchObject({ code: 'FORBIDDEN' }); await service.approveAdjustment('approver', adjustment.id);
    expect(audit.events).toEqual(expect.arrayContaining([expect.objectContaining({ eventType: 'FINANCIAL_ACCESS_DENIED', outcome: 'DENIED' }), expect.objectContaining({ eventType: 'FINANCIAL_ADJUSTMENT_APPROVED', outcome: 'SUCCESS' })]));
  });
  it('fails closed through the server-side financial authorization boundary', async () => {
    const { service, denied, audit } = setup(); denied.add('blocked');
    await expect(service.createPaymentIntent('blocked', { providerKey: 'RAZORPAY', idempotencyKey: 'blocked', amount: money(1n, 'INR') })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(audit.events).toEqual(expect.arrayContaining([expect.objectContaining({ eventType: 'FINANCIAL_ACCESS_DENIED', outcome: 'DENIED' })]));
  });
  it('enforces refund/settlement state prerequisites, bounded retry, reconciliation, ledger balance, and legal holds', () => {
    expect(() => assertRefundTransition('REQUESTED', 'SUCCEEDED')).toThrow('INVALID_REFUND_TRANSITION');
    expect(() => assertSettlementTransition('PENDING_ELIGIBILITY', 'ELIGIBLE')).toThrow('APPOINTMENT_COMPLETION_REQUIRED');
    expect(() => assertSettlementTransition('ELIGIBLE', 'PROCESSING', new Date())).toThrow('INVALID_SETTLEMENT_TRANSITION');
    expect(retryAt(new Date(0), 2, { baseDelayMs: 100, maxDelayMs: 1_000, jitterMs: 10 }).getTime()).toBeGreaterThanOrEqual(200);
    expect(reconcile({ providerKey: 'RAZORPAY', paymentId: 'p', amountMinor: 1n, currency: 'INR' }, [{ providerKey: 'RAZORPAY', paymentId: 'p', amountMinor: 1n, currency: 'INR' }])).toBe('MATCHED');
    expect(() => assertBalancedLedger([{ accountId: 'a', direction: 'DEBIT', amountMinor: 1n, currency: 'INR' }, { accountId: 'b', direction: 'CREDIT', amountMinor: 2n, currency: 'INR' }])).toThrow('UNBALANCED_LEDGER');
    expect(retentionAction({ category: 'WEBHOOK', action: 'DELETE', legalHold: true })).toBe('HOLD');
  });
});
