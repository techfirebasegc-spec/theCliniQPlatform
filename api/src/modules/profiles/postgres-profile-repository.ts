import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';
import type { DoctorProfile, PatientProfile, ProfileMutation, ProfileRepository } from './profiles.js';

export class PostgresProfileRepository implements ProfileRepository {
  public constructor(private readonly database: PostgresExecutor) {}

  public async createPatient(profile: PatientProfile): Promise<PatientProfile> {
    return patient(await this.database.query('INSERT INTO patient_profiles (id, account_id, status, display_name, created_by_account_id, updated_by_account_id) VALUES ($1, $2, $3, $4, $2, $2) RETURNING id, account_id, status, display_name', [profile.id, profile.accountId, profile.status, profile.displayName]));
  }
  public async createDoctor(profile: DoctorProfile): Promise<DoctorProfile> {
    return doctor(await this.database.query('INSERT INTO doctor_profiles (id, account_id, status, display_name, professional_verification_status, created_by_account_id, updated_by_account_id) VALUES ($1, $2, $3, $4, $5, $2, $2) RETURNING id, account_id, status, display_name, professional_verification_status', [profile.id, profile.accountId, profile.status, profile.displayName, profile.professionalVerificationStatus]));
  }
  public async findPatientForAccount(profileId: string, accountId: string): Promise<PatientProfile | null> {
    const result = await this.database.query('SELECT id, account_id, status, display_name FROM patient_profiles WHERE id = $1 AND account_id = $2', [profileId, accountId]);
    return result.rows[0] ? patient(result) : null;
  }
  public async findDoctorForAccount(profileId: string, accountId: string): Promise<DoctorProfile | null> {
    const result = await this.database.query('SELECT id, account_id, status, display_name, professional_verification_status FROM doctor_profiles WHERE id = $1 AND account_id = $2', [profileId, accountId]);
    return result.rows[0] ? doctor(result) : null;
  }
  public async updatePatientForAccount(profileId: string, accountId: string, mutation: ProfileMutation): Promise<PatientProfile | null> {
    const result = await this.database.query('UPDATE patient_profiles SET display_name = $3, updated_at = current_timestamp, updated_by_account_id = $2 WHERE id = $1 AND account_id = $2 AND status = $4 RETURNING id, account_id, status, display_name', [profileId, accountId, mutation.displayName ?? null, 'ACTIVE']);
    return result.rows[0] ? patient(result) : null;
  }
  public async updateDoctorForAccount(profileId: string, accountId: string, mutation: ProfileMutation): Promise<DoctorProfile | null> {
    const result = await this.database.query('UPDATE doctor_profiles SET display_name = $3, updated_at = current_timestamp, updated_by_account_id = $2 WHERE id = $1 AND account_id = $2 AND status IN ($4, $5, $6) RETURNING id, account_id, status, display_name, professional_verification_status', [profileId, accountId, mutation.displayName ?? null, 'DRAFT', 'PENDING_VERIFICATION', 'ACTIVE']);
    return result.rows[0] ? doctor(result) : null;
  }
}

function patient(result: { rows: Record<string, unknown>[] }): PatientProfile { const row = result.rows[0]!; return { id: String(row.id), accountId: String(row.account_id), status: row.status as PatientProfile['status'], displayName: row.display_name === null ? null : String(row.display_name) }; }
function doctor(result: { rows: Record<string, unknown>[] }): DoctorProfile { const row = result.rows[0]!; return { id: String(row.id), accountId: String(row.account_id), status: row.status as DoctorProfile['status'], displayName: row.display_name === null ? null : String(row.display_name), professionalVerificationStatus: row.professional_verification_status as DoctorProfile['professionalVerificationStatus'] }; }
