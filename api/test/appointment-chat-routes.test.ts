import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerErrorHandler } from '../src/middleware/errors.js';
import { AppointmentChatError, AppointmentChatService, type AppointmentChatRepository, type ChatAccess, type Conversation, type Message } from '../src/modules/chat/appointment-chat.js';
import { registerAppointmentChatRoutes } from '../src/routes/appointment-chat.js';
import { hashSessionSecret, type SessionAuthenticatorRepository } from '../src/modules/sessions/session.js';

class Repository implements AppointmentChatRepository {
  public conversation: Conversation | null = null; public messages: Message[] = [];
  public async access(appointmentId: string): Promise<ChatAccess | null> { return appointmentId === 'appointment-a' ? { appointmentId, status: 'CONFIRMED', patientProfileId: 'patient-profile', doctorProfileId: 'doctor-profile' } : null; }
  public async ownsPatient(accountId: string, profileId: string) { return accountId === 'patient' && profileId === 'patient-profile'; }
  public async ownsDoctor(accountId: string, profileId: string) { return accountId === 'doctor' && profileId === 'doctor-profile'; }
  public async getOrCreate() { return this.conversation ??= { id: 'conversation-a', appointmentId: 'appointment-a', patientProfileId: 'patient-profile', doctorProfileId: 'doctor-profile', createdAt: new Date(0) }; }
  public async find() { return this.conversation; }
  public async list() { return this.messages; }
  public async send(input: Omit<Message, 'id' | 'createdAt'>) { const prior = this.messages.find((message) => message.senderAccountId === input.senderAccountId && message.idempotencyKey === input.idempotencyKey); if (prior) { if (prior.body !== input.body) throw new AppointmentChatError('CONFLICT'); return { message: prior, replayed: true }; } const message: Message = { ...input, id: 'message-a', createdAt: new Date(0) }; this.messages.push(message); return { message, replayed: false }; }
}

function setup() {
  const repository = new Repository(); const sessions: SessionAuthenticatorRepository = { findBySecretHash: async (hash) => { const accountId = hash === hashSessionSecret('patient') ? 'patient' : hash === hashSessionSecret('doctor') ? 'doctor' : hash === hashSessionSecret('other') ? 'other' : null; return accountId ? { id: `session-${accountId}`, accountId, status: 'ACTIVE', idleExpiresAt: new Date('2031-01-01'), absoluteExpiresAt: new Date('2031-01-02') } : null; }, touch: async () => ({ updated: true }) };
  const app = Fastify(); registerErrorHandler(app); void app.register(async (instance) => registerAppointmentChatRoutes(instance, { chat: new AppointmentChatService(repository), sessions, sessionPolicy: { idleTtlSeconds: 600, absoluteTtlSeconds: 3600 } }));
  return app;
}

describe('appointment chat routes', () => {
  it('returns a client-safe not-found response when no conversation exists', async () => { const app = setup(); expect((await app.inject({ method: 'GET', url: '/v1/appointments/appointment-a/conversation', headers: { cookie: 'cliniq_session=session-patient.patient' } })).statusCode).toBe(404); await app.close(); });
  it('maps conflicting idempotency reuse to conflict and keeps participant checks', async () => { const app = setup(); const headers = { cookie: 'cliniq_session=session-patient.patient' }; expect((await app.inject({ method: 'POST', url: '/v1/appointments/appointment-a/conversation', headers })).statusCode).toBe(200); expect((await app.inject({ method: 'POST', url: '/v1/appointments/appointment-a/conversation/messages', headers, payload: { body: 'first', idempotencyKey: 'key' } })).statusCode).toBe(200); expect((await app.inject({ method: 'POST', url: '/v1/appointments/appointment-a/conversation/messages', headers, payload: { body: 'other', idempotencyKey: 'key' } })).statusCode).toBe(409); expect((await app.inject({ method: 'GET', url: '/v1/appointments/appointment-a/conversation', headers: { cookie: 'cliniq_session=session-other.other' } })).statusCode).toBe(403); expect((await app.inject({ method: 'GET', url: '/v1/appointments/appointment-a/conversation' })).statusCode).toBe(401); await app.close(); });
});
