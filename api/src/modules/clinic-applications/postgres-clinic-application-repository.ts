import { createIdentifier } from '../../shared/identifiers/uuid.js';
import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';
import type { ClinicApplication, ClinicApplicationInput, ClinicApplicationRepository } from './clinic-applications.js';

type Database = PostgresExecutor & { transaction<T>(operation: (database: PostgresExecutor) => Promise<T>): Promise<T> };
export class PostgresClinicApplicationRepository implements ClinicApplicationRepository {
  public constructor(private readonly database: Database) {}
  public transaction<T>(operation: (database: PostgresExecutor) => Promise<T>): Promise<T> { return this.database.transaction(operation); }
  public async lockForApplicant(database: PostgresExecutor, accountId: string): Promise<ClinicApplication | null> { return application(await database.query<Record<string, unknown>>(sql('WHERE application.applicant_account_id=$1 FOR UPDATE'), [accountId])); }
  public async submit(database: PostgresExecutor, accountId: string, input: ClinicApplicationInput, existing: ClinicApplication | null): Promise<ClinicApplication> {
    if (existing) await database.query("UPDATE clinic_applications SET legal_name=$2,clinic_name=$3,owner_email=$4,status='PENDING',submitted_at=current_timestamp,reviewer_account_id=NULL,reviewed_at=NULL,rejection_reason=NULL,updated_at=current_timestamp WHERE id=$1 AND status='REJECTED'", [existing.id, input.legalName, input.clinicName, input.ownerEmail]);
    else await database.query("INSERT INTO clinic_applications (id,applicant_account_id,legal_name,clinic_name,owner_email,status) VALUES ($1,$2,$3,$4,$5,'PENDING')", [createIdentifier(), accountId, input.legalName, input.clinicName, input.ownerEmail]);
    const saved = await database.query<Record<string, unknown>>(sql('WHERE application.applicant_account_id=$1'), [accountId]); const value = application(saved); if (!value) throw new Error('CLINIC_APPLICATION_SAVE_FAILED'); return value;
  }
  public async getForApplicant(accountId: string): Promise<ClinicApplication | null> { return application(await this.database.query<Record<string, unknown>>(sql('WHERE application.applicant_account_id=$1'), [accountId])); }
  public async listPending(): Promise<ClinicApplication[]> { return applications(await this.database.query<Record<string, unknown>>(sql("WHERE application.status='PENDING' ORDER BY application.submitted_at ASC"), [])); }
  public async getForReview(applicationId: string): Promise<ClinicApplication | null> { return application(await this.database.query<Record<string, unknown>>(sql('WHERE application.id=$1'), [applicationId])); }
  public async lockForReview(database: PostgresExecutor, applicationId: string): Promise<ClinicApplication | null> { return application(await database.query<Record<string, unknown>>(sql('WHERE application.id=$1 FOR UPDATE'), [applicationId])); }
  public async review(database: PostgresExecutor, value: ClinicApplication, reviewerAccountId: string, outcome: 'APPROVED' | 'REJECTED', rejectionReason?: string): Promise<ClinicApplication | null> {
    const result = await database.query("UPDATE clinic_applications SET status=$2,reviewer_account_id=$3,reviewed_at=current_timestamp,rejection_reason=$4,updated_at=current_timestamp WHERE id=$1 AND status='PENDING'", [value.id, outcome, reviewerAccountId, outcome === 'REJECTED' ? rejectionReason : null]);
    return result.rowCount === 1 ? application(await database.query<Record<string, unknown>>(sql('WHERE application.id=$1'), [value.id])) : null;
  }
}
const sql = (where: string) => `SELECT application.id,application.applicant_account_id,application.legal_name,application.clinic_name,application.owner_email,application.status,application.submitted_at,application.reviewer_account_id,application.reviewed_at,application.rejection_reason FROM clinic_applications application ${where}`;
function application(result: { rows: Record<string, unknown>[] }): ClinicApplication | null { const row = result.rows[0]; return row ? map(row) : null; }
function applications(result: { rows: Record<string, unknown>[] }): ClinicApplication[] { return result.rows.map(map); }
function map(row: Record<string, unknown>): ClinicApplication { return { id: String(row.id), applicantAccountId: String(row.applicant_account_id), legalName: String(row.legal_name), clinicName: String(row.clinic_name), ownerEmail: String(row.owner_email), status: row.status as ClinicApplication['status'], submittedAt: new Date(String(row.submitted_at)), reviewerAccountId: row.reviewer_account_id === null ? null : String(row.reviewer_account_id), reviewedAt: row.reviewed_at === null ? null : new Date(String(row.reviewed_at)), rejectionReason: row.rejection_reason === null ? null : String(row.rejection_reason) }; }
