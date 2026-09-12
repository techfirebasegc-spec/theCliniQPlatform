import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerErrorHandler } from '../src/middleware/errors.js';
import type { CancellationService } from '../src/modules/appointments/cancellation-refunds.js';
import { hashSessionSecret, type SessionAuthenticatorRepository } from '../src/modules/sessions/session.js';
import { registerAppointmentCancellationRoutes } from '../src/routes/appointment-cancellations.js';

function setup() {
  const calls: unknown[][] = [];
  const cancellations = { cancel: async (...input: unknown[]) => { calls.push(input); return { decision: { id: 'decision-a', refundAmountMinor: 100 }, replayed: false }; } } as unknown as CancellationService;
  const sessions: SessionAuthenticatorRepository = { findBySecretHash: async (hash) => hash === hashSessionSecret('secret') ? { id: 'session', accountId: 'patient-a', status: 'ACTIVE', idleExpiresAt: new Date('2031-01-01T00:00:00Z'), absoluteExpiresAt: new Date('2031-01-01T00:00:00Z') } : null, touch: async () => ({ updated: true }) };
  const app = Fastify(); registerErrorHandler(app); void app.register(async (instance) => registerAppointmentCancellationRoutes(instance, { cancellations, sessions, sessionPolicy: { idleTtlSeconds: 600, absoluteTtlSeconds: 3600 } }));
  return { app, calls };
}

describe('theCliniQ Phase 5.5 cancellation route', () => {
  it('derives the actor from the server session and rejects client financial inputs', async () => {
    const { app, calls } = setup(); const headers = { cookie: 'cliniq_session=session.secret' };
    const accepted = await app.inject({ method: 'POST', url: '/v1/appointments/appointment-a/cancellations', headers, payload: { reason: 'PATIENT_REQUEST', idempotencyKey: 'cancel-a' } });
    expect(accepted.statusCode).toBe(201); expect(calls).toEqual([['patient-a', { appointmentId: 'appointment-a', reason: 'PATIENT_REQUEST', idempotencyKey: 'cancel-a' }]]);
    const forged = await app.inject({ method: 'POST', url: '/v1/appointments/appointment-a/cancellations', headers, payload: { reason: 'PATIENT_REQUEST', idempotencyKey: 'cancel-b', refundAmountMinor: 1, refundPolicyVersionId: 'forged' } });
    expect(forged.statusCode).toBe(409); expect(calls).toHaveLength(1); await app.close();
  });
  it('requires a valid server session', async () => {
    const { app } = setup(); const response = await app.inject({ method: 'POST', url: '/v1/appointments/appointment-a/cancellations', payload: { reason: 'PATIENT_REQUEST', idempotencyKey: 'cancel-a' } });
    expect(response.statusCode).toBe(401); await app.close();
  });
});
