import { describe, expect, it } from 'vitest';
import { AppointmentChatError, AppointmentChatService, type AppointmentChatRepository, type ChatAccess, type Conversation, type Message } from '../src/modules/chat/appointment-chat.js';

class Repo implements AppointmentChatRepository {
  public accessValue: ChatAccess | null = { appointmentId: 'a', status: 'CONFIRMED', patientProfileId: 'p', doctorProfileId: 'd' };
  public conversation: Conversation | null = null;
  public messages: Message[] = [];
  public async access(id: string) { return id === 'a' ? this.accessValue : null; }
  public async ownsPatient(accountId: string, profileId: string) { return accountId === 'patient' && profileId === 'p'; }
  public async ownsDoctor(accountId: string, profileId: string) { return accountId === 'doctor' && profileId === 'd'; }
  public async getOrCreate() { return this.conversation ??= { id: 'c', appointmentId: 'a', patientProfileId: 'p', doctorProfileId: 'd', createdAt: new Date(0) }; }
  public async find() { return this.conversation; }
  public async list() { return [...this.messages].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id)); }
  public async send(input: Omit<Message, 'id' | 'createdAt'>) {
    const prior = this.messages.find((message) => message.conversationId === input.conversationId && message.senderAccountId === input.senderAccountId && message.idempotencyKey === input.idempotencyKey);
    if (prior) {
      if (prior.body !== input.body) throw new AppointmentChatError('CONFLICT');
      return { message: prior, replayed: true };
    }
    const message: Message = { ...input, id: `m${this.messages.length}`, createdAt: new Date(0) };
    this.messages.push(message);
    return { message, replayed: false };
  }
}

describe('appointment chat', () => {
  it('creates one appointment conversation concurrently and sends idempotently', async () => {
    const repository = new Repo(); const service = new AppointmentChatService(repository);
    expect(new Set((await Promise.all([service.conversation('patient', 'a'), service.conversation('doctor', 'a')])).map((conversation) => conversation.id))).toEqual(new Set(['c']));
    expect((await service.send('patient', 'a', 'hello', 'k')).replayed).toBe(false);
    expect((await service.send('patient', 'a', 'hello', 'k')).replayed).toBe(true);
    await expect(service.send('patient', 'a', 'different', 'k')).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('denies cross patient, doctor, clinic membership and appointment', async () => {
    const service = new AppointmentChatService(new Repo());
    for (const actor of ['other', 'clinic']) await expect(service.conversation(actor, 'a')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service.conversation('patient', 'other')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('denies sends after cancellation but keeps history readable', async () => {
    const repository = new Repo(); const service = new AppointmentChatService(repository);
    await service.conversation('patient', 'a'); await service.send('patient', 'a', 'old', 'k');
    repository.accessValue = { ...repository.accessValue!, status: 'CANCELLED' };
    await expect(service.send('patient', 'a', 'new', 'k2')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await service.messages('doctor', 'a')).toHaveLength(1);
  });
  it('requires doctor participant evidence and orders deterministically after completion', async () => {
    const repository = new Repo(); const service = new AppointmentChatService(repository);
    repository.accessValue = null; await expect(service.conversation('patient', 'a')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    repository.accessValue = { appointmentId: 'a', status: 'COMPLETED', patientProfileId: 'p', doctorProfileId: 'd' };
    await service.conversation('doctor', 'a'); await service.send('doctor', 'a', 'b', 'b'); await service.send('doctor', 'a', 'a', 'a');
    expect((await service.messages('patient', 'a')).map((message) => message.id)).toEqual(['m0', 'm1']);
  });
});
