import type { DatabaseHealth } from '../../infrastructure/database.js';
import type { AppointmentAccessContext, AppointmentAuthorizationRepository, AppointmentParticipant } from './appointment-authorization.js';
import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';

export class PostgresAppointmentAuthorizationRepository implements AppointmentAuthorizationRepository {
  public constructor(private readonly database: DatabaseHealth) {}

  public async findAccessContext(appointmentId: string): Promise<AppointmentAccessContext | null> {
    const result = await this.database.query<Record<string, unknown>>(`SELECT appointment.id,participant.participant_type,participant.patient_profile_id,participant.doctor_profile_id,participant.clinic_id,participant.tenant_id
      FROM appointments appointment JOIN appointment_participants participant ON participant.appointment_id=appointment.id
      WHERE appointment.id=$1 ORDER BY participant.participant_type`, [appointmentId]);
    if (result.rows.length === 0) return null;
    return { id: String(result.rows[0].id), participants: result.rows.map(participant) };
  }

  public async accountOwnsPatientProfile(accountId: string, patientProfileId: string): Promise<boolean> {
    return (await this.database.query('SELECT 1 FROM patient_profiles WHERE id=$1 AND account_id=$2', [patientProfileId, accountId])).rowCount === 1;
  }
  public async accountOwnsDoctorProfile(accountId: string, doctorProfileId: string): Promise<boolean> {
    return (await this.database.query('SELECT 1 FROM doctor_profiles WHERE id=$1 AND account_id=$2', [doctorProfileId, accountId])).rowCount === 1;
  }
  public async accountOwnsEligibleDoctorProfile(accountId: string, doctorProfileId: string): Promise<boolean> {
    return (await this.database.query("SELECT 1 FROM doctor_profiles WHERE id=$1 AND account_id=$2 AND status='ACTIVE' AND professional_verification_status='VERIFIED'", [doctorProfileId, accountId])).rowCount === 1;
  }

  public async findAccessContextForUpdate(database: PostgresExecutor, appointmentId: string): Promise<AppointmentAccessContext | null> {
    const result = await database.query<Record<string, unknown>>(`SELECT appointment.id,participant.participant_type,participant.patient_profile_id,participant.doctor_profile_id,participant.clinic_id,participant.tenant_id
      FROM appointments appointment JOIN appointment_participants participant ON participant.appointment_id=appointment.id
      WHERE appointment.id=$1 ORDER BY participant.participant_type FOR UPDATE OF participant`, [appointmentId]);
    if (result.rows.length === 0) return null;
    return { id: String(result.rows[0].id), participants: result.rows.map(participant) };
  }
  public async accountOwnsPatientProfileForUpdate(database: PostgresExecutor, accountId: string, patientProfileId: string): Promise<boolean> {
    return (await database.query('SELECT 1 FROM patient_profiles WHERE id=$1 AND account_id=$2 FOR UPDATE', [patientProfileId, accountId])).rowCount === 1;
  }
  public async accountOwnsDoctorProfileForUpdate(database: PostgresExecutor, accountId: string, doctorProfileId: string): Promise<boolean> {
    return (await database.query('SELECT 1 FROM doctor_profiles WHERE id=$1 AND account_id=$2 FOR UPDATE', [doctorProfileId, accountId])).rowCount === 1;
  }
  public async accountOwnsEligibleDoctorProfileForUpdate(database: PostgresExecutor, accountId: string, doctorProfileId: string): Promise<boolean> {
    return (await database.query("SELECT 1 FROM doctor_profiles WHERE id=$1 AND account_id=$2 AND status='ACTIVE' AND professional_verification_status='VERIFIED' FOR UPDATE", [doctorProfileId, accountId])).rowCount === 1;
  }
}

function participant(row: Record<string, unknown>): AppointmentParticipant {
  if (row.participant_type === 'PATIENT') return { type: 'PATIENT', patientProfileId: String(row.patient_profile_id) };
  if (row.participant_type === 'DOCTOR') return { type: 'DOCTOR', doctorProfileId: String(row.doctor_profile_id) };
  return { type: 'CLINIC', clinicId: String(row.clinic_id), tenantId: String(row.tenant_id) };
}
