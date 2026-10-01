import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { AdminReadError, AdminReadService, type AdminReadRepository } from '../src/modules/admin-read/admin-read.js';
import { registerErrorHandler } from '../src/middleware/errors.js';
import { registerAdminReadRoutes } from '../src/routes/admin-read.js';
import { hashSessionSecret, type SessionAuthenticatorRepository } from '../src/modules/sessions/session.js';

function repository(): AdminReadRepository {
  return {
    listContexts: async (accountId) => accountId === 'admin-a' ? [{ membershipId: 'membership-a', tenantId: 'tenant-a', role: 'CLINIC_ADMIN', access: 'TENANT_MEMBERSHIP', clinic: { id: 'clinic-a', displayName: 'Clinic A', status: 'ACTIVE' } }] : [],
    listAllActiveContexts: async () => [{ membershipId: null, tenantId: 'tenant-a', role: 'PLATFORM_ADMIN', access: 'PLATFORM_ADMIN', clinic: { id: 'clinic-a', displayName: 'Clinic A', status: 'ACTIVE' } }, { membershipId: null, tenantId: 'tenant-b', role: 'PLATFORM_ADMIN', access: 'PLATFORM_ADMIN', clinic: { id: 'clinic-b', displayName: 'Clinic B', status: 'ACTIVE' } }],
    listMemberships: async () => [{ id: 'membership-a', accountId: 'admin-a', role: 'CLINIC_ADMIN', status: 'ACTIVE' }],
    countMemberships: async () => 1,
    listAppointments: async () => [{ id: 'appointment-a', patientProfileId: 'patient-a', patientDisplayName: 'Patient A', serviceOfferingId: 'service-a', serviceName: 'Consultation', status: 'CONFIRMED', startsAt: new Date('2030-01-02T10:00:00Z'), endsAt: new Date('2030-01-02T10:30:00Z') }],
    countAppointments: async () => 1,
    listServices: async () => [{ id: 'service-a', name: 'Consultation', description: null, status: 'ACTIVE' }],
    countServices: async () => 1,
  };
}

function context() { return { require: async (accountId: string, tenantId: string, permission: string) => { if (accountId === 'platform-admin' && ['tenant-a', 'tenant-b'].includes(tenantId)) return { kind: 'PLATFORM_ADMIN' as const, accountId, tenantId }; if (accountId !== 'admin-a' || tenantId !== 'tenant-a' || !['membership.view', 'appointment.view', 'clinic.view'].includes(permission)) throw new Error('FORBIDDEN'); return { kind: 'TENANT_MEMBERSHIP' as const, membership: { id: 'membership-a', accountId, tenantId, role: 'CLINIC_ADMIN' as const, status: 'ACTIVE' as const } }; } }; }
function entitlements(platformAdmin = false) { return { hasActiveEntitlement: async (accountId: string) => platformAdmin && accountId === 'platform-admin' }; }
function sessions(): SessionAuthenticatorRepository { return { findBySecretHash: async (hash) => hash === hashSessionSecret('secret') ? { id: 'session-a', accountId: 'admin-a', status: 'ACTIVE', idleExpiresAt: new Date('2031-01-01T00:00:00Z'), absoluteExpiresAt: new Date('2031-01-01T00:00:00Z') } : null, touch: async () => ({ updated: true }) }; }

describe('admin reads', () => {
  it('returns only server-derived active contexts and enforces tenant permissions before reads', async () => {
    const service = new AdminReadService(repository(), context(), entitlements());
    await expect(service.contexts('admin-a')).resolves.toMatchObject([{ tenantId: 'tenant-a', role: 'CLINIC_ADMIN' }]);
    await expect(service.memberships('admin-a', 'tenant-a', { limit: 25, offset: 0 })).resolves.toMatchObject({ items: [{ accountId: 'admin-a' }], page: { total: 1 } });
    await expect(service.services('admin-a', 'tenant-a', { limit: 25, offset: 0 })).resolves.toMatchObject({ items: [{ name: 'Consultation' }], page: { total: 1 } });
    await expect(service.memberships('admin-a', 'tenant-b', { limit: 25, offset: 0 })).rejects.toBeInstanceOf(AdminReadError);
    await expect(service.appointments(undefined, 'tenant-a', { limit: 25, offset: 0 })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('returns all active tenant contexts and permits cross-tenant reads only for a persisted Platform Admin', async () => {
    const service = new AdminReadService(repository(), context(), entitlements(true));
    await expect(service.contexts('platform-admin')).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ tenantId: 'tenant-a', role: 'PLATFORM_ADMIN', membershipId: null })]));
    await expect(service.memberships('platform-admin', 'tenant-b', { limit: 25, offset: 0 })).resolves.toMatchObject({ page: { total: 1 } });
    await expect(service.appointments('platform-admin', 'tenant-b', { limit: 25, offset: 0 })).resolves.toMatchObject({ page: { total: 1 } });
  });

  it('authenticates the request session, validates filters, and does not authorize an arbitrary tenant id', async () => {
    const app = Fastify(); registerErrorHandler(app);
    void app.register(async (instance) => registerAdminReadRoutes(instance, { reads: new AdminReadService(repository(), context(), entitlements()), sessions: sessions(), sessionPolicy: { idleTtlSeconds: 600, absoluteTtlSeconds: 3600 } }));
    const headers = { cookie: 'cliniq_session=session-a.secret' };
    expect((await app.inject({ method: 'GET', url: '/v1/admin/context' })).statusCode).toBe(401);
    const appointments = await app.inject({ method: 'GET', url: '/v1/admin/tenants/tenant-a/appointments?from=2030-01-02&to=2030-01-03&status=CONFIRMED&limit=10&offset=0', headers });
    expect(appointments.statusCode).toBe(200);
    expect(appointments.json()).toMatchObject({ items: [{ id: 'appointment-a', status: 'CONFIRMED' }], page: { limit: 10, offset: 0, total: 1 } });
    expect((await app.inject({ method: 'GET', url: '/v1/admin/tenants/tenant-b/memberships', headers })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/admin/tenants/tenant-a/appointments?status=UNKNOWN', headers })).statusCode).toBe(409);
    await app.close();
  });
});
