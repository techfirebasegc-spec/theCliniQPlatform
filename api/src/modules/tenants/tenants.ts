import { createIdentifier } from '../../shared/identifiers/uuid.js';
import type { AuditRepository } from '../audit/audit.js';
import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';

export type Clinic = { id: string; tenantId: string; status: 'DRAFT' | 'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED' | 'CLOSED'; legalName: string; displayName: string };
export type ClinicInput = { legalName: string; displayName: string };
export interface TenantRepository { transaction<T>(operation: (database: PostgresExecutor) => Promise<T>): Promise<T>; create(database: PostgresExecutor, accountId: string, input: ClinicInput): Promise<Clinic>; findForCreator(clinicId: string, accountId: string): Promise<Clinic | null>; updateForCreator(clinicId: string, accountId: string, input: ClinicInput): Promise<Clinic | null>; }
export class TenantAccessError extends Error { public constructor(public readonly code: 'UNAUTHORIZED' | 'FORBIDDEN') { super(code === 'UNAUTHORIZED' ? 'Authentication is required.' : 'Clinic access is not permitted.'); } }
export class TenantClinicService {
  public constructor(private readonly repository: TenantRepository, private readonly audit: AuditRepository) {}
  public async create(accountId: string | undefined, input: ClinicInput): Promise<Clinic> { const creator = this.account(accountId); const clinic = await this.repository.transaction((database) => this.repository.create(database, creator, input)); await this.audit.append({ category: 'BUSINESS', eventType: 'CLINIC_CREATED', actorAccountId: creator, tenantId: clinic.tenantId, targetType: 'CLINIC', targetId: clinic.id, outcome: 'SUCCESS' }); return clinic; }
  public async read(accountId: string | undefined, clinicId: string): Promise<Clinic> { return this.owned(accountId, clinicId, this.repository.findForCreator(clinicId, this.account(accountId))); }
  public async update(accountId: string | undefined, clinicId: string, input: ClinicInput): Promise<Clinic> { return this.owned(accountId, clinicId, this.repository.updateForCreator(clinicId, this.account(accountId), input)); }
  private account(accountId: string | undefined): string { if (!accountId) throw new TenantAccessError('UNAUTHORIZED'); return accountId; }
  private async owned(accountId: string | undefined, clinicId: string, operation: Promise<Clinic | null>): Promise<Clinic> { const actor = this.account(accountId); const clinic = await operation; if (clinic) return clinic; await this.audit.append({ category: 'AUTHORIZATION', eventType: 'CLINIC_ACCESS_DENIED', actorAccountId: actor, targetType: 'CLINIC', targetId: clinicId, outcome: 'DENIED' }); throw new TenantAccessError('FORBIDDEN'); }
}
export function newClinic(input: ClinicInput) { return { tenantId: createIdentifier(), clinicId: createIdentifier(), input }; }
