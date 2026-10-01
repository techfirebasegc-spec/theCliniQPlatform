import type { TenantContextService } from '../memberships/memberships.js';

export type ProviderClinic = { id: string; tenantId: string; displayName: string; legalName: string; status: string; role: 'CLINIC_OWNER' | 'CLINIC_ADMIN' | 'CLINIC_STAFF' };
export type ProviderDoctor = { id: string; displayName: string | null; status: string; professionalVerificationStatus: string };
export type ProviderClinicDoctor = ProviderDoctor & { connectionId: string; connectionStatus: 'REQUESTED' | 'ACCEPTED'; connectionInitiatorKind: 'CLINIC' | 'DOCTOR' };
export type ProviderService = { id: string; name: string; description: string | null; status: string; versionId: string | null; versionStatus: string | null; availabilityStatus: string | null; exposureId: string | null; exposureStatus: string | null; publicDiscoveryStatus: string | null };
export type ProviderAppointment = { id: string; status: string; startsAt: Date; endsAt: Date; serviceName: string };
export type ProviderDashboard = { clinic: ProviderClinic; services: number; doctors: number; availability: number; appointments: number; publicDiscovery: string };

export interface ProviderPortalRepository {
  clinics(accountId: string): Promise<ProviderClinic[]>;
  doctor(accountId: string): Promise<ProviderDoctor | null>;
  servicesForClinic(clinicId: string): Promise<ProviderService[]>;
  servicesForDoctor(doctorId: string): Promise<ProviderService[]>;
  doctorsForClinic(clinicId: string): Promise<ProviderClinicDoctor[]>;
  appointmentsForClinic(clinicId: string): Promise<ProviderAppointment[]>;
  appointmentsForDoctor(doctorId: string): Promise<ProviderAppointment[]>;
  dashboard(clinicId: string): Promise<Omit<ProviderDashboard, 'clinic'>>;
}

export class ProviderPortalError extends Error { public constructor(public readonly code: 'UNAUTHORIZED' | 'FORBIDDEN') { super(code === 'UNAUTHORIZED' ? 'Authentication is required.' : 'Provider access is not permitted.'); } }

export class ProviderPortalService {
  public constructor(private readonly repository: ProviderPortalRepository, private readonly context: Pick<TenantContextService, 'require'>) {}
  public async contextFor(accountId: string | undefined) { const actor = this.account(accountId); const [clinics, doctor] = await Promise.all([this.repository.clinics(actor), this.repository.doctor(actor)]); if (!clinics.length && !doctor) throw new ProviderPortalError('FORBIDDEN'); return { clinics, doctor }; }
  public async clinicDashboard(accountId: string | undefined, clinicId: string) { const clinic = await this.clinic(accountId, clinicId); return { clinic, ...await this.repository.dashboard(clinicId) }; }
  public async clinicServices(accountId: string | undefined, clinicId: string) { await this.clinic(accountId, clinicId); return this.repository.servicesForClinic(clinicId); }
  public async clinicDoctors(accountId: string | undefined, clinicId: string) { await this.clinic(accountId, clinicId); return this.repository.doctorsForClinic(clinicId); }
  public async clinicAppointments(accountId: string | undefined, clinicId: string) { await this.clinic(accountId, clinicId); return this.repository.appointmentsForClinic(clinicId); }
  public async doctorServices(accountId: string | undefined) { return this.repository.servicesForDoctor((await this.doctor(accountId)).id); }
  public async doctorAppointments(accountId: string | undefined) { return this.repository.appointmentsForDoctor((await this.doctor(accountId)).id); }
  private account(accountId: string | undefined) { if (!accountId) throw new ProviderPortalError('UNAUTHORIZED'); return accountId; }
  private async clinic(accountId: string | undefined, clinicId: string) { const actor = this.account(accountId); const clinic = (await this.repository.clinics(actor)).find((item) => item.id === clinicId); if (!clinic) throw new ProviderPortalError('FORBIDDEN'); try { await this.context.require(actor, clinic.tenantId, 'clinic.view'); return clinic; } catch { throw new ProviderPortalError('FORBIDDEN'); } }
  private async doctor(accountId: string | undefined) { const doctor = await this.repository.doctor(this.account(accountId)); if (!doctor) throw new ProviderPortalError('FORBIDDEN'); return doctor; }
}
