import { createIdentifier } from '../../shared/identifiers/uuid.js';
import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';
import type { DoctorApplication, DoctorApplicationRepository } from './doctor-applications.js';

type Database = PostgresExecutor & { transaction<T>(operation: (database: PostgresExecutor) => Promise<T>): Promise<T> };

export class PostgresDoctorApplicationRepository implements DoctorApplicationRepository {
  public constructor(private readonly database: Database) {}
  public transaction<T>(operation: (database: PostgresExecutor) => Promise<T>): Promise<T> { return this.database.transaction(operation); }

  public async lockOwnedProfile(database: PostgresExecutor, doctorProfileId: string, accountId: string) {
    const result = await database.query<Record<string, unknown>>('SELECT id,account_id,status,professional_verification_status FROM doctor_profiles WHERE id=$1 AND account_id=$2 FOR UPDATE', [doctorProfileId, accountId]);
    const row = result.rows[0];
    return row ? { id: String(row.id), accountId: String(row.account_id), status: String(row.status), professionalVerificationStatus: String(row.professional_verification_status) } : null;
  }
  public async lockApplicationForProfile(database: PostgresExecutor, doctorProfileId: string): Promise<DoctorApplication | null> { return application(await database.query<Record<string, unknown>>(sql('WHERE application.doctor_profile_id=$1 FOR UPDATE OF application,doctor'), [doctorProfileId])); }
  public async submit(database: PostgresExecutor, profile: { id: string }, actorAccountId: string, existing: DoctorApplication | null): Promise<DoctorApplication> {
    if (existing) {
      await database.query("UPDATE doctor_applications SET status='PENDING',submitted_at=current_timestamp,reviewed_at=NULL,reviewer_account_id=NULL,rejection_reason=NULL,updated_at=current_timestamp WHERE id=$1 AND status='REJECTED'", [existing.id]);
    } else {
      await database.query("INSERT INTO doctor_applications (id,doctor_profile_id,status) VALUES ($1,$2,'PENDING')", [createIdentifier(), profile.id]);
    }
    await database.query("UPDATE doctor_profiles SET status='PENDING_VERIFICATION',professional_verification_status='NOT_SUBMITTED',updated_at=current_timestamp,updated_by_account_id=$2 WHERE id=$1", [profile.id, actorAccountId]);
    const saved = await database.query<Record<string, unknown>>(sql('WHERE application.doctor_profile_id=$1'), [profile.id]);
    const result = application(saved); if (!result) throw new Error('DOCTOR_APPLICATION_SAVE_FAILED'); return result;
  }
  public async getOwned(profileId: string, accountId: string): Promise<DoctorApplication | null> { return application(await this.database.query<Record<string, unknown>>(sql('WHERE application.doctor_profile_id=$1 AND doctor.account_id=$2'), [profileId, accountId])); }
  public async listPending(): Promise<DoctorApplication[]> { return applications(await this.database.query<Record<string, unknown>>(sql("WHERE application.status='PENDING' ORDER BY application.submitted_at ASC"), [])); }
  public async getForReview(applicationId: string): Promise<DoctorApplication | null> { return application(await this.database.query<Record<string, unknown>>(sql('WHERE application.id=$1'), [applicationId])); }
  public async lockForReview(database: PostgresExecutor, applicationId: string): Promise<DoctorApplication | null> { return application(await database.query<Record<string, unknown>>(sql('WHERE application.id=$1 FOR UPDATE OF application,doctor'), [applicationId])); }
  public async lockAccountForApproval(database: PostgresExecutor, accountId: string) {
    const row = (await database.query<Record<string, unknown>>('SELECT id,status FROM accounts WHERE id=$1 FOR UPDATE', [accountId])).rows[0];
    return row ? { id: String(row.id), status: String(row.status) } : null;
  }
  public async activatePendingAccountForApproval(database: PostgresExecutor, accountId: string, reviewerAccountId: string): Promise<boolean> {
    return (await database.query("UPDATE accounts SET status='ACTIVE',updated_at=current_timestamp,updated_by_account_id=$2 WHERE id=$1 AND status='PENDING_VERIFICATION'", [accountId, reviewerAccountId])).rowCount === 1;
  }
  public async review(database: PostgresExecutor, value: DoctorApplication, reviewerAccountId: string, outcome: 'APPROVED' | 'REJECTED', rejectionReason?: string): Promise<DoctorApplication | null> {
    const updated = await database.query("UPDATE doctor_applications SET status=$2,reviewed_at=current_timestamp,reviewer_account_id=$3,rejection_reason=$4,updated_at=current_timestamp WHERE id=$1 AND status='PENDING'", [value.id, outcome, reviewerAccountId, outcome === 'REJECTED' ? rejectionReason : null]);
    if (updated.rowCount !== 1) return null;
    if (outcome === 'APPROVED') {
      const profile = await database.query("UPDATE doctor_profiles SET status='ACTIVE',updated_at=current_timestamp,updated_by_account_id=$2 WHERE id=$1 AND status='PENDING_VERIFICATION' AND professional_verification_status='NOT_SUBMITTED'", [value.doctorProfileId, reviewerAccountId]);
      if (profile.rowCount !== 1) throw new Error('DOCTOR_APPLICATION_PROFILE_TRANSITION_FAILED');
    }
    return application(await database.query<Record<string, unknown>>(sql('WHERE application.id=$1'), [value.id]));
  }
}

const sql = (where: string) => `SELECT application.id,application.doctor_profile_id,doctor.account_id doctor_account_id,doctor.display_name,doctor.status profile_status,doctor.professional_verification_status,application.status,application.submitted_at,application.reviewed_at,application.reviewer_account_id,application.rejection_reason FROM doctor_applications application JOIN doctor_profiles doctor ON doctor.id=application.doctor_profile_id ${where}`;
function application(result: { rows: Record<string, unknown>[] }): DoctorApplication | null { const row = result.rows[0]; return row ? map(row) : null; }
function applications(result: { rows: Record<string, unknown>[] }): DoctorApplication[] { return result.rows.map(map); }
function map(row: Record<string, unknown>): DoctorApplication { return { id: String(row.id), doctorProfileId: String(row.doctor_profile_id), doctorAccountId: String(row.doctor_account_id), displayName: row.display_name === null ? null : String(row.display_name), profileStatus: String(row.profile_status), professionalVerificationStatus: String(row.professional_verification_status), status: row.status as DoctorApplication['status'], submittedAt: new Date(String(row.submitted_at)), reviewedAt: row.reviewed_at === null ? null : new Date(String(row.reviewed_at)), reviewerAccountId: row.reviewer_account_id === null ? null : String(row.reviewer_account_id), rejectionReason: row.rejection_reason === null ? null : String(row.rejection_reason) }; }
