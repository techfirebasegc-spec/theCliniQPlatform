import { createIdentifier } from '../../shared/identifiers/uuid.js';
import type { DatabaseHealth } from '../../infrastructure/database.js';
import { AppointmentChatError, type AppointmentChatRepository, type ChatAccess, type Conversation, type Message } from './appointment-chat.js';

export class PostgresAppointmentChatRepository implements AppointmentChatRepository {
  public constructor(private readonly database: DatabaseHealth) {}

  public async access(appointmentId: string): Promise<ChatAccess | null> {
    return access((await this.database.query<Record<string, unknown>>(`SELECT a.id,a.status,p.patient_profile_id,d.doctor_profile_id FROM appointments a JOIN appointment_participants p ON p.appointment_id=a.id AND p.participant_type='PATIENT' JOIN appointment_participants d ON d.appointment_id=a.id AND d.participant_type='DOCTOR' WHERE a.id=$1`, [appointmentId])).rows[0]);
  }
  public async ownsPatient(accountId: string, profileId: string): Promise<boolean> { return (await this.database.query('SELECT 1 FROM patient_profiles WHERE account_id=$1 AND id=$2', [accountId, profileId])).rowCount === 1; }
  public async ownsDoctor(accountId: string, profileId: string): Promise<boolean> { return (await this.database.query('SELECT 1 FROM doctor_profiles WHERE account_id=$1 AND id=$2', [accountId, profileId])).rowCount === 1; }

  /** Locks the same appointment row used by cancellation before deciding whether a new conversation may commit. */
  public async getOrCreate(appointmentId: string): Promise<Conversation> {
    return this.database.transaction(async (db) => {
      const current = access((await db.query<Record<string, unknown>>(`SELECT a.id,a.status,p.patient_profile_id,d.doctor_profile_id FROM appointments a JOIN appointment_participants p ON p.appointment_id=a.id AND p.participant_type='PATIENT' JOIN appointment_participants d ON d.appointment_id=a.id AND d.participant_type='DOCTOR' WHERE a.id=$1 FOR UPDATE OF a`, [appointmentId])).rows[0]);
      if (!current) throw new AppointmentChatError('NOT_FOUND');
      if (!writable(current.status)) throw new AppointmentChatError('CONFLICT');
      await db.query('INSERT INTO conversations (id,appointment_id,patient_profile_id,doctor_profile_id) VALUES ($1,$2,$3,$4) ON CONFLICT (appointment_id) DO NOTHING', [createIdentifier(), current.appointmentId, current.patientProfileId, current.doctorProfileId]);
      const row = (await db.query<Record<string, unknown>>('SELECT id,appointment_id,patient_profile_id,doctor_profile_id,created_at FROM conversations WHERE appointment_id=$1 FOR UPDATE', [appointmentId])).rows[0];
      return conversation(row)!;
    });
  }
  public async find(appointmentId: string): Promise<Conversation | null> { return conversation((await this.database.query<Record<string, unknown>>('SELECT id,appointment_id,patient_profile_id,doctor_profile_id,created_at FROM conversations WHERE appointment_id=$1', [appointmentId])).rows[0]); }
  public async list(conversationId: string): Promise<Message[]> { return (await this.database.query<Record<string, unknown>>('SELECT id,conversation_id,sender_account_id,message_type,body,idempotency_key,created_at FROM messages WHERE conversation_id=$1 ORDER BY created_at,id', [conversationId])).rows.map(message); }

  /** Locks the authoritative appointment row before inserting so a committed cancellation wins over a new message. */
  public async send(input: Omit<Message, 'id' | 'createdAt'>): Promise<{ message: Message; replayed: boolean }> {
    return this.database.transaction(async (db) => {
      const row = (await db.query<Record<string, unknown>>('SELECT a.status FROM conversations c JOIN appointments a ON a.id=c.appointment_id WHERE c.id=$1 FOR UPDATE OF a', [input.conversationId])).rows[0];
      if (!row) throw new AppointmentChatError('NOT_FOUND');
      if (!writable(String(row.status))) throw new AppointmentChatError('CONFLICT');
      const id = createIdentifier();
      await db.query("INSERT INTO messages (id,conversation_id,sender_account_id,message_type,body,idempotency_key) VALUES ($1,$2,$3,'TEXT',$4,$5) ON CONFLICT (conversation_id,sender_account_id,idempotency_key) DO NOTHING", [id, input.conversationId, input.senderAccountId, input.body, input.idempotencyKey]);
      const stored = message((await db.query<Record<string, unknown>>('SELECT id,conversation_id,sender_account_id,message_type,body,idempotency_key,created_at FROM messages WHERE conversation_id=$1 AND sender_account_id=$2 AND idempotency_key=$3 FOR UPDATE', [input.conversationId, input.senderAccountId, input.idempotencyKey])).rows[0]!);
      if (stored.body !== input.body) throw new AppointmentChatError('CONFLICT');
      return { message: stored, replayed: stored.id !== id };
    });
  }
}

function writable(status: string): boolean { return ['CONFIRMED', 'IN_PROGRESS', 'COMPLETED'].includes(status); }
function access(row: Record<string, unknown> | undefined): ChatAccess | null { return row ? { appointmentId: String(row.id), status: String(row.status), patientProfileId: String(row.patient_profile_id), doctorProfileId: String(row.doctor_profile_id) } : null; }
function conversation(row: Record<string, unknown> | undefined): Conversation | null { return row ? { id: String(row.id), appointmentId: String(row.appointment_id), patientProfileId: String(row.patient_profile_id), doctorProfileId: String(row.doctor_profile_id), createdAt: new Date(String(row.created_at)) } : null; }
function message(row: Record<string, unknown>): Message { return { id: String(row.id), conversationId: String(row.conversation_id), senderAccountId: String(row.sender_account_id), messageType: 'TEXT', body: String(row.body), idempotencyKey: String(row.idempotency_key), createdAt: new Date(String(row.created_at)) }; }
