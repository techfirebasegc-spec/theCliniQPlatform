import type { FastifyInstance } from 'fastify';
import { AppointmentAuthorizationError, type AppointmentAuthorizationService } from '../modules/appointments/appointment-authorization.js';
import { AppointmentLifecycleError, type AppointmentLifecycleService, type AppointmentTransitionAction } from '../modules/appointments/appointment-lifecycle.js';
import { authenticateSession, sessionCookieName, type SessionAuthenticatorRepository, type SessionPolicy } from '../modules/sessions/session.js';

type Operation = { action: Extract<AppointmentTransitionAction, 'START' | 'COMPLETE'>; permission: 'appointment.start' | 'appointment.complete'; expectedStatus: 'CONFIRMED' | 'IN_PROGRESS' };

/** Explicit operational routes: callers never select an appointment state. */
export async function registerAppointmentOperationRoutes(app: FastifyInstance, dependencies: {
  lifecycle: AppointmentLifecycleService;
  authorization: Pick<AppointmentAuthorizationService, 'authorize' | 'authorizeInTransaction'>;
  sessions: SessionAuthenticatorRepository;
  sessionPolicy: SessionPolicy;
}): Promise<void> {
  register(app, dependencies, '/v1/appointments/:appointmentId/start', { action: 'START', permission: 'appointment.start', expectedStatus: 'CONFIRMED' });
  register(app, dependencies, '/v1/appointments/:appointmentId/complete', { action: 'COMPLETE', permission: 'appointment.complete', expectedStatus: 'IN_PROGRESS' });
}

function register(app: FastifyInstance, dependencies: {
  lifecycle: AppointmentLifecycleService;
  authorization: Pick<AppointmentAuthorizationService, 'authorize' | 'authorizeInTransaction'>;
  sessions: SessionAuthenticatorRepository;
  sessionPolicy: SessionPolicy;
}, url: string, operation: Operation): void {
  app.post(url, async (request, reply) => {
    const appointmentId = (request.params as { appointmentId?: string }).appointmentId;
    if (!appointmentId || appointmentId.trim().length === 0 || !emptyBody(request.body)) throw conflict();
    const actorAccountId = await account(request.headers.cookie, dependencies);
    await dependencies.authorization.authorize(actorAccountId, appointmentId, operation.permission);
    try {
      const result = await dependencies.lifecycle.transition({
        appointmentId,
        expectedStatus: operation.expectedStatus,
        action: operation.action,
        actorAccountId,
        authorizeInTransaction: (database) => dependencies.authorization.authorizeInTransaction(database, actorAccountId, appointmentId, operation.permission).then(() => undefined),
      });
      return reply.code(200).send(result);
    } catch (error) {
      if (error instanceof AppointmentLifecycleError) throw conflict();
      throw error;
    }
  });
}

function emptyBody(value: unknown): boolean { return value === undefined || (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0); }
async function account(header: string | undefined, dependencies: { sessions: SessionAuthenticatorRepository; sessionPolicy: SessionPolicy }): Promise<string> {
  try {
    const secret = header?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${sessionCookieName}=`))?.slice(sessionCookieName.length + 1);
    return (await authenticateSession(secret, dependencies.sessionPolicy, dependencies.sessions)).accountId;
  } catch { throw new AppointmentAuthorizationError('UNAUTHORIZED'); }
}
function conflict(): Error & { code: 'CONFLICT' } { return Object.assign(new Error('Appointment operation cannot be completed.'), { code: 'CONFLICT' as const }); }
