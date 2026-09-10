import type { FastifyInstance } from 'fastify';
import { AppointmentError, type AppointmentIntentInput, type AppointmentService } from '../modules/appointments/appointments.js';
import { authenticateSession, sessionCookieName, type SessionAuthenticatorRepository, type SessionPolicy } from '../modules/sessions/session.js';

export async function registerAppointmentIntentRoutes(app: FastifyInstance, dependencies: { appointments: AppointmentService; sessions: SessionAuthenticatorRepository; sessionPolicy: SessionPolicy }): Promise<void> {
  app.post('/v1/appointment-intents', async (request, reply) => reply.code(201).send(await dependencies.appointments.create(await account(request.headers.cookie, dependencies), input(request.body))));
  app.post('/v1/appointment-intents/:intentId/reserve', async (request, reply) => reply.code(201).send(await dependencies.appointments.reserve(await account(request.headers.cookie, dependencies), (request.params as { intentId: string }).intentId)));
  app.post('/v1/slot-reservations/:reservationId/release', async (request, reply) => { await dependencies.appointments.release(await account(request.headers.cookie, dependencies), (request.params as { reservationId: string }).reservationId); return reply.code(204).send(); });
}

async function account(header: string | undefined, dependencies: { sessions: SessionAuthenticatorRepository; sessionPolicy: SessionPolicy }) { try { const value = header?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${sessionCookieName}=`))?.slice(sessionCookieName.length + 1); return (await authenticateSession(value, dependencies.sessionPolicy, dependencies.sessions)).accountId; } catch { throw new AppointmentError('UNAUTHORIZED'); } }
function input(value: unknown): AppointmentIntentInput { const body = value as Record<string, unknown>; if (typeof body?.serviceExposureId !== 'string' || typeof body.requestedLocalAt !== 'string' || typeof body.idempotencyKey !== 'string' || !body.idempotencyKey) throw new AppointmentError('CONFLICT'); return { serviceExposureId: body.serviceExposureId, requestedLocalAt: body.requestedLocalAt, idempotencyKey: body.idempotencyKey }; }
