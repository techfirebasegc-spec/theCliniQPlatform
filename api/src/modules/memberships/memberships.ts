import { createHash, randomBytes } from 'node:crypto';
import { createIdentifier } from '../../shared/identifiers/uuid.js';
import { assertTenantPermission, type TenantMembershipContext, type TenantPermission, type TenantRole } from '../authorization/authorization.js';
import type { AuditRepository } from '../audit/audit.js';
import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';

export type MembershipStatus = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'REMOVED' | 'EXPIRED';
export type InvitationStatus = 'INVITED' | 'ACCEPTED' | 'REJECTED' | 'REVOKED' | 'EXPIRED';
export type TenantMembership = TenantMembershipContext & { id: string };
export type TenantInvitation = { id: string; tenantId: string; targetAccountId: string; createdByAccountId: string; role: TenantRole; status: InvitationStatus; expiresAt: Date };
type InvitationAcceptanceOutcome = { kind: 'EXPIRED'; invitation: TenantInvitation } | { kind: 'ACCEPTED'; membership: TenantMembership };
export class MembershipAccessError extends Error { public constructor(public readonly code: 'FORBIDDEN' | 'CONFLICT') { super(code === 'FORBIDDEN' ? 'Tenant access is not permitted.' : 'The requested membership operation cannot be completed.'); } }
const roles: readonly TenantRole[] = ['CLINIC_OWNER', 'CLINIC_ADMIN', 'CLINIC_STAFF', 'DOCTOR', 'PATIENT'];
const membershipStatuses: readonly MembershipStatus[] = ['INVITED', 'ACTIVE', 'SUSPENDED', 'REMOVED', 'EXPIRED'];

export interface MembershipRepository {
  transaction<T>(operation: (database: PostgresExecutor) => Promise<T>): Promise<T>;
  findActiveContext(accountId: string, tenantId: string): Promise<TenantMembership | null>;
  findActiveContextForUpdate(database: PostgresExecutor, accountId: string, tenantId: string): Promise<TenantMembership | null>;
  createInvitation(database: PostgresExecutor, invitation: TenantInvitation & { secretHash: string; createdByAccountId: string }): Promise<void>;
  lockInvitation(database: PostgresExecutor, id: string): Promise<(TenantInvitation & { secretHash: string }) | null>;
  activeMembership(database: PostgresExecutor, tenantId: string, accountId: string): Promise<TenantMembership | null>;
  activateMembership(database: PostgresExecutor, tenantId: string, accountId: string, role: TenantRole, invitedByAccountId: string): Promise<TenantMembership>;
  acceptInvitation(database: PostgresExecutor, invitationId: string, accountId: string): Promise<void>;
  setInvitationStatus(database: PostgresExecutor, invitationId: string, status: Exclude<InvitationStatus, 'INVITED' | 'ACCEPTED'>, actorAccountId?: string): Promise<void>;
  lockActiveOwners(database: PostgresExecutor, tenantId: string): Promise<TenantMembership[]>;
  lockMembership(database: PostgresExecutor, tenantId: string, membershipId: string): Promise<TenantMembership | null>;
  updateMembership(database: PostgresExecutor, tenantId: string, membershipId: string, status: MembershipStatus, role: TenantRole, actorAccountId: string): Promise<TenantMembership | null>;
}

export class TenantContextService {
  public constructor(private readonly repository: MembershipRepository, private readonly audit: AuditRepository) {}
  public async require(accountId: string, tenantId: string, permission: TenantPermission): Promise<TenantMembership> {
    const context = await this.repository.findActiveContext(accountId, tenantId);
    try { assertTenantPermission(context, accountId, tenantId, permission); } catch {
      await this.audit.append({ category: 'AUTHORIZATION', eventType: 'TENANT_CONTEXT_DENIED', actorAccountId: accountId, tenantId, targetType: 'TENANT', targetId: tenantId, outcome: 'DENIED' });
      throw new MembershipAccessError('FORBIDDEN');
    }
    return context!;
  }
  public async requireInTransaction(database: PostgresExecutor, accountId: string, tenantId: string, permission: TenantPermission): Promise<TenantMembership> {
    const context = await this.repository.findActiveContextForUpdate(database, accountId, tenantId);
    try { assertTenantPermission(context, accountId, tenantId, permission); } catch {
      await this.audit.append({ category: 'AUTHORIZATION', eventType: 'TENANT_CONTEXT_DENIED', actorAccountId: accountId, tenantId, targetType: 'TENANT', targetId: tenantId, outcome: 'DENIED' });
      throw new MembershipAccessError('FORBIDDEN');
    }
    return context!;
  }
}

export class MembershipService {
  public constructor(private readonly repository: MembershipRepository, private readonly context: TenantContextService, private readonly audit: AuditRepository) {}
  public async invite(actorAccountId: string, tenantId: string, targetAccountId: string, role: TenantRole, expiresAt: Date): Promise<{ invitation: TenantInvitation; secret: string }> {
    if (!isTenantRole(role) || expiresAt <= new Date()) throw new MembershipAccessError('CONFLICT');
    const invitation = { id: createIdentifier(), tenantId, targetAccountId, createdByAccountId: actorAccountId, role, status: 'INVITED' as const, expiresAt };
    const secret = randomBytes(32).toString('base64url');
    try {
      await this.repository.transaction(async (database) => {
        const actor = await this.context.requireInTransaction(database, actorAccountId, tenantId, 'membership.invite');
        if (role === 'CLINIC_OWNER' && actor.role !== 'CLINIC_OWNER') throw new MembershipAccessError('FORBIDDEN');
        if (await this.repository.activeMembership(database, tenantId, targetAccountId)) throw new MembershipAccessError('CONFLICT');
        await this.repository.createInvitation(database, { ...invitation, secretHash: secretHash(secret) });
      });
    } catch {
      await this.audit.append({ category: 'AUTHORIZATION', eventType: 'TENANT_INVITATION_CREATE_DENIED', actorAccountId, tenantId, targetType: 'TENANT_INVITATION', targetId: invitation.id, outcome: 'DENIED' });
      throw new MembershipAccessError('CONFLICT');
    }
    await this.audit.append({ category: 'BUSINESS', eventType: 'TENANT_INVITATION_CREATED', actorAccountId, tenantId, targetType: 'TENANT_INVITATION', targetId: invitation.id, outcome: 'SUCCESS' });
    return { invitation, secret };
  }
  public async accept(accountId: string, invitationId: string, secret: string): Promise<TenantMembership> {
    try {
      const result = await this.repository.transaction<InvitationAcceptanceOutcome>(async (database) => {
        const invitation = await this.repository.lockInvitation(database, invitationId);
        if (!invitation || invitation.status !== 'INVITED' || invitation.targetAccountId !== accountId || invitation.secretHash !== secretHash(secret)) throw new MembershipAccessError('FORBIDDEN');
        if (invitation.expiresAt <= new Date()) { await this.repository.setInvitationStatus(database, invitation.id, 'EXPIRED'); return { kind: 'EXPIRED', invitation }; }
        if (await this.repository.activeMembership(database, invitation.tenantId, accountId)) throw new MembershipAccessError('CONFLICT');
        const created = await this.repository.activateMembership(database, invitation.tenantId, accountId, invitation.role, invitation.createdByAccountId);
        await this.repository.acceptInvitation(database, invitation.id, accountId);
        return { kind: 'ACCEPTED', membership: created };
      });
      if (result.kind === 'EXPIRED') { await this.audit.append({ category: 'BUSINESS', eventType: 'TENANT_INVITATION_EXPIRED', actorAccountId: accountId, tenantId: result.invitation.tenantId, targetType: 'TENANT_INVITATION', targetId: invitationId, outcome: 'SUCCESS' }); throw new MembershipAccessError('FORBIDDEN'); }
      await this.audit.append({ category: 'BUSINESS', eventType: 'TENANT_INVITATION_ACCEPTED', actorAccountId: accountId, tenantId: result.membership.tenantId, targetType: 'TENANT_INVITATION', targetId: invitationId, outcome: 'SUCCESS' });
      return result.membership;
    } catch {
      await this.audit.append({ category: 'AUTHORIZATION', eventType: 'TENANT_INVITATION_ACCEPT_DENIED', actorAccountId: accountId, targetType: 'TENANT_INVITATION', targetId: invitationId, outcome: 'DENIED' });
      throw new MembershipAccessError('FORBIDDEN');
    }
  }
  public async reject(actorAccountId: string, invitationId: string): Promise<void> { await this.lifecycle(actorAccountId, invitationId, 'REJECTED'); }
  public async revoke(actorAccountId: string, invitationId: string): Promise<void> { await this.lifecycle(actorAccountId, invitationId, 'REVOKED'); }
  public async change(actorAccountId: string, tenantId: string, membershipId: string, status: MembershipStatus, role: TenantRole): Promise<TenantMembership> {
    try { return await this.repository.transaction(async (database) => {
      const actor = await this.context.requireInTransaction(database, actorAccountId, tenantId, 'membership.manage');
      const current = await this.repository.lockMembership(database, tenantId, membershipId);
      if (!current) throw new MembershipAccessError('FORBIDDEN');
      if (!isMembershipStatus(status) || !isTenantRole(role)) throw new MembershipAccessError('FORBIDDEN');
      if (role === 'CLINIC_OWNER' && actor.role !== 'CLINIC_OWNER') throw new MembershipAccessError('FORBIDDEN');
      if (current.role === 'CLINIC_OWNER' && current.status === 'ACTIVE' && (status !== 'ACTIVE' || role !== 'CLINIC_OWNER')) {
        if (actor.role !== 'CLINIC_OWNER') throw new MembershipAccessError('FORBIDDEN');
        const owners = await this.repository.lockActiveOwners(database, tenantId);
        if (owners.length <= 1) throw new MembershipAccessError('CONFLICT');
      }
      const target = await this.repository.updateMembership(database, tenantId, membershipId, status, role, actorAccountId);
      if (!target) throw new MembershipAccessError('FORBIDDEN');
      await this.audit.append({ category: 'BUSINESS', eventType: 'TENANT_MEMBERSHIP_CHANGED', actorAccountId, tenantId, targetType: 'TENANT_MEMBERSHIP', targetId: membershipId, outcome: 'SUCCESS' });
      return target;
    }); } catch {
      await this.audit.append({ category: 'AUTHORIZATION', eventType: 'TENANT_MEMBERSHIP_CHANGE_DENIED', actorAccountId, tenantId, targetType: 'TENANT_MEMBERSHIP', targetId: membershipId, outcome: 'DENIED' });
      throw new MembershipAccessError('FORBIDDEN');
    }
  }
  private async lifecycle(actorAccountId: string, invitationId: string, status: 'REJECTED' | 'REVOKED'): Promise<void> {
    let tenantId: string | undefined;
    try { const outcome = await this.repository.transaction(async (database) => {
      const invitation = await this.repository.lockInvitation(database, invitationId);
      if (!invitation || invitation.status !== 'INVITED') throw new MembershipAccessError('FORBIDDEN');
      tenantId = invitation.tenantId;
      await this.context.requireInTransaction(database, actorAccountId, invitation.tenantId, 'membership.invite');
      if (invitation.expiresAt <= new Date()) { await this.repository.setInvitationStatus(database, invitation.id, 'EXPIRED'); return 'EXPIRED' as const; }
      await this.repository.setInvitationStatus(database, invitation.id, status, actorAccountId);
      return status;
    });
    if (outcome === 'EXPIRED') { await this.audit.append({ category: 'BUSINESS', eventType: 'TENANT_INVITATION_EXPIRED', actorAccountId, tenantId, targetType: 'TENANT_INVITATION', targetId: invitationId, outcome: 'SUCCESS' }); throw new MembershipAccessError('FORBIDDEN'); }
    await this.audit.append({ category: 'BUSINESS', eventType: `TENANT_INVITATION_${outcome}`, actorAccountId, tenantId, targetType: 'TENANT_INVITATION', targetId: invitationId, outcome: 'SUCCESS' });
    } catch { await this.audit.append({ category: 'AUTHORIZATION', eventType: 'TENANT_INVITATION_LIFECYCLE_DENIED', actorAccountId, tenantId, targetType: 'TENANT_INVITATION', targetId: invitationId, outcome: 'DENIED' }); throw new MembershipAccessError('FORBIDDEN'); }
  }
}
export function secretHash(value: string): string { return createHash('sha256').update(value).digest('base64url'); }
function isTenantRole(value: string): value is TenantRole { return roles.includes(value as TenantRole); }
function isMembershipStatus(value: string): value is MembershipStatus { return membershipStatuses.includes(value as MembershipStatus); }
