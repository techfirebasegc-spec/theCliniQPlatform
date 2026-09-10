import { createIdentifier } from '../../shared/identifiers/uuid.js';
import type { AuditRepository } from '../audit/audit.js';
import type { TenantContextService } from '../memberships/memberships.js';
import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';
import type { ServiceOffering, ServiceOfferingOwner } from '../service-offerings/service-offerings.js';

export type ServiceExposureStatus = 'DRAFT' | 'PUBLISHED' | 'UNPUBLISHED';
export type ServiceExposure = { id: string; serviceOfferingId: string; provider: ServiceOfferingOwner; status: ServiceExposureStatus };

export class ServiceExposureError extends Error {
  public constructor(public readonly code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'CONFLICT') { super(code === 'UNAUTHORIZED' ? 'Authentication is required.' : code === 'CONFLICT' ? 'The requested service exposure operation cannot be completed.' : 'Service Exposure access is not permitted.'); }
}

export interface ServiceExposureRepository {
  transaction<T>(operation: (database: PostgresExecutor) => Promise<T>): Promise<T>;
  find(id: string): Promise<ServiceExposure | null>;
  findDoctorOwnedOffering(offeringId: string, accountId: string): Promise<ServiceOffering | null>;
  findOffering(offeringId: string): Promise<ServiceOffering | null>;
  create(database: PostgresExecutor, exposure: ServiceExposure, actorAccountId: string): Promise<void>;
  transition(database: PostgresExecutor, exposureId: string, from: ServiceExposureStatus, to: ServiceExposureStatus, actorAccountId: string): Promise<ServiceExposure | null>;
}

export class ServiceExposureService {
  public constructor(private readonly repository: ServiceExposureRepository, private readonly context: Pick<TenantContextService, 'require'>, private readonly audit: AuditRepository) {}

  public async create(accountId: string | undefined, serviceOfferingId: string): Promise<ServiceExposure> {
    const actor = this.account(accountId);
    const offering = await this.requireManagedOffering(actor, serviceOfferingId);
    const exposure: ServiceExposure = { id: createIdentifier(), serviceOfferingId, provider: offering.owner, status: 'DRAFT' };
    try { await this.repository.transaction((database) => this.repository.create(database, exposure, actor)); }
    catch { return this.conflict(actor, exposure.id, offering.owner); }
    await this.audit.append(audit('SERVICE_EXPOSURE_CREATED', actor, exposure, 'SUCCESS'));
    return exposure;
  }

  public async publish(accountId: string | undefined, exposureId: string): Promise<ServiceExposure> { return this.change(accountId, exposureId, 'PUBLISHED'); }
  public async unpublish(accountId: string | undefined, exposureId: string): Promise<ServiceExposure> { return this.change(accountId, exposureId, 'UNPUBLISHED'); }

  private async change(accountId: string | undefined, exposureId: string, next: ServiceExposureStatus): Promise<ServiceExposure> {
    const actor = this.account(accountId);
    const exposure = await this.repository.find(exposureId);
    if (!exposure) return this.denied(actor, exposureId);
    await this.requireManagedOffering(actor, exposure.serviceOfferingId);
    if (!validTransition(exposure.status, next)) return this.conflict(actor, exposureId, exposure.provider);
    let updated: ServiceExposure | null;
    try { updated = await this.repository.transaction((database) => this.repository.transition(database, exposure.id, exposure.status, next, actor)); }
    catch { return this.conflict(actor, exposureId, exposure.provider); }
    if (!updated) return this.conflict(actor, exposureId, exposure.provider);
    const eventType = exposure.status === 'UNPUBLISHED' ? 'SERVICE_EXPOSURE_REPUBLISHED' : next === 'PUBLISHED' ? 'SERVICE_EXPOSURE_PUBLISHED' : 'SERVICE_EXPOSURE_UNPUBLISHED';
    await this.audit.append(audit(eventType, actor, updated, 'SUCCESS'));
    return updated;
  }

  private async requireManagedOffering(actor: string, offeringId: string): Promise<ServiceOffering> {
    const doctorOwned = await this.repository.findDoctorOwnedOffering(offeringId, actor);
    if (doctorOwned) return doctorOwned;
    const offering = await this.repository.findOffering(offeringId);
    if (!offering || offering.owner.kind !== 'CLINIC') return this.denied(actor, offeringId);
    try { await this.context.require(actor, offering.owner.tenantId, 'clinic.manage'); return offering; }
    catch { return this.denied(actor, offeringId, offering.owner); }
  }

  private account(accountId: string | undefined): string { if (!accountId) throw new ServiceExposureError('UNAUTHORIZED'); return accountId; }
  private async denied(actor: string, targetId: string, owner?: ServiceOfferingOwner): Promise<never> { await this.audit.append({ category: 'AUTHORIZATION', eventType: 'SERVICE_EXPOSURE_LIFECYCLE_DENIED', actorAccountId: actor, tenantId: owner?.kind === 'CLINIC' ? owner.tenantId : undefined, targetType: 'SERVICE_EXPOSURE', targetId, outcome: 'DENIED' }); throw new ServiceExposureError('FORBIDDEN'); }
  private async conflict(actor: string, targetId: string, owner: ServiceOfferingOwner): Promise<never> { await this.audit.append({ category: 'SECURITY', eventType: 'SERVICE_EXPOSURE_LIFECYCLE_DENIED', actorAccountId: actor, tenantId: owner.kind === 'CLINIC' ? owner.tenantId : undefined, targetType: 'SERVICE_EXPOSURE', targetId, outcome: 'DENIED' }); throw new ServiceExposureError('CONFLICT'); }
}

function validTransition(from: ServiceExposureStatus, to: ServiceExposureStatus) { return (from === 'DRAFT' && to === 'PUBLISHED') || (from === 'PUBLISHED' && to === 'UNPUBLISHED') || (from === 'UNPUBLISHED' && to === 'PUBLISHED'); }
function audit(eventType: string, actor: string, exposure: ServiceExposure, outcome: 'SUCCESS') { return { category: 'BUSINESS' as const, eventType, actorAccountId: actor, tenantId: exposure.provider.kind === 'CLINIC' ? exposure.provider.tenantId : undefined, targetType: 'SERVICE_EXPOSURE', targetId: exposure.id, outcome }; }
