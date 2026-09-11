export type TenantRole = 'CLINIC_OWNER' | 'CLINIC_ADMIN' | 'CLINIC_STAFF' | 'DOCTOR' | 'PATIENT';
export type TenantPermission = 'tenant.context.use' | 'tenant.view' | 'clinic.view' | 'clinic.manage' | 'membership.view' | 'membership.invite' | 'membership.manage' | 'network.manage' | 'appointment.view' | 'appointment.start' | 'appointment.complete' | 'appointment.cancel';

const permissionBundles: Record<TenantRole, readonly TenantPermission[]> = {
  CLINIC_OWNER: ['tenant.context.use', 'tenant.view', 'clinic.view', 'clinic.manage', 'membership.view', 'membership.invite', 'membership.manage', 'network.manage', 'appointment.view', 'appointment.complete', 'appointment.cancel'],
  CLINIC_ADMIN: ['tenant.context.use', 'tenant.view', 'clinic.view', 'clinic.manage', 'membership.view', 'membership.invite', 'membership.manage', 'network.manage', 'appointment.view', 'appointment.complete', 'appointment.cancel'],
  CLINIC_STAFF: ['tenant.context.use', 'tenant.view', 'clinic.view'],
  DOCTOR: ['tenant.context.use', 'tenant.view', 'clinic.view'],
  PATIENT: ['tenant.context.use', 'tenant.view', 'clinic.view'],
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
