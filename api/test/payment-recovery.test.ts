import { afterEach, describe, expect, it, vi } from 'vitest';
import { RazorpayPaymentProvider, type PaymentProvider } from '../src/modules/financial/provider.js';
import { PaymentConfirmationService, type PaymentConfirmationRepository } from '../src/modules/appointments/payment-confirmation.js';

afterEach(() => vi.unstubAllGlobals());

describe('Phase 6.1 Razorpay verification and recovery', () => {
  it('retrieves exactly one canonical captured payment for the persisted order', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [{ id: 'pay_1', order_id: 'order_1', amount: 1200, currency: 'INR', status: 'captured' }] }), { status: 200 })));
    await expect(new RazorpayPaymentProvider('id', 'secret', 'webhook').verifyPayment({ providerOrderId: 'order_1' })).resolves.toEqual({ status: 'SUCCEEDED', providerPaymentId: 'pay_1', providerOrderId: 'order_1', amountMinor: 1200n, currency: 'INR' });
  });
  it('returns failed facts, rejects malformed responses, and requires reconciliation for an ambiguous order', async () => {
    const provider = new RazorpayPaymentProvider('id', 'secret', 'webhook');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [{ id: 'pay_1', order_id: 'order_1', amount: 1200, currency: 'INR', status: 'failed' }] }), { status: 200 })));
    await expect(provider.verifyPayment({ providerOrderId: 'order_1' })).resolves.toMatchObject({ status: 'FAILED', providerPaymentId: 'pay_1' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [{ id: 'pay_1', order_id: 'order_1', amount: 1200, currency: 'INR', status: 'failed' }, { id: 'pay_2', order_id: 'order_1', amount: 1200, currency: 'INR', status: 'captured' }] }), { status: 200 })));
    await expect(provider.verifyPayment({ providerOrderId: 'order_1' })).resolves.toMatchObject({ status: 'SUCCEEDED', providerPaymentId: 'pay_2' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [{ id: 'pay_1', order_id: 'order_1', amount: 1200, currency: 'INR', status: 'captured' }, { id: 'pay_2', order_id: 'order_1', amount: 1200, currency: 'INR', status: 'captured' }] }), { status: 200 })));
    await expect(provider.verifyPayment({ providerOrderId: 'order_1' })).resolves.toMatchObject({ status: 'RECONCILIATION_REQUIRED' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [{ id: 'pay_1' }] }), { status: 200 })));
    await expect(provider.verifyPayment({ providerOrderId: 'order_1' })).rejects.toMatchObject({ code: 'PROVIDER_REJECTED' });
  });
  it('uses server-verified facts only, then exactly replays the existing confirmation path', async () => {
    const ingested = new Set<string>(); const confirmed: string[] = [];
    const repository: PaymentConfirmationRepository = {
      recoveryContext: async (account, intent) => account === 'patient-a' && intent === 'intent-a' ? { providerKey: 'RAZORPAY', providerOrderId: 'order-a' } : null,
      ingest: async (event) => { if (ingested.has(event.providerEventId)) return { eventId: event.providerEventId, status: 'PROCESSED' as const }; ingested.add(event.providerEventId); return { eventId: event.providerEventId, status: 'PERSISTED' as const }; },
      confirm: async (_key, eventId) => { confirmed.push(eventId); return { status: 'CONFIRMED' as const }; },
    };
    const provider = fakeProvider({ status: 'SUCCEEDED', providerPaymentId: 'pay-a', providerOrderId: 'order-a', amountMinor: 1200n, currency: 'INR' });
    const service = new PaymentConfirmationService(provider, repository);
    await expect(service.recover('patient-a', 'intent-a')).resolves.toEqual({ status: 'CONFIRMED' });
    await expect(service.recover('patient-a', 'intent-a')).resolves.toEqual({ status: 'REPLAYED' });
    await expect(service.recover('other-patient', 'intent-a')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(confirmed).toEqual(['recovery:pay-a']);
  });
  it('does not confirm a non-captured provider payment', async () => {
    let confirmed = false;
    const repository: PaymentConfirmationRepository = { recoveryContext: async () => ({ providerKey: 'RAZORPAY', providerOrderId: 'order-a' }), ingest: async () => ({ eventId: 'event', status: 'PERSISTED' }), confirm: async () => { confirmed = true; return { status: 'CONFIRMED' }; } };
    await expect(new PaymentConfirmationService(fakeProvider({ status: 'FAILED', providerPaymentId: 'pay-a', providerOrderId: 'order-a', amountMinor: 1200n, currency: 'INR' }), repository).recover('patient-a', 'intent-a')).resolves.toEqual({ status: 'IGNORED' });
    expect(confirmed).toBe(false);
  });
});

function fakeProvider(verified: Awaited<ReturnType<PaymentProvider['verifyPayment']>>): PaymentProvider { return { key: 'RAZORPAY', createOrder: async () => { throw new Error('unused'); }, findOrderByReceipt: async () => null, verifyPayment: async () => verified, verifyWebhook: () => false, createRefund: async () => ({ providerRefundId: 'unused' }), createSettlement: async () => ({ providerSettlementId: 'unused' }) }; }
