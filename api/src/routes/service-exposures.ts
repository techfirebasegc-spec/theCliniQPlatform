import type { FastifyInstance } from 'fastify';
import { ServiceExposureError, type ServiceExposureService } from '../modules/service-exposures/service-exposures.js';
import { authenticateSession, sessionCookieName, type SessionAuthenticatorRepository, type SessionPolicy } from '../modules/sessions/session.js';

export async function registerServiceExposureRoutes(app: FastifyInstance, dependencies: { exposures: ServiceExposureService; sessions: SessionAuthenticatorRepository; sessionPolicy: SessionPolicy }): Promise<void> {
  app.post('/v1/service-exposures', async (request, reply) => reply.code(201).send(await dependencies.exposures.create(await account(request.headers.cookie, dependencies), createInput(request.body))));
  app.post('/v1/service-exposures/:exposureId/publish', async (request) => dependencies.exposures.publish(await account(request.headers.cookie, dependencies), (request.params as { exposureId: string }).exposureId));
  app.post('/v1/service-exposures/:exposureId/unpublish', async (request) => dependencies.exposures.unpublish(await account(request.headers.cookie, dependencies), (request.params as { exposureId: string }).exposureId));
}

async function account(header: string | undefined, dependencies: { sessions: SessionAuthenticatorRepository; sessionPolicy: SessionPolicy }) { try { const value=header?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${sessionCookieName}=`))?.slice(sessionCookieName.length+1); return (await authenticateSession(value, dependencies.sessionPolicy, dependencies.sessions)).accountId; } catch { throw new ServiceExposureError('UNAUTHORIZED'); } }
function createInput(value: unknown) { const body=value as { serviceOfferingId?: unknown }; if (typeof body?.serviceOfferingId !== 'string' || !body.serviceOfferingId) throw new ServiceExposureError('CONFLICT'); return body.serviceOfferingId; }
