import type { Environment } from '../config/environment.js';
import type { FastifyInstance } from 'fastify';
import { FirebaseAdminIdentityVerifier, FirebaseProviderPolicyVerifier, ownerFirebaseIdentityProviders } from '../modules/identity/identity.js';
import { authenticateSession, createSession, sessionCookieName, sessionCookieOptions, sessionCookieValue, type SessionAuthenticatorRepository, type SessionPolicy } from '../modules/sessions/session.js';
import { TenantFirebaseSessionBridge, TenantFirebaseSessionBridgeError } from '../modules/sessions/tenant-firebase-session-bridge.js';
import { TenantOwnerOnboardingError, type TenantOwnerOnboardingService } from '../modules/tenant-onboarding/tenant-owner-onboarding.js';
import { requiresCrossSiteSessionCookie } from '../config/browser-origins.js';

export function registerTenantOwnerOnboardingRoutes(app: FastifyInstance, dependencies: { onboarding: TenantOwnerOnboardingService; tenantSessions: TenantFirebaseSessionBridge; sessions: SessionAuthenticatorRepository; sessionPolicy: SessionPolicy; environment: Pick<Environment, 'WEB_URL' | 'FIREBASE_PROJECT_ID'> }): void {
  app.post('/v1/platform/clinics', async (request, reply) => {
    const result = await dependencies.onboarding.create(await account(request.headers.cookie, dependencies), clinicInput(request.body));
    return reply.code(201).send({ clinic: result.clinic, invitation: safe(result.invitation), invitationUrl: invitationUrl(dependencies.environment.WEB_URL, result.invitation.id, result.secret) });
  });
  app.get('/v1/platform/tenant-invitations', async (request) => ({ items: (await dependencies.onboarding.list(await account(request.headers.cookie, dependencies))).map(safe) }));
  app.post('/v1/platform/tenant-invitations/:invitationId/resend', async (request) => {
    const body = request.body as { ownerEmail?: unknown };
    if (body.ownerEmail !== undefined && typeof body.ownerEmail !== 'string') throw new TenantOwnerOnboardingError('CONFLICT');
    const result = await dependencies.onboarding.resend(await account(request.headers.cookie, dependencies), (request.params as { invitationId: string }).invitationId, body.ownerEmail);
    return { invitation: safe(result.invitation), invitationUrl: invitationUrl(dependencies.environment.WEB_URL, result.invitation.id, result.secret) };
  });
  app.post('/v1/platform/tenant-invitations/:invitationId/revoke', async (request, reply) => { await dependencies.onboarding.revoke(await account(request.headers.cookie, dependencies), (request.params as { invitationId: string }).invitationId); return reply.code(204).send(); });
  app.post('/v1/tenant-owner-invitations/:invitationId/accept', async (request, reply) => {
    const body = request.body as { idToken?: unknown; secret?: unknown };
    if (typeof body?.idToken !== 'string' || typeof body.secret !== 'string') throw new TenantOwnerOnboardingError('FORBIDDEN');
    let identity;
    try { identity = await new FirebaseProviderPolicyVerifier(new FirebaseAdminIdentityVerifier(dependencies.environment.FIREBASE_PROJECT_ID), ownerFirebaseIdentityProviders).verify(body.idToken); }
    catch { throw new TenantOwnerOnboardingError('FORBIDDEN'); }
    const session = createSession('pending-owner', dependencies.sessionPolicy);
    await dependencies.onboarding.accept((request.params as { invitationId: string }).invitationId, body.secret, identity, session);
    reply.header('set-cookie', cookie(sessionCookieValue(session), request.headers.origin));
    return reply.code(204).send();
  });
  app.post('/v1/auth/tenant/firebase/session', async (request, reply) => {
    const body = request.body as { idToken?: unknown };
    if (typeof body?.idToken !== 'string') throw new TenantFirebaseSessionBridgeError();
    reply.header('set-cookie', cookie(await dependencies.tenantSessions.exchange(body.idToken), request.headers.origin));
    return reply.code(204).send();
  });
}

async function account(header: string | undefined, dependencies: { sessions: SessionAuthenticatorRepository; sessionPolicy: SessionPolicy }) { try { const value = header?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${sessionCookieName}=`))?.slice(sessionCookieName.length + 1); return (await authenticateSession(value, dependencies.sessionPolicy, dependencies.sessions)).accountId; } catch { throw new TenantOwnerOnboardingError('UNAUTHORIZED'); } }
function clinicInput(value: unknown) { const body = value as { legalName?: unknown; clinicName?: unknown; ownerEmail?: unknown }; if (typeof body?.legalName !== 'string' || typeof body.clinicName !== 'string' || typeof body.ownerEmail !== 'string') throw new TenantOwnerOnboardingError('CONFLICT'); return { legalName: body.legalName, displayName: body.clinicName, ownerEmail: body.ownerEmail }; }
function safe(value: { id: string; tenantId: string; role: string; invitedEmailNormalized: string | null; status: string; createdAt: Date; expiresAt: Date; acceptedAt: Date | null; revokedAt: Date | null }) { return { id: value.id, tenantId: value.tenantId, role: value.role, email: value.invitedEmailNormalized, status: value.status, createdAt: value.createdAt, expiresAt: value.expiresAt, acceptedAt: value.acceptedAt, revokedAt: value.revokedAt }; }
function invitationUrl(webUrl: string, invitationId: string, secret: string) { return `${webUrl.replace(/\/$/, '')}/accept-invitation?invitationId=${encodeURIComponent(invitationId)}&secret=${encodeURIComponent(secret)}`; }
function cookie(value: string, origin: string | undefined) { const sameSite = requiresCrossSiteSessionCookie(origin) ? 'none' : sessionCookieOptions.sameSite; return `${sessionCookieName}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=${sameSite}; Secure`; }
