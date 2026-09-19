import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerErrorHandler } from '../src/middleware/errors.js';
import type { AppointmentAuthorizationService } from '../src/modules/appointments/appointment-authorization.js';
import type { AppointmentLifecycleService } from '../src/modules/appointments/appointment-lifecycle.js';
import { hashSessionSecret, type SessionAuthenticatorRepository } from '../src/modules/sessions/session.js';
import { registerAppointmentOperationRoutes } from '../src/routes/appointment-operations.js';

function setup() {
  const calls: { action: string; expectedStatus: string; actorAccountId?: string; revalidated: boolean }[] = [];
  const authorization = {
    authorize: async () => ({ id: 'appointment-a', participants: [] }),
    authorizeInTransaction: async () => ({ id: 'appointment-a', participants: [] }),
  } as unknown as AppointmentAuthorizationService;
  const lifecycle = { transition: async (request: { action: string; expectedStatus: string; actorAccountId?: string; authorizeInTransaction?: (database: never) => Promise<void> }) => {
    await request.authorizeInTransaction?.(undefined as never);
    calls.push({ action: request.action, expectedStatus: request.expectedStatus, actorAccountId: request.actorAccountId, revalidated: Boolean(request.authorizeInTransaction) });
    return { appointmentId: 'appointment-a', previousStatus: request.expectedStatus, resultingStatus: request.action === 'START' ? 'IN_PROGRESS' : 'COMPLETED', eventId: 'event-a' };
  } } as unknown as AppointmentLifecycleService;
  const sessions: SessionAuthenticatorRepository = { findBySecretHash: async (hash) => hash === hashSessionSecret('secret') ? { id: 'session-a', accountId: 'doctor-a', status: 'ACTIVE', idleExpiresAt: new Date('2031-01-01T00:00:00Z'), absoluteExpiresAt: new Date('2031-01-01T00:00:00Z') } : null, touch: async () => ({ updated: true }) };
  const app = Fastify(); registerErrorHandler(app); void app.register(async (instance) => registerAppointmentOperationRoutes(instance, { lifecycle, authorization, sessions, sessionPolicy: { idleTtlSeconds: 600, absoluteTtlSeconds: 3600 } }));
  return { app, calls };
}

describe('theCliniQ Phase 5.7 appointment operation routes', () => {
  it('derives the actor from the session and exposes only explicit Start/Complete operations', async () => {
    const { app, calls } = setup(); const headers = { cookie: 'cliniq_session=session-a.secret' };
    expect((await app.inject({ method: 'POST', url: '/v1/appointments/appointment-a/start', headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/v1/appointments/appointment-a/complete', headers, payload: {} })).statusCode).toBe(200);
    expect(calls).toEqual([
      { action: 'START', expectedStatus: 'CONFIRMED', actorAccountId: 'doctor-a', revalidated: true },
      { action: 'COMPLETE', expectedStatus: 'IN_PROGRESS', actorAccountId: 'doctor-a', revalidated: true },
    ]);
    expect((await app.inject({ method: 'POST', url: '/v1/appointments/appointment-a/start', headers, payload: { status: 'COMPLETED' } })).statusCode).toBe(409);
    await app.close();
  });

  it('requires an active server-side session', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'POST', url: '/v1/appointments/appointment-a/start' })).statusCode).toBe(401);
    await app.close();
  });
});
