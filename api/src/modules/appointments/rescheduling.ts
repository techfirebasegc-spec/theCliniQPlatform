import { createHash } from 'node:crypto';
import { createIdentifier } from '../../shared/identifiers/uuid.js';
import type { AuditEventInput } from '../audit/audit.js';
import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';
import type { AppointmentAuthorizationService } from './appointment-authorization.js';
import { type AppointmentIntent, type AppointmentRepository, type BookableService, type SlotReservation } from './appointments.js';
import { localToUtcEarlier } from '../availability/timezone.js';

export type RescheduleInput = { requestedLocalAt: string; reason: string; idempotencyKey: string };
export type RescheduleResult = { id: string; sourceAppointmentId: string; successorAppointmentId: string; successorIntentId: string; successorReservationId: string; replayed: boolean };
export type RescheduleSource = { appointmentId: string; status: string; reservationId: string; committedCapacityId: string; intent: AppointmentIntent; handoffId: string; allocationId: string; paymentIntentId: string };

export interface RescheduleRepository {
  transaction<T>(operation: (database: PostgresExecutor) => Promise<T>): Promise<T>;
  lockSource(database: PostgresExecutor, appointmentId: string): Promise<RescheduleSource | null>;
  findByIdempotency(database: PostgresExecutor, actorId: string, key: string): Promise<(RescheduleResult & { fingerprint: string }) | null>;
  createSuccessorAppointment(database: PostgresExecutor, source: RescheduleSource, intent: AppointmentIntent, reservation: SlotReservation): Promise<string>;
  createCommittedCapacity(database: PostgresExecutor, appointmentId: string, reservationId: string): Promise<void>;
  createReschedule(database: PostgresExecutor, value: Omit<RescheduleResult, 'replayed'> & { actorId: string; reason: string; idempotencyKey: string; fingerprint: string; auditEventId: string }): Promise<void>;
  releaseSourceCapacity(database: PostgresExecutor, capacityId: string, at: Date): Promise<boolean>;
  appendAudit(database: PostgresExecutor, event: AuditEventInput): Promise<string>;
  appendEvent(database: PostgresExecutor, appointmentId: string, eventType: 'RESCHEDULE_REQUESTED' | 'RESCHEDULED', actorId: string, reason: string, auditEventId: string, context: Record<string, string>): Promise<void>;
}

export class RescheduleError extends Error { public constructor(public readonly code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'CONFLICT' | 'NOT_FOUND') { super(code === 'UNAUTHORIZED' ? 'Authentication is required.' : 'Appointment rescheduling cannot be completed.'); } }

/** A reschedule never mutates the source appointment or its financial evidence. */
export class RescheduleService {
  public constructor(private readonly appointments: AppointmentRepository, private readonly repository: RescheduleRepository, private readonly authorization: Pick<AppointmentAuthorizationService, 'authorize' | 'authorizeInTransaction'>, private readonly now: () => Date = () => new Date()) {}
  public async reschedule(actorId: string | undefined, appointmentId: string, input: RescheduleInput): Promise<RescheduleResult> {
    if (!actorId) throw new RescheduleError('UNAUTHORIZED');
    if (!input.reason.trim() || !input.idempotencyKey.trim()) throw new RescheduleError('CONFLICT');
    await this.authorization.authorize(actorId, appointmentId, 'appointment.reschedule');
    const fingerprint = createHash('sha256').update(JSON.stringify({ appointmentId, requestedLocalAt: input.requestedLocalAt, reason: input.reason.trim() })).digest('base64url');
    return this.repository.transaction(async (database) => {
      const replay = await this.repository.findByIdempotency(database, actorId, input.idempotencyKey);
      if (replay) { if (replay.fingerprint !== fingerprint) throw new RescheduleError('CONFLICT'); return { ...replay, replayed: true }; }
      const source = await this.repository.lockSource(database, appointmentId);
      if (!source) throw new RescheduleError('NOT_FOUND');
      await this.authorization.authorizeInTransaction(database, actorId, appointmentId, 'appointment.reschedule');
      if (source.status !== 'CONFIRMED') throw new RescheduleError('CONFLICT');
      const now = this.now();
      const bookable = await this.appointments.lockBookable(database, source.intent.serviceOfferingId, source.intent.provider, input.requestedLocalAt);
      if (!sameContext(source.intent, bookable)) throw new RescheduleError('CONFLICT');
      const startsAt = localToUtcEarlier(input.requestedLocalAt, bookable.timezone);
      const range = validate(bookable, input.requestedLocalAt, startsAt, now);
      const used = await this.appointments.activeCapacityUnits(database, source.intent.serviceOfferingVersionId, range.startsAt, range.endsAt);
      if (used + 1 > bookable.capacity) throw new RescheduleError('CONFLICT');
      const successorIntent: AppointmentIntent = { ...source.intent, id: createIdentifier(), requestedLocalAt: input.requestedLocalAt, startsAt: range.startsAt, endsAt: range.endsAt, state: 'APPOINTMENT_INTENT', idempotencyKey: `reschedule:${createIdentifier()}`, requestFingerprint: fingerprint, expiresAt: new Date(now.getTime() + source.intent.holdSeconds * 1000) };
      await this.appointments.createIntent(database, successorIntent);
      const successorReservation: SlotReservation = { id: createIdentifier(), appointmentIntentId: successorIntent.id, serviceOfferingVersionId: successorIntent.serviceOfferingVersionId, provider: successorIntent.provider, startsAt: range.startsAt, endsAt: range.endsAt, capacityUnits: 1, status: 'HELD', expiresAt: successorIntent.expiresAt, releasedAt: null, expiredAt: null };
      await this.appointments.createReservation(database, successorReservation);
      if (!await this.appointments.transitionIntent(database, successorIntent.id, 'APPOINTMENT_INTENT', 'SLOT_RESERVED', now)) throw new RescheduleError('CONFLICT');
      const successorAppointmentId = await this.repository.createSuccessorAppointment(database, source, successorIntent, successorReservation);
      await this.repository.createCommittedCapacity(database, successorAppointmentId, successorReservation.id);
      if (!await this.appointments.transitionIntent(database, successorIntent.id, 'SLOT_RESERVED', 'FULFILLED', now)) throw new RescheduleError('CONFLICT');
      const auditId = await this.repository.appendAudit(database, { category: 'BUSINESS', eventType: 'APPOINTMENT_RESCHEDULED', actorAccountId: actorId, targetType: 'APPOINTMENT', targetId: appointmentId, outcome: 'SUCCESS', metadata: { successorAppointmentId } });
      const result: RescheduleResult = { id: createIdentifier(), sourceAppointmentId: appointmentId, successorAppointmentId, successorIntentId: successorIntent.id, successorReservationId: successorReservation.id, replayed: false };
      await this.repository.createReschedule(database, { ...result, actorId, reason: input.reason.trim(), idempotencyKey: input.idempotencyKey, fingerprint, auditEventId: auditId });
      await this.repository.appendEvent(database, appointmentId, 'RESCHEDULE_REQUESTED', actorId, input.reason.trim(), auditId, { rescheduleId: result.id, successorAppointmentId });
      await this.repository.appendEvent(database, successorAppointmentId, 'RESCHEDULED', actorId, input.reason.trim(), auditId, { rescheduleId: result.id, sourceAppointmentId: appointmentId });
      if (!await this.repository.releaseSourceCapacity(database, source.committedCapacityId, now)) throw new RescheduleError('CONFLICT');
      return result;
    });
  }
}
function sameContext(intent: AppointmentIntent, b: BookableService | null): b is BookableService { return !!b && b.serviceOfferingId===intent.serviceOfferingId && b.versionId===intent.serviceOfferingVersionId && b.priceId===intent.serviceOfferingPriceId && b.currency===intent.currency && b.priceAmountMinor===intent.priceAmountMinor && b.bookingTenantId===intent.bookingTenantId && sameProvider(intent.provider,b.provider); }
function sameProvider(a: AppointmentIntent['provider'], b: AppointmentIntent['provider']) { return a.kind===b.kind && (a.kind==='DOCTOR' ? a.doctorProfileId===(b as Extract<AppointmentIntent['provider'],{kind:'DOCTOR'}>).doctorProfileId : a.clinicId===(b as Extract<AppointmentIntent['provider'],{kind:'CLINIC'}>).clinicId); }
function validate(bookable: BookableService, local: string, at: Date, now: Date) { if (at < new Date(now.getTime()+bookable.bookingLeadSeconds*1000) || at > new Date(now.getTime()+bookable.bookingHorizonSeconds*1000)) throw new RescheduleError('CONFLICT'); const startsAt=new Date(at.getTime()-bookable.bufferBeforeSeconds*1000), endsAt=new Date(at.getTime()+(bookable.durationSeconds+bookable.bufferAfterSeconds)*1000); const weekday=localWeekday(local), start=localSeconds(local)-bookable.bufferBeforeSeconds, end=localSeconds(local)+bookable.durationSeconds+bookable.bufferAfterSeconds; if(start<0||end>86400) throw new RescheduleError('CONFLICT'); const active=(r:{effectiveFrom:Date;effectiveTo:Date|null;canonicalRecurrence:string})=>r.effectiveFrom<=startsAt&&(!r.effectiveTo||r.effectiveTo>startsAt)&&r.canonicalRecurrence.split('BYDAY=')[1]?.split(',').includes(['','MO','TU','WE','TH','FR','SA','SU'][weekday]); const works=bookable.rules.some(r=>active(r)&&r.windows.some(w=>w.kind==='WORKING'&&w.weekday===weekday&&w.startSeconds<=start&&w.endSeconds>=end)); const breakHit=bookable.rules.some(r=>active(r)&&r.windows.some(w=>w.kind==='BREAK'&&w.weekday===weekday&&w.startSeconds<end&&start<w.endSeconds)); const oneOff=bookable.exceptions.some(x=>x.status==='ACTIVE'&&x.kind==='ONE_OFF'&&x.start<=startsAt&&x.end>=endsAt); const blocked=bookable.exceptions.some(x=>x.status==='ACTIVE'&&x.kind!=='ONE_OFF'&&x.start<endsAt&&startsAt<x.end); if((!works&&!oneOff)||breakHit||blocked) throw new RescheduleError('CONFLICT'); return {startsAt,endsAt}; }
function localWeekday(local:string){const d=new Date(`${local.slice(0,10)}T00:00:00Z`).getUTCDay();return d===0?7:d;} function localSeconds(local:string){return Number(local.slice(11,13))*3600+Number(local.slice(14,16))*60+Number(local.slice(17,19));}
