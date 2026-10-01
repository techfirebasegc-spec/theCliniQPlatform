import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerErrorHandler } from '../src/middleware/errors.js';
import { PublicDiscoveryControlError, PublicDiscoveryControlService, type DiscoveryReadinessService, type DiscoveryReadinessSubject, type PublicDiscoveryControlRepository } from '../src/modules/platform-admin/public-discovery-control.js';
import { PostgresPublicDiscoveryControlRepository } from '../src/modules/platform-admin/postgres-public-discovery-control-repository.js';
import { hashSessionSecret, type SessionAuthenticatorRepository } from '../src/modules/sessions/session.js';
import { registerPlatformAdminRoutes } from '../src/routes/platform-admin.js';
import { PlatformAdminService, type PlatformAdminRepository } from '../src/modules/platform-admin/platform-admin.js';

function controls(): PublicDiscoveryControlRepository { const states = new Map<string, 'PUBLISHED' | 'REVOKED'>(); return { transaction: async (operation) => operation({ query: async () => ({ rows: [], rowCount: 1 }) }), subjectExists: async (_kind, id) => id === 'clinic-a' || id === 'doctor-a', readyExposureCount: async (_kind, id) => id === 'clinic-a' || id === 'doctor-a' ? 1 : 0, approvalStatus: async (kind, id) => states.get(`${kind}:${id}`) ?? null, readinessSubject: async (kind, id) => id !== 'clinic-a' && id !== 'doctor-a' ? null : kind === 'CLINIC' ? { status: 'ACTIVE', tenantStatus: 'ACTIVE', professionalVerificationStatus: null } : { status: 'ACTIVE', tenantStatus: null, professionalVerificationStatus: 'VERIFIED' }, readinessServices: async () => [{ serviceId: 'service-a', serviceName: 'Consultation', serviceStatus: 'ACTIVE', versionStatus: 'ACTIVE', versionEffective: true, availabilityStatus: 'ACTIVE', exposureId: 'exposure-a', exposureStatus: 'PUBLISHED' }], setApproval: async (_database, _actor, kind, id, status) => { states.set(`${kind}:${id}`, status); } }; }
function readinessRepository(subject: DiscoveryReadinessSubject, services: DiscoveryReadinessService[], approval: 'PUBLISHED' | 'REVOKED' | null): PublicDiscoveryControlRepository { return { transaction: async (operation) => operation({ query: async () => ({ rows: [], rowCount: 1 }) }), subjectExists: async () => true, readyExposureCount: async () => 0, approvalStatus: async () => approval, readinessSubject: async () => subject, readinessServices: async () => services, setApproval: async () => undefined }; }
function platform(): PlatformAdminRepository { return { listClinics: async () => [], findClinic: async () => null, listDoctors: async () => [], findDoctor: async () => null, listDoctorInvitations: async () => [], metrics: async () => ({ clinics: 0, doctors: 0, patients: 0, activeInvitations: 0, upcomingAppointments: 0 }), transaction: async (operation) => operation({ query: async () => ({ rows: [], rowCount: 1 }) }), createDoctorInvitation: async () => undefined, lockDoctorInvitation: async () => null, revokeDoctorInvitation: async () => undefined, replaceDoctorInvitation: async () => { throw new Error('unused'); }, lockClinicForActivation: async () => null, hasActiveClinicOwner: async () => false, activateClinic: async () => null }; }
function sessions(): SessionAuthenticatorRepository { return { findBySecretHash: async (hash) => hash === hashSessionSecret('platform') ? { id: 'session-p', accountId: 'platform-admin', status: 'ACTIVE', idleExpiresAt: new Date('2031-01-01'), absoluteExpiresAt: new Date('2031-01-01') } : hash === hashSessionSecret('owner') ? { id: 'session-o', accountId: 'clinic-owner', status: 'ACTIVE', idleExpiresAt: new Date('2031-01-01'), absoluteExpiresAt: new Date('2031-01-01') } : null, touch: async () => ({ updated: true }) }; }

describe('platform public discovery control', () => {
  it('requires clinic activation or doctor professional verification before an exposure is discovery-ready', async () => {
    const queries: string[] = [];
    const repository = new PostgresPublicDiscoveryControlRepository({ query: async (query: string) => { queries.push(query); return { rows: [{ count: '0' }] }; } } as never);
    await repository.readyExposureCount('CLINIC', 'clinic-draft');
    await repository.readyExposureCount('DOCTOR', 'doctor-pending-verification');
    expect(queries[0]).toContain("clinic.status='ACTIVE'"); expect(queries[0]).toContain("tenant.status='ACTIVE'");
    expect(queries[1]).toContain("doctor.status='ACTIVE'"); expect(queries[1]).toContain("doctor.professional_verification_status='VERIFIED'");
  });

  it('derives detail facts from the same effective-version, availability, and provider predicates as discovery readiness', async () => {
    const queries: string[] = [];
    const repository = new PostgresPublicDiscoveryControlRepository({ query: async (query: string) => { queries.push(query); return { rows: [] }; } } as never);
    await repository.readinessSubject('CLINIC', 'clinic-a'); await repository.readinessSubject('DOCTOR', 'doctor-a');
    await repository.readinessServices('CLINIC', 'clinic-a'); await repository.readinessServices('DOCTOR', 'doctor-a');
    expect(queries[0]).toContain('tenant.status AS tenant_status'); expect(queries[1]).toContain('professional_verification_status');
    expect(queries[2]).toContain('offering.name AS service_name'); expect(queries[2]).toContain("version.status='ACTIVE'"); expect(queries[2]).toContain('version.effective_from<=current_timestamp'); expect(queries[2]).toContain('exposure.provider_clinic_id=offering.owner_clinic_id');
    expect(queries[3]).toContain('exposure.provider_doctor_profile_id=offering.owner_doctor_profile_id'); expect(queries[3]).toContain('availability.service_offering_version_id=version.id');
  });

  it('distinguishes not ready, unpublished, published, revoked, and republished without changing an exposure', async () => {
    const repository = controls(); const service = new PublicDiscoveryControlService(repository, { hasActiveEntitlement: async (id) => id === 'platform-admin' });
    await expect(service.status('platform-admin', 'CLINIC', 'clinic-a')).resolves.toMatchObject({ status: 'NOT_PUBLISHED', publishedExposureCount: 1 });
    await expect(service.publish('platform-admin', 'CLINIC', 'clinic-a')).resolves.toMatchObject({ status: 'PUBLISHED' });
    await expect(service.revoke('platform-admin', 'CLINIC', 'clinic-a')).resolves.toMatchObject({ status: 'REVOKED' });
    await expect(service.publish('platform-admin', 'CLINIC', 'clinic-a')).resolves.toMatchObject({ status: 'PUBLISHED' });
    await expect(service.publish('platform-admin', 'CLINIC', 'missing')).rejects.toBeInstanceOf(PublicDiscoveryControlError);
  });

  it('returns authoritative per-service clinic and doctor readiness facts without allowing the caller to supply eligibility', async () => {
    const readyService: DiscoveryReadinessService = { serviceId: 'service-a', serviceName: 'Consultation', serviceStatus: 'ACTIVE', versionStatus: 'ACTIVE', versionEffective: true, availabilityStatus: 'ACTIVE', exposureId: 'exposure-a', exposureStatus: 'PUBLISHED' };
    const clinicMissing = new PublicDiscoveryControlService(readinessRepository({ status: 'DRAFT', tenantStatus: 'PENDING', professionalVerificationStatus: null }, [{ ...readyService, exposureStatus: 'UNPUBLISHED' }], null), { hasActiveEntitlement: async (id) => id === 'platform-admin' });
    await expect(clinicMissing.readiness('platform-admin', 'CLINIC', 'clinic-a')).resolves.toMatchObject({ eligibleForPlatformDiscoveryApproval: false, ready: false, missingPrerequisites: expect.arrayContaining(['CLINIC_NOT_ACTIVE', 'TENANT_NOT_ACTIVE']), services: [expect.objectContaining({ serviceName: 'Consultation', eligibleForPlatformDiscoveryApproval: false, missingPrerequisites: expect.arrayContaining(['EXPOSURE_NOT_PUBLISHED']) })] });
    const clinicEligible = new PublicDiscoveryControlService(readinessRepository({ status: 'ACTIVE', tenantStatus: 'ACTIVE', professionalVerificationStatus: null }, [readyService], null), { hasActiveEntitlement: async (id) => id === 'platform-admin' });
    await expect(clinicEligible.readiness('platform-admin', 'CLINIC', 'clinic-a')).resolves.toMatchObject({ eligibleForPlatformDiscoveryApproval: true, ready: false, missingPrerequisites: [] });
    const clinicPublished = new PublicDiscoveryControlService(readinessRepository({ status: 'ACTIVE', tenantStatus: 'ACTIVE', professionalVerificationStatus: null }, [readyService], 'PUBLISHED'), { hasActiveEntitlement: async (id) => id === 'platform-admin' });
    await expect(clinicPublished.readiness('platform-admin', 'CLINIC', 'clinic-a')).resolves.toMatchObject({ eligibleForPlatformDiscoveryApproval: true, ready: true, services: [expect.objectContaining({ ready: true })] });
    const clinicMissingAvailability = new PublicDiscoveryControlService(readinessRepository({ status: 'ACTIVE', tenantStatus: 'ACTIVE', professionalVerificationStatus: null }, [{ ...readyService, availabilityStatus: null }], null), { hasActiveEntitlement: async (id) => id === 'platform-admin' });
    await expect(clinicMissingAvailability.readiness('platform-admin', 'CLINIC', 'clinic-a')).resolves.toMatchObject({ eligibleForPlatformDiscoveryApproval: false, missingPrerequisites: expect.arrayContaining(['NO_ACTIVE_AVAILABILITY']) });
    const doctorMissing = new PublicDiscoveryControlService(readinessRepository({ status: 'ACTIVE', tenantStatus: null, professionalVerificationStatus: 'PENDING' }, [{ ...readyService, exposureStatus: 'UNPUBLISHED' }], 'REVOKED'), { hasActiveEntitlement: async (id) => id === 'platform-admin' });
    await expect(doctorMissing.readiness('platform-admin', 'DOCTOR', 'doctor-a')).resolves.toMatchObject({ eligibleForPlatformDiscoveryApproval: false, ready: false, platformDiscoveryStatus: 'REVOKED', missingPrerequisites: expect.arrayContaining(['DOCTOR_NOT_VERIFIED', 'EXPOSURE_NOT_PUBLISHED']) });
    const doctorRevoked = new PublicDiscoveryControlService(readinessRepository({ status: 'ACTIVE', tenantStatus: null, professionalVerificationStatus: 'VERIFIED' }, [readyService], 'REVOKED'), { hasActiveEntitlement: async (id) => id === 'platform-admin' });
    await expect(doctorRevoked.readiness('platform-admin', 'DOCTOR', 'doctor-a')).resolves.toMatchObject({ eligibleForPlatformDiscoveryApproval: true, ready: false, platformDiscoveryStatus: 'REVOKED' });
  });

  it('allows only the persisted Platform Admin through the HTTP endpoints', async () => {
    const app = Fastify(); registerErrorHandler(app); const entitlement = { hasActiveEntitlement: async (id: string) => id === 'platform-admin' };
    void app.register(async (instance) => registerPlatformAdminRoutes(instance, { platform: new PlatformAdminService(platform(), entitlement, { append: async () => undefined }), discovery: new PublicDiscoveryControlService(controls(), entitlement), sessions: sessions(), sessionPolicy: { idleTtlSeconds: 600, absoluteTtlSeconds: 3600 } }));
    const admin = { cookie: 'cliniq_session=session-p.platform' }; const owner = { cookie: 'cliniq_session=session-o.owner' };
    expect((await app.inject({ method: 'POST', url: '/v1/platform/clinics/clinic-a/public-discovery/publish' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/v1/platform/clinics/clinic-a/public-discovery/publish', headers: owner })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/platform/clinics/clinic-a/discovery-readiness' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/platform/clinics/clinic-a/discovery-readiness', headers: owner })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/platform/clinics/clinic-a/discovery-readiness', headers: admin })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/v1/platform/clinics/clinic-a/public-discovery/publish', headers: admin })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/v1/platform/clinics/clinic-a/public-discovery/revoke', headers: admin })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/v1/platform/doctors/doctor-a/public-discovery/publish', headers: admin })).statusCode).toBe(200);
    await app.close();
  });
});
