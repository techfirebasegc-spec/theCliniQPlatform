import { createIdentifier } from '../../shared/identifiers/uuid.js';
import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';
import type { DoctorVerificationRepository, DoctorVerificationSubmission, DoctorVerificationSubmissionInput } from './doctor-verification.js';

type Database = PostgresExecutor & { transaction<T>(operation: (database: PostgresExecutor) => Promise<T>): Promise<T> };

export class PostgresDoctorVerificationRepository implements DoctorVerificationRepository {
  public constructor(private readonly database: Database) {}

  public transaction<T>(operation: (database: PostgresExecutor) => Promise<T>): Promise<T> {
    return this.database.transaction(operation);
  }

  public async lockOwnedDoctorProfile(database: PostgresExecutor, profileId: string, accountId: string) {
    return profile(await database.query<Record<string, unknown>>('SELECT id,account_id,status,professional_verification_status FROM doctor_profiles WHERE id=$1 AND account_id=$2 FOR UPDATE', [profileId, accountId]));
  }

  public async findPendingSubmission(database: PostgresExecutor, doctorProfileId: string) {
    return submission(await database.query<Record<string, unknown>>(submissionSql("WHERE submission.doctor_profile_id=$1 AND submission.status='PENDING'"), [doctorProfileId]));
  }

  public async savePendingSubmission(database: PostgresExecutor, actorAccountId: string, profileValue: { id: string; accountId: string }, input: DoctorVerificationSubmissionInput, existing: DoctorVerificationSubmission | null) {
    const values = [input.registrationAuthority.trim(), input.registrationJurisdiction.trim(), input.registrationIdentifier.trim()];
    let saved: DoctorVerificationSubmission | null;
    if (existing) {
      await database.query('UPDATE doctor_verification_submissions SET registration_authority=$1,registration_jurisdiction=$2,registration_identifier=$3,submitted_at=current_timestamp,updated_at=current_timestamp,updated_by_account_id=$4 WHERE id=$5 AND status=\'PENDING\'', [...values, actorAccountId, existing.id]);
      await database.query('DELETE FROM doctor_verification_submission_documents WHERE submission_id=$1', [existing.id]);
      await this.insertDocuments(database, existing.id, profileValue.id, actorAccountId, input.documentFileIds);
      saved = await this.load(database, existing.id);
    } else {
      const id = createIdentifier();
      await database.query("INSERT INTO doctor_verification_submissions (id,doctor_profile_id,registration_authority,registration_jurisdiction,registration_identifier,status,created_by_account_id,updated_by_account_id) VALUES ($1,$2,$3,$4,$5,'PENDING',$6,$6)", [id, profileValue.id, ...values, actorAccountId]);
      await this.insertDocuments(database, id, profileValue.id, actorAccountId, input.documentFileIds);
      saved = await this.load(database, id);
    }
    await database.query("UPDATE doctor_profiles SET status='ACTIVE',professional_verification_status='PENDING',updated_at=current_timestamp,updated_by_account_id=$2 WHERE id=$1", [profileValue.id, actorAccountId]);
    if (!saved) throw new Error('DOCTOR_VERIFICATION_SUBMISSION_SAVE_FAILED');
    return saved;
  }

  public async listSubmissionsForDoctor(profileId: string, accountId: string) {
    const exists = await this.database.query('SELECT 1 FROM doctor_profiles WHERE id=$1 AND account_id=$2', [profileId, accountId]);
    if (exists.rows.length === 0) return null;
    return submissions(await this.database.query<Record<string, unknown>>(submissionSql('WHERE submission.doctor_profile_id=$1', 'ORDER BY submission.submitted_at DESC'), [profileId]));
  }

  public async listSubmissionsForReview(profileId: string) {
    const exists = await this.database.query('SELECT 1 FROM doctor_profiles WHERE id=$1', [profileId]);
    if (exists.rows.length === 0) return null;
    return submissions(await this.database.query<Record<string, unknown>>(submissionSql('WHERE submission.doctor_profile_id=$1', 'ORDER BY submission.submitted_at DESC'), [profileId]));
  }

  public async lockSubmission(database: PostgresExecutor, submissionId: string) {
    const locked = await database.query<{ id: string }>('SELECT doctor.id FROM doctor_verification_submissions submission JOIN doctor_profiles doctor ON doctor.id=submission.doctor_profile_id WHERE submission.id=$1 FOR UPDATE OF doctor', [submissionId]);
    return locked.rows[0] ? this.load(database, submissionId) : null;
  }

  public async reviewSubmission(database: PostgresExecutor, value: DoctorVerificationSubmission, reviewerAccountId: string, outcome: 'APPROVED' | 'REJECTED', rejectionReason?: string) {
    const updated = await database.query<Record<string, unknown>>("UPDATE doctor_verification_submissions SET status=$2,reviewed_by_account_id=$3,reviewed_at=current_timestamp,rejection_reason=$4,updated_at=current_timestamp,updated_by_account_id=$3 WHERE id=$1 AND status='PENDING' RETURNING id", [value.id, outcome, reviewerAccountId, outcome === 'REJECTED' ? rejectionReason : null]);
    if (updated.rowCount !== 1) return null;
    await database.query("UPDATE doctor_profiles SET status='ACTIVE',professional_verification_status=$2,updated_at=current_timestamp,updated_by_account_id=$3 WHERE id=$1", [value.doctorProfileId, outcome === 'APPROVED' ? 'VERIFIED' : 'REJECTED', reviewerAccountId]);
    return this.load(database, value.id);
  }

  private async insertDocuments(database: PostgresExecutor, submissionId: string, doctorProfileId: string, actorAccountId: string, fileIds: string[]): Promise<void> {
    const available = await database.query<{ id: string }>("SELECT file.id FROM files file JOIN file_bindings binding ON binding.file_id=file.id WHERE file.id = ANY($1::uuid[]) AND file.created_by_account_id=$2 AND file.status='AVAILABLE' AND binding.purpose='DOCTOR_PROFILE_MEDIA' AND binding.doctor_profile_id=$3", [fileIds, actorAccountId, doctorProfileId]);
    if (available.rows.length !== fileIds.length) throw new Error('DOCTOR_VERIFICATION_DOCUMENT_NOT_AVAILABLE');
    for (const fileId of fileIds) {
      await database.query('INSERT INTO doctor_verification_submission_documents (id,submission_id,file_id) VALUES ($1,$2,$3)', [createIdentifier(), submissionId, fileId]);
    }
  }

  private async load(database: PostgresExecutor, submissionId: string) {
    return submission(await database.query<Record<string, unknown>>(submissionSql('WHERE submission.id=$1'), [submissionId]));
  }
}

const submissionSql = (where: string, orderBy = '') => `SELECT submission.id,submission.doctor_profile_id,doctor.account_id doctor_account_id,submission.registration_authority,submission.registration_jurisdiction,submission.registration_identifier,submission.status,submission.submitted_at,submission.reviewed_by_account_id,submission.reviewed_at,submission.rejection_reason,COALESCE(array_agg(document.file_id) FILTER (WHERE document.file_id IS NOT NULL),'{}') document_file_ids FROM doctor_verification_submissions submission JOIN doctor_profiles doctor ON doctor.id=submission.doctor_profile_id LEFT JOIN doctor_verification_submission_documents document ON document.submission_id=submission.id ${where} GROUP BY submission.id,doctor.account_id ${orderBy}`;

function profile(result: { rows: Record<string, unknown>[] }) { const row = result.rows[0]; return row ? { id: String(row.id), accountId: String(row.account_id), status: String(row.status), professionalVerificationStatus: String(row.professional_verification_status) } : null; }
function submission(result: { rows: Record<string, unknown>[] }): DoctorVerificationSubmission | null { const row = result.rows[0]; return row ? mapSubmission(row) : null; }
function submissions(result: { rows: Record<string, unknown>[] }): DoctorVerificationSubmission[] { return result.rows.map(mapSubmission); }
function mapSubmission(row: Record<string, unknown>): DoctorVerificationSubmission { return { id: String(row.id), doctorProfileId: String(row.doctor_profile_id), doctorAccountId: String(row.doctor_account_id), registrationAuthority: String(row.registration_authority), registrationJurisdiction: String(row.registration_jurisdiction), registrationIdentifier: String(row.registration_identifier), status: row.status as DoctorVerificationSubmission['status'], submittedAt: new Date(String(row.submitted_at)), reviewedByAccountId: row.reviewed_by_account_id === null ? null : String(row.reviewed_by_account_id), reviewedAt: row.reviewed_at === null ? null : new Date(String(row.reviewed_at)), rejectionReason: row.rejection_reason === null ? null : String(row.rejection_reason), documentFileIds: Array.isArray(row.document_file_ids) ? row.document_file_ids.map(String) : [] }; }
