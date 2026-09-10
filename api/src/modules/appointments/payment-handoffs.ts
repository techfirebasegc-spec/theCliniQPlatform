import { createHash } from 'node:crypto';
import { createIdentifier } from '../../shared/identifiers/uuid.js';
import type { AuditEventInput } from '../audit/audit.js';
import { evaluateCommercialRule, type CommercialRuleVersion } from '../financial/commercial.js';
import type { PaymentProviderKey } from '../financial/provider-registry.js';
import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';
import { AppointmentError, type AppointmentIntent, type SlotReservation } from './appointments.js';

export interface PaymentHandoffInput { idempotencyKey: string; }
export interface PaymentHandoff {
  id: string;
  appointmentIntentId: string;
  slotReservationId: string;
  financialAllocationSnapshotId: string;
  paymentIntentId: string;
  currency: string;
  amountMinor: bigint;
  state: 'PAYMENT_PENDING';
}
type PaymentHandoffOutcome = { handoff: PaymentHandoff; replayed: boolean } | { error: 'FORBIDDEN' | 'CONFLICT' };

interface CommercialSelection { at: Date; rules: CommercialRuleVersion[]; }

export interface PaymentHandoffRepository {
  transaction<T>(operation: (database: PostgresExecutor) => Promise<T>): Promise<T>;
  lockIntent(database: PostgresExecutor, id: string): Promise<AppointmentIntent | null>;
  lockReservationForIntent(database: PostgresExecutor, intentId: string): Promise<SlotReservation | null>;
  lockHandoff(database: PostgresExecutor, intentId: string): Promise<(PaymentHandoff & { bookingActorAccountId: string; idempotencyKey: string; requestFingerprint: string }) | null>;
  activePatient(database: PostgresExecutor, accountId: string): Promise<boolean>;
  revalidateDirectBooking(database: PostgresExecutor, intent: AppointmentIntent): Promise<boolean>;
  reservationIsCurrent(database: PostgresExecutor, reservationId: string): Promise<boolean>;
  expireReservation(database: PostgresExecutor, reservationId: string): Promise<boolean>;
  transitionIntent(database: PostgresExecutor, id: string, from: AppointmentIntent['state'], to: AppointmentIntent['state']): Promise<boolean>;
  selectCommercialRules(database: PostgresExecutor, intent: AppointmentIntent): Promise<CommercialSelection>;
  createAllocation(database: PostgresExecutor, value: AllocationWrite): Promise<void>;
  createPaymentIntent(database: PostgresExecutor, value: PaymentIntentWrite): Promise<void>;
  createHandoff(database: PostgresExecutor, value: HandoffWrite): Promise<void>;
  appendAudit(database: PostgresExecutor, event: AuditEventInput): Promise<void>;
}

interface AllocationWrite {
  id: string;
  intent: AppointmentIntent;
  reservation: SlotReservation;
  actorAccountId: string;
  grossAmountMinor: bigint;
  currency: string;
  platformCommissionMinor: bigint;
  providerPayableMinor: bigint;
  selectedRuleVersionId: string;
  calculationBasis: string;
}

interface PaymentIntentWrite { id: string; providerKey: PaymentProviderKey; idempotencyKey: string; allocationSnapshotId: string; currency: string; amountMinor: bigint; actorAccountId: string; }
interface HandoffWrite { id: string; intentId: string; reservationId: string; allocationSnapshotId: string; paymentIntentId: string; actorAccountId: string; idempotencyKey: string; requestFingerprint: string; }

export class PaymentHandoffService {
  public constructor(private readonly repository: PaymentHandoffRepository, private readonly providerKey: PaymentProviderKey) {}

  public async create(accountId: string | undefined, intentId: string, input: PaymentHandoffInput): Promise<{ handoff: PaymentHandoff; replayed: boolean }> {
    const actor = requireAccount(accountId);
    const fingerprint = requestFingerprint(actor, intentId, input.idempotencyKey);
    const outcome: PaymentHandoffOutcome = await this.repository.transaction(async (database) => {
      const intent = await this.repository.lockIntent(database, intentId);
      if (!intent || intent.patientAccountId !== actor || intent.bookingActorAccountId !== actor || intent.bookingRelationship !== 'PATIENT_PROVIDER') return this.denied(database, actor, intentId);
      if (!await this.repository.activePatient(database, actor)) return this.denied(database, actor, intent.id);

      const reservation = await this.repository.lockReservationForIntent(database, intent.id);
      if (!reservation || reservation.appointmentIntentId !== intent.id) return this.conflict(database, actor, intent.id);
      const existing = await this.repository.lockHandoff(database, intent.id);

      if (!await this.repository.reservationIsCurrent(database, reservation.id)) {
        if (reservation.status === 'HELD' && (intent.state === 'SLOT_RESERVED' || intent.state === 'PAYMENT_PENDING') && await this.repository.expireReservation(database, reservation.id)) {
          await this.repository.transitionIntent(database, intent.id, intent.state, 'EXPIRED');
          await this.repository.appendAudit(database, audit('APPOINTMENT_PAYMENT_HANDOFF_EXPIRED', actor, intent.id, 'SUCCESS'));
        }
        return this.conflict(database, actor, intent.id);
      }

      if (existing) {
        if (existing.bookingActorAccountId !== actor || existing.idempotencyKey !== input.idempotencyKey || existing.requestFingerprint !== fingerprint) return this.conflict(database, actor, intent.id);
        if (intent.state !== 'PAYMENT_PENDING') return this.conflict(database, actor, intent.id);
        await this.repository.appendAudit(database, audit('APPOINTMENT_PAYMENT_HANDOFF_REPLAYED', actor, existing.id, 'SUCCESS'));
        return { handoff: existing, replayed: true };
      }

      if (intent.state !== 'SLOT_RESERVED' || !await this.repository.revalidateDirectBooking(database, intent)) return this.conflict(database, actor, intent.id);
      let evaluation;
      try {
        const selection = await this.repository.selectCommercialRules(database, intent);
        evaluation = evaluateCommercialRule(selection.rules, {
          at: selection.at, currency: intent.currency, grossAmountMinor: intent.priceAmountMinor,
          scopes: directBookingScopes(intent),
        });
      } catch {
        return this.conflict(database, actor, intent.id);
      }
      const providerPayableMinor = intent.priceAmountMinor - evaluation.platformCommission.amountMinor;
      if (providerPayableMinor < 0n) return this.conflict(database, actor, intent.id);

      const allocationSnapshotId = createIdentifier();
      const paymentIntentId = createIdentifier();
      const handoffId = createIdentifier();
      await this.repository.createAllocation(database, {
        id: allocationSnapshotId, intent, reservation, actorAccountId: actor, grossAmountMinor: intent.priceAmountMinor,
        currency: intent.currency, platformCommissionMinor: evaluation.platformCommission.amountMinor,
        providerPayableMinor, selectedRuleVersionId: evaluation.rule.id, calculationBasis: evaluation.calculationBasis,
      });
      await this.repository.createPaymentIntent(database, {
        id: paymentIntentId, providerKey: this.providerKey, idempotencyKey: providerIdempotencyKey(actor, intent.id, input.idempotencyKey),
        allocationSnapshotId, currency: intent.currency, amountMinor: intent.priceAmountMinor, actorAccountId: actor,
      });
      await this.repository.createHandoff(database, {
        id: handoffId, intentId: intent.id, reservationId: reservation.id, allocationSnapshotId, paymentIntentId,
        actorAccountId: actor, idempotencyKey: input.idempotencyKey, requestFingerprint: fingerprint,
      });
      if (!await this.repository.transitionIntent(database, intent.id, 'SLOT_RESERVED', 'PAYMENT_PENDING')) return this.conflict(database, actor, intent.id);
      const handoff: PaymentHandoff = { id: handoffId, appointmentIntentId: intent.id, slotReservationId: reservation.id, financialAllocationSnapshotId: allocationSnapshotId, paymentIntentId, currency: intent.currency, amountMinor: intent.priceAmountMinor, state: 'PAYMENT_PENDING' };
      await this.repository.appendAudit(database, audit('APPOINTMENT_PAYMENT_HANDOFF_CREATED', actor, handoff.id, 'SUCCESS'));
      return { handoff, replayed: false };
    });
    if ('error' in outcome) throw new AppointmentError(outcome.error);
    return outcome;
  }

  private async denied(database: PostgresExecutor, actor: string, targetId: string): Promise<PaymentHandoffOutcome> {
    await this.repository.appendAudit(database, audit('APPOINTMENT_ACCESS_DENIED', actor, targetId, 'DENIED'));
    return { error: 'FORBIDDEN' };
  }

  private async conflict(database: PostgresExecutor, actor: string, targetId: string): Promise<PaymentHandoffOutcome> {
    await this.repository.appendAudit(database, audit('APPOINTMENT_PAYMENT_HANDOFF_CONFLICT', actor, targetId, 'DENIED'));
    return { error: 'CONFLICT' };
  }
}

function requireAccount(accountId: string | undefined): string { if (!accountId) throw new AppointmentError('UNAUTHORIZED'); return accountId; }
function audit(eventType: string, actorAccountId: string, targetId: string, outcome: 'SUCCESS' | 'DENIED'): AuditEventInput { return { category: outcome === 'SUCCESS' ? 'BUSINESS' : 'SECURITY', eventType, actorAccountId, targetType: 'APPOINTMENT_PAYMENT_HANDOFF', targetId, outcome }; }
function requestFingerprint(actor: string, intentId: string, key: string) { return hash(`payment-handoff:v1:${actor}:${intentId}:${key}`); }
function providerIdempotencyKey(actor: string, intentId: string, key: string) { return hash(`payment-intent:v1:${actor}:${intentId}:${key}`); }
function hash(value: string) { return createHash('sha256').update(value).digest('base64url'); }
function directBookingScopes(intent: AppointmentIntent): Record<string, string | undefined> {
  return {
    DOCTOR: intent.provider.kind === 'DOCTOR' ? intent.provider.doctorProfileId : undefined,
    CLINIC: intent.provider.kind === 'CLINIC' ? intent.provider.clinicId : undefined,
    SERVICE: intent.serviceOfferingId,
    BOOKING_CONTEXT: 'PATIENT_PROVIDER',
  };
}
