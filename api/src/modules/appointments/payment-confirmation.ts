import { createHash } from 'node:crypto';
import { ProviderOperationError, type PaymentProvider } from '../financial/provider.js';

export type CapturedPayment = {
  providerEventId: string;
  providerKey: 'RAZORPAY';
  eventType: string;
  providerPaymentId: string;
  providerOrderId: string;
  amountMinor: bigint;
  currency: string;
  payload: Record<string, unknown>;
  payloadRaw: string;
};

export interface PaymentConfirmationRepository {
  ingest(event: CapturedPayment | { providerEventId: string; providerKey: 'RAZORPAY'; eventType: string; payload: Record<string, unknown>; payloadRaw: string }): Promise<{ eventId: string; status: 'PERSISTED' | 'UNKNOWN' | 'PROCESSED' | 'RECONCILIATION_REQUIRED' }>;
  confirm(providerKey: 'RAZORPAY', providerEventId: string): Promise<{ status: 'CONFIRMED' | 'REPLAYED' | 'RECONCILIATION_REQUIRED' | 'IGNORED' }>;
  confirmRefund?(providerKey: 'RAZORPAY', providerEventId: string): Promise<{ status: 'REPLAYED' | 'RECONCILIATION_REQUIRED' | 'IGNORED' }>;
  recoveryContext(accountId: string, appointmentIntentId: string): Promise<{ providerKey: 'RAZORPAY'; providerOrderId: string } | null>;
}

export class PaymentConfirmationError extends Error {
  public constructor(public readonly code: 'INVALID_SIGNATURE' | 'MALFORMED_EVENT') { super(code); this.name = 'PaymentConfirmationError'; }
}
export class PaymentRecoveryError extends Error { public constructor(public readonly code: 'UNAUTHORIZED' | 'CONFLICT' | 'PROVIDER_UNAVAILABLE') { super(code); this.name = 'PaymentRecoveryError'; } }

/** Raw-body provider ingress. It never trusts internal identifiers from a request. */
export class PaymentConfirmationService {
  public constructor(private readonly provider: PaymentProvider, private readonly repository: PaymentConfirmationRepository) {}

  public async receiveRazorpayWebhook(rawBody: string, signature: string | undefined, eventId: string | undefined): Promise<{ status: 'CONFIRMED' | 'REPLAYED' | 'RECONCILIATION_REQUIRED' | 'IGNORED' }> {
    if (!signature || !this.provider.verifyWebhook({ payload: rawBody, signature })) throw new PaymentConfirmationError('INVALID_SIGNATURE');
    const parsed = object(parse(rawBody));
    const type = string(parsed.event);
    const id = eventId?.trim();
    if (!id || !type) throw new PaymentConfirmationError('MALFORMED_EVENT');
    if (type === 'refund.processed') {
      const ingested = await this.repository.ingest({ providerEventId: id, providerKey: 'RAZORPAY', eventType: type, payload: parsed, payloadRaw: rawBody });
      return ingested.status === 'PERSISTED' && this.repository.confirmRefund ? this.repository.confirmRefund('RAZORPAY', id) : ingested.status === 'PROCESSED' ? { status: 'REPLAYED' } : ingested.status === 'RECONCILIATION_REQUIRED' ? { status: 'RECONCILIATION_REQUIRED' } : { status: 'IGNORED' };
    }
    if (type !== 'payment.captured') { await this.repository.ingest({ providerEventId: id, providerKey: 'RAZORPAY', eventType: type, payload: parsed, payloadRaw: rawBody }); return { status: 'IGNORED' }; }
    const payment = object(object(parsed.payload).payment).entity;
    const entity = object(payment);
    const providerPaymentId = string(entity.id); const providerOrderId = string(entity.order_id); const currency = string(entity.currency);
    const amount = entity.amount;
    if (!providerPaymentId || !providerOrderId || !currency || entity.status !== 'captured' || typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) throw new PaymentConfirmationError('MALFORMED_EVENT');
    const ingested = await this.repository.ingest({ providerEventId: id, providerKey: 'RAZORPAY', eventType: type, providerPaymentId, providerOrderId, amountMinor: BigInt(amount), currency, payload: parsed, payloadRaw: rawBody });
    if (ingested.status !== 'PERSISTED') return { status: ingested.status === 'PROCESSED' ? 'REPLAYED' : ingested.status === 'RECONCILIATION_REQUIRED' ? 'RECONCILIATION_REQUIRED' : 'IGNORED' };
    return this.repository.confirm('RAZORPAY', id);
  }
  public async recover(accountId: string | undefined, appointmentIntentId: string): Promise<{ status: 'CONFIRMED' | 'REPLAYED' | 'RECONCILIATION_REQUIRED' | 'IGNORED' }> {
    if (!accountId) throw new PaymentRecoveryError('UNAUTHORIZED');
    const context = await this.repository.recoveryContext(accountId, appointmentIntentId);
    if (!context) throw new PaymentRecoveryError('UNAUTHORIZED');
    let verified;
    try { verified = await this.provider.verifyPayment({ providerOrderId: context.providerOrderId }); }
    catch (error) { if (error instanceof ProviderOperationError && error.code === 'PROVIDER_UNAVAILABLE') throw new PaymentRecoveryError('PROVIDER_UNAVAILABLE'); throw error; }
    if (verified.status !== 'SUCCEEDED' || !verified.providerPaymentId || verified.amountMinor === null || !verified.currency) return { status: verified.status === 'RECONCILIATION_REQUIRED' ? 'RECONCILIATION_REQUIRED' : 'IGNORED' };
    const payload = { event: 'payment.captured', recovery: true, payload: { payment: { entity: { id: verified.providerPaymentId, order_id: verified.providerOrderId, amount: Number(verified.amountMinor), currency: verified.currency, status: 'captured' } } } };
    const raw = JSON.stringify(payload); const eventId = `recovery:${verified.providerPaymentId}`;
    const ingested = await this.repository.ingest({ providerEventId: eventId, providerKey: context.providerKey, eventType: 'payment.captured', providerPaymentId: verified.providerPaymentId, providerOrderId: verified.providerOrderId, amountMinor: verified.amountMinor, currency: verified.currency, payload, payloadRaw: raw });
    if (ingested.status !== 'PERSISTED') return { status: ingested.status === 'PROCESSED' ? 'REPLAYED' : ingested.status === 'RECONCILIATION_REQUIRED' ? 'RECONCILIATION_REQUIRED' : 'IGNORED' };
    return this.repository.confirm(context.providerKey, eventId);
  }
}

export function payloadHash(raw: string): string { return createHash('sha256').update(raw).digest('hex'); }
function parse(raw: string): unknown { try { return JSON.parse(raw); } catch { throw new PaymentConfirmationError('MALFORMED_EVENT'); } }
function object(value: unknown): Record<string, unknown> { if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>; throw new PaymentConfirmationError('MALFORMED_EVENT'); }
function string(value: unknown): string { return typeof value === 'string' && value.trim() ? value : ''; }
