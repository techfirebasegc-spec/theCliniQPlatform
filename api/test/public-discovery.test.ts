import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerErrorHandler } from '../src/middleware/errors.js';
import { PublicDiscoveryService, type PublicDiscoveryRepository, type PublicDoctor, type PublicService } from '../src/modules/discovery/public-discovery.js';
import type { BookableService } from '../src/modules/appointments/appointments.js';
import { registerPublicDiscoveryRoutes } from '../src/routes/public-discovery.js';

const doctors: PublicDoctor[] = [{ id: 'doctor-a', displayName: 'Doctor A' }];
const services: PublicService[] = [{ id: 'exposure-a', doctorProfileId: 'doctor-a', name: 'Consultation', description: 'Consultation description', currency: 'INR', amountMinor: '10000' }];
function bookable(versionId = 'version-a', windowStart = 36_000, windowEnd = 39_600): BookableService { return { provider: { kind: 'DOCTOR', doctorProfileId: 'doctor-a' }, serviceOfferingId: 'offering-a', versionId, priceId: `private-${versionId}`, currency: 'INR', priceAmountMinor: 10_000n, bookingTenantId: null, timezone: 'Asia/Kolkata', slotDurationSeconds: 1800, durationSeconds: 1800, bufferBeforeSeconds: 0, bufferAfterSeconds: 0, capacity: 2, bookingLeadSeconds: 0, bookingHorizonSeconds: 86_400 * 30, holdSeconds: 600, rules: [{ canonicalRecurrence: 'FREQ=WEEKLY;BYDAY=MO', effectiveFrom: new Date('2020-01-01T00:00:00Z'), effectiveTo: null, windows: [{ kind: 'WORKING', weekday: 1, startSeconds: windowStart, endSeconds: windowEnd }] }], exceptions: [] }; }

class Repository implements PublicDiscoveryRepository {
  public activeCapacity = 0; public candidates = [bookable()]; public resolved = (localStart: string) => this.candidates.find(() => localStart) ?? null;
  async listDoctors(query: string | undefined) { return query ? doctors.filter((doctor) => doctor.displayName?.toLowerCase().includes(query.toLowerCase())) : doctors; }
  async findDoctor(id: string) { return doctors.find((doctor) => doctor.id === id) ?? null; }
  async listServices(filter: { doctorProfileId?: string; query?: string }) { return services.filter((service) => (!filter.doctorProfileId || service.doctorProfileId === filter.doctorProfileId) && (!filter.query || service.name.toLowerCase().includes(filter.query.toLowerCase()))); }
  async findCandidateServices(id: string) { return id === 'exposure-a' ? this.candidates : []; }
  async findBookableService(id: string, localStart: string) { return id === 'exposure-a' ? this.resolved(localStart) : null; }
  async activeCapacityUnits() { return this.activeCapacity; }
}

function setup() { const repository = new Repository(); const service = new PublicDiscoveryService(repository, () => new Date('2030-01-01T00:00:00Z')); const app = Fastify(); registerErrorHandler(app); void app.register(async (instance) => registerPublicDiscoveryRoutes(instance, { discovery: service })); return { app, repository }; }

describe('Phase 8.6 public discovery', () => {
  it('returns only eligible public doctor and service fields without a session', async () => {
    const { app } = setup();
    const doctorsResponse = await app.inject({ method: 'GET', url: '/v1/public/doctors?q=doctor' }); const servicesResponse = await app.inject({ method: 'GET', url: '/v1/public/service-exposures?doctorProfileId=doctor-a' });
    expect(doctorsResponse.statusCode).toBe(200); expect(doctorsResponse.json()).toEqual({ items: doctors }); expect(servicesResponse.statusCode).toBe(200); expect(servicesResponse.json()).toEqual({ items: services }); expect(servicesResponse.body).not.toContain('private-version-a'); expect(servicesResponse.body).not.toContain('accountId'); await app.close();
  });
  it('returns public doctor details with only that doctor\'s public services and hides ineligible doctors', async () => {
    const { app } = setup(); const response = await app.inject({ method: 'GET', url: '/v1/public/doctors/doctor-a' }); expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ doctor: doctors[0], services }); expect((await app.inject({ method: 'GET', url: '/v1/public/doctors/doctor-ineligible' })).statusCode).toBe(404); await app.close();
  });
  it('generates slots from a non-midnight-aligned working window', async () => {
    const { app, repository } = setup(); repository.candidates = [bookable('version-a', 33_300, 38_700)];
    const response = await app.inject({ method: 'GET', url: '/v1/public/service-exposures/exposure-a/availability?date=2030-01-07' });
    expect(response.statusCode).toBe(200); expect((response.json() as { slots: { localStart: string }[] }).slots.map((slot) => slot.localStart)).toEqual(['2030-01-07T09:15:00', '2030-01-07T09:45:00', '2030-01-07T10:15:00']); await app.close();
  });
  it('generates slots from a non-midnight-aligned one-off window', async () => {
    const { app, repository } = setup(); const oneOff = bookable('version-a'); oneOff.rules = []; oneOff.exceptions = [{ kind: 'ONE_OFF', status: 'ACTIVE', start: new Date('2030-01-07T03:45:00Z'), end: new Date('2030-01-07T04:45:00Z') }]; repository.candidates = [oneOff];
    const response = await app.inject({ method: 'GET', url: '/v1/public/service-exposures/exposure-a/availability?date=2030-01-07' });
    expect((response.json() as { slots: { localStart: string }[] }).slots.map((slot) => slot.localStart)).toEqual(['2030-01-07T09:15:00', '2030-01-07T09:45:00']); await app.close();
  });
  it('resolves the effective version separately for each candidate start', async () => {
    const { app, repository } = setup(); const before = bookable('version-before', 32_400, 36_000); const after = bookable('version-after', 36_000, 39_600); repository.candidates = [before, after]; repository.resolved = (localStart) => localStart < '2030-01-07T10:00:00' ? before : after;
    const response = await app.inject({ method: 'GET', url: '/v1/public/service-exposures/exposure-a/availability?date=2030-01-07' }); const slots = (response.json() as { slots: { localStart: string }[] }).slots.map((slot) => slot.localStart);
    expect(slots).toEqual(['2030-01-07T09:00:00', '2030-01-07T09:30:00', '2030-01-07T10:00:00', '2030-01-07T10:30:00']); await app.close();
  });
  it('returns remaining capacity and rejects invalid or unpublished availability requests', async () => {
    const { app, repository } = setup(); repository.activeCapacity = 1; const response = await app.inject({ method: 'GET', url: '/v1/public/service-exposures/exposure-a/availability?date=2030-01-07' }); expect((response.json() as { slots: { remainingCapacity: number }[] }).slots[0]).toMatchObject({ remainingCapacity: 1 }); repository.activeCapacity = 2; expect((await app.inject({ method: 'GET', url: '/v1/public/service-exposures/exposure-a/availability?date=2030-01-07' })).json()).toMatchObject({ slots: [] }); expect((await app.inject({ method: 'GET', url: '/v1/public/service-exposures/exposure-a/availability?date=not-a-date' })).statusCode).toBe(409); expect((await app.inject({ method: 'GET', url: '/v1/public/service-exposures/hidden/availability?date=2030-01-07' })).statusCode).toBe(404); await app.close();
  });
});
