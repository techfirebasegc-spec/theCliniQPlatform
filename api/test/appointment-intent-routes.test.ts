import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerErrorHandler } from '../src/middleware/errors.js';
import { type AppointmentIntentInput, type AppointmentService } from '../src/modules/appointments/appointments.js';
import { hashSessionSecret, type SessionAuthenticatorRepository } from '../src/modules/sessions/session.js';
import { registerAppointmentIntentRoutes } from '../src/routes/appointment-intents.js';

function setup() {
  const calls: { accountId: string | undefined; input: AppointmentIntentInput }[] = [];
  const appointments = { create: async (accountId: string | undefined, input: AppointmentIntentInput) => { calls.push({ accountId, input }); return { id: 'intent-a' }; }, reserve: async () => ({ id: 'reservation-a' }), release: async () => {} } as unknown as AppointmentService;
  const sessions: SessionAuthenticatorRepository = { findBySecretHash: async (hash) => hash === hashSessionSecret('secret') ? { id: 'session-a', accountId: 'patient-a', status: 'ACTIVE', idleExpiresAt: new Date('2031-01-01T00:00:00Z'), absoluteExpiresAt: new Date('2031-01-01T00:00:00Z') } : null, touch: async () => ({ updated: true }) };
  const app = Fastify(); registerErrorHandler(app); void app.register(async (instance) => registerAppointmentIntentRoutes(instance, { appointments, sessions, sessionPolicy: { idleTtlSeconds: 600, absoluteTtlSeconds: 3600 } }));
  return { app, calls };
}

describe('Phase 5 Step 3.2 appointment intent routes', () => {
  it('requires a server-side session and accepts only an exposure identifier from the client', async () => { const { app, calls } = setup(); const body = { serviceExposureId: 'exposure-a', requestedLocalAt: '2030-01-07T10:00:00', idempotencyKey: 'key-a', provider: { kind: 'DOCTOR', doctorProfileId: 'attacker-doctor' }, serviceOfferingId: 'attacker-offering', bookingTenantId: 'attacker-tenant' }; expect((await app.inject({ method: 'POST', url: '/v1/appointment-intents', payload: body })).statusCode).toBe(401); const response = await app.inject({ method: 'POST', url: '/v1/appointment-intents', headers: { cookie: 'cliniq_session=session-a.secret' }, payload: body }); expect(response.statusCode).toBe(201); expect(calls).toEqual([expect.objectContaining({ accountId: 'patient-a', input: { serviceExposureId: 'exposure-a', requestedLocalAt: '2030-01-07T10:00:00', idempotencyKey: 'key-a' } })]); await app.close(); });
  it('rejects a missing exposure body before service invocation', async () => { const { app, calls } = setup(); const response = await app.inject({ method: 'POST', url: '/v1/appointment-intents', headers: { cookie: 'cliniq_session=session-a.secret' }, payload: { requestedLocalAt: '2030-01-07T10:00:00', idempotencyKey: 'key-a' } }); expect(response.statusCode).toBe(409); expect(calls).toEqual([]); await app.close(); });
});
