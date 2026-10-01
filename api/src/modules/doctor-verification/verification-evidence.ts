import { createHash } from 'node:crypto';
import { createIdentifier } from '../../shared/identifiers/uuid.js';
import type { TransactionalAuditRepository } from '../audit/audit.js';
import type { StorageProvider } from '../files/aic-s3-storage-provider.js';
import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';
import { DoctorVerificationError, type PlatformAdminEntitlements } from './doctor-verification.js';

export type VerificationEvidence = { id: string; doctorProfileId: string; originalFilename: string; contentType: string; byteSize: number; status: 'AVAILABLE' | 'PENDING_UPLOAD' | 'UPLOAD_FAILED' };
type EvidenceObject = VerificationEvidence & { objectKey: string; bucket: string; doctorAccountId: string };
export type EvidenceUpload = { originalFilename: string; contentType: string; body: Uint8Array };

export interface VerificationEvidenceRepository {
  transaction<T>(operation: (database: PostgresExecutor) => Promise<T>): Promise<T>;
  createPending(database: PostgresExecutor, value: EvidenceObject, actorAccountId: string): Promise<void>;
  markAvailable(id: string, sha256: string): Promise<void>;
  markUploadFailed(id: string): Promise<void>;
  listOwned(doctorProfileId: string, accountId: string): Promise<EvidenceObject[] | null>;
  findOwned(fileId: string, doctorProfileId: string, accountId: string): Promise<EvidenceObject | null>;
  listForReview(submissionId: string): Promise<EvidenceObject[] | null>;
  findForReview(submissionId: string, fileId: string): Promise<EvidenceObject | null>;
}

export class VerificationEvidenceService {
  public constructor(private readonly repository: VerificationEvidenceRepository, private readonly storage: StorageProvider | null, private readonly storageBucket: string | undefined, private readonly platformAdmins: PlatformAdminEntitlements, private readonly audit: TransactionalAuditRepository) {}

  public async upload(actorAccountId: string | undefined, doctorProfileId: string, input: EvidenceUpload): Promise<VerificationEvidence> {
    const actor = requireActor(actorAccountId); validateUpload(input);
    if (!this.storage || !this.storageBucket) throw new DoctorVerificationError('CONFLICT');
    const id = createIdentifier();
    const value: EvidenceObject = { id, doctorProfileId, doctorAccountId: actor, originalFilename: cleanFilename(input.originalFilename), contentType: input.contentType, byteSize: input.body.byteLength, status: 'PENDING_UPLOAD', objectKey: `doctor-verification/${doctorProfileId}/${id}`, bucket: this.storageBucket };
    await this.repository.transaction(async (database) => {
      await this.repository.createPending(database, value, actor);
      await this.audit.appendInTransaction(database, { category: 'BUSINESS', eventType: 'DOCTOR_VERIFICATION_EVIDENCE_UPLOAD_STARTED', actorAccountId: actor, targetType: 'FILE', targetId: id, outcome: 'SUCCESS' });
    });
    try {
      await this.storage.putObject(value.objectKey, input.body, { contentType: value.contentType });
      const digest = createHash('sha256').update(input.body).digest('hex');
      await this.repository.markAvailable(id, digest);
      await this.audit.append({ category: 'BUSINESS', eventType: 'DOCTOR_VERIFICATION_EVIDENCE_UPLOADED', actorAccountId: actor, targetType: 'FILE', targetId: id, outcome: 'SUCCESS' });
      return publicEvidence({ ...value, status: 'AVAILABLE' });
    } catch (error) {
      await this.repository.markUploadFailed(id);
      await this.audit.append({ category: 'SECURITY', eventType: 'DOCTOR_VERIFICATION_EVIDENCE_UPLOAD_FAILED', actorAccountId: actor, targetType: 'FILE', targetId: id, outcome: 'FAILURE' });
      throw error;
    }
  }

  public async listForDoctor(actorAccountId: string | undefined, doctorProfileId: string): Promise<VerificationEvidence[]> {
    const actor = requireActor(actorAccountId);
    const evidence = await this.repository.listOwned(doctorProfileId, actor);
    if (evidence) return evidence.map(publicEvidence);
    await this.audit.append({ category: 'AUTHORIZATION', eventType: 'DOCTOR_VERIFICATION_EVIDENCE_ACCESS_DENIED', actorAccountId: actor, targetType: 'DOCTOR_PROFILE', targetId: doctorProfileId, outcome: 'DENIED' });
    throw new DoctorVerificationError('FORBIDDEN');
  }

  public async downloadForDoctor(actorAccountId: string | undefined, doctorProfileId: string, fileId: string): Promise<{ evidence: VerificationEvidence; body: Uint8Array }> {
    const actor = requireActor(actorAccountId); const evidence = await this.repository.findOwned(fileId, doctorProfileId, actor);
    if (!evidence) return this.denied(actor, fileId);
    return this.read(evidence, actor, 'DOCTOR_VERIFICATION_EVIDENCE_DOWNLOADED');
  }

  public async listForReviewer(actorAccountId: string | undefined, submissionId: string): Promise<VerificationEvidence[]> {
    const actor = await this.requireReviewer(actorAccountId);
    const evidence = await this.repository.listForReview(submissionId);
    if (!evidence) throw new DoctorVerificationError('NOT_FOUND');
    if (evidence.some((item) => item.doctorAccountId === actor)) return this.denied(actor, submissionId);
    return evidence.map(publicEvidence);
  }

  public async downloadForReviewer(actorAccountId: string | undefined, submissionId: string, fileId: string): Promise<{ evidence: VerificationEvidence; body: Uint8Array }> {
    const actor = await this.requireReviewer(actorAccountId); const evidence = await this.repository.findForReview(submissionId, fileId);
    if (!evidence || evidence.doctorAccountId === actor) return this.denied(actor, submissionId);
    return this.read(evidence, actor, 'DOCTOR_VERIFICATION_EVIDENCE_REVIEWED');
  }

  private async read(evidence: EvidenceObject, actorAccountId: string, eventType: string): Promise<{ evidence: VerificationEvidence; body: Uint8Array }> {
    if (!this.storage || evidence.status !== 'AVAILABLE') throw new DoctorVerificationError('CONFLICT');
    const object = await this.storage.getObject(evidence.objectKey);
    await this.audit.append({ category: 'SECURITY', eventType, actorAccountId, targetType: 'FILE', targetId: evidence.id, outcome: 'SUCCESS' });
    return { evidence: publicEvidence(evidence), body: object.body };
  }

  private async requireReviewer(actorAccountId: string | undefined): Promise<string> {
    const actor = requireActor(actorAccountId);
    if (!await this.platformAdmins.hasActiveEntitlement(actor)) return this.denied(actor, 'platform-review');
    return actor;
  }

  private async denied(actorAccountId: string, targetId: string): Promise<never> {
    await this.audit.append({ category: 'AUTHORIZATION', eventType: 'DOCTOR_VERIFICATION_EVIDENCE_ACCESS_DENIED', actorAccountId, targetType: 'FILE', targetId, outcome: 'DENIED' });
    throw new DoctorVerificationError('FORBIDDEN');
  }
}

function requireActor(value: string | undefined) { if (!value) throw new DoctorVerificationError('UNAUTHORIZED'); return value; }
function publicEvidence(value: EvidenceObject): VerificationEvidence { return { id: value.id, doctorProfileId: value.doctorProfileId, originalFilename: value.originalFilename, contentType: value.contentType, byteSize: value.byteSize, status: value.status }; }
function cleanFilename(value: string) { return value.trim(); }
function validateUpload(input: EvidenceUpload) { if (!cleanFilename(input.originalFilename) || /[\r\n]/.test(input.originalFilename) || !['application/pdf', 'image/jpeg', 'image/png'].includes(input.contentType) || input.body.byteLength === 0 || input.body.byteLength > 4 * 1024 * 1024) throw new DoctorVerificationError('CONFLICT'); }
