import { createIdentifier } from '../../shared/identifiers/uuid.js';
import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';

export type PublicDiscoveryStatus = 'NOT_READY' | 'NOT_PUBLISHED' | 'PUBLISHED' | 'REVOKED';
export type PublicDiscoveryControl = { subjectId: string; subjectKind: 'CLINIC' | 'DOCTOR'; status: PublicDiscoveryStatus; publishedExposureCount: number; reason: string | null };
export type DiscoveryReadinessPrerequisite = 'CLINIC_NOT_ACTIVE' | 'TENANT_NOT_ACTIVE' | 'DOCTOR_NOT_ACTIVE' | 'DOCTOR_NOT_VERIFIED' | 'NO_SERVICE_OFFERINGS' | 'SERVICE_NOT_ACTIVE' | 'NO_EFFECTIVE_ACTIVE_VERSION' | 'NO_ACTIVE_AVAILABILITY' | 'EXPOSURE_NOT_PUBLISHED';
export type DiscoveryReadinessSubject = { status: string; tenantStatus: string | null; professionalVerificationStatus: string | null };
export type DiscoveryReadinessService = { serviceId: string; serviceName: string; serviceStatus: string; versionStatus: string | null; versionEffective: boolean; availabilityStatus: string | null; exposureId: string | null; exposureStatus: string | null };
export type DiscoveryReadinessDetail = { subjectId: string; subjectKind: 'CLINIC' | 'DOCTOR'; subjectStatus: string; tenantStatus: string | null; professionalVerificationStatus: string | null; platformDiscoveryStatus: 'PUBLISHED' | 'REVOKED' | null; eligibleForPlatformDiscoveryApproval: boolean; ready: boolean; missingPrerequisites: DiscoveryReadinessPrerequisite[]; services: Array<DiscoveryReadinessService & { eligibleForPlatformDiscoveryApproval: boolean; ready: boolean; missingPrerequisites: DiscoveryReadinessPrerequisite[] }> };
export class PublicDiscoveryControlError extends Error { public constructor(public readonly code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT') { super(code === 'UNAUTHORIZED' ? 'Authentication is required.' : code === 'FORBIDDEN' ? 'Public discovery control is not permitted.' : code === 'NOT_FOUND' ? 'The requested platform record was not found.' : 'The public discovery operation cannot be completed.'); } }
export interface PublicDiscoveryControlRepository {
  transaction<T>(operation: (database: PostgresExecutor) => Promise<T>): Promise<T>;
  subjectExists(kind: 'CLINIC' | 'DOCTOR', id: string): Promise<boolean>;
  readyExposureCount(kind: 'CLINIC' | 'DOCTOR', id: string): Promise<number>;
  approvalStatus(kind: 'CLINIC' | 'DOCTOR', id: string): Promise<'PUBLISHED' | 'REVOKED' | null>;
  readinessSubject(kind: 'CLINIC' | 'DOCTOR', id: string): Promise<DiscoveryReadinessSubject | null>;
  readinessServices(kind: 'CLINIC' | 'DOCTOR', id: string): Promise<DiscoveryReadinessService[]>;
  setApproval(database: PostgresExecutor, actorId: string, kind: 'CLINIC' | 'DOCTOR', id: string, status: 'PUBLISHED' | 'REVOKED'): Promise<void>;
}
export interface PublicDiscoveryPlatformAuthorizer { hasActiveEntitlement(accountId: string): Promise<boolean>; }
export class PublicDiscoveryControlService {
  public constructor(private readonly repository: PublicDiscoveryControlRepository, private readonly entitlements: PublicDiscoveryPlatformAuthorizer) {}
  public async status(actor: string | undefined, kind: 'CLINIC' | 'DOCTOR', id: string): Promise<PublicDiscoveryControl> { await this.require(actor); return this.read(kind, id); }
  public async readiness(actor: string | undefined, kind: 'CLINIC' | 'DOCTOR', id: string): Promise<DiscoveryReadinessDetail> {
    await this.require(actor);
    const [subject, services, approval] = await Promise.all([this.repository.readinessSubject(kind, id), this.repository.readinessServices(kind, id), this.repository.approvalStatus(kind, id)]);
    if (!subject) throw new PublicDiscoveryControlError('NOT_FOUND');
    const subjectMissing = missingSubjectPrerequisites(kind, subject);
    const detailedServices = services.map((service) => {
      const missingPrerequisites = [...subjectMissing, ...missingServicePrerequisites(service)];
      const eligibleForPlatformDiscoveryApproval = missingPrerequisites.length === 0;
      return { ...service, eligibleForPlatformDiscoveryApproval, ready: eligibleForPlatformDiscoveryApproval && approval === 'PUBLISHED', missingPrerequisites };
    });
    const missingPrerequisites = [...new Set<DiscoveryReadinessPrerequisite>([...subjectMissing, ...(services.length ? detailedServices.flatMap((service) => service.missingPrerequisites) : ['NO_SERVICE_OFFERINGS' as const])])];
    const eligibleForPlatformDiscoveryApproval = detailedServices.some((service) => service.eligibleForPlatformDiscoveryApproval);
    return { subjectId: id, subjectKind: kind, subjectStatus: subject.status, tenantStatus: subject.tenantStatus, professionalVerificationStatus: subject.professionalVerificationStatus, platformDiscoveryStatus: approval, eligibleForPlatformDiscoveryApproval, ready: eligibleForPlatformDiscoveryApproval && approval === 'PUBLISHED', missingPrerequisites, services: detailedServices };
  }
  public async publish(actor: string | undefined, kind: 'CLINIC' | 'DOCTOR', id: string): Promise<PublicDiscoveryControl> { const accountId = await this.require(actor); const current = await this.read(kind, id); if (current.publishedExposureCount === 0) throw new PublicDiscoveryControlError('CONFLICT'); await this.repository.transaction((database) => this.repository.setApproval(database, accountId, kind, id, 'PUBLISHED')); return this.read(kind, id); }
  public async revoke(actor: string | undefined, kind: 'CLINIC' | 'DOCTOR', id: string): Promise<PublicDiscoveryControl> { const accountId = await this.require(actor); const current = await this.read(kind, id); if (current.status !== 'PUBLISHED') throw new PublicDiscoveryControlError('CONFLICT'); await this.repository.transaction((database) => this.repository.setApproval(database, accountId, kind, id, 'REVOKED')); return this.read(kind, id); }
  private async read(kind: 'CLINIC' | 'DOCTOR', id: string): Promise<PublicDiscoveryControl> { if (!await this.repository.subjectExists(kind, id)) throw new PublicDiscoveryControlError('NOT_FOUND'); const [publishedExposureCount, approval] = await Promise.all([this.repository.readyExposureCount(kind, id), this.repository.approvalStatus(kind, id)]); const status: PublicDiscoveryStatus = approval === 'REVOKED' ? 'REVOKED' : publishedExposureCount === 0 ? 'NOT_READY' : approval === 'PUBLISHED' ? 'PUBLISHED' : 'NOT_PUBLISHED'; return { subjectId: id, subjectKind: kind, status, publishedExposureCount, reason: status === 'NOT_READY' ? 'No published service exposure with active service and availability exists.' : status === 'REVOKED' ? 'Platform Admin revoked public discovery.' : null }; }
  private async require(actor: string | undefined) { if (!actor) throw new PublicDiscoveryControlError('UNAUTHORIZED'); if (!await this.entitlements.hasActiveEntitlement(actor)) throw new PublicDiscoveryControlError('FORBIDDEN'); return actor; }
}
function missingSubjectPrerequisites(kind: 'CLINIC' | 'DOCTOR', subject: DiscoveryReadinessSubject): DiscoveryReadinessPrerequisite[] { return kind === 'CLINIC' ? [...(subject.status === 'ACTIVE' ? [] : ['CLINIC_NOT_ACTIVE' as const]), ...(subject.tenantStatus === 'ACTIVE' ? [] : ['TENANT_NOT_ACTIVE' as const])] : [...(subject.status === 'ACTIVE' ? [] : ['DOCTOR_NOT_ACTIVE' as const]), ...(subject.professionalVerificationStatus === 'VERIFIED' ? [] : ['DOCTOR_NOT_VERIFIED' as const])]; }
function missingServicePrerequisites(service: DiscoveryReadinessService): DiscoveryReadinessPrerequisite[] { return [...(service.serviceStatus === 'ACTIVE' ? [] : ['SERVICE_NOT_ACTIVE' as const]), ...(service.versionEffective && service.versionStatus === 'ACTIVE' ? [] : ['NO_EFFECTIVE_ACTIVE_VERSION' as const]), ...(service.availabilityStatus === 'ACTIVE' ? [] : ['NO_ACTIVE_AVAILABILITY' as const]), ...(service.exposureStatus === 'PUBLISHED' ? [] : ['EXPOSURE_NOT_PUBLISHED' as const])]; }
export function newApprovalId() { return createIdentifier(); }
