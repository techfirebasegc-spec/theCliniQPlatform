import { createHash, randomBytes } from 'node:crypto';
import { createIdentifier } from '../../shared/identifiers/uuid.js';
import type { TenantRole } from '../authorization/authorization.js';
import type { VerifiedFirebaseIdentity } from '../identity/identity.js';
import { ownerFirebaseIdentityProviders } from '../identity/identity.js';
import type { NewSession } from '../sessions/session.js';
import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';

export type OwnerInvitationStatus = 'INVITED' | 'ACCEPTED' | 'REJECTED' | 'REVOKED' | 'EXPIRED';
export type OwnerInvitation = { id: string; tenantId: string; targetAccountId: string; role: TenantRole; invitedEmailNormalized: string | null; status: OwnerInvitationStatus; createdAt: Date; expiresAt: Date; acceptedAt: Date | null; revokedAt: Date | null };
export type NewOwnerClinic = { legalName: string; displayName: string; ownerEmail: string };
export type CreatedOwnerClinic = { clinic: { id: string; tenantId: string; legalName: string; displayName: string; status: 'DRAFT' }; invitation: OwnerInvitation; secret: string };

export class TenantOwnerOnboardingError extends Error {
  public constructor(public readonly code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'CONFLICT') { super(code === 'UNAUTHORIZED' ? 'Authentication is required.' : code === 'CONFLICT' ? 'The onboarding operation cannot be completed.' : 'Tenant onboarding is not permitted.'); }
}

export interface TenantOwnerOnboardingRepository {
  transaction<T>(operation: (database: PostgresExecutor) => Promise<T>): Promise<T>;
  createPendingClinic(database: PostgresExecutor, actorAccountId: string, value: NewOwnerClinic, invitation: OwnerInvitation & { secretHash: string }): Promise<CreatedOwnerClinic['clinic']>;
  list(): Promise<OwnerInvitation[]>;
  lockInvitation(database: PostgresExecutor, id: string): Promise<(OwnerInvitation & { secretHash: string }) | null>;
  revoke(database: PostgresExecutor, id: string, actorAccountId: string): Promise<void>;
  replace(database: PostgresExecutor, old: OwnerInvitation, actorAccountId: string, secretHash: string, expiresAt: Date): Promise<OwnerInvitation>;
  accept(database: PostgresExecutor, invitation: OwnerInvitation, identity: VerifiedFirebaseIdentity, session: NewSession): Promise<void>;
  hasActiveOwnerMembership(accountId: string): Promise<boolean>;
}

export interface PlatformAdminAuthorizer { hasActiveEntitlement(accountId: string): Promise<boolean>; }

export class TenantOwnerOnboardingService {
  public constructor(private readonly repository: TenantOwnerOnboardingRepository, private readonly platformAdmins: PlatformAdminAuthorizer, private readonly now: () => Date = () => new Date()) {}

  public async create(actorAccountId: string, input: NewOwnerClinic): Promise<CreatedOwnerClinic> {
    this.assertClinicInput(input);
    if (!await this.platformAdmins.hasActiveEntitlement(actorAccountId)) throw new TenantOwnerOnboardingError('FORBIDDEN');
    return this.repository.transaction((database) => this.createForPlatformAdminInTransaction(database, actorAccountId, input));
  }

  /** The caller must already have verified the persisted Platform Admin entitlement. */
  public async createForPlatformAdminInTransaction(database: PostgresExecutor, actorAccountId: string, input: NewOwnerClinic): Promise<CreatedOwnerClinic> {
    this.assertClinicInput(input);
    const secret = randomBytes(32).toString('base64url');
    const invitation: OwnerInvitation & { secretHash: string } = {
      id: createIdentifier(), tenantId: createIdentifier(), targetAccountId: createIdentifier(), role: 'CLINIC_OWNER', invitedEmailNormalized: normalizeEmail(input.ownerEmail), status: 'INVITED', createdAt: this.now(), expiresAt: new Date(this.now().getTime() + 7 * 24 * 60 * 60 * 1000), acceptedAt: null, revokedAt: null, secretHash: hashSecret(secret),
    };
    const clinic = await this.repository.createPendingClinic(database, actorAccountId, input, invitation);
    return { clinic, invitation, secret };
  }

  public async list(actorAccountId: string): Promise<OwnerInvitation[]> {
    if (!await this.platformAdmins.hasActiveEntitlement(actorAccountId)) throw new TenantOwnerOnboardingError('FORBIDDEN');
    return this.repository.list();
  }

  public async resend(actorAccountId: string, invitationId: string, ownerEmail?: string): Promise<{ invitation: OwnerInvitation; secret: string }> {
    if (ownerEmail !== undefined && !validEmail(ownerEmail)) throw new TenantOwnerOnboardingError('CONFLICT');
    if (!await this.platformAdmins.hasActiveEntitlement(actorAccountId)) throw new TenantOwnerOnboardingError('FORBIDDEN');
    const secret = randomBytes(32).toString('base64url');
    const invitation = await this.repository.transaction(async (database) => {
      const old = await this.repository.lockInvitation(database, invitationId);
      if (!old || old.status !== 'INVITED' || !old.invitedEmailNormalized || old.expiresAt <= this.now()) throw new TenantOwnerOnboardingError('CONFLICT');
      await this.repository.revoke(database, old.id, actorAccountId);
      return this.repository.replace(database, { ...old, invitedEmailNormalized: ownerEmail === undefined ? old.invitedEmailNormalized : normalizeEmail(ownerEmail) }, actorAccountId, hashSecret(secret), new Date(this.now().getTime() + 7 * 24 * 60 * 60 * 1000));
    });
    return { invitation, secret };
  }

  public async revoke(actorAccountId: string, invitationId: string): Promise<void> {
    if (!await this.platformAdmins.hasActiveEntitlement(actorAccountId)) throw new TenantOwnerOnboardingError('FORBIDDEN');
    await this.repository.transaction(async (database) => {
      const invitation = await this.repository.lockInvitation(database, invitationId);
      if (!invitation || invitation.status !== 'INVITED') throw new TenantOwnerOnboardingError('CONFLICT');
      await this.repository.revoke(database, invitationId, actorAccountId);
    });
  }

  public async accept(invitationId: string, secret: string, identity: VerifiedFirebaseIdentity, session: NewSession): Promise<void> {
    if (!ownerFirebaseIdentityProviders.includes(identity.provider) || !identity.email || identity.emailVerified !== true) throw new TenantOwnerOnboardingError('FORBIDDEN');
    try {
      await this.repository.transaction(async (database) => {
        const invitation = await this.repository.lockInvitation(database, invitationId);
        if (!invitation || invitation.status !== 'INVITED' || !invitation.invitedEmailNormalized || invitation.expiresAt <= this.now() || !safeEqual(invitation.secretHash, hashSecret(secret)) || normalizeEmail(identity.email!) !== invitation.invitedEmailNormalized) throw new TenantOwnerOnboardingError('FORBIDDEN');
        await this.repository.accept(database, invitation, identity, session);
      });
    } catch (error) {
      if (error instanceof TenantOwnerOnboardingError) throw error;
      if (error instanceof Error && error.message === 'IDENTITY_ALREADY_LINKED') throw new TenantOwnerOnboardingError('CONFLICT');
      throw error;
    }
  }

  private assertClinicInput(input: NewOwnerClinic) {
    if (!input.legalName.trim() || !input.displayName.trim() || !validEmail(input.ownerEmail)) throw new TenantOwnerOnboardingError('CONFLICT');
  }
}

export function normalizeEmail(value: string): string { return value.trim().toLowerCase(); }
export function hashSecret(value: string): string { return createHash('sha256').update(value).digest('base64url'); }
function validEmail(value: string): boolean { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value)); }
function safeEqual(left: string, right: string): boolean { return left.length === right.length && createHash('sha256').update(left).digest('hex') === createHash('sha256').update(right).digest('hex'); }
