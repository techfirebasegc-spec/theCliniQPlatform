import { describe, expect, it } from 'vitest';
import { type AppointmentIntent, AppointmentError, type ProviderInput, type SlotReservation } from '../src/modules/appointments/appointments.js';
import { PaymentHandoffService, type PaymentHandoffRepository } from '../src/modules/appointments/payment-handoffs.js';
import { resolvePaymentProviderKey } from '../src/modules/financial/provider-registry.js';

const doctor: ProviderInput = { kind: 'DOCTOR', doctorProfileId: 'doctor-a' };
const now = new Date('2030-01-01T00:00:00Z');

class Repository {
  public intent = intent(); public reservation = reservation(); public published = true; public patientActive = true; public rules = [rule()];
  public handoff: ReturnType<Repository['handoffValue']> | null = null; public allocations: unknown[] = []; public payments: unknown[] = []; public audits: unknown[] = [];
  async transaction<T>(operation: (database: never) => Promise<T>): Promise<T> { return operation({ query: async () => ({ rows: [], rowCount: 0 }) } as never); }
  async lockIntent() { return this.intent; }
  async lockReservationForIntent() { return this.reservation; }
  async lockHandoff() { return this.handoff; }
  async activePatient() { return this.patientActive; }
  async revalidateDirectBooking() { return this.published; }
  async reservationIsCurrent() { return this.reservation.status === 'HELD' && this.reservation.expiresAt > now; }
  async expireReservation() { if (this.reservation.status !== 'HELD') return false; this.reservation = { ...this.reservation, status: 'EXPIRED', expiredAt: now }; return true; }
  async transitionIntent(_database: unknown, _id: string, from: AppointmentIntent['state'], to: AppointmentIntent['state']) { if (this.intent.state !== from) return false; this.intent = { ...this.intent, state: to }; return true; }
  async selectCommercialRules() { return { at: now, rules: this.rules }; }
  async createAllocation(_database: unknown, value: unknown) { this.allocations.push(value); }
  async createPaymentIntent(_database: unknown, value: unknown) { this.payments.push(value); }
  async createHandoff(_database: unknown, value: { id: string; intentId: string; reservationId: string; allocationSnapshotId: string; paymentIntentId: string; actorAccountId: string; idempotencyKey: string; requestFingerprint: string }) { this.handoff = this.handoffValue(value); }
  async appendAudit(_database: unknown, value: unknown) { this.audits.push(value); }
  private handoffValue(value: { id: string; intentId: string; reservationId: string; allocationSnapshotId: string; paymentIntentId: string; actorAccountId: string; idempotencyKey: string; requestFingerprint: string }) { return { id: value.id, appointmentIntentId: value.intentId, slotReservationId: value.reservationId, financialAllocationSnapshotId: value.allocationSnapshotId, paymentIntentId: value.paymentIntentId, bookingActorAccountId: value.actorAccountId, idempotencyKey: value.idempotencyKey, requestFingerprint: value.requestFingerprint, currency: 'INR', amountMinor: 10_000n, state: 'PAYMENT_PENDING' as const }; }
}

function intent(): AppointmentIntent { return { id: 'intent-a', patientAccountId: 'patient-a', bookingActorAccountId: 'patient-a', bookingTenantId: null, serviceExposureId: 'exposure-a', provider: doctor, serviceOfferingId: 'offering-a', serviceOfferingVersionId: 'version-a', serviceOfferingPriceId: 'price-a', currency: 'INR', priceAmountMinor: 10_000n, providerTimezone: 'Asia/Kolkata', requestedLocalAt: '2030-01-07T10:00:00', startsAt: new Date('2030-01-07T04:30:00Z'), endsAt: new Date('2030-01-07T05:00:00Z'), serviceDurationSeconds: 1800, bufferBeforeSeconds: 0, bufferAfterSeconds: 0, holdSeconds: 600, bookingRelationship: 'PATIENT_PROVIDER', state: 'SLOT_RESERVED', idempotencyKey: 'intent-key', requestFingerprint: 'intent-fingerprint', expiresAt: new Date('2030-01-01T00:10:00Z') }; }
function reservation(): SlotReservation { return { id: 'reservation-a', appointmentIntentId: 'intent-a', serviceOfferingVersionId: 'version-a', provider: doctor, startsAt: new Date('2030-01-07T04:30:00Z'), endsAt: new Date('2030-01-07T05:00:00Z'), capacityUnits: 1, status: 'HELD', expiresAt: new Date('2030-01-01T00:10:00Z'), releasedAt: null, expiredAt: null }; }
function rule() { return { id: 'rule-version-a', ruleType: 'FIXED' as const, priority: 1, effectiveFrom: new Date('2029-01-01T00:00:00Z'), scopes: [{ kind: 'GLOBAL' as const }], policy: { fixedAmountMinor: 500n } }; }
function setup() { const repository = new Repository(); return { repository, service: new PaymentHandoffService(repository as unknown as PaymentHandoffRepository, resolvePaymentProviderKey('RAZORPAY')) }; }

describe('theCliniQ Phase 5 Step 4 payment handoff', () => {
  it('creates exactly one immutable financial handoff from a patient-owned held reservation', async () => {
    const { repository, service } = setup();
    const result = await service.create('patient-a', 'intent-a', { idempotencyKey: 'handoff-key' });
    expect(result).toMatchObject({ replayed: false, handoff: { appointmentIntentId: 'intent-a', currency: 'INR', amountMinor: 10_000n, state: 'PAYMENT_PENDING' } });
    expect(repository.intent.state).toBe('PAYMENT_PENDING'); expect(repository.allocations).toHaveLength(1); expect(repository.payments).toHaveLength(1);
    expect(repository.audits).toEqual(expect.arrayContaining([expect.objectContaining({ eventType: 'APPOINTMENT_PAYMENT_HANDOFF_CREATED', outcome: 'SUCCESS' })]));
  });

  it('returns only an exact idempotent replay without a duplicate allocation or payment intent', async () => {
    const { repository, service } = setup(); await service.create('patient-a', 'intent-a', { idempotencyKey: 'handoff-key' });
    await expect(service.create('patient-a', 'intent-a', { idempotencyKey: 'handoff-key' })).resolves.toMatchObject({ replayed: true });
    expect(repository.allocations).toHaveLength(1); expect(repository.payments).toHaveLength(1);
  });

  it('denies substituted intent IDs and never treats patient authentication as financial authority for another account', async () => {
    const { repository, service } = setup(); repository.intent = { ...repository.intent, patientAccountId: 'patient-b', bookingActorAccountId: 'patient-b' };
    await expect(service.create('patient-a', 'intent-a', { idempotencyKey: 'handoff-key' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(repository.allocations).toHaveLength(0); expect(repository.audits).toEqual(expect.arrayContaining([expect.objectContaining({ eventType: 'APPOINTMENT_ACCESS_DENIED', outcome: 'DENIED' })]));
  });

  it('fails closed for unpublished exposure, no rule, ambiguous rule, or a released/expired reservation', async () => {
    const { repository, service } = setup(); repository.published = false;
    await expect(service.create('patient-a', 'intent-a', { idempotencyKey: 'unpublished' })).rejects.toMatchObject({ code: 'CONFLICT' }); expect(repository.allocations).toHaveLength(0);
    repository.published = true; repository.rules = [];
    await expect(service.create('patient-a', 'intent-a', { idempotencyKey: 'no-rule' })).rejects.toMatchObject({ code: 'CONFLICT' });
    repository.rules = [rule(), { ...rule(), id: 'rule-version-b' }];
    await expect(service.create('patient-a', 'intent-a', { idempotencyKey: 'ambiguous' })).rejects.toMatchObject({ code: 'CONFLICT' });
    repository.rules = [rule()]; repository.reservation = { ...repository.reservation, status: 'RELEASED', releasedAt: now };
    await expect(service.create('patient-a', 'intent-a', { idempotencyKey: 'released' })).rejects.toMatchObject({ code: 'CONFLICT' }); expect(repository.allocations).toHaveLength(0);
  });

  it('expires an elapsed hold without creating financial records and preserves terminal state', async () => {
    const { repository, service } = setup(); repository.reservation = { ...repository.reservation, expiresAt: new Date('2029-12-31T23:59:59Z') };
    await expect(service.create('patient-a', 'intent-a', { idempotencyKey: 'expired' })).rejects.toBeInstanceOf(AppointmentError);
    expect(repository.reservation.status).toBe('EXPIRED'); expect(repository.intent.state).toBe('EXPIRED'); expect(repository.allocations).toHaveLength(0);
  });

  it('resolves only configured provider keys and never accepts a caller-selected provider', () => {
    expect(resolvePaymentProviderKey('RAZORPAY')).toBe('RAZORPAY'); expect(() => resolvePaymentProviderKey('ATTACKER_PROVIDER')).toThrow('Unsupported payment provider configuration.');
  });
});
