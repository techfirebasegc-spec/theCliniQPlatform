import type { AuditEventInput, TransactionalAuditRepository } from '../audit/audit.js';
import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';

export type DoctorApplicationStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type DoctorApplication = {
  id: string;
  doctorProfileId: string;
  doctorAccountId: string;
  displayName: string | null;
  profileStatus: string;
  professionalVerificationStatus: string;
  status: DoctorApplicationStatus;
  submittedAt: Date;
  reviewedAt: Date | null;
  reviewerAccountId: string | null;
  rejectionReason: string | null;
};

export type DoctorApplicationProfile = {
  id: string;
  accountId: string;
  status: string;
  professionalVerificationStatus: string;
};

export type DoctorApplicationAccount = {
  id: string;
  status: string;
};

export interface DoctorApplicationRepository {
  transaction<T>(operation: (database: PostgresExecutor) => Promise<T>): Promise<T>;
  lockOwnedProfile(database: PostgresExecutor, doctorProfileId: string, accountId: string): Promise<DoctorApplicationProfile | null>;
  lockApplicationForProfile(database: PostgresExecutor, doctorProfileId: string): Promise<DoctorApplication | null>;
  submit(database: PostgresExecutor, profile: DoctorApplicationProfile, actorAccountId: string, existing: DoctorApplication | null): Promise<DoctorApplication>;
  getOwned(profileId: string, accountId: string): Promise<DoctorApplication | null>;
  listPending(): Promise<DoctorApplication[]>;
  getForReview(applicationId: string): Promise<DoctorApplication | null>;
  lockForReview(database: PostgresExecutor, applicationId: string): Promise<DoctorApplication | null>;
  lockAccountForApproval(database: PostgresExecutor, accountId: string): Promise<DoctorApplicationAccount | null>;
  activatePendingAccountForApproval(database: PostgresExecutor, accountId: string, reviewerAccountId: string): Promise<boolean>;
  review(database: PostgresExecutor, application: DoctorApplication, reviewerAccountId: string, outcome: 'APPROVED' | 'REJECTED', rejectionReason?: string): Promise<DoctorApplication | null>;
}

export interface PlatformAdminEntitlements { hasActiveEntitlement(accountId: string): Promise<boolean>; }

export class DoctorApplicationError extends Error {
  public constructor(public readonly code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT') {
    super(code === 'UNAUTHORIZED' ? 'Authentication is required.' : code === 'FORBIDDEN' ? 'Doctor application access is not permitted.' : code === 'NOT_FOUND' ? 'The requested doctor application was not found.' : 'The doctor application operation cannot be completed.');
  }
}

export class DoctorApplicationService {
  public constructor(private readonly repository: DoctorApplicationRepository, private readonly platformAdmins: PlatformAdminEntitlements, private readonly audit: TransactionalAuditRepository) {}

  public async submit(actorAccountId: string | undefined, doctorProfileId: string): Promise<DoctorApplication> {
    const actor = requireActor(actorAccountId);
    return this.repository.transaction(async (database) => {
      const profile = await this.repository.lockOwnedProfile(database, doctorProfileId, actor);
      if (!profile) return this.denied(actor, doctorProfileId, database);
      const existing = await this.repository.lockApplicationForProfile(database, doctorProfileId);
      if (!isSubmittable(profile, existing)) throw new DoctorApplicationError('CONFLICT');
      const submitted = await this.repository.submit(database, profile, actor, existing);
      await this.audit.appendInTransaction(database, applicationAudit('DOCTOR_APPLICATION_SUBMITTED', actor, submitted.id, { resubmission: existing?.status === 'REJECTED' }));
      return submitted;
    });
  }

  public async mine(actorAccountId: string | undefined, doctorProfileId: string): Promise<DoctorApplication> {
    const actor = requireActor(actorAccountId);
    const application = await this.repository.getOwned(doctorProfileId, actor);
    if (application) return application;
    await this.audit.append({ category: 'AUTHORIZATION', eventType: 'DOCTOR_APPLICATION_ACCESS_DENIED', actorAccountId: actor, targetType: 'DOCTOR_PROFILE', targetId: doctorProfileId, outcome: 'DENIED' });
    throw new DoctorApplicationError('NOT_FOUND');
  }

  public async pending(actorAccountId: string | undefined): Promise<DoctorApplication[]> {
    await this.requirePlatformAdmin(actorAccountId);
    return this.repository.listPending();
  }

  public async inspect(actorAccountId: string | undefined, applicationId: string): Promise<DoctorApplication> {
    const actor = await this.requirePlatformAdmin(actorAccountId);
    const application = await this.repository.getForReview(applicationId);
    if (!application) throw new DoctorApplicationError('NOT_FOUND');
    if (application.doctorAccountId === actor) return this.deniedReview(actor, applicationId);
    return application;
  }

  public approve(actorAccountId: string | undefined, applicationId: string): Promise<DoctorApplication> { return this.review(actorAccountId, applicationId, 'APPROVED'); }
  public reject(actorAccountId: string | undefined, applicationId: string, rejectionReason: string): Promise<DoctorApplication> {
    if (!rejectionReason.trim()) throw new DoctorApplicationError('CONFLICT');
    return this.review(actorAccountId, applicationId, 'REJECTED', rejectionReason.trim());
  }

  private async review(actorAccountId: string | undefined, applicationId: string, outcome: 'APPROVED' | 'REJECTED', rejectionReason?: string): Promise<DoctorApplication> {
    const actor = await this.requirePlatformAdmin(actorAccountId);
    return this.repository.transaction(async (database) => {
      const application = await this.repository.lockForReview(database, applicationId);
      if (!application) throw new DoctorApplicationError('NOT_FOUND');
      if (application.doctorAccountId === actor) return this.deniedReviewInTransaction(actor, applicationId, database);
      if (application.status !== 'PENDING' || application.profileStatus !== 'PENDING_VERIFICATION' || application.professionalVerificationStatus !== 'NOT_SUBMITTED') throw new DoctorApplicationError('CONFLICT');
      const account = outcome === 'APPROVED' ? await this.repository.lockAccountForApproval(database, application.doctorAccountId) : null;
      if (account && !['PENDING_VERIFICATION', 'ACTIVE'].includes(account.status)) throw new DoctorApplicationError('CONFLICT');
      if (outcome === 'APPROVED' && !account) throw new DoctorApplicationError('CONFLICT');
      const reviewed = await this.repository.review(database, application, actor, outcome, rejectionReason);
      if (!reviewed) throw new DoctorApplicationError('CONFLICT');
      if (account?.status === 'PENDING_VERIFICATION' && !await this.repository.activatePendingAccountForApproval(database, account.id, actor)) throw new DoctorApplicationError('CONFLICT');
      await this.audit.appendInTransaction(database, applicationAudit(outcome === 'APPROVED' ? 'DOCTOR_APPLICATION_APPROVED' : 'DOCTOR_APPLICATION_REJECTED', actor, reviewed.id, { doctorProfileId: reviewed.doctorProfileId }));
      return reviewed;
    });
  }

  private async requirePlatformAdmin(actorAccountId: string | undefined): Promise<string> {
    const actor = requireActor(actorAccountId);
    if (!await this.platformAdmins.hasActiveEntitlement(actor)) {
      await this.audit.append({ category: 'AUTHORIZATION', eventType: 'DOCTOR_APPLICATION_REVIEW_DENIED', actorAccountId: actor, targetType: 'DOCTOR_APPLICATION', outcome: 'DENIED' });
      throw new DoctorApplicationError('FORBIDDEN');
    }
    return actor;
  }

  private async denied(actor: string, targetId: string, database: PostgresExecutor): Promise<never> {
    await this.audit.appendInTransaction(database, { category: 'AUTHORIZATION', eventType: 'DOCTOR_APPLICATION_ACCESS_DENIED', actorAccountId: actor, targetType: 'DOCTOR_PROFILE', targetId, outcome: 'DENIED' });
    throw new DoctorApplicationError('FORBIDDEN');
  }
  private async deniedReview(actor: string, targetId: string): Promise<never> {
    await this.audit.append({ category: 'AUTHORIZATION', eventType: 'DOCTOR_APPLICATION_REVIEW_DENIED', actorAccountId: actor, targetType: 'DOCTOR_APPLICATION', targetId, outcome: 'DENIED' });
    throw new DoctorApplicationError('FORBIDDEN');
  }
  private async deniedReviewInTransaction(actor: string, targetId: string, database: PostgresExecutor): Promise<never> {
    await this.audit.appendInTransaction(database, { category: 'AUTHORIZATION', eventType: 'DOCTOR_APPLICATION_REVIEW_DENIED', actorAccountId: actor, targetType: 'DOCTOR_APPLICATION', targetId, outcome: 'DENIED' });
    throw new DoctorApplicationError('FORBIDDEN');
  }
}

function requireActor(actorAccountId: string | undefined): string { if (!actorAccountId) throw new DoctorApplicationError('UNAUTHORIZED'); return actorAccountId; }
function isSubmittable(profile: DoctorApplicationProfile, application: DoctorApplication | null): boolean {
  return (!application && profile.status === 'DRAFT' && profile.professionalVerificationStatus === 'NOT_SUBMITTED')
    || (application?.status === 'REJECTED' && profile.status === 'PENDING_VERIFICATION' && profile.professionalVerificationStatus === 'NOT_SUBMITTED');
}
function applicationAudit(eventType: string, actorAccountId: string, targetId: string, metadata: AuditEventInput['metadata']): AuditEventInput { return { category: 'BUSINESS', eventType, actorAccountId, targetType: 'DOCTOR_APPLICATION', targetId, outcome: 'SUCCESS', metadata }; }
