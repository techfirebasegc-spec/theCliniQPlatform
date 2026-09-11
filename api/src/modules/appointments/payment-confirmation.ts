import { createHash } from 'node:crypto';
import type { PaymentProvider } from '../financial/provider.js';

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
}

export class PaymentConfirmationError extends Error {
  public constructor(public readonly code: 'INVALID_SIGNATURE' | 'MALFORMED_EVENT') { super(code); this.name = 'PaymentConfirmationError'; }
}

/** Raw-body provider ingress. It never trusts internal identifiers from a request. */
export class PaymentConfirmationService {
  public constructor(private readonly provider: PaymentProvider, private readonly repository: PaymentConfirmationRepository) {}

  public async receiveRazorpayWebhook(rawBody: string, signature: string | undefined, eventId: string | undefined): Promise<{ status: 'CONFIRMED' | 'REPLAYED' | 'RECONCILIATION_REQUIRED' | 'IGNORED' }> {
    if (!signature || !this.provider.verifyWebhook({ payload: rawBody, signature })) throw new PaymentConfirmationError('INVALID_SIGNATURE');
    const parsed = object(parse(rawBody));
    const type = string(parsed.event);
    const id = eventId?.trim();
    if (!id || !type) throw new PaymentConfirmationError('MALFORMED_EVENT');
    if (type !== 'payment.captured') {
      await this.repository.ingest({ providerEventId: id, providerKey: 'RAZORPAY', eventType: type, payload: parsed, payloadRaw: rawBody });
      return { status: 'IGNORED' };
    }
    const payment = object(object(parsed.payload).payment).entity;
    const entity = object(payment);
    const providerPaymentId = string(entity.id); const providerOrderId = string(entity.order_id); const currency = string(entity.currency);
    const amount = entity.amount;
    if (!providerPaymentId || !providerOrderId || !currency || entity.status !== 'captured' || typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) throw new PaymentConfirmationError('MALFORMED_EVENT');
    const ingested = await this.repository.ingest({ providerEventId: id, providerKey: 'RAZORPAY', eventType: type, providerPaymentId, providerOrderId, amountMinor: BigInt(amount), currency, payload: parsed, payloadRaw: rawBody });
    if (ingested.status !== 'PERSISTED') return { status: ingested.status === 'PROCESSED' ? 'REPLAYED' : ingested.status === 'RECONCILIATION_REQUIRED' ? 'RECONCILIATION_REQUIRED' : 'IGNORED' };
    return this.repository.confirm('RAZORPAY', id);
  }
}

export function payloadHash(raw: string): string { return createHash('sha256').update(raw).digest('hex'); }
function parse(raw: string): unknown { try { return JSON.parse(raw); } catch { throw new PaymentConfirmationError('MALFORMED_EVENT'); } }
function object(value: unknown): Record<string, unknown> { if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>; throw new PaymentConfirmationError('MALFORMED_EVENT'); }
function string(value: unknown): string { return typeof value === 'string' && value.trim() ? value : ''; }
