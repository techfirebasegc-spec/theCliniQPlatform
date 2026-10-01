import type { AuditEventInput, TransactionalAuditRepository } from '../audit/audit.js';
import type { NewOwnerClinic, TenantOwnerOnboardingService } from '../tenant-onboarding/tenant-owner-onboarding.js';
import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';

export type ClinicApplicationStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type ClinicApplicationInput = { legalName: string; clinicName: string; ownerEmail: string };
export type ClinicApplication = ClinicApplicationInput & { id: string; applicantAccountId: string; status: ClinicApplicationStatus; submittedAt: Date; reviewerAccountId: string | null; reviewedAt: Date | null; rejectionReason: string | null };

export interface ClinicApplicationRepository {
  transaction<T>(operation: (database: PostgresExecutor) => Promise<T>): Promise<T>;
  lockForApplicant(database: PostgresExecutor, accountId: string): Promise<ClinicApplication | null>;
  submit(database: PostgresExecutor, accountId: string, input: ClinicApplicationInput, existing: ClinicApplication | null): Promise<ClinicApplication>;
  getForApplicant(accountId: string): Promise<ClinicApplication | null>;
  listPending(): Promise<ClinicApplication[]>;
  getForReview(applicationId: string): Promise<ClinicApplication | null>;
  lockForReview(database: PostgresExecutor, applicationId: string): Promise<ClinicApplication | null>;
  review(database: PostgresExecutor, application: ClinicApplication, reviewerAccountId: string, outcome: 'APPROVED' | 'REJECTED', rejectionReason?: string): Promise<ClinicApplication | null>;
}
export interface PlatformAdminEntitlements { hasActiveEntitlement(accountId: string): Promise<boolean>; }

export class ClinicApplicationError extends Error {
  public constructor(public readonly code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT') { super(code === 'UNAUTHORIZED' ? 'Authentication is required.' : code === 'FORBIDDEN' ? 'Clinic application access is not permitted.' : code === 'NOT_FOUND' ? 'The requested clinic application was not found.' : 'The clinic application operation cannot be completed.'); }
}

export class ClinicApplicationService {
  public constructor(private readonly repository: ClinicApplicationRepository, private readonly platformAdmins: PlatformAdminEntitlements, private readonly ownerOnboarding: Pick<TenantOwnerOnboardingService, 'createForPlatformAdminInTransaction'>, private readonly audit: TransactionalAuditRepository) {}

  public async submit(actorAccountId: string | undefined, input: ClinicApplicationInput): Promise<ClinicApplication> {
    const actor = requireActor(actorAccountId); const validated = validate(input);
    return this.repository.transaction(async (database) => {
      const existing = await this.repository.lockForApplicant(database, actor);
      if (existing?.status === 'PENDING' || existing?.status === 'APPROVED') throw new ClinicApplicationError('CONFLICT');
      const submitted = await this.repository.submit(database, actor, validated, existing);
      await this.audit.appendInTransaction(database, event('CLINIC_APPLICATION_SUBMITTED', actor, submitted.id, { resubmission: existing?.status === 'REJECTED' }));
      return submitted;
    });
  }

  public async mine(actorAccountId: string | undefined): Promise<ClinicApplication> {
    const actor = requireActor(actorAccountId); const application = await this.repository.getForApplicant(actor);
    if (application) return application;
    throw new ClinicApplicationError('NOT_FOUND');
  }
  public async pending(actorAccountId: string | undefined): Promise<ClinicApplication[]> { await this.requirePlatformAdmin(actorAccountId); return this.repository.listPending(); }
  public async inspect(actorAccountId: string | undefined, applicationId: string): Promise<ClinicApplication> {
    const actor = await this.requirePlatformAdmin(actorAccountId); const application = await this.repository.getForReview(applicationId);
    if (!application) throw new ClinicApplicationError('NOT_FOUND');
    if (application.applicantAccountId === actor) return this.deniedReview(actor, applicationId);
    return application;
  }
  public approve(actorAccountId: string | undefined, applicationId: string): Promise<ClinicApplication> { return this.review(actorAccountId, applicationId, 'APPROVED'); }
  public reject(actorAccountId: string | undefined, applicationId: string, rejectionReason: string): Promise<ClinicApplication> { if (!rejectionReason.trim()) throw new ClinicApplicationError('CONFLICT'); return this.review(actorAccountId, applicationId, 'REJECTED', rejectionReason.trim()); }

  private async review(actorAccountId: string | undefined, applicationId: string, outcome: 'APPROVED' | 'REJECTED', rejectionReason?: string): Promise<ClinicApplication> {
    const actor = await this.requirePlatformAdmin(actorAccountId);
    return this.repository.transaction(async (database) => {
      const application = await this.repository.lockForReview(database, applicationId);
      if (!application) throw new ClinicApplicationError('NOT_FOUND');
      if (application.applicantAccountId === actor) return this.deniedReviewInTransaction(actor, applicationId, database);
      if (application.status !== 'PENDING') throw new ClinicApplicationError('CONFLICT');
      const reviewed = await this.repository.review(database, application, actor, outcome, rejectionReason);
      if (!reviewed) throw new ClinicApplicationError('CONFLICT');
      if (outcome === 'APPROVED') {
        const onboarding = await this.ownerOnboarding.createForPlatformAdminInTransaction(database, actor, { legalName: application.legalName, displayName: application.clinicName, ownerEmail: application.ownerEmail } satisfies NewOwnerClinic);
        await this.audit.appendInTransaction(database, event('CLINIC_APPLICATION_APPROVED', actor, reviewed.id, { clinicId: onboarding.clinic.id, tenantId: onboarding.clinic.tenantId }));
      } else {
        await this.audit.appendInTransaction(database, event('CLINIC_APPLICATION_REJECTED', actor, reviewed.id));
      }
      return reviewed;
    });
  }
  private async requirePlatformAdmin(actorAccountId: string | undefined): Promise<string> {
    const actor = requireActor(actorAccountId);
    if (!await this.platformAdmins.hasActiveEntitlement(actor)) { await this.audit.append({ category: 'AUTHORIZATION', eventType: 'CLINIC_APPLICATION_REVIEW_DENIED', actorAccountId: actor, targetType: 'CLINIC_APPLICATION', outcome: 'DENIED' }); throw new ClinicApplicationError('FORBIDDEN'); }
    return actor;
  }
  private async deniedReview(actor: string, targetId: string): Promise<never> { await this.audit.append({ category: 'AUTHORIZATION', eventType: 'CLINIC_APPLICATION_REVIEW_DENIED', actorAccountId: actor, targetType: 'CLINIC_APPLICATION', targetId, outcome: 'DENIED' }); throw new ClinicApplicationError('FORBIDDEN'); }
  private async deniedReviewInTransaction(actor: string, targetId: string, database: PostgresExecutor): Promise<never> { await this.audit.appendInTransaction(database, { category: 'AUTHORIZATION', eventType: 'CLINIC_APPLICATION_REVIEW_DENIED', actorAccountId: actor, targetType: 'CLINIC_APPLICATION', targetId, outcome: 'DENIED' }); throw new ClinicApplicationError('FORBIDDEN'); }
}

function requireActor(accountId: string | undefined): string { if (!accountId) throw new ClinicApplicationError('UNAUTHORIZED'); return accountId; }
function validate(value: ClinicApplicationInput): ClinicApplicationInput { const legalName = value.legalName.trim(), clinicName = value.clinicName.trim(), ownerEmail = value.ownerEmail.trim().toLowerCase(); if (!legalName || !clinicName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) throw new ClinicApplicationError('CONFLICT'); return { legalName, clinicName, ownerEmail }; }
function event(eventType: string, actorAccountId: string, targetId: string, metadata?: AuditEventInput['metadata']): AuditEventInput { return { category: 'BUSINESS', eventType, actorAccountId, targetType: 'CLINIC_APPLICATION', targetId, outcome: 'SUCCESS', metadata }; }
