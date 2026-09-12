import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PaymentConfirmationService } from '../src/modules/appointments/payment-confirmation.js';
import { PaymentOrderProvisioningService, providerReceipt, type PaymentOrderProvisioningRepository } from '../src/modules/appointments/payment-order-provisioning.js';

describe('theCliniQ Phase 5 Step 5.3 payment boundaries', () => {
  it('fails before claiming or contacting Razorpay when the provider is unconfigured', async () => {
    let claimed = false;
    const repository: PaymentOrderProvisioningRepository = {
      claim: async () => { claimed = true; throw new Error('must not claim'); },
      finalize: async () => { throw new Error('must not finalize'); },
      reconcile: async () => { throw new Error('must not reconcile'); },
    };
    await expect(new PaymentOrderProvisioningService(repository, undefined, undefined).provision('patient', 'intent')).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
    expect(claimed).toBe(false);
  });

  it('uses a deterministic non-sensitive receipt and finalizes only after provider validation', async () => {
    const calls: string[] = [];
    const repository: PaymentOrderProvisioningRepository = {
      claim: async () => ({ kind: 'CLAIMED', paymentIntentId: '11111111-1111-4111-8111-111111111111', receipt: providerReceipt('11111111-1111-4111-8111-111111111111'), claimToken: '22222222-2222-4222-8222-222222222222', amountMinor: 1200n, currency: 'INR' }),
      finalize: async ({ order }) => { calls.push(`finalize:${order.providerOrderId}`); return { providerOrderId: order.providerOrderId, amountMinor: 1200n, currency: 'INR' }; },
      reconcile: async () => { calls.push('reconcile'); },
    };
    const provider = { key: 'RAZORPAY', findOrderByReceipt: async () => null, createOrder: async (value: { receipt: string }) => ({ providerOrderId: 'order_1', receipt: value.receipt, amountMinor: 1200n, currency: 'INR' }), verifyWebhook: () => false, verifyPayment: async () => ({ status: 'SUCCEEDED' as const }), createRefund: async () => ({ providerRefundId: 'x' }), createSettlement: async () => ({ providerSettlementId: 'x' }) };
    const result = await new PaymentOrderProvisioningService(repository, provider, 60).provision('patient', 'intent');
    expect(result).toMatchObject({ state: 'PENDING_PROVIDER', providerOrderId: 'order_1' });
    expect(providerReceipt('11111111-1111-4111-8111-111111111111')).toHaveLength(38);
    expect(providerReceipt('11111111-1111-4111-8111-111111111111')).not.toContain('patient');
    expect(calls).toEqual(['finalize:order_1']);
  });

  it('authenticates raw Razorpay payment.captured before passing only provider facts to confirmation', async () => {
    const secret = 'test-webhook-secret'; const raw = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1', amount: 1200, currency: 'INR', status: 'captured' } } } });
    const received: unknown[] = [];
    const confirmation = new PaymentConfirmationService({ key: 'RAZORPAY', createOrder: async () => { throw new Error('unused'); }, findOrderByReceipt: async () => null, verifyPayment: async () => ({ status: 'SUCCEEDED' }), verifyWebhook: ({ payload, signature }) => createHmac('sha256', secret).update(payload).digest('hex') === signature, createRefund: async () => ({ providerRefundId: 'x' }), createSettlement: async () => ({ providerSettlementId: 'x' }) }, { ingest: async (event) => { received.push(event); return { eventId: 'event-row', status: 'PERSISTED' as const }; }, confirm: async () => ({ status: 'CONFIRMED' as const }) });
    const signature = createHmac('sha256', secret).update(raw).digest('hex');
    await expect(confirmation.receiveRazorpayWebhook(raw, 'bad', 'evt_1')).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
    await expect(confirmation.receiveRazorpayWebhook(raw, signature, 'evt_1')).resolves.toEqual({ status: 'CONFIRMED' });
    expect(received[0]).toMatchObject({ providerOrderId: 'order_1', providerPaymentId: 'pay_1', amountMinor: 1200n, currency: 'INR' });
  });
});
