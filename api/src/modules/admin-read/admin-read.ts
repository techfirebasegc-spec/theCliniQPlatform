import type { TenantRole } from '../authorization/authorization.js';
import type { PlatformAdminEntitlementService } from '../admin-access/admin-entitlements.js';
import type { TenantContextService } from '../memberships/memberships.js';

export type Page = { limit: number; offset: number };
export type PageResult<T> = { items: T[]; page: Page & { total: number } };
export type AdminTenantContext = { membershipId: string | null; tenantId: string; role: TenantRole | 'PLATFORM_ADMIN'; access: 'TENANT_MEMBERSHIP' | 'PLATFORM_ADMIN'; clinic: { id: string; displayName: string; status: string } | null };
export type AdminMembership = { id: string; accountId: string; role: TenantRole; status: string };
export type AdminAppointment = { id: string; patientProfileId: string | null; patientDisplayName: string | null; serviceOfferingId: string; serviceName: string; status: string; startsAt: Date; endsAt: Date };
export type AdminServiceOffering = { id: string; name: string; description: string | null; status: string };
export type AppointmentListFilter = Page & { from?: Date; to?: Date; status?: string };

export interface AdminReadRepository {
  listContexts(accountId: string): Promise<AdminTenantContext[]>;
  listAllActiveContexts(): Promise<AdminTenantContext[]>;
  listMemberships(tenantId: string, page: Page): Promise<AdminMembership[]>;
  countMemberships(tenantId: string): Promise<number>;
  listAppointments(tenantId: string, filter: AppointmentListFilter): Promise<AdminAppointment[]>;
  countAppointments(tenantId: string, filter: Omit<AppointmentListFilter, 'limit' | 'offset'>): Promise<number>;
  listServices(tenantId: string, page: Page): Promise<AdminServiceOffering[]>;
  countServices(tenantId: string): Promise<number>;
}

export class AdminReadError extends Error {
  public constructor(public readonly code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'CONFLICT') {
    super(code === 'UNAUTHORIZED' ? 'Authentication is required.' : code === 'FORBIDDEN' ? 'Tenant access is not permitted.' : 'The requested read filter is invalid.');
  }
}

export class AdminReadService {
  public constructor(private readonly repository: AdminReadRepository, private readonly context: Pick<TenantContextService, 'require'>, private readonly platformAdmins: Pick<PlatformAdminEntitlementService, 'hasActiveEntitlement'>) {}

  public async contexts(accountId: string | undefined): Promise<AdminTenantContext[]> {
    const actor = this.requireAccount(accountId);
    return (await this.platformAdmins.hasActiveEntitlement(actor)) ? this.repository.listAllActiveContexts() : this.repository.listContexts(actor);
  }

  public async memberships(accountId: string | undefined, tenantId: string, page: Page): Promise<PageResult<AdminMembership>> {
    const actor = this.requireAccount(accountId);
    await this.require(actor, tenantId, 'membership.view');
    const [items, total] = await Promise.all([this.repository.listMemberships(tenantId, page), this.repository.countMemberships(tenantId)]);
    return { items, page: { ...page, total } };
  }

  public async appointments(accountId: string | undefined, tenantId: string, filter: AppointmentListFilter): Promise<PageResult<AdminAppointment>> {
    const actor = this.requireAccount(accountId);
    await this.require(actor, tenantId, 'appointment.view');
    const { limit, offset, ...countFilter } = filter;
    const [items, total] = await Promise.all([this.repository.listAppointments(tenantId, filter), this.repository.countAppointments(tenantId, countFilter)]);
    return { items, page: { limit, offset, total } };
  }

  public async services(accountId: string | undefined, tenantId: string, page: Page): Promise<PageResult<AdminServiceOffering>> {
    const actor = this.requireAccount(accountId);
    await this.require(actor, tenantId, 'clinic.view');
    const [items, total] = await Promise.all([this.repository.listServices(tenantId, page), this.repository.countServices(tenantId)]);
    return { items, page: { ...page, total } };
  }

  private requireAccount(accountId: string | undefined): string {
    if (!accountId) throw new AdminReadError('UNAUTHORIZED');
    return accountId;
  }

  private async require(accountId: string, tenantId: string, permission: 'membership.view' | 'appointment.view' | 'clinic.view'): Promise<void> {
    try { await this.context.require(accountId, tenantId, permission); }
    catch { throw new AdminReadError('FORBIDDEN'); }
  }
}
