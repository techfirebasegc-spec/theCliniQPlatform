import { createIdentifier } from '../../shared/identifiers/uuid.js';
import type { AuditRepository } from '../audit/audit.js';
import type { TenantContextService } from '../memberships/memberships.js';
import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';

export type ServiceOfferingStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
export type ServiceOfferingVersionStatus = 'DRAFT' | 'ACTIVE' | 'RETIRED';
export type ServiceOfferingOwner = { kind: 'DOCTOR'; doctorProfileId: string } | { kind: 'CLINIC'; clinicId: string; tenantId: string };
export type ServiceOffering = { id: string; owner: ServiceOfferingOwner; name: string; description: string | null; status: ServiceOfferingStatus };
export type ServiceOfferingVersion = { id: string; serviceOfferingId: string; versionNumber: number; status: ServiceOfferingVersionStatus; effectiveFrom: Date; effectiveTo: Date | null; price: { currency: string; amountMinor: bigint } };
export type ServiceOfferingInput = { owner: { kind: 'DOCTOR'; doctorProfileId: string } | { kind: 'CLINIC'; clinicId: string }; name: string; description?: string | null; status: ServiceOfferingStatus };
export type ServiceOfferingMutation = { name: string; description?: string | null; status: ServiceOfferingStatus };
export type ServiceOfferingVersionInput = { versionNumber: number; status: ServiceOfferingVersionStatus; effectiveFrom: Date; effectiveTo?: Date | null; currency: string; amountMinor: bigint };

export class ServiceOfferingError extends Error {
  public constructor(public readonly code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'CONFLICT') { super(code === 'UNAUTHORIZED' ? 'Authentication is required.' : code === 'CONFLICT' ? 'The requested service offering operation cannot be completed.' : 'Service Offering access is not permitted.'); }
}

export interface ServiceOfferingRepository {
  transaction<T>(operation: (database: PostgresExecutor) => Promise<T>): Promise<T>;
  find(id: string): Promise<ServiceOffering | null>;
  findDoctorOwnedForAccount(id: string, accountId: string): Promise<ServiceOffering | null>;
  create(database: PostgresExecutor, offering: ServiceOffering, actorAccountId: string): Promise<void>;
  update(database: PostgresExecutor, id: string, mutation: ServiceOfferingMutation, actorAccountId: string): Promise<ServiceOffering | null>;
  createVersion(database: PostgresExecutor, version: ServiceOfferingVersion, actorAccountId: string): Promise<void>;
  findApplicableVersion(serviceOfferingId: string, at: Date): Promise<ServiceOfferingVersion | null>;
  doctorProfileOwned(accountId: string, doctorProfileId: string): Promise<boolean>;
  clinicTenant(clinicId: string): Promise<string | null>;
}

export class ServiceOfferingService {
  public constructor(private readonly repository: ServiceOfferingRepository, private readonly context: Pick<TenantContextService, 'require'>, private readonly audit: AuditRepository) {}

  public async create(accountId: string | undefined, input: ServiceOfferingInput): Promise<ServiceOffering> {
    const actor = this.requireAccount(accountId);
    const owner = await this.authorizeNewOwner(actor, input.owner);
    const offering: ServiceOffering = { id: createIdentifier(), owner, name: input.name, description: input.description ?? null, status: input.status };
    try {
      await this.repository.transaction((database) => this.repository.create(database, offering, actor));
    } catch (error) {
      return this.failed(actor, 'SERVICE_OFFERING', offering.id, owner.kind === 'CLINIC' ? owner.tenantId : undefined, error);
    }
    await this.audit.append({ category: 'BUSINESS', eventType: 'SERVICE_OFFERING_CREATED', actorAccountId: actor, tenantId: owner.kind === 'CLINIC' ? owner.tenantId : undefined, targetType: 'SERVICE_OFFERING', targetId: offering.id, outcome: 'SUCCESS' });
    return offering;
  }

  public async read(accountId: string | undefined, offeringId: string): Promise<ServiceOffering> {
    const actor = this.requireAccount(accountId);
    return this.requireManaged(actor, offeringId);
  }

  public async update(accountId: string | undefined, offeringId: string, mutation: ServiceOfferingMutation): Promise<ServiceOffering> {
    const actor = this.requireAccount(accountId);
    const offering = await this.requireManaged(actor, offeringId);
    try {
      const updated = await this.repository.transaction((database) => this.repository.update(database, offeringId, mutation, actor));
      if (!updated) return this.denied(actor, offeringId, offering.owner.kind === 'CLINIC' ? offering.owner.tenantId : undefined);
      await this.audit.append({ category: 'BUSINESS', eventType: 'SERVICE_OFFERING_UPDATED', actorAccountId: actor, tenantId: offering.owner.kind === 'CLINIC' ? offering.owner.tenantId : undefined, targetType: 'SERVICE_OFFERING', targetId: offeringId, outcome: 'SUCCESS' });
      return updated;
    } catch (error) {
      if (error instanceof ServiceOfferingError) throw error;
      return this.failed(actor, 'SERVICE_OFFERING', offeringId, offering.owner.kind === 'CLINIC' ? offering.owner.tenantId : undefined, error);
    }
  }

  public async createVersion(accountId: string | undefined, offeringId: string, input: ServiceOfferingVersionInput): Promise<ServiceOfferingVersion> {
    const actor = this.requireAccount(accountId);
    const offering = await this.requireManaged(actor, offeringId);
    if (!validVersion(input)) return this.conflict(actor, 'SERVICE_OFFERING_VERSION', offeringId, offering.owner.kind === 'CLINIC' ? offering.owner.tenantId : undefined);
    const version: ServiceOfferingVersion = { id: createIdentifier(), serviceOfferingId: offeringId, versionNumber: input.versionNumber, status: input.status, effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null, price: { currency: input.currency, amountMinor: input.amountMinor } };
    try {
      await this.repository.transaction((database) => this.repository.createVersion(database, version, actor));
    } catch (error) {
      return this.failed(actor, 'SERVICE_OFFERING_VERSION', version.id, offering.owner.kind === 'CLINIC' ? offering.owner.tenantId : undefined, error);
    }
    await this.audit.append({ category: 'BUSINESS', eventType: 'SERVICE_OFFERING_VERSION_CREATED', actorAccountId: actor, tenantId: offering.owner.kind === 'CLINIC' ? offering.owner.tenantId : undefined, targetType: 'SERVICE_OFFERING_VERSION', targetId: version.id, outcome: 'SUCCESS' });
    return version;
  }

  public async applicableVersion(accountId: string | undefined, offeringId: string, at: Date): Promise<ServiceOfferingVersion> {
    const actor = this.requireAccount(accountId);
    await this.requireManaged(actor, offeringId);
    const version = await this.repository.findApplicableVersion(offeringId, at);
    if (!version) return this.denied(actor, offeringId);
    return version;
  }

  private async authorizeNewOwner(accountId: string, owner: ServiceOfferingInput['owner']): Promise<ServiceOfferingOwner> {
    if (owner.kind === 'DOCTOR') {
      if (await this.repository.doctorProfileOwned(accountId, owner.doctorProfileId)) return owner;
      return this.denied(accountId, owner.doctorProfileId);
    }
    const tenantId = await this.repository.clinicTenant(owner.clinicId);
    if (!tenantId) return this.denied(accountId, owner.clinicId);
    try { await this.context.require(accountId, tenantId, 'clinic.manage'); } catch { return this.denied(accountId, owner.clinicId, tenantId); }
    return { kind: 'CLINIC', clinicId: owner.clinicId, tenantId };
  }

  private async requireManaged(accountId: string, offeringId: string): Promise<ServiceOffering> {
    const doctorOwned = await this.repository.findDoctorOwnedForAccount(offeringId, accountId);
    if (doctorOwned) return doctorOwned;
    const offering = await this.repository.find(offeringId);
    if (!offering) return this.denied(accountId, offeringId);
    if (offering.owner.kind !== 'CLINIC') return this.denied(accountId, offeringId);
    try { await this.context.require(accountId, offering.owner.tenantId, 'clinic.manage'); return offering; } catch { return this.denied(accountId, offeringId, offering.owner.tenantId); }
  }

  private requireAccount(accountId: string | undefined): string { if (!accountId) throw new ServiceOfferingError('UNAUTHORIZED'); return accountId; }
  private async denied(accountId: string, targetId: string, tenantId?: string): Promise<never> { await this.audit.append({ category: 'AUTHORIZATION', eventType: 'SERVICE_OFFERING_ACCESS_DENIED', actorAccountId: accountId, tenantId, targetType: 'SERVICE_OFFERING', targetId, outcome: 'DENIED' }); throw new ServiceOfferingError('FORBIDDEN'); }
  private async conflict(accountId: string, targetType: string, targetId: string, tenantId?: string): Promise<never> { await this.audit.append({ category: 'SECURITY', eventType: 'SERVICE_OFFERING_VERSION_REJECTED', actorAccountId: accountId, tenantId, targetType, targetId, outcome: 'DENIED' }); throw new ServiceOfferingError('CONFLICT'); }
  private async failed(accountId: string, targetType: string, targetId: string, tenantId: string | undefined, error: unknown): Promise<never> { if (error instanceof ServiceOfferingError) throw error; if (isConstraintError(error)) return this.conflict(accountId, targetType, targetId, tenantId); await this.audit.append({ category: 'SECURITY', eventType: 'SERVICE_OFFERING_OPERATION_DENIED', actorAccountId: accountId, tenantId, targetType, targetId, outcome: 'DENIED' }); throw new ServiceOfferingError('FORBIDDEN'); }
}

function validVersion(input: ServiceOfferingVersionInput): boolean { return Number.isInteger(input.versionNumber) && input.versionNumber > 0 && input.amountMinor >= 0n && /^[A-Z]{3}$/.test(input.currency) && input.effectiveFrom instanceof Date && !Number.isNaN(input.effectiveFrom.getTime()) && (!input.effectiveTo || input.effectiveTo > input.effectiveFrom) && ['DRAFT', 'ACTIVE', 'RETIRED'].includes(input.status); }
function isConstraintError(error: unknown): error is { code: string } { return typeof error === 'object' && error !== null && 'code' in error && ['23505', '23514', '23P01', '23503'].includes(String((error as { code: unknown }).code)); }
