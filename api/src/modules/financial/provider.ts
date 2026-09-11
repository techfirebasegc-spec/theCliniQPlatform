import { createHmac, timingSafeEqual } from 'node:crypto';

export interface PaymentProvider {
  readonly key: string;
  createOrder(input: { receipt: string; amountMinor: bigint; currency: string }): Promise<ProviderOrder>;
  findOrderByReceipt(input: { receipt: string }): Promise<ProviderOrder | null>;
  verifyPayment(input: { providerPaymentId: string; providerOrderId?: string }): Promise<{ status: 'SUCCEEDED' | 'FAILED' | 'RECONCILIATION_REQUIRED' }>;
  verifyWebhook(input: { payload: string; signature: string }): boolean;
  createRefund(input: { providerPaymentId: string; idempotencyKey: string; amountMinor: bigint; currency: string }): Promise<{ providerRefundId: string }>;
  createSettlement(input: { beneficiaryReference: string; idempotencyKey: string; amountMinor: bigint; currency: string }): Promise<{ providerSettlementId: string }>;
}

export interface ProviderOrder { providerOrderId: string; receipt: string; amountMinor: bigint; currency: string; }

/** Server-only boundary. Credentials are injected at runtime and never persisted. */
export class RazorpayPaymentProvider implements PaymentProvider {
  public readonly key = 'RAZORPAY';
  public constructor(private readonly keyId: string, private readonly keySecret: string, private readonly webhookSecret: string) {}
  public async createOrder(input: { receipt: string; amountMinor: bigint; currency: string }): Promise<ProviderOrder> {
    const response = await this.request('/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: safeAmount(input.amountMinor), currency: input.currency, receipt: input.receipt }),
    });
    return order(await json(response));
  }
  public async findOrderByReceipt(input: { receipt: string }): Promise<ProviderOrder | null> {
    const response = await this.request(`/orders?receipt=${encodeURIComponent(input.receipt)}`);
    const body = object(await json(response));
    const matches = array(body.items).map(order).filter((value) => value.receipt === input.receipt);
    if (matches.length > 1) throw new ProviderOperationError('PROVIDER_CONFLICT');
    return matches[0] ?? null;
  }
  public async verifyPayment(input: { providerPaymentId: string; providerOrderId?: string }): Promise<{ status: 'SUCCEEDED' | 'FAILED' | 'RECONCILIATION_REQUIRED' }> { void input; throw new ProviderOperationUnavailable(); }
  public verifyWebhook(input: { payload: string; signature: string }): boolean {
    const expected = createHmac('sha256', this.webhookSecret).update(input.payload).digest('hex');
    const actual = Buffer.from(input.signature, 'hex'); const candidate = Buffer.from(expected, 'hex');
    return actual.length === candidate.length && timingSafeEqual(actual, candidate);
  }
  public async createRefund(input: { providerPaymentId: string; idempotencyKey: string; amountMinor: bigint; currency: string }): Promise<{ providerRefundId: string }> { void input; throw new ProviderOperationUnavailable(); }
  public async createSettlement(input: { beneficiaryReference: string; idempotencyKey: string; amountMinor: bigint; currency: string }): Promise<{ providerSettlementId: string }> { void input; throw new ProviderOperationUnavailable(); }
  private async request(path: string, init?: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`https://api.razorpay.com/v1${path}`, {
        ...init,
        headers: { ...init?.headers, authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}` },
      });
    } catch {
      throw new ProviderOperationError('PROVIDER_UNAVAILABLE');
    }
    if (!response.ok) throw new ProviderOperationError(response.status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_REJECTED');
    return response;
  }
}
export class ProviderOperationUnavailable extends Error { public constructor() { super('PROVIDER_OPERATION_UNAVAILABLE'); this.name = 'ProviderOperationUnavailable'; } }
export class ProviderOperationError extends Error { public constructor(public readonly code: 'PROVIDER_UNAVAILABLE' | 'PROVIDER_REJECTED' | 'PROVIDER_CONFLICT') { super(code); this.name = 'ProviderOperationError'; } }

function safeAmount(value: bigint): number { if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ProviderOperationError('PROVIDER_REJECTED'); return Number(value); }
async function json(response: Response): Promise<unknown> { try { return await response.json(); } catch { throw new ProviderOperationError('PROVIDER_REJECTED'); } }
function order(value: unknown): ProviderOrder {
  const body = object(value);
  const amount = body.amount;
  if (typeof body.id !== 'string' || typeof body.receipt !== 'string' || typeof body.currency !== 'string' || typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) throw new ProviderOperationError('PROVIDER_REJECTED');
  return { providerOrderId: body.id, receipt: body.receipt, amountMinor: BigInt(amount), currency: body.currency };
}
function object(value: unknown): Record<string, unknown> { if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>; throw new ProviderOperationError('PROVIDER_REJECTED'); }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
