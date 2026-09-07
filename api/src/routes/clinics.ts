import type { FastifyInstance } from 'fastify';
import { TenantAccessError, type ClinicInput, type TenantClinicService } from '../modules/tenants/tenants.js';
import { authenticateSession, sessionCookieName, type SessionAuthenticatorRepository, type SessionPolicy } from '../modules/sessions/session.js';
export async function registerClinicRoutes(app: FastifyInstance, dependencies: { clinics: TenantClinicService; sessions: SessionAuthenticatorRepository; sessionPolicy: SessionPolicy }): Promise<void> {
  app.post('/v1/me/clinic', async (request, reply) => reply.code(201).send(await dependencies.clinics.create(await account(request.headers.cookie, dependencies), input(request.body))));
  app.get('/v1/me/clinic/:clinicId', async (request) => dependencies.clinics.read(await account(request.headers.cookie, dependencies), (request.params as { clinicId: string }).clinicId));
  app.patch('/v1/me/clinic/:clinicId', async (request) => dependencies.clinics.update(await account(request.headers.cookie, dependencies), (request.params as { clinicId: string }).clinicId, input(request.body)));
}
async function account(header: string | undefined, dependencies: { sessions: SessionAuthenticatorRepository; sessionPolicy: SessionPolicy }) { try { const value = header?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${sessionCookieName}=`))?.slice(sessionCookieName.length + 1); return (await authenticateSession(value, dependencies.sessionPolicy, dependencies.sessions)).accountId; } catch { throw new TenantAccessError('UNAUTHORIZED'); } }
function input(value: unknown): ClinicInput { const body = value as { legalName?: unknown; displayName?: unknown }; if (typeof body?.legalName !== 'string' || typeof body?.displayName !== 'string') throw new TenantAccessError('FORBIDDEN'); return { legalName: body.legalName, displayName: body.displayName }; }
