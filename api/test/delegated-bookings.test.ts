import { describe, expect, it } from 'vitest';
import { DelegatedBookingError, DelegatedBookingService, type DelegatedBookingRepository } from '../src/modules/appointments/delegated-bookings.js';

describe('Phase 5.9 delegated booking authorization', () => {
  it('denies a patient attempting to execute a delegated booking when no Clinic Owner/Admin membership is present', async () => {
    let created = false;
    const authorization = { id: 'authorization-a', patientAccountId: 'patient-a', delegatedClinicId: 'clinic-a', delegatedTenantId: 'tenant-a', targetDoctorProfileId: 'doctor-a', serviceExposureId: 'exposure-a', serviceOfferingId: 'offering-a', approvedStartsAt: new Date('2031-01-01T10:00:00Z'), approvedEndsAt: new Date('2031-01-01T10:30:00Z'), expiresAt: new Date('2031-01-01T11:00:00Z'), status: 'ACTIVE' as const };
    const repository = {
      transaction: async <T>(operation: (database: never) => Promise<T>) => operation(undefined as never),
      findBookingByIdempotency: async () => null,
      lockAuthorization: async () => authorization,
      lockBookingContext: async () => null,
      createBooking: async () => { created = true; },
    } as unknown as DelegatedBookingRepository;
    const audit = { append: async () => {} };
    const service = new DelegatedBookingService(repository, audit, () => new Date('2030-01-01T00:00:00Z'));
    await expect(service.book('patient-a', { authorizationId: authorization.id, idempotencyKey: 'attempt-a' })).rejects.toMatchObject({ code: 'FORBIDDEN' } satisfies Partial<DelegatedBookingError>);
    expect(created).toBe(false);
  });
});
