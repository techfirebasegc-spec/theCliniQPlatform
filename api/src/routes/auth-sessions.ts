import type { FastifyInstance } from 'fastify';
import { FirebaseSessionBridge, FirebaseSessionBridgeError } from '../modules/sessions/firebase-session-bridge.js';
import { sessionCookieName, sessionCookieOptions } from '../modules/sessions/session.js';

export function registerAuthSessionRoutes(app: FastifyInstance, dependencies: { sessions: FirebaseSessionBridge }): void {
  app.post('/v1/auth/firebase/session', async (request, reply) => {
    const body = request.body as { idToken?: unknown };
    if (!body || typeof body.idToken !== 'string' || !body.idToken.trim()) throw new FirebaseSessionBridgeError('UNAUTHORIZED');
    const value = await dependencies.sessions.exchange(body.idToken);
    reply.header('set-cookie', cookie(value));
    return reply.code(204).send();
  });

  app.post('/v1/auth/session/logout', async (request, reply) => {
    await dependencies.sessions.logout(readCookie(request.headers.cookie));
    reply.header('set-cookie', clearCookie());
    return reply.code(204).send();
  });
}

function readCookie(header: string | undefined): string | undefined {
  return header?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${sessionCookieName}=`))?.slice(sessionCookieName.length + 1);
}

function cookie(value: string): string {
  return `${sessionCookieName}=${encodeURIComponent(value)}; Path=${sessionCookieOptions.path}; HttpOnly; SameSite=${sessionCookieOptions.sameSite}; Secure`;
}

function clearCookie(): string {
  return `${sessionCookieName}=; Path=${sessionCookieOptions.path}; HttpOnly; SameSite=${sessionCookieOptions.sameSite}; Secure; Max-Age=0`;
}
