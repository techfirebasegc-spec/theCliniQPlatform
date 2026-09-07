export type TenantRole = 'CLINIC_OWNER' | 'CLINIC_ADMIN' | 'CLINIC_STAFF';
export type TenantPermission = 'tenant.view' | 'clinic.manage' | 'membership.manage' | 'network.manage';

const permissionBundles: Record<TenantRole, readonly TenantPermission[]> = {
  CLINIC_OWNER: ['tenant.view', 'clinic.manage', 'membership.manage', 'network.manage'],
  CLINIC_ADMIN: ['tenant.view', 'clinic.manage', 'membership.manage', 'network.manage'],
  CLINIC_STAFF: ['tenant.view'],
};

export interface TenantMembershipContext {
  accountId: string;
  tenantId: string;
  role: TenantRole;
  status: 'ACTIVE' | 'INVITED' | 'SUSPENDED' | 'REMOVED' | 'EXPIRED';
}

export interface AuthorizationAudit {
  recordDenial(accountId: string, tenantId: string): Promise<void>;
}

export function hasTenantPermission(membership: TenantMembershipContext | null, accountId: string, tenantId: string, permission: TenantPermission): boolean {
  return membership?.accountId === accountId
    && membership.tenantId === tenantId
    && membership.status === 'ACTIVE'
    && permissionBundles[membership.role].includes(permission);
}

export function assertTenantPermission(membership: TenantMembershipContext | null, accountId: string, tenantId: string, permission: TenantPermission): void {
  if (!hasTenantPermission(membership, accountId, tenantId, permission)) {
    throw new Error('FORBIDDEN');
  }
}

export async function authorizeTenant(membership: TenantMembershipContext | null, accountId: string, tenantId: string, permission: TenantPermission, audit: AuthorizationAudit): Promise<void> {
  if (hasTenantPermission(membership, accountId, tenantId, permission)) return;
  await audit.recordDenial(accountId, tenantId);
  throw new Error('FORBIDDEN');
}
