import type { FastifyInstance } from 'fastify';
import { ClinicApplicationError, type ClinicApplicationInput, type ClinicApplicationService } from '../modules/clinic-applications/clinic-applications.js';
import { authenticateSession, sessionCookieName, type SessionAuthenticatorRepository, type SessionPolicy } from '../modules/sessions/session.js';

export function registerClinicApplicationRoutes(app: FastifyInstance, dependencies: { applications: ClinicApplicationService; sessions: SessionAuthenticatorRepository; sessionPolicy: SessionPolicy }) {
  app.post('/v1/me/clinic-application', async (request, reply) => reply.code(201).send({ application: await dependencies.applications.submit(await account(request.headers.cookie, dependencies), input(request.body)) }));
  app.get('/v1/me/clinic-application', async (request) => ({ application: await dependencies.applications.mine(await account(request.headers.cookie, dependencies)) }));
  app.get('/v1/platform/clinic-applications', async (request) => ({ items: await dependencies.applications.pending(await account(request.headers.cookie, dependencies)) }));
  app.get('/v1/platform/clinic-applications/:applicationId', async (request) => ({ application: await dependencies.applications.inspect(await account(request.headers.cookie, dependencies), id(request, 'applicationId')) }));
  app.post('/v1/platform/clinic-applications/:applicationId/approve', async (request) => ({ application: await dependencies.applications.approve(await account(request.headers.cookie, dependencies), id(request, 'applicationId')) }));
  app.post('/v1/platform/clinic-applications/:applicationId/reject', async (request) => ({ application: await dependencies.applications.reject(await account(request.headers.cookie, dependencies), id(request, 'applicationId'), reason(request.body)) }));
}
async function account(header: string | undefined, dependencies: { sessions: SessionAuthenticatorRepository; sessionPolicy: SessionPolicy }) { try { return (await authenticateSession(cookie(header, sessionCookieName), dependencies.sessionPolicy, dependencies.sessions)).accountId; } catch { throw new ClinicApplicationError('UNAUTHORIZED'); } }
function cookie(header: string | undefined, name: string): string | undefined { return header?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1); }
function id(request: { params: unknown }, key: string): string { const value = (request.params as Record<string, unknown>)[key]; if (typeof value !== 'string' || !value) throw new ClinicApplicationError('NOT_FOUND'); return value; }
function input(value: unknown): ClinicApplicationInput { if (typeof value !== 'object' || value === null) throw new ClinicApplicationError('CONFLICT'); const body = value as Record<string, unknown>; if (typeof body.legalName !== 'string' || typeof body.clinicName !== 'string' || typeof body.ownerEmail !== 'string') throw new ClinicApplicationError('CONFLICT'); return { legalName: body.legalName, clinicName: body.clinicName, ownerEmail: body.ownerEmail }; }
function reason(value: unknown): string { if (typeof value !== 'object' || value === null || typeof (value as { rejectionReason?: unknown }).rejectionReason !== 'string') throw new ClinicApplicationError('CONFLICT'); return (value as { rejectionReason: string }).rejectionReason; }
