import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerErrorHandler } from '../src/middleware/errors.js';
import { PlatformAdminError, PlatformAdminService, type PlatformAdminRepository } from '../src/modules/platform-admin/platform-admin.js';
import { hashSessionSecret, type SessionAuthenticatorRepository } from '../src/modules/sessions/session.js';
import { registerPlatformAdminRoutes } from '../src/routes/platform-admin.js';
import { PublicDiscoveryControlService } from '../src/modules/platform-admin/public-discovery-control.js';
import type { AuditEventInput } from '../src/modules/audit/audit.js';

function repository(): PlatformAdminRepository {
  const invitations = new Map<string, { id: string; targetAccountId: string; email: string; displayName: string | null; status: string; createdAt: Date; expiresAt: Date; revokedAt: Date | null; acceptedAt: Date | null; secretHash: string }>();
  const clinics = [{ id: 'clinic-a', tenantId: 'tenant-a', displayName: 'Clinic A', legalName: 'Clinic A Legal', clinicStatus: 'ACTIVE', tenantStatus: 'ACTIVE', ownerEmail: 'a@example.com', ownerMembershipStatus: 'ACTIVE', invitationStatus: 'ACCEPTED' }, { id: 'clinic-b', tenantId: 'tenant-b', displayName: 'Clinic B', legalName: 'Clinic B Legal', clinicStatus: 'ACTIVE', tenantStatus: 'ACTIVE', ownerEmail: 'b@example.com', ownerMembershipStatus: 'ACTIVE', invitationStatus: 'ACCEPTED' }, { id: 'clinic-c', tenantId: 'tenant-c', displayName: 'Clinic C', legalName: 'Clinic C Legal', clinicStatus: 'DRAFT', tenantStatus: 'PENDING', ownerEmail: 'c@example.com', ownerMembershipStatus: 'INVITED', invitationStatus: 'INVITED' }, { id: 'clinic-owner-pending', tenantId: 'tenant-owner-pending', displayName: 'Owner Pending Clinic', legalName: 'Owner Pending Clinic Legal', clinicStatus: 'DRAFT', tenantStatus: 'ACTIVE', ownerEmail: 'owner-pending@example.com', ownerMembershipStatus: 'INVITED', invitationStatus: 'INVITED' }, { id: 'clinic-draft', tenantId: 'tenant-draft', displayName: 'Draft Clinic', legalName: 'Draft Clinic Legal', clinicStatus: 'DRAFT', tenantStatus: 'ACTIVE', ownerEmail: 'draft@example.com', ownerMembershipStatus: 'ACTIVE', invitationStatus: 'ACCEPTED' }];
  return {
    listClinics: async () => clinics,
    findClinic: async (id) => clinics.find((clinic) => clinic.id === id) ?? null,
    listDoctors: async () => [{ id: 'doctor-a', accountId: 'doctor-account', displayName: 'Doctor A', status: 'ACTIVE', professionalVerificationStatus: 'VERIFIED', clinicNames: ['Clinic A'] }],
    findDoctor: async () => ({ id: 'doctor-a', accountId: 'doctor-account', displayName: 'Doctor A', status: 'ACTIVE', professionalVerificationStatus: 'VERIFIED', clinicNames: ['Clinic A'] }),
    listDoctorInvitations: async () => [...invitations.values()],
    metrics: async () => ({ clinics: 3, doctors: 1, patients: 2, activeInvitations: 1, upcomingAppointments: 1 }),
    transaction: async (operation) => operation({ query: async () => ({ rows: [], rowCount: 1 }) }),
    createDoctorInvitation: async (_database, _actor, invitation) => { invitations.set(invitation.id, invitation); },
    lockDoctorInvitation: async (_database, id) => invitations.get(id) ?? null,
    revokeDoctorInvitation: async (_database, id) => { const invitation = invitations.get(id); if (invitation) invitation.status = 'REVOKED'; },
    replaceDoctorInvitation: async (_database, _actor, previous, secretHash) => { const next = { ...previous, id: `${previous.id}-next`, status: 'INVITED', createdAt: new Date(), expiresAt: new Date('2031-01-01T00:00:00Z'), revokedAt: null, acceptedAt: null, secretHash }; invitations.set(next.id, next); return next; },
    lockClinicForActivation: async (_database, id) => { const clinic = clinics.find((candidate) => candidate.id === id); return clinic ? { id: clinic.id, tenantId: clinic.tenantId, clinicStatus: clinic.clinicStatus, tenantStatus: clinic.tenantStatus } : null; },
    hasActiveClinicOwner: async (_database, tenantId) => clinics.some((clinic) => clinic.tenantId === tenantId && clinic.ownerMembershipStatus === 'ACTIVE'),
    activateClinic: async (_database, id) => { const clinic = clinics.find((candidate) => candidate.id === id); if (!clinic || clinic.clinicStatus !== 'DRAFT') return null; clinic.clinicStatus = 'ACTIVE'; return clinic; },
  };
}
function audit(events: AuditEventInput[] = []) { return { append: async (event: AuditEventInput) => { events.push(event); } }; }
function sessions(): SessionAuthenticatorRepository { return { findBySecretHash: async (hash) => { if (hash === hashSessionSecret('platform')) return { id: 's-platform', accountId: 'platform-admin', status: 'ACTIVE', idleExpiresAt: new Date('2031-01-01'), absoluteExpiresAt: new Date('2031-01-01') }; if (hash === hashSessionSecret('clinic-a')) return { id: 's-a', accountId: 'clinic-a-owner', status: 'ACTIVE', idleExpiresAt: new Date('2031-01-01'), absoluteExpiresAt: new Date('2031-01-01') }; if (hash === hashSessionSecret('clinic-b')) return { id: 's-b', accountId: 'clinic-b-owner', status: 'ACTIVE', idleExpiresAt: new Date('2031-01-01'), absoluteExpiresAt: new Date('2031-01-01') }; return null; }, touch: async () => ({ updated: true }) }; }

describe('platform admin routes', () => {
  it('allows only a persisted Platform Admin to manage all clinics, doctors, and doctor invitations', async () => {
    const app = Fastify(); registerErrorHandler(app);
    const events: AuditEventInput[] = [];
    const service = new PlatformAdminService(repository(), { hasActiveEntitlement: async (id) => id === 'platform-admin' }, audit(events), () => new Date('2030-01-01T00:00:00Z'));
    const discovery = new PublicDiscoveryControlService({ transaction: async (operation) => operation({ query: async () => ({ rows: [], rowCount: 1 }) }), subjectExists: async () => false, readyExposureCount: async () => 0, approvalStatus: async () => null, setApproval: async () => undefined }, { hasActiveEntitlement: async (id) => id === 'platform-admin' });
    void app.register(async (instance) => registerPlatformAdminRoutes(instance, { platform: service, discovery, sessions: sessions(), sessionPolicy: { idleTtlSeconds: 600, absoluteTtlSeconds: 3600 } }));
    const platform = { cookie: 'cliniq_session=s-platform.platform' }; const clinicA = { cookie: 'cliniq_session=s-a.clinic-a' }; const clinicB = { cookie: 'cliniq_session=s-b.clinic-b' };
    expect((await app.inject({ method: 'GET', url: '/v1/platform/clinics' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/platform/clinics', headers: clinicA })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/platform/clinics/clinic-b', headers: clinicB })).statusCode).toBe(403);
    const clinics = await app.inject({ method: 'GET', url: '/v1/platform/clinics', headers: platform });
    expect(clinics.statusCode).toBe(200); expect(clinics.json().items).toHaveLength(5);
    expect((await app.inject({ method: 'GET', url: '/v1/platform/clinics/clinic-a', headers: platform })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/platform/clinics/clinic-b', headers: platform })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/platform/clinics/clinic-c', headers: platform })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/platform/doctors', headers: platform })).statusCode).toBe(200);
    const invited = await app.inject({ method: 'POST', url: '/v1/platform/doctor-invitations', headers: platform, payload: { email: 'doctor@example.com', displayName: 'Doctor Example' } });
    expect(invited.statusCode).toBe(201); const invitationId = invited.json().invitation.id;
    expect((await app.inject({ method: 'POST', url: `/v1/platform/doctor-invitations/${invitationId}/resend`, headers: platform })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/v1/platform/doctor-invitations/${invitationId}-next/revoke`, headers: platform })).statusCode).toBe(204);
    expect((await app.inject({ method: 'POST', url: '/v1/platform/doctor-invitations', headers: clinicA, payload: { email: 'not-allowed@example.com' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/v1/platform/clinics/clinic-draft/activate' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/v1/platform/clinics/clinic-draft/activate', headers: clinicA })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/v1/platform/clinics/clinic-c/activate', headers: platform })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/v1/platform/clinics/clinic-owner-pending/activate', headers: platform })).statusCode).toBe(409);
    const activated = await app.inject({ method: 'POST', url: '/v1/platform/clinics/clinic-draft/activate', headers: platform });
    expect(activated.statusCode).toBe(200); expect(activated.json().clinic.clinicStatus).toBe('ACTIVE');
    expect((await app.inject({ method: 'POST', url: '/v1/platform/clinics/clinic-draft/activate', headers: platform })).statusCode).toBe(409);
    expect(events).toContainEqual({ category: 'BUSINESS', eventType: 'CLINIC_ACTIVATED', actorAccountId: 'platform-admin', tenantId: 'tenant-draft', targetType: 'CLINIC', targetId: 'clinic-draft', outcome: 'SUCCESS' });
    await app.close();
  });

  it('does not allow a non-entitled caller to use the service directly', async () => {
    const service = new PlatformAdminService(repository(), { hasActiveEntitlement: async () => false }, audit());
    await expect(service.clinics('clinic-a-owner')).rejects.toBeInstanceOf(PlatformAdminError);
  });
});
