import { createIdentifier } from '../../shared/identifiers/uuid.js';
import type { VerifiedFirebaseIdentity } from '../identity/identity.js';
import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';
import type { NewSession } from '../sessions/session.js';
import type { CreatedOwnerClinic, NewOwnerClinic, OwnerInvitation, TenantOwnerOnboardingRepository } from './tenant-owner-onboarding.js';

type Database = { transaction<T>(operation: (database: PostgresExecutor) => Promise<T>): Promise<T>; query: PostgresExecutor['query'] };

export class PostgresTenantOwnerOnboardingRepository implements TenantOwnerOnboardingRepository {
  public constructor(private readonly database: Database) {}
  public transaction<T>(operation: (database: PostgresExecutor) => Promise<T>) { return this.database.transaction(operation); }

  public async createPendingClinic(database: PostgresExecutor, actor: string, value: NewOwnerClinic, invitation: OwnerInvitation & { secretHash: string }): Promise<CreatedOwnerClinic['clinic']> {
    await database.query('INSERT INTO accounts (id, status, created_by_account_id, updated_by_account_id) VALUES ($1, $2, $3, $3)', [invitation.targetAccountId, 'PENDING_VERIFICATION', actor]);
    await database.query('INSERT INTO tenants (id, status, created_by_account_id, updated_by_account_id) VALUES ($1, $2, $3, $3)', [invitation.tenantId, 'PENDING', actor]);
    await database.query("INSERT INTO tenant_memberships (id, tenant_id, account_id, role_key, status, invited_by_account_id, invited_at) VALUES ($1, $2, $3, 'CLINIC_OWNER', 'INVITED', $4, current_timestamp)", [createIdentifier(), invitation.tenantId, invitation.targetAccountId, actor]);
    const clinicId = createIdentifier();
    await database.query("INSERT INTO clinics (id, tenant_id, status, legal_name, display_name, created_by_account_id, updated_by_account_id) VALUES ($1, $2, 'DRAFT', $3, $4, $5, $5)", [clinicId, invitation.tenantId, value.legalName.trim(), value.displayName.trim(), actor]);
    await database.query("INSERT INTO tenant_invitations (id, tenant_id, target_account_id, role_key, secret_hash, status, expires_at, created_by_account_id, invited_email_normalized) VALUES ($1,$2,$3,$4,$5,'INVITED',$6,$7,$8)", [invitation.id, invitation.tenantId, invitation.targetAccountId, invitation.role, invitation.secretHash, invitation.expiresAt, actor, invitation.invitedEmailNormalized]);
    return { id: clinicId, tenantId: invitation.tenantId, legalName: value.legalName.trim(), displayName: value.displayName.trim(), status: 'DRAFT' };
  }

  public async list(): Promise<OwnerInvitation[]> {
    const result = await this.database.query('SELECT id, tenant_id, target_account_id, role_key, invited_email_normalized, status, created_at, expires_at, accepted_at, revoked_at FROM tenant_invitations WHERE invited_email_normalized IS NOT NULL ORDER BY created_at DESC', []);
    return result.rows.map(invitation);
  }

  public async lockInvitation(database: PostgresExecutor, id: string) {
    const result = await database.query('SELECT id, tenant_id, target_account_id, role_key, invited_email_normalized, secret_hash, status, created_at, expires_at, accepted_at, revoked_at FROM tenant_invitations WHERE id = $1 FOR UPDATE', [id]);
    const row = result.rows[0];
    return row ? { ...invitation(row), secretHash: String(row.secret_hash) } : null;
  }

  public async revoke(database: PostgresExecutor, id: string, actor: string) {
    const result = await database.query("UPDATE tenant_invitations SET status='REVOKED', revoked_at=current_timestamp, revoked_by_account_id=$2, updated_at=current_timestamp WHERE id=$1 AND status='INVITED'", [id, actor]);
    if (result.rowCount !== 1) throw new Error('INVITATION_REVOKE_FAILED');
  }

  public async replace(database: PostgresExecutor, old: OwnerInvitation, actor: string, secretHash: string, expiresAt: Date): Promise<OwnerInvitation> {
    const value: OwnerInvitation = { id: createIdentifier(), tenantId: old.tenantId, targetAccountId: old.targetAccountId, role: old.role, invitedEmailNormalized: old.invitedEmailNormalized, status: 'INVITED', createdAt: new Date(), expiresAt, acceptedAt: null, revokedAt: null };
    await database.query("INSERT INTO tenant_invitations (id, tenant_id, target_account_id, role_key, secret_hash, status, expires_at, created_by_account_id, invited_email_normalized) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [value.id, value.tenantId, value.targetAccountId, value.role, secretHash, value.status, value.expiresAt, actor, value.invitedEmailNormalized]);
    return value;
  }

  public async accept(database: PostgresExecutor, value: OwnerInvitation, identity: VerifiedFirebaseIdentity, session: NewSession): Promise<void> {
    const existing = await database.query<{ account_id: string }>('SELECT account_id FROM authentication_identities WHERE provider=$1 AND provider_subject=$2 AND status=\'LINKED\' FOR UPDATE', [identity.provider, identity.subject]);
    if (existing.rows[0] && existing.rows[0].account_id !== value.targetAccountId) throw new Error('IDENTITY_ALREADY_LINKED');
    if (!existing.rows[0]) await database.query("INSERT INTO authentication_identities (id, account_id, provider, provider_subject, status, verified_at, linked_at, created_by_account_id, updated_by_account_id) VALUES ($1,$2,$3,$4,'LINKED',$5,$5,$2,$2)", [createIdentifier(), value.targetAccountId, identity.provider, identity.subject, identity.verifiedAt]);
    if ((await database.query("UPDATE accounts SET status='ACTIVE', updated_at=current_timestamp, updated_by_account_id=$2 WHERE id=$1 AND status='PENDING_VERIFICATION'", [value.targetAccountId, value.targetAccountId])).rowCount !== 1) throw new Error('ACCOUNT_ACTIVATION_FAILED');
    if ((await database.query("UPDATE tenant_memberships SET status='ACTIVE', accepted_at=current_timestamp, updated_at=current_timestamp WHERE tenant_id=$1 AND account_id=$2 AND role_key='CLINIC_OWNER' AND status='INVITED'", [value.tenantId, value.targetAccountId])).rowCount !== 1) throw new Error('MEMBERSHIP_ACTIVATION_FAILED');
    if ((await database.query("UPDATE tenants SET status='ACTIVE', updated_at=current_timestamp, updated_by_account_id=$2 WHERE id=$1 AND status='PENDING'", [value.tenantId, value.targetAccountId])).rowCount !== 1) throw new Error('TENANT_ACTIVATION_FAILED');
    if ((await database.query("UPDATE tenant_invitations SET status='ACCEPTED', accepted_at=current_timestamp, accepted_by_account_id=$2, updated_at=current_timestamp WHERE id=$1 AND status='INVITED'", [value.id, value.targetAccountId])).rowCount !== 1) throw new Error('INVITATION_ACCEPT_FAILED');
    await database.query("INSERT INTO sessions (id, account_id, secret_hash, status, created_at, last_seen_at, idle_expires_at, absolute_expires_at, created_by_account_id) VALUES ($1,$2,$3,'ACTIVE',$4,$4,$5,$6,$2)", [session.id, value.targetAccountId, session.secretHash, session.createdAt, session.idleExpiresAt, session.absoluteExpiresAt]);
  }

  public async hasActiveOwnerMembership(accountId: string): Promise<boolean> {
    return (await this.database.query("SELECT 1 FROM tenant_memberships JOIN tenants ON tenants.id=tenant_memberships.tenant_id WHERE tenant_memberships.account_id=$1 AND tenant_memberships.role_key='CLINIC_OWNER' AND tenant_memberships.status='ACTIVE' AND tenants.status='ACTIVE' LIMIT 1", [accountId])).rows.length === 1;
  }
}

function invitation(row: Record<string, unknown>): OwnerInvitation {
  return { id: String(row.id), tenantId: String(row.tenant_id), targetAccountId: String(row.target_account_id), role: row.role_key as OwnerInvitation['role'], invitedEmailNormalized: row.invited_email_normalized === null ? null : String(row.invited_email_normalized), status: row.status as OwnerInvitation['status'], createdAt: new Date(String(row.created_at)), expiresAt: new Date(String(row.expires_at)), acceptedAt: row.accepted_at ? new Date(String(row.accepted_at)) : null, revokedAt: row.revoked_at ? new Date(String(row.revoked_at)) : null };
}
