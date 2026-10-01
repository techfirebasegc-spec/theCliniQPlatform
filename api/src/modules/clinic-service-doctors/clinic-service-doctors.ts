import { createIdentifier } from '../../shared/identifiers/uuid.js';
import type { AuditRepository } from '../audit/audit.js';
import type { TenantContextService } from '../memberships/memberships.js';
import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';

export type ClinicServiceDoctorAssignment = { id: string; serviceOfferingId: string; doctorProfileId: string; doctorDisplayName: string | null; networkConnectionId: string; status: 'ACTIVE' | 'REVOKED'; createdAt: Date; revokedAt: Date | null };
export type ClinicOwnedOffering = { id: string; clinicId: string; tenantId: string };
export class ClinicServiceDoctorAssignmentError extends Error { public constructor(public readonly code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'CONFLICT') { super(code === 'UNAUTHORIZED' ? 'Authentication is required.' : code === 'CONFLICT' ? 'The clinic service doctor assignment cannot be completed.' : 'Clinic service doctor assignment access is not permitted.'); } }
export interface ClinicServiceDoctorAssignmentRepository {
  transaction<T>(operation: (database: PostgresExecutor) => Promise<T>): Promise<T>;
  clinicOwnedOffering(serviceOfferingId: string): Promise<ClinicOwnedOffering | null>;
  acceptedEligibleConnection(serviceOfferingId: string, doctorProfileId: string): Promise<string | null>;
  list(serviceOfferingId: string): Promise<ClinicServiceDoctorAssignment[]>;
  create(database: PostgresExecutor, assignment: ClinicServiceDoctorAssignment, actorId: string): Promise<void>;
  revoke(database: PostgresExecutor, serviceOfferingId: string, doctorProfileId: string, actorId: string): Promise<ClinicServiceDoctorAssignment | null>;
}

export class ClinicServiceDoctorAssignmentService {
  public constructor(private readonly repository: ClinicServiceDoctorAssignmentRepository, private readonly context: Pick<TenantContextService, 'require' | 'isPlatformAdministrator'>, private readonly audit: AuditRepository) {}
  public async list(accountId: string | undefined, serviceOfferingId: string) { const actor = this.account(accountId); await this.access(actor, serviceOfferingId, false); return this.repository.list(serviceOfferingId); }
  public async create(accountId: string | undefined, serviceOfferingId: string, doctorProfileId: string) {
    const actor = this.account(accountId); const offering = await this.access(actor, serviceOfferingId, true); const connectionId = await this.repository.acceptedEligibleConnection(serviceOfferingId, doctorProfileId);
    if (!connectionId) return this.rejected(actor, offering, doctorProfileId);
    const assignment: ClinicServiceDoctorAssignment = { id: createIdentifier(), serviceOfferingId, doctorProfileId, doctorDisplayName: null, networkConnectionId: connectionId, status: 'ACTIVE', createdAt: new Date(), revokedAt: null };
    try { await this.repository.transaction((database) => this.repository.create(database, assignment, actor)); }
    catch { return this.rejected(actor, offering, doctorProfileId); }
    await this.audit.append({ category: 'BUSINESS', eventType: 'CLINIC_SERVICE_DOCTOR_ASSIGNMENT_CREATED', actorAccountId: actor, tenantId: offering.tenantId, targetType: 'CLINIC_SERVICE_DOCTOR_ASSIGNMENT', targetId: assignment.id, outcome: 'SUCCESS', metadata: { clinicId: offering.clinicId, serviceOfferingId, doctorProfileId, networkConnectionId: connectionId } });
    return assignment;
  }
  public async revoke(accountId: string | undefined, serviceOfferingId: string, doctorProfileId: string) {
    const actor = this.account(accountId); const offering = await this.access(actor, serviceOfferingId, true); const assignment = await this.repository.transaction((database) => this.repository.revoke(database, serviceOfferingId, doctorProfileId, actor));
    if (!assignment) return this.rejected(actor, offering, doctorProfileId);
    await this.audit.append({ category: 'BUSINESS', eventType: 'CLINIC_SERVICE_DOCTOR_ASSIGNMENT_REVOKED', actorAccountId: actor, tenantId: offering.tenantId, targetType: 'CLINIC_SERVICE_DOCTOR_ASSIGNMENT', targetId: assignment.id, outcome: 'SUCCESS', metadata: { clinicId: offering.clinicId, serviceOfferingId, doctorProfileId } });
    return assignment;
  }
  private account(accountId: string | undefined) { if (!accountId) throw new ClinicServiceDoctorAssignmentError('UNAUTHORIZED'); return accountId; }
  private async access(actor: string, serviceOfferingId: string, mutate: boolean): Promise<ClinicOwnedOffering> {
    const offering = await this.repository.clinicOwnedOffering(serviceOfferingId);
    if (!offering) return this.denied(actor, serviceOfferingId);
    if (await this.context.isPlatformAdministrator(actor)) { if (!mutate) return offering; return this.denied(actor, serviceOfferingId, offering.tenantId); }
    try { await this.context.require(actor, offering.tenantId, 'clinic.manage'); return offering; }
    catch { return this.denied(actor, serviceOfferingId, offering.tenantId); }
  }
  private async denied(actor: string, serviceOfferingId: string, tenantId?: string): Promise<never> { await this.audit.append({ category: 'AUTHORIZATION', eventType: 'CLINIC_SERVICE_DOCTOR_ASSIGNMENT_ACCESS_DENIED', actorAccountId: actor, tenantId, targetType: 'SERVICE_OFFERING', targetId: serviceOfferingId, outcome: 'DENIED' }); throw new ClinicServiceDoctorAssignmentError('FORBIDDEN'); }
  private async rejected(actor: string, offering: ClinicOwnedOffering, doctorProfileId: string): Promise<never> { await this.audit.append({ category: 'SECURITY', eventType: 'CLINIC_SERVICE_DOCTOR_ASSIGNMENT_REJECTED', actorAccountId: actor, tenantId: offering.tenantId, targetType: 'SERVICE_OFFERING', targetId: offering.id, outcome: 'DENIED', metadata: { clinicId: offering.clinicId, serviceOfferingId: offering.id, doctorProfileId } }); throw new ClinicServiceDoctorAssignmentError('CONFLICT'); }
}
