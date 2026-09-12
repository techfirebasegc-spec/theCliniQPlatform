import { describe, expect, it } from 'vitest';
import { AppointmentAuthorizationError, AppointmentAuthorizationService, type AppointmentAccessContext, type AppointmentAuthorizationRepository } from '../src/modules/appointments/appointment-authorization.js';
import type { PostgresExecutor } from '../src/modules/sessions/postgres-session-repository.js';

const patientDoctor: AppointmentAccessContext = { id: 'appointment-doctor', participants: [{ type: 'PATIENT', patientProfileId: 'patient-a' }, { type: 'DOCTOR', doctorProfileId: 'doctor-a' }] };
const patientClinic: AppointmentAccessContext = { id: 'appointment-clinic', participants: [{ type: 'PATIENT', patientProfileId: 'patient-a' }, { type: 'CLINIC', clinicId: 'clinic-a', tenantId: 'tenant-a' }] };

class Repository implements AppointmentAuthorizationRepository {
  public contexts = new Map([[patientDoctor.id, patientDoctor], [patientClinic.id, patientClinic]]);
  public eligibleDoctor = true;
  public async findAccessContext(id: string) { return this.contexts.get(id) ?? null; }
  public async accountOwnsPatientProfile(account: string, profile: string) { return account === 'patient-account' && profile === 'patient-a'; }
  public async accountOwnsDoctorProfile(account: string, profile: string) { return account === 'doctor-account' && profile === 'doctor-a'; }
  public async accountOwnsEligibleDoctorProfile(account: string, profile: string) { return this.eligibleDoctor && account === 'doctor-account' && profile === 'doctor-a'; }
  public async findAccessContextForUpdate(_db: PostgresExecutor, id: string) { return this.findAccessContext(id); }
  public async accountOwnsPatientProfileForUpdate(_db: PostgresExecutor, account: string, profile: string) { return this.accountOwnsPatientProfile(account, profile); }
  public async accountOwnsDoctorProfileForUpdate(_db: PostgresExecutor, account: string, profile: string) { return this.accountOwnsDoctorProfile(account, profile); }
  public async accountOwnsEligibleDoctorProfileForUpdate(_db: PostgresExecutor, account: string, profile: string) { return this.accountOwnsEligibleDoctorProfile(account, profile); }
}

function setup() {
  const repository = new Repository(); const audit: unknown[] = []; const permissions = new Set(['owner:tenant-a:appointment.view', 'owner:tenant-a:appointment.complete', 'owner:tenant-a:appointment.cancel', 'admin:tenant-a:appointment.view', 'admin:tenant-a:appointment.complete', 'admin:tenant-a:appointment.cancel', 'staff:tenant-a:appointment.view']);
  const require = async (account: string, tenant: string, permission: string) => { if (!permissions.has(`${account}:${tenant}:${permission}`)) throw new Error('FORBIDDEN'); return { id: 'membership', accountId: account, tenantId: tenant, role: 'CLINIC_STAFF' as const, status: 'ACTIVE' as const }; };
  const context = { require, requireInTransaction: async (_db: unknown, account: string, tenant: string, permission: string) => require(account, tenant, permission) };
  return { repository, audit, permissions, service: new AppointmentAuthorizationService(repository, context, { append: async (event) => { audit.push(event); } }) };
}

describe('theCliniQ Phase 5.4 appointment operational access', () => {
  it('allows a patient only to view/cancel their own immutable patient participation', async () => {
    const { service } = setup();
    await expect(service.authorize('patient-account', 'appointment-doctor', 'appointment.view')).resolves.toEqual(patientDoctor);
    await expect(service.authorize('patient-account', 'appointment-doctor', 'appointment.cancel')).resolves.toEqual(patientDoctor);
    await expect(service.authorize('patient-account', 'appointment-doctor', 'appointment.start')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service.authorize('other-patient', 'appointment-doctor', 'appointment.view')).rejects.toBeInstanceOf(AppointmentAuthorizationError);
  });

  it('requires participating doctor ownership and current eligibility for sensitive operations', async () => {
    const { service, repository } = setup();
    await expect(service.authorize('doctor-account', 'appointment-doctor', 'appointment.view')).resolves.toEqual(patientDoctor);
    await expect(service.authorize('doctor-account', 'appointment-doctor', 'appointment.start')).resolves.toEqual(patientDoctor);
    await expect(service.authorize('unrelated-doctor', 'appointment-doctor', 'appointment.complete')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    repository.eligibleDoctor = false;
    await expect(service.authorize('doctor-account', 'appointment-doctor', 'appointment.view')).resolves.toEqual(patientDoctor);
    await expect(service.authorize('doctor-account', 'appointment-doctor', 'appointment.complete')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('requires a current clinic permission in addition to immutable clinic participation', async () => {
    const { service, permissions } = setup();
    await expect(service.authorize('staff', 'appointment-clinic', 'appointment.view')).resolves.toEqual(patientClinic);
    await expect(service.authorize('staff', 'appointment-clinic', 'appointment.start')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service.authorize('staff', 'appointment-clinic', 'appointment.complete')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service.authorize('owner', 'appointment-clinic', 'appointment.complete')).resolves.toEqual(patientClinic);
    await expect(service.authorize('admin', 'appointment-clinic', 'appointment.cancel')).resolves.toEqual(patientClinic);
    permissions.delete('staff:tenant-a:appointment.view');
    await expect(service.authorize('staff', 'appointment-clinic', 'appointment.view')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('does not grant ordinary access to support, IDs, tenant context, or missing authentication', async () => {
    const { service, audit } = setup();
    await expect(service.authorize(undefined, 'appointment-clinic', 'appointment.view')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(service.authorize('support-account', 'appointment-clinic', 'appointment.view')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service.authorize('owner', 'unknown-appointment', 'appointment.view')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(audit).toEqual(expect.arrayContaining([expect.objectContaining({ eventType: 'APPOINTMENT_ACCESS_DENIED', outcome: 'DENIED' })]));
  });
});

describe('theCliniQ transactional appointment authorization', () => {
  it('revalidates current doctor eligibility and clinic permission under the lifecycle transaction', async () => {
    const { service, repository, permissions } = setup();
    await expect(service.authorizeInTransaction({ query: undefined as never }, 'doctor-account', 'appointment-doctor', 'appointment.cancel')).resolves.toEqual(patientDoctor);
    repository.eligibleDoctor = false;
    await expect(service.authorizeInTransaction({ query: undefined as never }, 'doctor-account', 'appointment-doctor', 'appointment.cancel')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    permissions.delete('admin:tenant-a:appointment.cancel');
    await expect(service.authorizeInTransaction({ query: undefined as never }, 'admin', 'appointment-clinic', 'appointment.cancel')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
