import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { ServiceOfferingError, ServiceOfferingService, type ServiceOffering, type ServiceOfferingRepository, type ServiceOfferingVersion } from '../src/modules/service-offerings/service-offerings.js';
import { registerErrorHandler } from '../src/middleware/errors.js';
import { registerServiceOfferingRoutes } from '../src/routes/service-offerings.js';
import { hashSessionSecret, type SessionAuthenticatorRepository } from '../src/modules/sessions/session.js';

class Repository implements ServiceOfferingRepository {
  public offerings = new Map<string, ServiceOffering>();
  public versions = new Map<string, ServiceOfferingVersion>();
  public doctorAccounts = new Map([['doctor-a', 'account-doctor-a'], ['doctor-b', 'account-doctor-b']]);
  public clinics = new Map([['clinic-a', 'tenant-a'], ['clinic-b', 'tenant-b']]);
  public transactions = 0;
  async transaction<T>(operation: Parameters<ServiceOfferingRepository['transaction']>[0]): Promise<T> { this.transactions += 1; return operation({ query: async () => ({ rows: [], rowCount: 0 }) }); }
  async find(id: string) { return this.offerings.get(id) ?? null; }
  async findDoctorOwnedForAccount(id: string, accountId: string) { const item = this.offerings.get(id); return item?.owner.kind === 'DOCTOR' && this.doctorAccounts.get(item.owner.doctorProfileId) === accountId ? item : null; }
  async create(_db: unknown, value: ServiceOffering) { this.offerings.set(value.id, value); }
  async update(_db: unknown, id: string, mutation: { name: string; description?: string | null; status: ServiceOffering['status'] }) { const current = this.offerings.get(id); if (!current) return null; const result = { ...current, name: mutation.name, description: mutation.description ?? null, status: mutation.status }; this.offerings.set(id, result); return result; }
  async createVersion(_db: unknown, value: ServiceOfferingVersion) {
    if ([...this.versions.values()].some((item) => item.serviceOfferingId === value.serviceOfferingId && item.versionNumber === value.versionNumber)) throw { code: '23505' };
    if ([...this.versions.values()].some((item) => item.serviceOfferingId === value.serviceOfferingId && overlaps(item, value))) throw { code: '23P01' };
    this.versions.set(value.id, Object.freeze(value));
  }
  async findApplicableVersion(offeringId: string, at: Date) { return [...this.versions.values()].filter((item) => item.serviceOfferingId === offeringId && item.status === 'ACTIVE' && item.effectiveFrom <= at && (!item.effectiveTo || item.effectiveTo > at)).sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0] ?? null; }
  async doctorProfileOwned(accountId: string, doctorProfileId: string) { return this.doctorAccounts.get(doctorProfileId) === accountId; }
  async clinicTenant(clinicId: string) { return this.clinics.get(clinicId) ?? null; }
}
function overlaps(left: ServiceOfferingVersion, right: ServiceOfferingVersion) { const leftEnd = left.effectiveTo?.getTime() ?? Number.POSITIVE_INFINITY; const rightEnd = right.effectiveTo?.getTime() ?? Number.POSITIVE_INFINITY; return left.effectiveFrom.getTime() < rightEnd && right.effectiveFrom.getTime() < leftEnd; }
function setup() {
  const repository = new Repository(); const audit = { events: [] as unknown[], append: async (event: unknown) => { audit.events.push(event); } };
  const allowed = new Set(['account-clinic-owner:tenant-a', 'account-clinic-admin:tenant-a']);
  const context = { require: async (accountId: string, tenantId: string, permission: string) => { if (permission !== 'clinic.manage' || !allowed.has(`${accountId}:${tenantId}`)) throw new Error('FORBIDDEN'); return { id: 'membership', accountId, tenantId, role: 'CLINIC_OWNER' as const, status: 'ACTIVE' as const }; }, isPlatformAdministrator: async (accountId: string) => accountId === 'platform-admin' };
  return { repository, audit, allowed, service: new ServiceOfferingService(repository, context, audit) };
}
const active = { versionNumber: 1, status: 'ACTIVE' as const, effectiveFrom: new Date('2026-10-01T00:00:00Z'), currency: 'INR', amountMinor: 12_500n };

describe('theCliniQ Phase 5 Step 1 Service Offering foundation', () => {
  it('returns applicable and newly created versions with string exact-minor-unit amounts over HTTP', async () => {
    const { service } = setup();
    const offering = await service.create('account-doctor-a', { owner: { kind: 'DOCTOR', doctorProfileId: 'doctor-a' }, name: 'Consultation', status: 'ACTIVE' });
    await service.createVersion('account-doctor-a', offering.id, { ...active, effectiveTo: new Date('2027-01-01T00:00:00Z') });
    const app = Fastify();
    registerErrorHandler(app);
    const sessions: SessionAuthenticatorRepository = { findBySecretHash: async (hash) => hash === hashSessionSecret('doctor') ? { id: 'session', accountId: 'account-doctor-a', status: 'ACTIVE', idleExpiresAt: new Date('2031-01-01'), absoluteExpiresAt: new Date('2031-01-01') } : null, touch: async () => ({ updated: true }) };
    await registerServiceOfferingRoutes(app, { offerings: service, sessions, sessionPolicy: { idleTtlSeconds: 600, absoluteTtlSeconds: 3600 } });

    const applicable = await app.inject({ method: 'GET', url: `/v1/service-offerings/${offering.id}/versions/applicable?at=2026-10-15T00:00:00.000Z`, headers: { cookie: 'cliniq_session=session.doctor' } });
    expect(applicable.statusCode).toBe(200);
    expect(applicable.json()).toMatchObject({ price: { currency: 'INR', amountMinor: '12500' } });

    const created = await app.inject({ method: 'POST', url: `/v1/service-offerings/${offering.id}/versions`, headers: { cookie: 'cliniq_session=session.doctor' }, payload: { versionNumber: 2, status: 'ACTIVE', effectiveFrom: '2027-01-01T00:00:00.000Z', currency: 'INR', amountMinor: '13000' } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ price: { currency: 'INR', amountMinor: '13000' } });
    await app.close();
  });

  it('lets an authenticated doctor create and manage only their own doctor-owned offering', async () => {
    const { service } = setup(); const offering = await service.create('account-doctor-a', { owner: { kind: 'DOCTOR', doctorProfileId: 'doctor-a' }, name: 'Consultation', status: 'DRAFT' });
    await expect(service.update('account-doctor-a', offering.id, { name: 'Updated', status: 'ACTIVE' })).resolves.toMatchObject({ name: 'Updated', status: 'ACTIVE' });
    await expect(service.read('account-doctor-b', offering.id)).rejects.toBeInstanceOf(ServiceOfferingError);
    await expect(service.create('account-doctor-b', { owner: { kind: 'DOCTOR', doctorProfileId: 'doctor-a' }, name: 'Spoofed', status: 'DRAFT' })).rejects.toBeInstanceOf(ServiceOfferingError);
  });

  it('uses active clinic manage permission for clinic-owned offerings and denies staff, patients, and other tenants', async () => {
    const { service } = setup();
    const offering = await service.create('account-clinic-owner', { owner: { kind: 'CLINIC', clinicId: 'clinic-a' }, name: 'Clinic Consultation', status: 'DRAFT' });
    await expect(service.update('account-clinic-admin', offering.id, { name: 'Admin update', status: 'ACTIVE' })).resolves.toMatchObject({ status: 'ACTIVE' });
    await expect(service.read('account-clinic-staff', offering.id)).rejects.toBeInstanceOf(ServiceOfferingError);
    await expect(service.read('patient-account', offering.id)).rejects.toBeInstanceOf(ServiceOfferingError);
    await expect(service.read('account-other-tenant', offering.id)).rejects.toBeInstanceOf(ServiceOfferingError);
    await expect(service.create('account-clinic-owner', { owner: { kind: 'CLINIC', clinicId: 'clinic-b' }, name: 'Cross tenant', status: 'DRAFT' })).rejects.toBeInstanceOf(ServiceOfferingError);
  });

  it('allows only a persisted Platform Admin to manage doctor-owned offerings they do not own', async () => {
    const { service } = setup();
    const offering = await service.create('account-doctor-a', { owner: { kind: 'DOCTOR', doctorProfileId: 'doctor-a' }, name: 'Consultation', status: 'DRAFT' });
    await expect(service.update('platform-admin', offering.id, { name: 'Platform update', status: 'ACTIVE' })).resolves.toMatchObject({ name: 'Platform update' });
    await expect(service.update('support-account', offering.id, { name: 'Denied', status: 'ACTIVE' })).rejects.toBeInstanceOf(ServiceOfferingError);
  });

  it('rejects unauthenticated, invalid doctor-owner, invalid money, currency, and effective-range operations without owner spoofing', async () => {
    const { service } = setup();
    await expect(service.create(undefined, { owner: { kind: 'DOCTOR', doctorProfileId: 'doctor-a' }, name: 'No auth', status: 'DRAFT' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(service.create('account-doctor-a', { owner: { kind: 'DOCTOR', doctorProfileId: 'missing-doctor' }, name: 'Invalid', status: 'DRAFT' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const offering = await service.create('account-doctor-a', { owner: { kind: 'DOCTOR', doctorProfileId: 'doctor-a' }, name: 'Consultation', status: 'DRAFT' });
    await expect(service.createVersion('account-doctor-a', offering.id, { ...active, amountMinor: -1n })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(service.createVersion('account-doctor-a', offering.id, { ...active, currency: 'inr' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(service.createVersion('account-doctor-a', offering.id, { ...active, effectiveTo: new Date('2026-09-01T00:00:00Z') })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('creates immutable non-overlapping exact-minor-unit price versions and selects historical prices deterministically', async () => {
    const { service, repository } = setup(); const offering = await service.create('account-doctor-a', { owner: { kind: 'DOCTOR', doctorProfileId: 'doctor-a' }, name: 'Consultation', status: 'ACTIVE' });
    const first = await service.createVersion('account-doctor-a', offering.id, { ...active, effectiveTo: new Date('2026-11-01T00:00:00Z') });
    const second = await service.createVersion('account-doctor-a', offering.id, { ...active, versionNumber: 2, effectiveFrom: new Date('2026-11-01T00:00:00Z'), amountMinor: 15_000n });
    await expect(service.createVersion('account-doctor-a', offering.id, { ...active, versionNumber: 3, effectiveFrom: new Date('2026-10-15T00:00:00Z') })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(service.applicableVersion('account-doctor-a', offering.id, new Date('2026-10-15T00:00:00Z'))).resolves.toMatchObject({ id: first.id, price: { amountMinor: 12_500n, currency: 'INR' } });
    await expect(service.applicableVersion('account-doctor-a', offering.id, new Date('2026-11-15T00:00:00Z'))).resolves.toMatchObject({ id: second.id, price: { amountMinor: 15_000n } });
    expect(Object.isFrozen(repository.versions.get(first.id))).toBe(true);
  });

  it('audits successful creation/versioning and denied ownership-sensitive operations', async () => {
    const { service, audit } = setup(); const offering = await service.create('account-doctor-a', { owner: { kind: 'DOCTOR', doctorProfileId: 'doctor-a' }, name: 'Consultation', status: 'DRAFT' });
    await service.createVersion('account-doctor-a', offering.id, active);
    await expect(service.update('account-doctor-b', offering.id, { name: 'Denied', status: 'ACTIVE' })).rejects.toBeInstanceOf(ServiceOfferingError);
    expect(audit.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: 'SERVICE_OFFERING_CREATED', outcome: 'SUCCESS' }),
      expect.objectContaining({ eventType: 'SERVICE_OFFERING_VERSION_CREATED', outcome: 'SUCCESS' }),
      expect.objectContaining({ eventType: 'SERVICE_OFFERING_ACCESS_DENIED', outcome: 'DENIED' }),
    ]));
  });
});
