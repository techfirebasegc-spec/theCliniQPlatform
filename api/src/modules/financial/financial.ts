import { createHash } from 'node:crypto';
import { createIdentifier } from '../../shared/identifiers/uuid.js';
import type { AuditRepository } from '../audit/audit.js';
import { evaluateCommercialRule, type CommercialContext, type CommercialEvaluation, type CommercialRuleVersion } from './commercial.js';
import { money, type Money } from './money.js';

export type PaymentIntentStatus = 'CREATED' | 'PENDING_PROVIDER' | 'AUTHORIZED' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED' | 'RECONCILIATION_REQUIRED';
export type WebhookStatus = 'RECEIVED' | 'AUTHENTICATED' | 'PERSISTED' | 'PROCESSING' | 'PROCESSED' | 'RETRY_PENDING' | 'RECONCILIATION_REQUIRED' | 'UNKNOWN';
export type SettlementStatus = 'PENDING_ELIGIBILITY' | 'ON_HOLD' | 'ELIGIBLE' | 'SCHEDULED' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'REVERSED' | 'RECONCILIATION_REQUIRED';
export type AdjustmentStatus = 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'EXECUTED' | 'RECONCILIATION_REQUIRED';
export interface AllocationSnapshot { id: string; gross: Money; platformCommission: Money; providerPayable: Money; selectedRuleVersionId: string; calculationBasis: string; createdAt: Date; }
export interface PaymentIntent { id: string; providerKey: string; idempotencyKey: string; amount: Money; allocationSnapshotId?: string; status: PaymentIntentStatus; }
export interface WebhookEvent { id: string; providerKey: string; providerEventId: string; eventType: string; payload: Record<string, unknown>; payloadRaw: string; payloadHash: string; status: WebhookStatus; handlerVersion: string; }
export interface FinancialRepository {
  transaction<T>(operation: (repository: FinancialRepository) => Promise<T>): Promise<T>;
  saveAllocation(snapshot: AllocationSnapshot): Promise<void>;
  findIntent(providerKey: string, idempotencyKey: string): Promise<PaymentIntent | null>;
  saveIntent(intent: PaymentIntent): Promise<void>;
  updateIntent(id: string, from: PaymentIntentStatus, to: PaymentIntentStatus): Promise<boolean>;
  findWebhook(providerKey: string, providerEventId: string): Promise<WebhookEvent | null>;
  saveWebhook(event: WebhookEvent): Promise<void>;
  transitionWebhook(id: string, from: WebhookStatus, to: WebhookStatus): Promise<boolean>;
  saveAdjustment(adjustment: FinancialAdjustment): Promise<void>;
  findAdjustment(id: string): Promise<FinancialAdjustment | null>;
  approveAdjustment(id: string, approverAccountId: string): Promise<boolean>;
}
export interface FinancialAdjustment { id: string; allocationSnapshotId: string; requestedByAccountId: string; amountMinor: bigint; category: string; component: string; reason: string; reference: string; status: AdjustmentStatus; }
export type FinancialAction = 'ALLOCATION_CREATE' | 'PAYMENT_INTENT_CREATE' | 'PAYMENT_INTENT_TRANSITION' | 'WEBHOOK_PROCESS' | 'ADJUSTMENT_REQUEST' | 'ADJUSTMENT_APPROVE';
export interface FinancialAuthorizer { authorize(accountId: string, action: FinancialAction, targetId?: string): Promise<void>; }

export class FinancialService {
  public constructor(private readonly repository: FinancialRepository, private readonly audit: AuditRepository, private readonly authorizer: FinancialAuthorizer) {}
  public async allocate(actorAccountId: string, rules: readonly CommercialRuleVersion[], context: CommercialContext): Promise<AllocationSnapshot> {
    await this.authorize(actorAccountId, 'ALLOCATION_CREATE');
    const evaluation = evaluateCommercialRule(rules, context); const snapshot = allocation(evaluation, context);
    await this.repository.transaction(async (repository) => { await repository.saveAllocation(snapshot); await this.audit.append({ category: 'BUSINESS', eventType: 'FINANCIAL_ALLOCATION_CREATED', actorAccountId, targetType: 'FINANCIAL_ALLOCATION_SNAPSHOT', targetId: snapshot.id, outcome: 'SUCCESS' }); });
    return snapshot;
  }
  public async createPaymentIntent(actorAccountId: string, input: { providerKey: string; idempotencyKey: string; amount: Money; allocationSnapshotId?: string }): Promise<PaymentIntent> {
    await this.authorize(actorAccountId, 'PAYMENT_INTENT_CREATE');
    return this.repository.transaction(async (repository) => {
      const existing = await repository.findIntent(input.providerKey, input.idempotencyKey); if (existing) return existing;
      const intent: PaymentIntent = { id: createIdentifier(), providerKey: input.providerKey, idempotencyKey: input.idempotencyKey, amount: input.amount, allocationSnapshotId: input.allocationSnapshotId, status: 'CREATED' };
      await repository.saveIntent(intent); await this.audit.append({ category: 'BUSINESS', eventType: 'PAYMENT_INTENT_CREATED', actorAccountId, targetType: 'PAYMENT_INTENT', targetId: intent.id, outcome: 'SUCCESS' }); return intent;
    });
  }
  public async transitionPaymentIntent(actorAccountId: string, id: string, from: PaymentIntentStatus, to: PaymentIntentStatus): Promise<void> {
    await this.authorize(actorAccountId, 'PAYMENT_INTENT_TRANSITION', id);
    if (!paymentTransition(from, to) || !await this.repository.updateIntent(id, from, to)) return this.denied(actorAccountId, 'PAYMENT_INTENT', id);
    await this.audit.append({ category: 'BUSINESS', eventType: 'PAYMENT_INTENT_TRANSITIONED', actorAccountId, targetType: 'PAYMENT_INTENT', targetId: id, outcome: 'SUCCESS' });
  }
  public async receiveWebhook(actorAccountId: string, input: { providerKey: string; providerEventId: string; eventType: string; payload: string; authenticated: boolean; knownType: boolean; handlerVersion: string }): Promise<WebhookEvent> {
    await this.authorize(actorAccountId, 'WEBHOOK_PROCESS', input.providerEventId);
    if (!input.authenticated) return this.denied(actorAccountId, 'PROVIDER_WEBHOOK', input.providerEventId);
    return this.repository.transaction(async (repository) => {
      const duplicate = await repository.findWebhook(input.providerKey, input.providerEventId); if (duplicate) return duplicate;
      let payload: Record<string, unknown>; try { const parsed: unknown = JSON.parse(input.payload); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); payload = parsed as Record<string, unknown>; } catch { return this.denied(actorAccountId, 'PROVIDER_WEBHOOK', input.providerEventId); }
      const event: WebhookEvent = { id: createIdentifier(), providerKey: input.providerKey, providerEventId: input.providerEventId, eventType: input.eventType, payload, payloadRaw: input.payload, payloadHash: createHash('sha256').update(input.payload).digest('hex'), status: input.knownType ? 'PERSISTED' : 'UNKNOWN', handlerVersion: input.handlerVersion };
      await repository.saveWebhook(event); await this.audit.append({ category: 'SECURITY', eventType: 'PROVIDER_WEBHOOK_PERSISTED', actorAccountId, targetType: 'PROVIDER_WEBHOOK_EVENT', targetId: event.id, outcome: 'SUCCESS' }); return event;
    });
  }
  public async transitionWebhook(actorAccountId: string, id: string, from: WebhookStatus, to: WebhookStatus): Promise<void> {
    await this.authorize(actorAccountId, 'WEBHOOK_PROCESS', id);
    if (!webhookTransition(from, to) || !await this.repository.transitionWebhook(id, from, to)) return this.denied(actorAccountId, 'PROVIDER_WEBHOOK_EVENT', id);
    await this.audit.append({ category: 'BUSINESS', eventType: 'PROVIDER_WEBHOOK_TRANSITIONED', actorAccountId, targetType: 'PROVIDER_WEBHOOK_EVENT', targetId: id, outcome: 'SUCCESS' });
  }
  public async requestAdjustment(input: Omit<FinancialAdjustment, 'id' | 'status'>): Promise<FinancialAdjustment> {
    await this.authorize(input.requestedByAccountId, 'ADJUSTMENT_REQUEST', input.allocationSnapshotId);
    if (!input.reason || !input.reference || !input.amountMinor) throw new FinancialError('INVALID_ADJUSTMENT');
    const adjustment = { ...input, id: createIdentifier(), status: 'REQUESTED' as const };
    await this.repository.saveAdjustment(adjustment); await this.audit.append({ category: 'BUSINESS', eventType: 'FINANCIAL_ADJUSTMENT_REQUESTED', actorAccountId: input.requestedByAccountId, targetType: 'FINANCIAL_ADJUSTMENT', targetId: adjustment.id, outcome: 'SUCCESS' }); return adjustment;
  }
  public async approveAdjustment(actorAccountId: string, adjustmentId: string): Promise<void> {
    await this.authorize(actorAccountId, 'ADJUSTMENT_APPROVE', adjustmentId);
    const adjustment = await this.repository.findAdjustment(adjustmentId); if (!adjustment || adjustment.requestedByAccountId === actorAccountId || adjustment.status !== 'REQUESTED' || !await this.repository.approveAdjustment(adjustmentId, actorAccountId)) return this.denied(actorAccountId, 'FINANCIAL_ADJUSTMENT', adjustmentId);
    await this.audit.append({ category: 'BUSINESS', eventType: 'FINANCIAL_ADJUSTMENT_APPROVED', actorAccountId, targetType: 'FINANCIAL_ADJUSTMENT', targetId: adjustmentId, outcome: 'SUCCESS' });
  }
  private async denied(accountId: string, targetType: string, targetId: string): Promise<never> { await this.audit.append({ category: 'AUTHORIZATION', eventType: 'FINANCIAL_ACCESS_DENIED', actorAccountId: accountId, targetType, targetId, outcome: 'DENIED' }); throw new FinancialError('FORBIDDEN'); }
  private async authorize(accountId: string, action: FinancialAction, targetId?: string): Promise<void> { try { await this.authorizer.authorize(accountId, action, targetId); } catch { return this.denied(accountId, 'FINANCIAL_OPERATION', targetId ?? action); } }
}
function allocation(evaluation: CommercialEvaluation, context: CommercialContext): AllocationSnapshot { const gross = money(context.grossAmountMinor, context.currency); const payable = money(gross.amountMinor - evaluation.platformCommission.amountMinor, context.currency); if (payable.amountMinor < 0n) throw new FinancialError('INVALID_ALLOCATION'); return { id: createIdentifier(), gross, platformCommission: evaluation.platformCommission, providerPayable: payable, selectedRuleVersionId: evaluation.rule.id, calculationBasis: evaluation.calculationBasis, createdAt: new Date() }; }
function paymentTransition(from: PaymentIntentStatus, to: PaymentIntentStatus): boolean { return ({ CREATED: ['PENDING_PROVIDER','FAILED','EXPIRED'], PENDING_PROVIDER: ['AUTHORIZED','SUCCEEDED','FAILED','EXPIRED','RECONCILIATION_REQUIRED'], AUTHORIZED: ['SUCCEEDED','FAILED','RECONCILIATION_REQUIRED'] } as Partial<Record<PaymentIntentStatus, string[]>>)[from]?.includes(to) ?? false; }
function webhookTransition(from: WebhookStatus, to: WebhookStatus): boolean { return ({ PERSISTED: ['PROCESSING'], PROCESSING: ['PROCESSED','RETRY_PENDING','RECONCILIATION_REQUIRED'], RETRY_PENDING: ['PROCESSING'] } as Partial<Record<WebhookStatus, string[]>>)[from]?.includes(to) ?? false; }
export class FinancialError extends Error { public constructor(public readonly code: string) { super(code); this.name = 'FinancialError'; } }
