import { createHmac, timingSafeEqual } from 'node:crypto';

export interface PaymentProvider {
  readonly key: string;
  createOrder(input: { idempotencyKey: string; amountMinor: bigint; currency: string }): Promise<{ providerOrderId: string }>;
  verifyPayment(input: { providerPaymentId: string; providerOrderId?: string }): Promise<{ status: 'SUCCEEDED' | 'FAILED' | 'RECONCILIATION_REQUIRED' }>;
  verifyWebhook(input: { payload: string; signature: string }): boolean;
  createRefund(input: { providerPaymentId: string; idempotencyKey: string; amountMinor: bigint; currency: string }): Promise<{ providerRefundId: string }>;
  createSettlement(input: { beneficiaryReference: string; idempotencyKey: string; amountMinor: bigint; currency: string }): Promise<{ providerSettlementId: string }>;
}

/** Server-only boundary. Credentials are injected at runtime and never persisted. */
export class RazorpayPaymentProvider implements PaymentProvider {
  public readonly key = 'RAZORPAY';
  public constructor(private readonly webhookSecret: string) {}
  public async createOrder(input: { idempotencyKey: string; amountMinor: bigint; currency: string }): Promise<{ providerOrderId: string }> { void input; throw new ProviderOperationUnavailable(); }
  public async verifyPayment(input: { providerPaymentId: string; providerOrderId?: string }): Promise<{ status: 'SUCCEEDED' | 'FAILED' | 'RECONCILIATION_REQUIRED' }> { void input; throw new ProviderOperationUnavailable(); }
  public verifyWebhook(input: { payload: string; signature: string }): boolean {
    const expected = createHmac('sha256', this.webhookSecret).update(input.payload).digest('hex');
    const actual = Buffer.from(input.signature, 'hex'); const candidate = Buffer.from(expected, 'hex');
    return actual.length === candidate.length && timingSafeEqual(actual, candidate);
  }
  public async createRefund(input: { providerPaymentId: string; idempotencyKey: string; amountMinor: bigint; currency: string }): Promise<{ providerRefundId: string }> { void input; throw new ProviderOperationUnavailable(); }
  public async createSettlement(input: { beneficiaryReference: string; idempotencyKey: string; amountMinor: bigint; currency: string }): Promise<{ providerSettlementId: string }> { void input; throw new ProviderOperationUnavailable(); }
}
export class ProviderOperationUnavailable extends Error { public constructor() { super('PROVIDER_OPERATION_UNAVAILABLE'); this.name = 'ProviderOperationUnavailable'; } }
