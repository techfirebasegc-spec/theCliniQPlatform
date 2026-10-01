import type { FastifyInstance } from 'fastify';
import { authenticateSession, sessionCookieName, sessionCookieOptions, type SessionAuthenticatorRepository, type SessionPolicy } from '../modules/sessions/session.js';
import { isLocalProviderDevelopmentOrigin, requiresCrossSiteSessionCookie } from '../config/browser-origins.js';
import { ProviderFirebaseSessionBridge, ProviderFirebaseSessionBridgeError } from '../modules/sessions/provider-firebase-session-bridge.js';
import { ProviderPasswordIdentityLinkError, type ProviderPasswordIdentityLinkService } from '../modules/sessions/provider-password-identity-link.js';

export function registerProviderAuthSessionRoutes(app: FastifyInstance, dependencies: { sessions: ProviderFirebaseSessionBridge; passwordIdentityLinks: ProviderPasswordIdentityLinkService; sessionRepository: SessionAuthenticatorRepository; sessionPolicy: SessionPolicy }) {
  app.post('/v1/auth/provider/firebase/session', async (request, reply) => {
    const body=request.body as {idToken?:unknown};
    if(typeof body?.idToken!=='string') throw new ProviderFirebaseSessionBridgeError();
    const value=await dependencies.sessions.exchange(body.idToken);
    const origin=request.headers.origin;
    const local=isLocalProviderDevelopmentOrigin(origin);
    const sameSite=local?sessionCookieOptions.sameSite:requiresCrossSiteSessionCookie(origin)?'none':sessionCookieOptions.sameSite;
    const secure=local?'':' Secure';
    reply.header('set-cookie',`${sessionCookieName}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=${sameSite};${secure}`);
    return reply.code(204).send();
  });
  app.post('/v1/auth/provider/firebase/password-identity', async (request, reply) => {
    const body=request.body as {idToken?:unknown};
    if(typeof body?.idToken!=='string') throw new ProviderPasswordIdentityLinkError('UNAUTHORIZED');
    const accountId=await account(request.headers.cookie, dependencies);
    return reply.code(200).send(await dependencies.passwordIdentityLinks.link(accountId, body.idToken));
  });
}

async function account(header: string | undefined, dependencies: { sessionRepository: SessionAuthenticatorRepository; sessionPolicy: SessionPolicy }): Promise<string> {
  try {
    const value=header?.split(';').map((part)=>part.trim()).find((part)=>part.startsWith(`${sessionCookieName}=`))?.slice(sessionCookieName.length+1);
    return (await authenticateSession(value,dependencies.sessionPolicy,dependencies.sessionRepository)).accountId;
  } catch {
    throw new ProviderPasswordIdentityLinkError('UNAUTHORIZED');
  }
}
