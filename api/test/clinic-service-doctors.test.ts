import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerErrorHandler } from '../src/middleware/errors.js';
import { ClinicServiceDoctorAssignmentError, ClinicServiceDoctorAssignmentService, type ClinicOwnedOffering, type ClinicServiceDoctorAssignment, type ClinicServiceDoctorAssignmentRepository } from '../src/modules/clinic-service-doctors/clinic-service-doctors.js';
import { registerClinicServiceDoctorAssignmentRoutes } from '../src/routes/clinic-service-doctors.js';
import { hashSessionSecret, type SessionAuthenticatorRepository } from '../src/modules/sessions/session.js';

const offering: ClinicOwnedOffering = { id: 'clinic-service', clinicId: 'clinic-a', tenantId: 'tenant-a' };
class Repository implements ClinicServiceDoctorAssignmentRepository {
  public assignments: ClinicServiceDoctorAssignment[] = [];
  public connections = new Map<string, string>([['doctor-a', 'connection-a'], ['doctor-b', 'connection-b']]);
  async transaction<T>(operation: Parameters<ClinicServiceDoctorAssignmentRepository['transaction']>[0]): Promise<T> { return operation({ query: async () => ({ rows: [], rowCount: 1 }) }); }
  async clinicOwnedOffering(id: string) { return id === offering.id ? offering : null; }
  async acceptedEligibleConnection(id: string, doctorId: string) { return id === offering.id ? this.connections.get(doctorId) ?? null : null; }
  async list(id: string) { return this.assignments.filter((item) => item.serviceOfferingId === id); }
  async create(_database: unknown, item: ClinicServiceDoctorAssignment) { if (this.assignments.some((value) => value.serviceOfferingId === item.serviceOfferingId && value.doctorProfileId === item.doctorProfileId && value.status === 'ACTIVE')) throw { code: '23505' }; this.assignments.push(item); }
  async revoke(_database: unknown, serviceOfferingId: string, doctorProfileId: string) { const item = this.assignments.find((value) => value.serviceOfferingId === serviceOfferingId && value.doctorProfileId === doctorProfileId && value.status === 'ACTIVE'); if (!item) return null; item.status = 'REVOKED'; item.revokedAt = new Date(); return item; }
}
function setup() {
  const repository = new Repository(); const events: unknown[] = [];
  const context = { require: async (accountId: string, tenantId: string, permission: string) => { if (!['owner', 'admin'].includes(accountId) || tenantId !== 'tenant-a' || permission !== 'clinic.manage') throw new Error('FORBIDDEN'); return { kind: 'TENANT_MEMBERSHIP' as const }; }, isPlatformAdministrator: async (accountId: string) => accountId === 'platform' };
  return { repository, events, service: new ClinicServiceDoctorAssignmentService(repository, context, { append: async (event) => { events.push(event); } }) };
}
function sessions(): SessionAuthenticatorRepository { return { findBySecretHash: async (hash) => hash === hashSessionSecret('owner') ? { id: 'session', accountId: 'owner', status: 'ACTIVE', idleExpiresAt: new Date('2031-01-01'), absoluteExpiresAt: new Date('2031-01-01') } : null, touch: async () => ({ updated: true }) }; }

describe('clinic service doctor assignments', () => {
  it('lets Clinic Owner and Clinic Admin create, list, and revoke an accepted doctor assignment while retaining history', async () => {
    const { service, events } = setup();
    const created = await service.create('owner', 'clinic-service', 'doctor-a');
    expect(created).toMatchObject({ status: 'ACTIVE', networkConnectionId: 'connection-a' });
    await expect(service.list('admin', 'clinic-service')).resolves.toHaveLength(1);
    await expect(service.revoke('admin', 'clinic-service', 'doctor-a')).resolves.toMatchObject({ id: created.id, status: 'REVOKED' });
    await expect(service.list('owner', 'clinic-service')).resolves.toEqual([expect.objectContaining({ id: created.id, status: 'REVOKED' })]);
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ eventType: 'CLINIC_SERVICE_DOCTOR_ASSIGNMENT_CREATED' }), expect.objectContaining({ eventType: 'CLINIC_SERVICE_DOCTOR_ASSIGNMENT_REVOKED' })]));
  });

  it('rejects staff, independent doctors, Platform Admin mutation, unauthenticated callers, doctor-owned offerings, and cross-clinic or unaccepted doctors', async () => {
    const { service, repository, events } = setup();
    for (const actor of ['staff', 'independent-doctor', 'platform']) await expect(service.create(actor, 'clinic-service', 'doctor-a')).rejects.toBeInstanceOf(ClinicServiceDoctorAssignmentError);
    await expect(service.create(undefined, 'clinic-service', 'doctor-a')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(service.create('owner', 'doctor-owned-service', 'doctor-a')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    for (const doctor of ['doctor-other-clinic', 'doctor-without-accepted-connection']) await expect(service.create('owner', 'clinic-service', doctor)).rejects.toMatchObject({ code: 'CONFLICT' });
    repository.connections.delete('doctor-b');
    await expect(service.create('owner', 'clinic-service', 'doctor-b')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ eventType: 'CLINIC_SERVICE_DOCTOR_ASSIGNMENT_ACCESS_DENIED' }), expect.objectContaining({ eventType: 'CLINIC_SERVICE_DOCTOR_ASSIGNMENT_REJECTED' })]));
  });

  it('prevents duplicate active assignments, while a later re-assignment creates a new lifecycle row after revocation', async () => {
    const { service } = setup();
    const first = await service.create('owner', 'clinic-service', 'doctor-a');
    await expect(service.create('owner', 'clinic-service', 'doctor-a')).rejects.toMatchObject({ code: 'CONFLICT' });
    await service.revoke('owner', 'clinic-service', 'doctor-a');
    const reassigned = await service.create('owner', 'clinic-service', 'doctor-a');
    expect(reassigned.id).not.toBe(first.id);
    await expect(service.list('platform', 'clinic-service')).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: first.id, status: 'REVOKED' }), expect.objectContaining({ id: reassigned.id, status: 'ACTIVE' })]));
  });

  it('accepts only doctorProfileId from the request and derives the clinic from the service offering', async () => {
    const { service } = setup(); const app = Fastify(); registerErrorHandler(app);
    void app.register(async (instance) => registerClinicServiceDoctorAssignmentRoutes(instance, { assignments: service, sessions: sessions(), sessionPolicy: { idleTtlSeconds: 600, absoluteTtlSeconds: 3600 } }));
    expect((await app.inject({ method: 'POST', url: '/v1/me/clinic/services/clinic-service/doctors', payload: { doctorProfileId: 'doctor-a', clinicId: 'forged', role: 'CLINIC_OWNER' } })).statusCode).toBe(401);
    const response = await app.inject({ method: 'POST', url: '/v1/me/clinic/services/clinic-service/doctors', headers: { cookie: 'cliniq_session=session.owner' }, payload: { doctorProfileId: 'doctor-a', clinicId: 'forged', role: 'CLINIC_OWNER' } });
    expect(response.statusCode).toBe(201); expect(response.json().assignment).toMatchObject({ doctorProfileId: 'doctor-a', serviceOfferingId: 'clinic-service' });
    await app.close();
  });
});
