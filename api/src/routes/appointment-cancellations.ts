import type { FastifyInstance } from 'fastify';
import { CancellationError, type CancellationService } from '../modules/appointments/cancellation-refunds.js';
import { authenticateSession, sessionCookieName, type SessionAuthenticatorRepository, type SessionPolicy } from '../modules/sessions/session.js';

/** Phase 5.5 accepts only a reason and idempotency key; all financial inputs remain server-derived. */
export async function registerAppointmentCancellationRoutes(app: FastifyInstance, dependencies: { cancellations: CancellationService; sessions: SessionAuthenticatorRepository; sessionPolicy: SessionPolicy }): Promise<void> {
  app.post('/v1/appointments/:appointmentId/cancellations', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    if (!body || Object.keys(body).some((key) => key !== 'reason' && key !== 'idempotencyKey') || typeof body.reason !== 'string' || typeof body.idempotencyKey !== 'string') throw new CancellationError('CONFLICT');
    const result = await dependencies.cancellations.cancel(await account(request.headers.cookie, dependencies), { appointmentId: (request.params as { appointmentId: string }).appointmentId, reason: body.reason, idempotencyKey: body.idempotencyKey });
    return reply.code(result.replayed ? 200 : 201).send(result);
  });
}

async function account(header: string | undefined, dependencies: { sessions: SessionAuthenticatorRepository; sessionPolicy: SessionPolicy }): Promise<string> {
  try {
    const secret = header?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${sessionCookieName}=`))?.slice(sessionCookieName.length + 1);
    return (await authenticateSession(secret, dependencies.sessionPolicy, dependencies.sessions)).accountId;
  } catch { throw new CancellationError('UNAUTHORIZED'); }
}
