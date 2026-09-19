import { afterEach, describe, expect, it, vi } from 'vitest';
import { RefundExecutionService, type RefundExecutionRepository } from '../src/modules/appointments/cancellation-refunds.js';
import { ProviderOperationError, RazorpayPaymentProvider, type PaymentProvider, type ProviderRefund } from '../src/modules/financial/provider.js';
import type { PostgresExecutor } from '../src/modules/sessions/postgres-session-repository.js';

afterEach(() => vi.unstubAllGlobals());

const facts = (status: ProviderRefund['status'] = 'SUCCEEDED'): ProviderRefund => ({ status, providerRefundId: 'rfnd_1', providerPaymentId: 'pay_1', amountMinor: 1200n, currency: 'INR' });

describe('Phase 6.2 Razorpay refund provider', () => {
  it.each([['processed', 'SUCCEEDED'], ['pending', 'PROCESSING'], ['processing', 'PROCESSING'], ['failed', 'FAILED']] as const)('maps %s to %s with canonical facts', async (providerStatus, expected) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'rfnd_1', payment_id: 'pay_1', amount: 1200, currency: 'INR', status: providerStatus }), { status: 200 })));
    await expect(new RazorpayPaymentProvider('key', 'secret', 'webhook').createRefund({ providerPaymentId: 'pay_1', idempotencyKey: 'refund-key', amountMinor: 1200n, currency: 'INR' })).resolves.toMatchObject({ status: expected, providerRefundId: 'rfnd_1', providerPaymentId: 'pay_1', amountMinor: 1200n, currency: 'INR' });
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('https://api.razorpay.com/v1/payments/pay_1/refund', expect.objectContaining({ method: 'POST', body: JSON.stringify({ amount: 1200, receipt: 'refund-key' }) }));
  });
  it('rejects malformed, rejected, and unavailable provider responses', async () => {
    const provider = new RazorpayPaymentProvider('key', 'secret', 'webhook');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'rfnd_1' }), { status: 200 })));
    await expect(provider.createRefund({ providerPaymentId: 'pay_1', idempotencyKey: 'refund-key', amountMinor: 1200n, currency: 'INR' })).rejects.toMatchObject({ code: 'PROVIDER_MALFORMED' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 400 })));
    await expect(provider.createRefund({ providerPaymentId: 'pay_1', idempotencyKey: 'refund-key', amountMinor: 1200n, currency: 'INR' })).rejects.toMatchObject({ code: 'PROVIDER_REJECTED' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(provider.createRefund({ providerPaymentId: 'pay_1', idempotencyKey: 'refund-key', amountMinor: 1200n, currency: 'INR' })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
});

describe('Phase 6.2 refund execution', () => {
  it('finalizes processed and failed provider facts, but leaves pending facts processing with durable reference evidence', async () => {
    for (const [providerStatus, expected] of [['SUCCEEDED', 'SUCCEEDED'], ['FAILED', 'FAILED'], ['PROCESSING', 'PROCESSING']] as const) {
      const repository = executionRepository();
      await expect(new RefundExecutionService(repository, provider(facts(providerStatus))).execute('refund')).resolves.toEqual({ status: expected });
      if (providerStatus === 'PROCESSING') expect(repository.records).toEqual(['reference:rfnd_1']);
      else expect(repository.records).toContain(`final:${providerStatus}:rfnd_1`);
    }
  });
  it('maps a definitive rejection to failed and unknown outcomes to reconciliation-required', async () => {
    const rejected = executionRepository();
    await expect(new RefundExecutionService(rejected, providerError('PROVIDER_REJECTED')).execute('refund')).resolves.toEqual({ status: 'FAILED' });
    expect(rejected.records).toContain('final:FAILED:none');
    const unknown = executionRepository();
    await expect(new RefundExecutionService(unknown, providerError('PROVIDER_UNAVAILABLE')).execute('refund')).resolves.toEqual({ status: 'RECONCILIATION_REQUIRED' });
    expect(unknown.records).toContain('final:RECONCILIATION_REQUIRED:none');
  });
  it('permits one concurrent claim and replays a matching webhook-finalized refund', async () => {
    const repository = executionRepository({ replaySuccess: true });
    const paymentProvider = provider(facts());
    const service = new RefundExecutionService(repository, paymentProvider);
    await expect(Promise.all([service.execute('refund'), service.execute('refund')])).resolves.toEqual(expect.arrayContaining([{ status: 'SUCCEEDED' }, { status: 'PROCESSING' }]));
    expect(paymentProvider.createRefund).toHaveBeenCalledTimes(1);
    expect(repository.records).toContain('final:SUCCEEDED:rfnd_1');
  });
});

function executionRepository(options: { replaySuccess?: boolean } = {}) {
  let claimed = false;
  const records: string[] = [];
  const repository: RefundExecutionRepository = {
    transaction: async <T>(operation: (database: PostgresExecutor) => Promise<T>) => operation({ query: undefined as never }),
    claimRefund: async () => {
      if (claimed) return { refund: { id: 'refund', status: 'PROCESSING', paymentProviderId: 'pay_1', providerKey: 'RAZORPAY', idempotencyKey: 'refund-key', amountMinor: 1200n, currency: 'INR' }, attempt: null };
      claimed = true; return { refund: { id: 'refund', status: 'REQUESTED', paymentProviderId: 'pay_1', providerKey: 'RAZORPAY', idempotencyKey: 'refund-key', amountMinor: 1200n, currency: 'INR' }, attempt: { id: 'attempt', attemptNumber: 1 } };
    },
    recordProviderRefund: async (_db, input) => { records.push(`reference:${input.providerRefundId}`); return 'PROCESSING'; },
    finalizeRefund: async (_db, input) => { records.push(`final:${input.status}:${input.providerRefundId ?? 'none'}`); return options.replaySuccess && input.status === 'SUCCEEDED' ? 'SUCCEEDED' : input.status; },
    appendAudit: async (_db, event) => { records.push(`audit:${event.eventType}`); return 'audit'; },
  };
  return Object.assign(repository, { records });
}

function provider(refund: ProviderRefund): PaymentProvider & { createRefund: ReturnType<typeof vi.fn> } {
  return { key: 'RAZORPAY', createOrder: async () => { throw new Error('unused'); }, findOrderByReceipt: async () => null, verifyPayment: async () => ({ status: 'FAILED', providerPaymentId: null, providerOrderId: 'unused', amountMinor: null, currency: null }), verifyWebhook: () => false, createRefund: vi.fn(async () => refund), createSettlement: async () => ({ providerSettlementId: 'unused' }) } as PaymentProvider & { createRefund: ReturnType<typeof vi.fn> };
}
function providerError(code: ProviderOperationError['code']): PaymentProvider {
  return { key: 'RAZORPAY', createOrder: async () => { throw new Error('unused'); }, findOrderByReceipt: async () => null, verifyPayment: async () => ({ status: 'FAILED', providerPaymentId: null, providerOrderId: 'unused', amountMinor: null, currency: null }), verifyWebhook: () => false, createRefund: async () => { throw new ProviderOperationError(code); }, createSettlement: async () => ({ providerSettlementId: 'unused' }) };
}
