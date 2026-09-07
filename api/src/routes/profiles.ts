import type { FastifyInstance } from 'fastify';
import { ProfileAccessError, type ProfileMutation, type ProfileService } from '../modules/profiles/profiles.js';
import { authenticateSession, sessionCookieName, type SessionAuthenticatorRepository, type SessionPolicy } from '../modules/sessions/session.js';

export interface ProfileRouteDependencies { profiles: ProfileService; sessions: SessionAuthenticatorRepository; sessionPolicy: SessionPolicy }

export async function registerProfileRoutes(app: FastifyInstance, dependencies: ProfileRouteDependencies): Promise<void> {
  app.post('/v1/me/patient-profile', async (request, reply) => reply.code(201).send(await dependencies.profiles.createPatient(await accountId(request.headers.cookie, dependencies), mutation(request.body))));
  app.post('/v1/me/doctor-profile', async (request, reply) => reply.code(201).send(await dependencies.profiles.createDoctor(await accountId(request.headers.cookie, dependencies), mutation(request.body))));
  app.get('/v1/me/patient-profile/:profileId', async (request) => dependencies.profiles.readPatient(await accountId(request.headers.cookie, dependencies), (request.params as { profileId: string }).profileId));
  app.get('/v1/me/doctor-profile/:profileId', async (request) => dependencies.profiles.readDoctor(await accountId(request.headers.cookie, dependencies), (request.params as { profileId: string }).profileId));
  app.patch('/v1/me/patient-profile/:profileId', async (request) => dependencies.profiles.updatePatient(await accountId(request.headers.cookie, dependencies), (request.params as { profileId: string }).profileId, mutation(request.body)));
  app.patch('/v1/me/doctor-profile/:profileId', async (request) => dependencies.profiles.updateDoctor(await accountId(request.headers.cookie, dependencies), (request.params as { profileId: string }).profileId, mutation(request.body)));
}

async function accountId(cookieHeader: string | undefined, dependencies: ProfileRouteDependencies): Promise<string> {
  try { return (await authenticateSession(cookie(cookieHeader, sessionCookieName), dependencies.sessionPolicy, dependencies.sessions)).accountId; } catch { throw new ProfileAccessError('UNAUTHORIZED'); }
}
function cookie(header: string | undefined, name: string): string | undefined { return header?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1); }
function mutation(value: unknown): ProfileMutation { if (typeof value !== 'object' || value === null) return {}; const displayName = (value as { displayName?: unknown }).displayName; if (displayName !== undefined && displayName !== null && typeof displayName !== 'string') throw new ProfileAccessError('FORBIDDEN'); return { displayName: displayName as string | null | undefined }; }
