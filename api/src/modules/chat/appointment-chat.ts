export type Conversation = { id: string; appointmentId: string; patientProfileId: string; doctorProfileId: string; createdAt: Date };
export type Message = { id: string; conversationId: string; senderAccountId: string; messageType: 'TEXT'; body: string; idempotencyKey: string; createdAt: Date };
export type ChatAccess = { appointmentId: string; status: string; patientProfileId: string; doctorProfileId: string };

export class AppointmentChatError extends Error {
  public constructor(public readonly code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT') { super(code); }
}

export interface AppointmentChatRepository {
  access(appointmentId: string): Promise<ChatAccess | null>;
  ownsPatient(accountId: string, profileId: string): Promise<boolean>;
  ownsDoctor(accountId: string, profileId: string): Promise<boolean>;
  getOrCreate(appointmentId: string): Promise<Conversation>;
  find(appointmentId: string): Promise<Conversation | null>;
  list(conversationId: string): Promise<Message[]>;
  send(input: Omit<Message, 'id' | 'createdAt'>): Promise<{ message: Message; replayed: boolean }>;
}

export class AppointmentChatService {
  public constructor(private readonly repository: AppointmentChatRepository) {}

  public async conversation(accountId: string | undefined, appointmentId: string): Promise<Conversation> {
    const access = await this.authorize(accountId, appointmentId);
    if (!writable(access.status)) throw new AppointmentChatError('CONFLICT');
    return this.repository.getOrCreate(appointmentId);
  }

  public async get(accountId: string | undefined, appointmentId: string): Promise<Conversation> {
    await this.authorize(accountId, appointmentId);
    const conversation = await this.repository.find(appointmentId);
    if (!conversation) throw new AppointmentChatError('NOT_FOUND');
    return conversation;
  }

  public async messages(accountId: string | undefined, appointmentId: string): Promise<Message[]> {
    return this.repository.list((await this.get(accountId, appointmentId)).id);
  }

  public async send(accountId: string | undefined, appointmentId: string, body: string, idempotencyKey: string): Promise<{ message: Message; replayed: boolean }> {
    const access = await this.authorize(accountId, appointmentId);
    if (!writable(access.status) || !body.trim() || !idempotencyKey.trim()) throw new AppointmentChatError('CONFLICT');
    const conversation = await this.repository.find(appointmentId);
    if (!conversation) throw new AppointmentChatError('NOT_FOUND');
    return this.repository.send({ conversationId: conversation.id, senderAccountId: accountId!, messageType: 'TEXT', body: body.trim(), idempotencyKey });
  }

  private async authorize(accountId: string | undefined, appointmentId: string): Promise<ChatAccess> {
    if (!accountId) throw new AppointmentChatError('UNAUTHORIZED');
    const access = await this.repository.access(appointmentId);
    if (!access || !((await this.repository.ownsPatient(accountId, access.patientProfileId)) || (await this.repository.ownsDoctor(accountId, access.doctorProfileId)))) throw new AppointmentChatError('FORBIDDEN');
    return access;
  }
}

function writable(status: string): boolean { return ['CONFIRMED', 'IN_PROGRESS', 'COMPLETED'].includes(status); }
