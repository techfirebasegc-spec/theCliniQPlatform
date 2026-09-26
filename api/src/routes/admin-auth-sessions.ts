import type { FastifyInstance } from 'fastify';
import { requiresCrossSiteSessionCookie } from '../config/browser-origins.js';
import { AdminFirebaseSessionBridge, AdminFirebaseSessionBridgeError } from '../modules/sessions/admin-firebase-session-bridge.js';
import { sessionCookieName, sessionCookieOptions } from '../modules/sessions/session.js';

export function registerAdminAuthSessionRoutes(app: FastifyInstance, dependencies: { sessions: AdminFirebaseSessionBridge }): void {
  app.post('/v1/auth/admin/firebase/session', async (request, reply) => {
    const body = request.body as { idToken?: unknown };
    if (!body || typeof body.idToken !== 'string' || !body.idToken.trim()) throw new AdminFirebaseSessionBridgeError('UNAUTHORIZED');
    const value = await dependencies.sessions.exchange(body.idToken);
    const sameSite = requiresCrossSiteSessionCookie(request.headers.origin) ? 'none' : sessionCookieOptions.sameSite;
    reply.header('set-cookie', `${sessionCookieName}=${encodeURIComponent(value)}; Path=${sessionCookieOptions.path}; HttpOnly; SameSite=${sameSite}; Secure`);
    return reply.code(204).send();
  });
}
