import type { AuditEventInput, TransactionalAuditRepository } from '../audit/audit.js';
import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';

export type DoctorVerificationSubmissionStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type DoctorVerificationSubmission = {
  id: string;
  doctorProfileId: string;
  doctorAccountId: string;
  registrationAuthority: string;
  registrationJurisdiction: string;
  registrationIdentifier: string;
  status: DoctorVerificationSubmissionStatus;
  submittedAt: Date;
  reviewedByAccountId: string | null;
  reviewedAt: Date | null;
  rejectionReason: string | null;
  documentFileIds: string[];
};

type DoctorProfileForVerification = {
  id: string;
  accountId: string;
  status: string;
  professionalVerificationStatus: string;
};

export type DoctorVerificationSubmissionInput = {
  registrationAuthority: string;
  registrationJurisdiction: string;
  registrationIdentifier: string;
  documentFileIds: string[];
};

export interface DoctorVerificationRepository {
  transaction<T>(operation: (database: PostgresExecutor) => Promise<T>): Promise<T>;
  lockOwnedDoctorProfile(database: PostgresExecutor, profileId: string, accountId: string): Promise<DoctorProfileForVerification | null>;
  findPendingSubmission(database: PostgresExecutor, doctorProfileId: string): Promise<DoctorVerificationSubmission | null>;
  savePendingSubmission(database: PostgresExecutor, actorAccountId: string, profile: DoctorProfileForVerification, input: DoctorVerificationSubmissionInput, existing: DoctorVerificationSubmission | null): Promise<DoctorVerificationSubmission>;
  listSubmissionsForDoctor(profileId: string, accountId: string): Promise<DoctorVerificationSubmission[] | null>;
  listSubmissionsForReview(profileId: string): Promise<DoctorVerificationSubmission[] | null>;
  lockSubmission(database: PostgresExecutor, submissionId: string): Promise<DoctorVerificationSubmission | null>;
  reviewSubmission(database: PostgresExecutor, submission: DoctorVerificationSubmission, reviewerAccountId: string, outcome: 'APPROVED' | 'REJECTED', rejectionReason?: string): Promise<DoctorVerificationSubmission | null>;
}

export interface PlatformAdminEntitlements {
  hasActiveEntitlement(accountId: string): Promise<boolean>;
}

export class DoctorVerificationError extends Error {
  public constructor(public readonly code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT') {
    super(code === 'UNAUTHORIZED' ? 'Authentication is required.' : code === 'FORBIDDEN' ? 'Doctor verification is not permitted.' : code === 'NOT_FOUND' ? 'The requested doctor verification record was not found.' : 'The doctor verification operation cannot be completed.');
  }
}

export class DoctorVerificationService {
  public constructor(private readonly repository: DoctorVerificationRepository, private readonly platformAdmins: PlatformAdminEntitlements, private readonly audit: TransactionalAuditRepository) {}

  public async submit(actorAccountId: string | undefined, profileId: string, input: DoctorVerificationSubmissionInput): Promise<DoctorVerificationSubmission> {
    const actor = requireActor(actorAccountId);
    validateSubmission(input);
    return this.repository.transaction(async (database) => {
      const profile = await this.repository.lockOwnedDoctorProfile(database, profileId, actor);
      if (!profile) return this.denied(actor, profileId, database);
      if (!isSubmittable(profile)) throw new DoctorVerificationError('CONFLICT');
      const existing = await this.repository.findPendingSubmission(database, profileId);
      const submission = await this.repository.savePendingSubmission(database, actor, profile, input, existing);
      await this.audit.appendInTransaction(database, audit(existing ? 'DOCTOR_VERIFICATION_SUBMISSION_UPDATED' : 'DOCTOR_VERIFICATION_SUBMITTED', actor, submission.id, 'SUCCESS'));
      await this.audit.appendInTransaction(database, audit('DOCTOR_VERIFICATION_EVIDENCE_ATTACHED', actor, submission.id, 'SUCCESS', { documentCount: input.documentFileIds.length }));
      return submission;
    });
  }

  public async submissionsForDoctor(actorAccountId: string | undefined, profileId: string): Promise<DoctorVerificationSubmission[]> {
    const actor = requireActor(actorAccountId);
    const submissions = await this.repository.listSubmissionsForDoctor(profileId, actor);
    if (submissions) return submissions;
    await this.audit.append({ category: 'AUTHORIZATION', eventType: 'DOCTOR_VERIFICATION_ACCESS_DENIED', actorAccountId: actor, targetType: 'DOCTOR_PROFILE', targetId: profileId, outcome: 'DENIED' });
    throw new DoctorVerificationError('FORBIDDEN');
  }

  public async submissionsForReview(actorAccountId: string | undefined, profileId: string): Promise<DoctorVerificationSubmission[]> {
    const actor = await this.requirePlatformAdmin(actorAccountId);
    const submissions = await this.repository.listSubmissionsForReview(profileId);
    if (!submissions) throw new DoctorVerificationError('NOT_FOUND');
    if (submissions.some((submission) => submission.doctorAccountId === actor)) {
      await this.audit.append({ category: 'AUTHORIZATION', eventType: 'DOCTOR_VERIFICATION_REVIEW_DENIED', actorAccountId: actor, targetType: 'DOCTOR_PROFILE', targetId: profileId, outcome: 'DENIED' });
      throw new DoctorVerificationError('FORBIDDEN');
    }
    return submissions;
  }

  public async approve(actorAccountId: string | undefined, submissionId: string): Promise<DoctorVerificationSubmission> {
    return this.review(actorAccountId, submissionId, 'APPROVED');
  }

  public async reject(actorAccountId: string | undefined, submissionId: string, rejectionReason: string): Promise<DoctorVerificationSubmission> {
    if (!rejectionReason.trim()) throw new DoctorVerificationError('CONFLICT');
    return this.review(actorAccountId, submissionId, 'REJECTED', rejectionReason.trim());
  }

  private async review(actorAccountId: string | undefined, submissionId: string, outcome: 'APPROVED' | 'REJECTED', rejectionReason?: string): Promise<DoctorVerificationSubmission> {
    const actor = await this.requirePlatformAdmin(actorAccountId);
    return this.repository.transaction(async (database) => {
      const submission = await this.repository.lockSubmission(database, submissionId);
      if (!submission) throw new DoctorVerificationError('NOT_FOUND');
      if (submission.doctorAccountId === actor) return this.denied(actor, submissionId, database);
      if (submission.status !== 'PENDING') throw new DoctorVerificationError('CONFLICT');
      const reviewed = await this.repository.reviewSubmission(database, submission, actor, outcome, rejectionReason);
      if (!reviewed) throw new DoctorVerificationError('CONFLICT');
      await this.audit.appendInTransaction(database, audit(outcome === 'APPROVED' ? 'DOCTOR_PROFESSIONAL_VERIFICATION_APPROVED' : 'DOCTOR_PROFESSIONAL_VERIFICATION_REJECTED', actor, reviewed.id, 'SUCCESS', { doctorProfileId: reviewed.doctorProfileId }));
      return reviewed;
    });
  }

  private async requirePlatformAdmin(actorAccountId: string | undefined): Promise<string> {
    const actor = requireActor(actorAccountId);
    if (!await this.platformAdmins.hasActiveEntitlement(actor)) {
      await this.audit.append({ category: 'AUTHORIZATION', eventType: 'DOCTOR_VERIFICATION_REVIEW_DENIED', actorAccountId: actor, targetType: 'DOCTOR_VERIFICATION_SUBMISSION', outcome: 'DENIED' });
      throw new DoctorVerificationError('FORBIDDEN');
    }
    return actor;
  }

  private async denied(actor: string, targetId: string, database: PostgresExecutor): Promise<never> {
    await this.audit.appendInTransaction(database, { category: 'AUTHORIZATION', eventType: 'DOCTOR_VERIFICATION_ACCESS_DENIED', actorAccountId: actor, targetType: 'DOCTOR_PROFILE', targetId, outcome: 'DENIED' });
    throw new DoctorVerificationError('FORBIDDEN');
  }
}

function requireActor(actorAccountId: string | undefined): string {
  if (!actorAccountId) throw new DoctorVerificationError('UNAUTHORIZED');
  return actorAccountId;
}

function validateSubmission(input: DoctorVerificationSubmissionInput): void {
  if (!input.registrationAuthority.trim() || !input.registrationJurisdiction.trim() || !input.registrationIdentifier.trim() || input.documentFileIds.length === 0 || new Set(input.documentFileIds).size !== input.documentFileIds.length || input.documentFileIds.some((id) => !id.trim())) throw new DoctorVerificationError('CONFLICT');
}

function isSubmittable(profile: DoctorProfileForVerification): boolean {
  return profile.status === 'ACTIVE'
    && ['NOT_SUBMITTED', 'PENDING', 'REJECTED'].includes(profile.professionalVerificationStatus);
}

function audit(eventType: string, actorAccountId: string, targetId: string, outcome: AuditEventInput['outcome'], metadata?: AuditEventInput['metadata']): AuditEventInput {
  return { category: 'BUSINESS', eventType, actorAccountId, targetType: 'DOCTOR_VERIFICATION_SUBMISSION', targetId, outcome, metadata };
}

