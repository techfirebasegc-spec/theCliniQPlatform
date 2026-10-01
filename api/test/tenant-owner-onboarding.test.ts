import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { createSession } from '../src/modules/sessions/session.js';
import { registerErrorHandler } from '../src/middleware/errors.js';
import { registerTenantOwnerOnboardingRoutes } from '../src/routes/tenant-owner-onboarding.js';
import { hashSessionSecret, type SessionAuthenticatorRepository } from '../src/modules/sessions/session.js';
import { TenantOwnerOnboardingError, TenantOwnerOnboardingService, hashSecret, type OwnerInvitation, type TenantOwnerOnboardingRepository } from '../src/modules/tenant-onboarding/tenant-owner-onboarding.js';

function setup() {
  const invitations = new Map<string, OwnerInvitation & { secretHash: string }>();
  const memberships = new Set<string>();
  const repository: TenantOwnerOnboardingRepository = {
    transaction: async (operation) => operation({ query: async () => ({ rows: [] }) }),
    createPendingClinic: async (_db, _actor, value, invitation) => { invitations.set(invitation.id, invitation); return { id: 'clinic', tenantId: invitation.tenantId, legalName: value.legalName, displayName: value.displayName, status: 'DRAFT' }; },
    list: async () => [...invitations.values()],
    lockInvitation: async (_db, id) => invitations.get(id) ?? null,
    revoke: async (_db, id) => { invitations.get(id)!.status = 'REVOKED'; },
    replace: async (_db, old, _actor, secretHash, expiresAt) => { const next = { ...old, id: `${old.id}-next`, status: 'INVITED' as const, expiresAt, secretHash, createdAt: new Date(), acceptedAt: null, revokedAt: null }; invitations.set(next.id, next); return next; },
    accept: async (_db, invitation, identity) => { if (identity.subject === 'linked-elsewhere') throw new Error('IDENTITY_ALREADY_LINKED'); invitations.get(invitation.id)!.status = 'ACCEPTED'; memberships.add(invitation.targetAccountId); },
    hasActiveOwnerMembership: async (accountId) => memberships.has(accountId),
  };
  const service = new TenantOwnerOnboardingService(repository, { hasActiveEntitlement: async (accountId) => accountId === 'platform-admin' }, () => new Date('2026-10-01T00:00:00Z'));
  return { service, invitations, memberships };
}

describe('tenant owner onboarding', () => {
  it('keeps direct Platform Admin clinic onboarding available through its dedicated route', async () => {
    const { service, invitations } = setup(); const app = Fastify(); registerErrorHandler(app);
    const sessions: SessionAuthenticatorRepository = {
      findBySecretHash: async (hash) => hash === hashSessionSecret('platform') ? { id: 'session-platform', accountId: 'platform-admin', status: 'ACTIVE', idleExpiresAt: new Date('2031-01-01'), absoluteExpiresAt: new Date('2031-01-01') } : null,
      touch: async () => ({ updated: true }),
    };
    registerTenantOwnerOnboardingRoutes(app, { onboarding: service, tenantSessions: undefined as never, sessions, sessionPolicy: { idleTtlSeconds: 600, absoluteTtlSeconds: 3600 }, environment: { WEB_URL: 'http://localhost:3001', FIREBASE_PROJECT_ID: 'thecliniq-6868a' } });
    const response = await app.inject({ method: 'POST', url: '/v1/platform/clinics', headers: { cookie: 'cliniq_session=session-platform.platform' }, payload: { legalName: 'Legal', clinicName: 'Clinic', ownerEmail: 'owner@example.com' } });
    expect(response.statusCode).toBe(201);
    expect(invitations.size).toBe(1);
    await app.close();
  });

  it('creates a pending owner invitation with a hashed secret and no platform entitlement', async () => {
    const { service, invitations, memberships } = setup();
    const created = await service.create('platform-admin', { legalName: 'Legal', displayName: 'Clinic', ownerEmail: ' Owner@Example.com ' });
    const invitation = invitations.get(created.invitation.id)!;
    expect(invitation.invitedEmailNormalized).toBe('owner@example.com');
    expect(invitation.secretHash).toBe(hashSecret(created.secret));
    expect(invitation.secretHash).not.toBe(created.secret);
    expect(memberships).toEqual(new Set());
  });

  it('requires the verified Firebase Password email, rejects replay, and never grants platform access', async () => {
    const { service, memberships } = setup(); const created = await service.create('platform-admin', { legalName: 'Legal', displayName: 'Clinic', ownerEmail: 'owner@example.com' });
    const session = createSession('unused', { idleTtlSeconds: 60, absoluteTtlSeconds: 120 });
    await expect(service.accept(created.invitation.id, created.secret, { provider: 'firebase_password', subject: 'uid', verifiedAt: new Date(), email: 'other@example.com', emailVerified: true }, session)).rejects.toBeInstanceOf(TenantOwnerOnboardingError);
    await expect(service.accept(created.invitation.id, created.secret, { provider: 'firebase_password', subject: 'uid', verifiedAt: new Date(), email: 'owner@example.com', emailVerified: true }, session)).resolves.toBeUndefined();
    expect(memberships.has(created.invitation.targetAccountId)).toBe(true);
    await expect(service.accept(created.invitation.id, created.secret, { provider: 'firebase_password', subject: 'uid', verifiedAt: new Date(), email: 'owner@example.com', emailVerified: true }, session)).rejects.toBeInstanceOf(TenantOwnerOnboardingError);
  });

  it('accepts a verified Google identity only when its email matches the invitation', async () => {
    const { service, memberships } = setup(); const created = await service.create('platform-admin', { legalName: 'Legal', displayName: 'Clinic', ownerEmail: 'owner@example.com' });
    const session = createSession('unused', { idleTtlSeconds: 60, absoluteTtlSeconds: 120 });
    await expect(service.accept(created.invitation.id, created.secret, { provider: 'firebase_google', subject: 'google-uid', verifiedAt: new Date(), email: 'other@example.com', emailVerified: true }, session)).rejects.toBeInstanceOf(TenantOwnerOnboardingError);
    await expect(service.accept(created.invitation.id, created.secret, { provider: 'firebase_google', subject: 'google-uid', verifiedAt: new Date(), email: 'owner@example.com', emailVerified: false }, session)).rejects.toBeInstanceOf(TenantOwnerOnboardingError);
    await expect(service.accept(created.invitation.id, created.secret, { provider: 'firebase_google', subject: 'google-uid', verifiedAt: new Date(), email: 'owner@example.com', emailVerified: true }, session)).resolves.toBeUndefined();
    expect(memberships.has(created.invitation.targetAccountId)).toBe(true);
  });

  it('rejects unverified identities, UID collisions, expiry, revocation, and invalidates an old secret on resend', async () => {
    const { service, invitations } = setup(); const created = await service.create('platform-admin', { legalName: 'Legal', displayName: 'Clinic', ownerEmail: 'owner@example.com' });
    const session = createSession('unused', { idleTtlSeconds: 60, absoluteTtlSeconds: 120 });
    await expect(service.accept(created.invitation.id, created.secret, { provider: 'firebase_password', subject: 'uid', verifiedAt: new Date(), email: 'owner@example.com', emailVerified: false }, session)).rejects.toBeInstanceOf(TenantOwnerOnboardingError);
    await expect(service.accept(created.invitation.id, created.secret, { provider: 'firebase_password', subject: 'linked-elsewhere', verifiedAt: new Date(), email: 'owner@example.com', emailVerified: true }, session)).rejects.toBeInstanceOf(TenantOwnerOnboardingError);
    invitations.get(created.invitation.id)!.expiresAt = new Date('2026-09-30T00:00:00Z');
    await expect(service.accept(created.invitation.id, created.secret, { provider: 'firebase_password', subject: 'uid', verifiedAt: new Date(), email: 'owner@example.com', emailVerified: true }, session)).rejects.toBeInstanceOf(TenantOwnerOnboardingError);
    invitations.get(created.invitation.id)!.expiresAt = new Date('2026-10-10T00:00:00Z');
    const resent = await service.resend('platform-admin', created.invitation.id);
    expect(invitations.get(created.invitation.id)?.status).toBe('REVOKED');
    await expect(service.accept(created.invitation.id, created.secret, { provider: 'firebase_password', subject: 'uid', verifiedAt: new Date(), email: 'owner@example.com', emailVerified: true }, session)).rejects.toBeInstanceOf(TenantOwnerOnboardingError);
    expect(resent.secret).not.toBe(created.secret);
  });
});
