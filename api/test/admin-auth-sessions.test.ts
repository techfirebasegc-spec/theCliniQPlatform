import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerErrorHandler } from '../src/middleware/errors.js';
import { type AccountIdentityRecord, FirebaseIdentityVerificationError, type FirebaseIdentityVerifier, type VerifiedFirebaseIdentity } from '../src/modules/identity/identity.js';
import { PlatformAdminEntitlementService } from '../src/modules/admin-access/admin-entitlements.js';
import { AdminFirebaseSessionBridge, type AdminSessionBridgeRepository } from '../src/modules/sessions/admin-firebase-session-bridge.js';
import { type NewSession, sessionCookieName } from '../src/modules/sessions/session.js';
import { registerAdminAuthSessionRoutes } from '../src/routes/admin-auth-sessions.js';

const policy = { idleTtlSeconds: 60, absoluteTtlSeconds: 120 };
const passwordIdentity: VerifiedFirebaseIdentity = { provider: 'firebase_password', subject: 'firebase-subject', verifiedAt: new Date('2026-09-29T00:00:00Z') };
const activeAccount: AccountIdentityRecord = { accountId: 'account-1', identityId: 'identity-1', accountStatus: 'ACTIVE' };

function appWith(options: { identity?: VerifiedFirebaseIdentity; verify?: FirebaseIdentityVerifier['verify']; account?: AccountIdentityRecord | null; entitled?: boolean } = {}) {
  const created: { accountId: string; secretHash: string }[] = [];
  const sessions: AdminSessionBridgeRepository = { create: async (accountId: string, session: NewSession) => { created.push({ accountId, secretHash: session.secretHash }); } };
  const verifier: FirebaseIdentityVerifier = { verify: options.verify ?? (async () => options.identity ?? passwordIdentity) };
  const identities = { findByProviderSubject: async () => options.account === undefined ? activeAccount : options.account };
  const entitlements = new PlatformAdminEntitlementService({ hasActiveForAccount: async () => options.entitled ?? true });
  const app = Fastify();
  registerErrorHandler(app);
  registerAdminAuthSessionRoutes(app, { sessions: new AdminFirebaseSessionBridge(identities, verifier, entitlements, sessions, policy) });
  return { app, created };
}

describe('Admin Firebase session route', () => {
  it('creates a secure Platform session only for an active entitled password identity', async () => {
    const { app, created } = appWith();
    const response = await app.inject({ method: 'POST', url: '/v1/auth/admin/firebase/session', headers: { origin: 'http://localhost:3001' }, payload: { idToken: 'firebase-token' } });
    expect(response.statusCode).toBe(204);
    expect(response.headers['set-cookie']).toContain(`${sessionCookieName}=`);
    expect(response.headers['set-cookie']).toContain('HttpOnly');
    expect(response.headers['set-cookie']).toContain('Secure');
    expect(response.headers['set-cookie']).toContain('SameSite=none');
    expect(created).toEqual([expect.objectContaining({ accountId: 'account-1' })]);
    expect(created[0]?.secretHash).not.toContain('firebase-token');
    await app.close();
  });

  it('does not provision an identity or session for an unknown Firebase password identity', async () => {
    const { app, created } = appWith({ account: null });
    const response = await app.inject({ method: 'POST', url: '/v1/auth/admin/firebase/session', payload: { idToken: 'firebase-token' } });
    expect(response.statusCode).toBe(401);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(created).toEqual([]);
    await app.close();
  });

  it.each(['PENDING_VERIFICATION', 'SUSPENDED', 'DEACTIVATED', 'DELETED_REQUESTED', 'DELETED'] as const)('denies a %s account without a session', async (accountStatus) => {
    const { app, created } = appWith({ account: { ...activeAccount, accountStatus } });
    const response = await app.inject({ method: 'POST', url: '/v1/auth/admin/firebase/session', payload: { idToken: 'firebase-token' } });
    expect(response.statusCode).toBe(401);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(created).toEqual([]);
    await app.close();
  });

  it('denies missing or revoked admin entitlement without a session', async () => {
    for (const entitled of [false, false]) {
      const { app, created } = appWith({ entitled });
      const response = await app.inject({ method: 'POST', url: '/v1/auth/admin/firebase/session', payload: { idToken: 'firebase-token' } });
      expect(response.statusCode).toBe(401);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(created).toEqual([]);
      await app.close();
    }
  });

  it.each(['firebase_google', 'firebase_phone'] as const)('denies %s identities at the Email/Password-only Admin endpoint', async (provider) => {
    const { app, created } = appWith({ identity: { ...passwordIdentity, provider } });
    const response = await app.inject({ method: 'POST', url: '/v1/auth/admin/firebase/session', payload: { idToken: 'firebase-token' } });
    expect(response.statusCode).toBe(401);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(created).toEqual([]);
    await app.close();
  });

  it('rejects a missing, invalid, or revoked Firebase token without a cookie', async () => {
    const { app, created } = appWith({ verify: async () => { throw new FirebaseIdentityVerificationError(); } });
    const missing = await app.inject({ method: 'POST', url: '/v1/auth/admin/firebase/session', payload: {} });
    const invalid = await app.inject({ method: 'POST', url: '/v1/auth/admin/firebase/session', payload: { idToken: 'invalid' } });
    expect(missing.statusCode).toBe(401);
    expect(invalid.statusCode).toBe(401);
    expect(missing.headers['set-cookie']).toBeUndefined();
    expect(invalid.headers['set-cookie']).toBeUndefined();
    expect(created).toEqual([]);
    await app.close();
  });
});
