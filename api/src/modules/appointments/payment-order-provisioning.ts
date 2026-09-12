import { createIdentifier } from '../../shared/identifiers/uuid.js';
import { ProviderOperationError, type PaymentProvider, type ProviderOrder } from '../financial/provider.js';

export type ProvisioningAttempt = {
  id: string;
  paymentIntentId: string;
  providerKey: string;
  receipt: string;
  status: 'READY' | 'CLAIMED' | 'FINALIZED' | 'RECONCILIATION_REQUIRED';
  claimToken: string | null;
  leaseExpiresAt: Date | null;
};

export type ProvisioningClaim =
  | { kind: 'CLAIMED'; paymentIntentId: string; receipt: string; claimToken: string; amountMinor: bigint; currency: string }
  | { kind: 'PENDING_PROVIDER'; paymentIntentId: string; providerOrderId: string; amountMinor: bigint; currency: string }
  | { kind: 'PROCESSING' | 'RECONCILIATION_REQUIRED'; paymentIntentId: string };

export interface PaymentOrderProvisioningRepository {
  claim(accountId: string, appointmentIntentId: string, leaseSeconds: number, now: Date): Promise<ProvisioningClaim>;
  finalize(input: { accountId: string; paymentIntentId: string; claimToken: string; order: ProviderOrder; now: Date }): Promise<{ providerOrderId: string; amountMinor: bigint; currency: string }>;
  reconcile(input: { paymentIntentId: string; claimToken: string; reason: string; now: Date }): Promise<void>;
}

export class PaymentOrderProvisioningError extends Error {
  public constructor(public readonly code: 'UNAUTHORIZED' | 'CONFLICT' | 'PROCESSING' | 'RECONCILIATION_REQUIRED' | 'PROVIDER_NOT_CONFIGURED' | 'PROVIDER_UNAVAILABLE') {
    super(code);
    this.name = 'PaymentOrderProvisioningError';
  }
}

/**
 * Creates or recovers a server-owned provider Order. The provider request is
 * deliberately outside PostgreSQL transactions; claim/finalize are separate
 * short transactions in the repository.
 */
export class PaymentOrderProvisioningService {
  public constructor(private readonly repository: PaymentOrderProvisioningRepository, private readonly provider: PaymentProvider | undefined, private readonly leaseSeconds: number | undefined, private readonly now: () => Date = () => new Date()) {}

  public async provision(accountId: string | undefined, appointmentIntentId: string): Promise<{ state: 'PENDING_PROVIDER' | 'PROCESSING'; providerOrderId?: string; amountMinor?: bigint; currency?: string }> {
    if (!accountId) throw new PaymentOrderProvisioningError('UNAUTHORIZED');
    const provider = this.provider;
    const leaseSeconds = this.leaseSeconds;
    if (!provider || typeof leaseSeconds !== 'number' || !Number.isInteger(leaseSeconds) || leaseSeconds <= 0) throw new PaymentOrderProvisioningError('PROVIDER_NOT_CONFIGURED');
    const claim = await this.repository.claim(accountId, appointmentIntentId, leaseSeconds, this.now());
    if (claim.kind === 'PENDING_PROVIDER') return { state: 'PENDING_PROVIDER', providerOrderId: claim.providerOrderId, amountMinor: claim.amountMinor, currency: claim.currency };
    if (claim.kind === 'PROCESSING') return { state: 'PROCESSING' };
    if (claim.kind === 'RECONCILIATION_REQUIRED') throw new PaymentOrderProvisioningError('RECONCILIATION_REQUIRED');
    if (claim.kind !== 'CLAIMED') throw new PaymentOrderProvisioningError('CONFLICT');

    try {
      const order = await provider.findOrderByReceipt({ receipt: claim.receipt })
        ?? await provider.createOrder({ receipt: claim.receipt, amountMinor: claim.amountMinor, currency: claim.currency });
      const finalized = await this.repository.finalize({ accountId, paymentIntentId: claim.paymentIntentId, claimToken: claim.claimToken, order, now: this.now() });
      return { state: 'PENDING_PROVIDER', ...finalized };
    } catch (error) {
      // Repository conflicts are authoritative local outcomes, not provider failures.
      if (error instanceof PaymentOrderProvisioningError) {
        // The failed finalize transaction has rolled back. Persist any applicable
        // reconciliation evidence in its own short transaction, never inside it.
        if (error.code === 'CONFLICT') await this.repository.reconcile({ paymentIntentId: claim.paymentIntentId, claimToken: claim.claimToken, reason: 'FINALIZATION_CONFLICT', now: this.now() });
        throw error;
      }
      if (!(error instanceof ProviderOperationError)) throw new PaymentOrderProvisioningError('PROVIDER_UNAVAILABLE');
      if (error.code !== 'PROVIDER_UNAVAILABLE') {
        await this.repository.reconcile({ paymentIntentId: claim.paymentIntentId, claimToken: claim.claimToken, reason: error.code, now: this.now() });
        throw new PaymentOrderProvisioningError('CONFLICT');
      }
      throw new PaymentOrderProvisioningError('PROVIDER_UNAVAILABLE');
    }
  }
}

export function providerReceipt(paymentIntentId: string): string {
  const normalized = paymentIntentId.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(normalized)) throw new PaymentOrderProvisioningError('CONFLICT');
  return `clqpi_${normalized}`;
}

export function newClaimToken(): string { return createIdentifier(); }
