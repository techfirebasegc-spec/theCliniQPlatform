import type { AuditRepository } from '../audit/audit.js';
import type { TenantPermission } from '../authorization/authorization.js';
import type { TenantContextService } from '../memberships/memberships.js';
import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';

export type AppointmentOperation = 'appointment.view' | 'appointment.start' | 'appointment.complete' | 'appointment.cancel';
export type AppointmentParticipant =
  | { type: 'PATIENT'; patientProfileId: string }
  | { type: 'DOCTOR'; doctorProfileId: string }
  | { type: 'CLINIC'; clinicId: string; tenantId: string };
export interface AppointmentAccessContext { id: string; participants: AppointmentParticipant[]; }

export interface AppointmentAuthorizationRepository {
  findAccessContext(appointmentId: string): Promise<AppointmentAccessContext | null>;
  accountOwnsPatientProfile(accountId: string, patientProfileId: string): Promise<boolean>;
  accountOwnsDoctorProfile(accountId: string, doctorProfileId: string): Promise<boolean>;
  accountOwnsEligibleDoctorProfile(accountId: string, doctorProfileId: string): Promise<boolean>;
  findAccessContextForUpdate(database: PostgresExecutor, appointmentId: string): Promise<AppointmentAccessContext | null>;
  accountOwnsPatientProfileForUpdate(database: PostgresExecutor, accountId: string, patientProfileId: string): Promise<boolean>;
  accountOwnsDoctorProfileForUpdate(database: PostgresExecutor, accountId: string, doctorProfileId: string): Promise<boolean>;
  accountOwnsEligibleDoctorProfileForUpdate(database: PostgresExecutor, accountId: string, doctorProfileId: string): Promise<boolean>;
}

/** Deliberately inert until a separately approved global-role source exists. */
export interface AppointmentElevatedAuthorizer {
  authorize(_accountId: string, _appointment: AppointmentAccessContext, _operation: AppointmentOperation): Promise<boolean>;
}

export class AppointmentAuthorizationError extends Error {
  public constructor(public readonly code: 'UNAUTHORIZED' | 'FORBIDDEN') {
    super(code === 'UNAUTHORIZED' ? 'Authentication is required.' : 'Appointment access is not permitted.');
    this.name = 'AppointmentAuthorizationError';
  }
}

/**
 * Separates immutable historical participation from current actor authority.
 * No client-provided participant, tenant, role, or permission is accepted.
 */
export class AppointmentAuthorizationService {
  public constructor(
    private readonly repository: AppointmentAuthorizationRepository,
    private readonly tenantContext: Pick<TenantContextService, 'require' | 'requireInTransaction'>,
    private readonly audit: AuditRepository,
    private readonly elevated?: AppointmentElevatedAuthorizer,
  ) {}

  public async authorize(accountId: string | undefined, appointmentId: string, operation: AppointmentOperation): Promise<AppointmentAccessContext> {
    if (!accountId) throw new AppointmentAuthorizationError('UNAUTHORIZED');
    const appointment = await this.repository.findAccessContext(appointmentId);
    if (!appointment) return this.denied(accountId, appointmentId);

    if (this.elevated && await this.elevated.authorize(accountId, appointment, operation)) return appointment;

    const patient = appointment.participants.find((participant): participant is Extract<AppointmentParticipant, { type: 'PATIENT' }> => participant.type === 'PATIENT');
    if (patient && await this.repository.accountOwnsPatientProfile(accountId, patient.patientProfileId)) {
      if (operation === 'appointment.view' || operation === 'appointment.cancel') return appointment;
    }

    const doctor = appointment.participants.find((participant): participant is Extract<AppointmentParticipant, { type: 'DOCTOR' }> => participant.type === 'DOCTOR');
    if (doctor && await this.repository.accountOwnsDoctorProfile(accountId, doctor.doctorProfileId)) {
      if (operation === 'appointment.view') return appointment;
      if (await this.repository.accountOwnsEligibleDoctorProfile(accountId, doctor.doctorProfileId)) return appointment;
    }

    const clinic = appointment.participants.find((participant): participant is Extract<AppointmentParticipant, { type: 'CLINIC' }> => participant.type === 'CLINIC');
    if (clinic) {
      try {
        await this.tenantContext.require(accountId, clinic.tenantId, operation as TenantPermission);
        return appointment;
      } catch { return this.denied(accountId, appointmentId, clinic.tenantId); }
    }
    return this.denied(accountId, appointmentId);
  }

  /** Revalidates mutable authority against locked current records within a lifecycle transaction. */
  public async authorizeInTransaction(database: PostgresExecutor, accountId: string | undefined, appointmentId: string, operation: AppointmentOperation): Promise<AppointmentAccessContext> {
    if (!accountId) throw new AppointmentAuthorizationError('UNAUTHORIZED');
    const appointment = await this.repository.findAccessContextForUpdate(database, appointmentId);
    if (!appointment) return this.denied(accountId, appointmentId);

    const patient = appointment.participants.find((participant): participant is Extract<AppointmentParticipant, { type: 'PATIENT' }> => participant.type === 'PATIENT');
    if (patient && await this.repository.accountOwnsPatientProfileForUpdate(database, accountId, patient.patientProfileId)) {
      if (operation === 'appointment.view' || operation === 'appointment.cancel') return appointment;
    }

    const doctor = appointment.participants.find((participant): participant is Extract<AppointmentParticipant, { type: 'DOCTOR' }> => participant.type === 'DOCTOR');
    if (doctor && await this.repository.accountOwnsDoctorProfileForUpdate(database, accountId, doctor.doctorProfileId)) {
      if (operation === 'appointment.view') return appointment;
      if (await this.repository.accountOwnsEligibleDoctorProfileForUpdate(database, accountId, doctor.doctorProfileId)) return appointment;
    }

    const clinic = appointment.participants.find((participant): participant is Extract<AppointmentParticipant, { type: 'CLINIC' }> => participant.type === 'CLINIC');
    if (clinic) {
      try {
        await this.tenantContext.requireInTransaction(database, accountId, clinic.tenantId, operation as TenantPermission);
        return appointment;
      } catch { return this.denied(accountId, appointmentId, clinic.tenantId); }
    }
    return this.denied(accountId, appointmentId);
  }

  private async denied(accountId: string, appointmentId: string, tenantId?: string): Promise<never> {
    await this.audit.append({ category: 'AUTHORIZATION', eventType: 'APPOINTMENT_ACCESS_DENIED', actorAccountId: accountId, tenantId, targetType: 'APPOINTMENT', targetId: appointmentId, outcome: 'DENIED' });
    throw new AppointmentAuthorizationError('FORBIDDEN');
  }
}
