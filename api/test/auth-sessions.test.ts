import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerErrorHandler } from '../src/middleware/errors.js';
import { AccountIdentityService, FirebaseIdentityVerificationError, FirebaseProviderPolicyVerifier, sharedFirebaseIdentityProviders, type AccountIdentityRecord, type FirebaseIdentityVerifier } from '../src/modules/identity/identity.js';
import { FirebaseSessionBridge, type SessionBridgeRepository } from '../src/modules/sessions/firebase-session-bridge.js';
import { createSession, sessionCookieName, type NewSession, type StoredSession } from '../src/modules/sessions/session.js';
import { registerAuthSessionRoutes } from '../src/routes/auth-sessions.js';

const policy = { idleTtlSeconds: 60, absoluteTtlSeconds: 120 };

function appWith(options: { identities?: Pick<AccountIdentityService, 'resolve'>; resolve?: (token: string) => Promise<AccountIdentityRecord>; verify?: FirebaseIdentityVerifier['verify']; stored?: StoredSession | null } = {}) {
  const created: { accountId: string; secretHash: string }[] = [];
  const revoked: { sessionId: string; accountId: string; reason: string }[] = [];
  const sessions: SessionBridgeRepository = {
    create: async (accountId: string, session: NewSession) => { created.push({ accountId, secretHash: session.secretHash }); },
    revoke: async (sessionId: string, accountId: string, reason: string) => { revoked.push({ sessionId, accountId, reason }); },
    findBySecretHash: async () => options.stored ?? null,
    touch: async () => ({ updated: true }),
  };
  const verifier: FirebaseIdentityVerifier = { verify: options.verify ?? (async () => ({ provider: 'firebase_google', subject: 'firebase-user', verifiedAt: new Date() })) };
  const identities = options.identities ?? { resolve: options.resolve ?? (async (token: string) => { await verifier.verify(token); return { accountId: 'account-1', identityId: 'identity-1', accountStatus: 'ACTIVE' }; }) };
  const bridge = new FirebaseSessionBridge(
    identities,
    verifier,
    sessions,
    policy,
  );
  const app = Fastify();
  registerErrorHandler(app);
  registerAuthSessionRoutes(app, { sessions: bridge });
  return { app, created, revoked };
}

describe('Firebase platform session bridge routes', () => {
  it('verifies a Firebase token server-side and establishes only the existing secure session cookie', async () => {
    const { app, created } = appWith();
    const response = await app.inject({ method: 'POST', url: '/v1/auth/firebase/session', payload: { idToken: 'firebase-token' } });
    expect(response.statusCode).toBe(204);
    expect(response.headers['set-cookie']).toContain(`${sessionCookieName}=`);
    expect(response.headers['set-cookie']).toContain('HttpOnly');
    expect(response.headers['set-cookie']).toContain('SameSite=lax');
    expect(response.headers['set-cookie']).toContain('Secure');
    expect(created).toHaveLength(1);
    expect(created[0]?.accountId).toBe('account-1');
    expect(created[0]?.secretHash).not.toContain('firebase-token');
    await app.close();
  });

  it('uses a cross-site secure cookie only for the explicit local Admin development origin', async () => {
    const { app } = appWith();
    const response = await app.inject({ method: 'POST', url: '/v1/auth/firebase/session', headers: { origin: 'http://localhost:3001' }, payload: { idToken: 'firebase-token' } });
    expect(response.statusCode).toBe(204);
    expect(response.headers['set-cookie']).toContain('SameSite=none');
    expect(response.headers['set-cookie']).toContain('Secure');
    await app.close();
  });

  it.each(['firebase_google', 'firebase_phone'] as const)('keeps the shared session route compatible with %s identities', async (provider) => {
    const verifier = new FirebaseProviderPolicyVerifier({ verify: async () => ({ provider, subject: 'firebase-user', verifiedAt: new Date() }) }, sharedFirebaseIdentityProviders);
    const { app, created } = appWith({ verify: verifier.verify.bind(verifier) });
    const response = await app.inject({ method: 'POST', url: '/v1/auth/firebase/session', payload: { idToken: 'firebase-token' } });
    expect(response.statusCode).toBe(204);
    expect(created).toHaveLength(1);
    await app.close();
  });

  it('rejects a password token before account resolution, identity creation, or session creation', async () => {
    const accountRepositoryCalls = { find: 0, create: 0, authenticated: 0 };
    const identities = new AccountIdentityService({
      findByProviderSubject: async () => { accountRepositoryCalls.find += 1; return null; },
      createAccountWithIdentity: async () => { accountRepositoryCalls.create += 1; return { accountId: 'new-account', identityId: 'new-identity', accountStatus: 'PENDING_VERIFICATION' }; },
      markAuthenticated: async () => { accountRepositoryCalls.authenticated += 1; },
    });
    const passwordVerifier = new FirebaseProviderPolicyVerifier({ verify: async () => ({ provider: 'firebase_password', subject: 'password-user', verifiedAt: new Date() }) }, sharedFirebaseIdentityProviders);
    const { app, created } = appWith({ identities, verify: passwordVerifier.verify.bind(passwordVerifier) });
    const response = await app.inject({ method: 'POST', url: '/v1/auth/firebase/session', payload: { idToken: 'password-token' } });
    expect(response.statusCode).toBe(401);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(accountRepositoryCalls).toEqual({ find: 0, create: 0, authenticated: 0 });
    expect(created).toEqual([]);
    await app.close();
  });

  it('rejects a missing or invalid Firebase token without creating a platform session', async () => {
    const { app, created } = appWith({ verify: async () => { throw new FirebaseIdentityVerificationError(); } });
    const missing = await app.inject({ method: 'POST', url: '/v1/auth/firebase/session', payload: {} });
    expect(missing.statusCode).toBe(401);
    const invalid = await app.inject({ method: 'POST', url: '/v1/auth/firebase/session', payload: { idToken: 'invalid' } });
    expect(invalid.statusCode).toBe(401);
    expect(created).toHaveLength(0);
    await app.close();
  });

  it('revokes the authenticated server-side session and clears its cookie on logout', async () => {
    const created = createSession('account-1', policy);
    const stored: StoredSession = { id: created.id, accountId: 'account-1', status: 'ACTIVE', idleExpiresAt: created.idleExpiresAt, absoluteExpiresAt: created.absoluteExpiresAt };
    const { app, revoked } = appWith({ stored });
    const response = await app.inject({ method: 'POST', url: '/v1/auth/session/logout', headers: { cookie: `${sessionCookieName}=${encodeURIComponent(`${created.id}.${created.rawSecret}`)}` } });
    expect(response.statusCode).toBe(204);
    expect(response.headers['set-cookie']).toContain('Max-Age=0');
    expect(revoked).toEqual([{ sessionId: created.id, accountId: 'account-1', reason: 'LOGOUT' }]);
    await app.close();
  });

  it('rejects logout when the platform session is absent or invalid', async () => {
    const { app, revoked } = appWith();
    const response = await app.inject({ method: 'POST', url: '/v1/auth/session/logout', headers: { cookie: `${sessionCookieName}=missing.secret` } });
    expect(response.statusCode).toBe(401);
    expect(revoked).toEqual([]);
    await app.close();
  });
});
