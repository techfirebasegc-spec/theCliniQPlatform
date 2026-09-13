import { describe, expect, it } from 'vitest';
import type { AppointmentAuthorizationService } from '../src/modules/appointments/appointment-authorization.js';
import type { AppointmentIntent, AppointmentRepository, AvailabilityException, AvailabilityRule, BookableService, ProviderInput, SlotReservation } from '../src/modules/appointments/appointments.js';
import { RescheduleError, RescheduleService, type RescheduleRepository, type RescheduleSource } from '../src/modules/appointments/rescheduling.js';

const now = new Date('2030-01-01T00:00:00Z');
const provider: ProviderInput = { kind: 'DOCTOR', doctorProfileId: 'doctor' };
const sourceIntent: AppointmentIntent = { id: 'source-intent', patientAccountId: 'patient', bookingActorAccountId: 'patient', bookingTenantId: null, serviceExposureId: 'exposure', provider, serviceOfferingId: 'offering', serviceOfferingVersionId: 'version', serviceOfferingPriceId: 'price', currency: 'INR', priceAmountMinor: 10_000n, providerTimezone: 'Asia/Kolkata', requestedLocalAt: '2030-01-07T10:00:00', startsAt: new Date('2030-01-07T04:30:00Z'), endsAt: new Date('2030-01-07T05:00:00Z'), serviceDurationSeconds: 1800, bufferBeforeSeconds: 0, bufferAfterSeconds: 0, holdSeconds: 600, bookingRelationship: 'PATIENT_PROVIDER', state: 'SLOT_RESERVED', idempotencyKey: 'source', requestFingerprint: 'source', expiresAt: new Date('2030-01-01T00:10:00Z') };
const rule: AvailabilityRule = { canonicalRecurrence: 'FREQ=WEEKLY;BYDAY=MO', effectiveFrom: new Date('2029-01-01'), effectiveTo: null, windows: [{ kind: 'WORKING', weekday: 1, startSeconds: 9 * 3600, endSeconds: 17 * 3600 }] };

class Appointments implements AppointmentRepository {
  public intents: AppointmentIntent[] = []; public reservations: SlotReservation[] = []; public capacity = 0;
  async transaction<T>(operation: Parameters<AppointmentRepository['transaction']>[0]): Promise<T> { return operation({ query: async () => ({ rows: [], rowCount: 0 }) }); }
  async findByIdempotency() { return null; } async activePatient() { return true; } async lockPublishedExposure() { return null; }
  async lockBookable(): Promise<BookableService> { return { provider, serviceOfferingId: 'offering', versionId: 'version', priceId: 'price', currency: 'INR', priceAmountMinor: 10_000n, bookingTenantId: null, timezone: 'Asia/Kolkata', durationSeconds: 1800, bufferBeforeSeconds: 0, bufferAfterSeconds: 0, capacity: 1, bookingLeadSeconds: 60, bookingHorizonSeconds: 86_400 * 14, holdSeconds: 600, rules: [rule], exceptions: [] as AvailabilityException[] }; }
  async createIntent(_db: unknown, intent: AppointmentIntent) { this.intents.push(intent); } async lockIntent() { return null; }
  async activeCapacityUnits() { return this.capacity; } async createReservation(_db: unknown, reservation: SlotReservation) { this.reservations.push(reservation); }
  async transitionIntent(_db: unknown, id: string, from: AppointmentIntent['state'], to: AppointmentIntent['state']) { const intent=this.intents.find(x=>x.id===id); if(!intent||intent.state!==from)return false; intent.state=to; return true; }
  async findReservationIntentId() { return null; } async lockReservation() { return null; } async releaseReservation() { return false; } async expireReservation() { return false; } async appendAudit() {}
}
class Reschedules implements RescheduleRepository {
  public source: RescheduleSource = { appointmentId: 'source', status: 'CONFIRMED', reservationId: 'source-reservation', committedCapacityId: 'source-capacity', intent: { ...sourceIntent }, handoffId: 'handoff', allocationId: 'allocation', paymentIntentId: 'payment' };
  public values: Array<{ fingerprint: string; result: ReturnType<Reschedules['result']> }> = []; public released = false;
  result() { return { id: 'reschedule', sourceAppointmentId: 'source', successorAppointmentId: 'successor', successorIntentId: 'successor-intent', successorReservationId: 'successor-reservation', replayed: false }; }
  async transaction<T>(operation: Parameters<RescheduleRepository['transaction']>[0]): Promise<T> { return operation({ query: async () => ({ rows: [], rowCount: 0 }) }); }
  async lockSource() { return this.source; } async findByIdempotency(_db: unknown, _actor: string, key: string) { const found=key==='same' ? this.values[0] : undefined; return found ? { ...found.result, fingerprint: found.fingerprint } : null; }
  async createSuccessorAppointment() { return 'successor'; } async createCommittedCapacity() {} async createReschedule(_db: unknown, value: Parameters<RescheduleRepository['createReschedule']>[1]) { this.values.push({fingerprint:value.fingerprint,result:this.result()}); } async releaseSourceCapacity(){this.released=true;return true;} async appendAudit(){return 'audit';} async appendEvent() {}
}
const authorization = { authorize: async () => ({ id: 'source', participants: [] }), authorizeInTransaction: async () => ({ id: 'source', participants: [] }) } as unknown as Pick<AppointmentAuthorizationService, 'authorize' | 'authorizeInTransaction'>;
function setup(){const appointments=new Appointments(),reschedules=new Reschedules();return {appointments,reschedules,service:new RescheduleService(appointments,reschedules,authorization,()=>now)};}

describe('theCliniQ Phase 5.6 appointment rescheduling', () => {
  it('creates a distinct fulfilled successor, then releases source committed capacity atomically', async () => { const {service,appointments,reschedules}=setup(); const result=await service.reschedule('patient','source',{requestedLocalAt:'2030-01-07T11:00:00',reason:'patient request',idempotencyKey:'same'}); expect(result.replayed).toBe(false); expect(appointments.intents[0]).toMatchObject({state:'FULFILLED',serviceOfferingVersionId:'version',serviceOfferingPriceId:'price'}); expect(appointments.reservations[0]).toMatchObject({status:'HELD'}); expect(reschedules.released).toBe(true); await expect(service.reschedule('patient','source',{requestedLocalAt:'2030-01-07T11:00:00',reason:'patient request',idempotencyKey:'same'})).resolves.toMatchObject({replayed:true}); });
  it('fails closed before creating successor capacity when target capacity is exhausted or source is not confirmed', async () => { const {service,appointments,reschedules}=setup(); appointments.capacity=1; await expect(service.reschedule('patient','source',{requestedLocalAt:'2030-01-07T11:00:00',reason:'x',idempotencyKey:'one'})).rejects.toBeInstanceOf(RescheduleError); expect(appointments.intents).toHaveLength(0); reschedules.source.status='IN_PROGRESS'; appointments.capacity=0; await expect(service.reschedule('patient','source',{requestedLocalAt:'2030-01-07T11:00:00',reason:'x',idempotencyKey:'two'})).rejects.toBeInstanceOf(RescheduleError); });
});
