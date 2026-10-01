import { createIdentifier } from '../../shared/identifiers/uuid.js';
import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';
import type { VerificationEvidenceRepository, VerificationEvidence } from './verification-evidence.js';

type Database = PostgresExecutor & { transaction<T>(operation: (database: PostgresExecutor) => Promise<T>): Promise<T> };
type EvidenceObject = VerificationEvidence & { objectKey: string; bucket: string; doctorAccountId: string };

export class PostgresVerificationEvidenceRepository implements VerificationEvidenceRepository {
  public constructor(private readonly database: Database) {}
  public transaction<T>(operation: (database: PostgresExecutor) => Promise<T>) { return this.database.transaction(operation); }

  public async createPending(database: PostgresExecutor, value: EvidenceObject, actorAccountId: string): Promise<void> {
    const owned = await database.query('SELECT 1 FROM doctor_profiles WHERE id=$1 AND account_id=$2', [value.doctorProfileId, actorAccountId]);
    if (owned.rows.length !== 1) throw new Error('DOCTOR_VERIFICATION_PROFILE_NOT_OWNED');
    await database.query("INSERT INTO files (id,storage_provider,bucket,object_key,original_filename,content_type,byte_size,status,created_by_account_id,create_idempotency_key,create_request_fingerprint) VALUES ($1,'AIC_S3',$2,$3,$4,$5,$6,'PENDING_UPLOAD',$7,$8,$9)", [value.id, value.bucket, value.objectKey, value.originalFilename, value.contentType, value.byteSize, actorAccountId, value.id, 'doctor-verification-evidence']);
    await database.query("INSERT INTO file_bindings (id,file_id,purpose,doctor_profile_id) VALUES ($1,$2,'DOCTOR_PROFILE_MEDIA',$3)", [createIdentifier(), value.id, value.doctorProfileId]);
  }

  public async markAvailable(id: string, sha256: string): Promise<void> {
    await this.database.query("UPDATE files SET status='AVAILABLE',sha256=$2 WHERE id=$1 AND status='PENDING_UPLOAD'", [id, sha256]);
  }
  public async markUploadFailed(id: string): Promise<void> { await this.database.query("UPDATE files SET status='UPLOAD_FAILED' WHERE id=$1 AND status='PENDING_UPLOAD'", [id]); }

  public async listOwned(doctorProfileId: string, accountId: string) {
    const owned = await this.database.query('SELECT 1 FROM doctor_profiles WHERE id=$1 AND account_id=$2', [doctorProfileId, accountId]);
    if (owned.rows.length !== 1) return null;
    return evidences(await this.database.query<Record<string, unknown>>(`${evidenceSql} WHERE binding.doctor_profile_id=$1 AND file.created_by_account_id=$2 ORDER BY file.created_at DESC`, [doctorProfileId, accountId]));
  }
  public async findOwned(fileId: string, doctorProfileId: string, accountId: string) { return evidence(await this.database.query<Record<string, unknown>>(`${evidenceSql} WHERE file.id=$1 AND binding.doctor_profile_id=$2 AND file.created_by_account_id=$3`, [fileId, doctorProfileId, accountId])); }
  public async listForReview(submissionId: string) { const exists = await this.database.query('SELECT 1 FROM doctor_verification_submissions WHERE id=$1', [submissionId]); if (exists.rows.length !== 1) return null; return evidences(await this.database.query<Record<string, unknown>>(`${evidenceSql} JOIN doctor_verification_submission_documents document ON document.file_id=file.id WHERE document.submission_id=$1 ORDER BY file.created_at`, [submissionId])); }
  public async findForReview(submissionId: string, fileId: string) { return evidence(await this.database.query<Record<string, unknown>>(`${evidenceSql} JOIN doctor_verification_submission_documents document ON document.file_id=file.id WHERE document.submission_id=$1 AND file.id=$2`, [submissionId, fileId])); }
}

const evidenceSql = "SELECT file.id,binding.doctor_profile_id,file.created_by_account_id doctor_account_id,file.original_filename,file.content_type,file.byte_size,file.status,file.object_key,file.bucket FROM files file JOIN file_bindings binding ON binding.file_id=file.id AND binding.purpose='DOCTOR_PROFILE_MEDIA'";
function evidence(result: { rows: Record<string, unknown>[] }): EvidenceObject | null { const row = result.rows[0]; return row ? map(row) : null; }
function evidences(result: { rows: Record<string, unknown>[] }): EvidenceObject[] { return result.rows.map(map); }
function map(row: Record<string, unknown>): EvidenceObject { return { id: String(row.id), doctorProfileId: String(row.doctor_profile_id), doctorAccountId: String(row.doctor_account_id), originalFilename: String(row.original_filename), contentType: String(row.content_type), byteSize: Number(row.byte_size), status: row.status as VerificationEvidence['status'], objectKey: String(row.object_key), bucket: String(row.bucket) }; }
