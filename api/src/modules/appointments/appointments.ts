import { createIdentifier } from '../../shared/identifiers/uuid.js';
import { createHash } from 'node:crypto';
import type { AuditEventInput, AuditRepository } from '../audit/audit.js';
import { localToUtcEarlier } from '../availability/timezone.js';
import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';

export type ProviderInput = { kind: 'DOCTOR'; doctorProfileId: string } | { kind: 'CLINIC'; clinicId: string };
export type AppointmentIntentInput = { serviceExposureId: string; requestedLocalAt: string; idempotencyKey: string };
export type AvailabilityRule = { canonicalRecurrence: string; effectiveFrom: Date; effectiveTo: Date | null; windows: { kind: 'WORKING' | 'BREAK'; weekday: number; startSeconds: number; endSeconds: number }[] };
export type AvailabilityException = { kind: 'HOLIDAY' | 'LEAVE' | 'BLOCKED' | 'ONE_OFF'; start: Date; end: Date; status: 'ACTIVE' | 'INACTIVE' };
export type BookableService = {
  provider: ProviderInput; serviceOfferingId: string; versionId: string; priceId: string; currency: string; priceAmountMinor: bigint;
  bookingTenantId: string | null;
  timezone: string; durationSeconds: number; bufferBeforeSeconds: number; bufferAfterSeconds: number; capacity: number;
  bookingLeadSeconds: number; bookingHorizonSeconds: number; holdSeconds: number; rules: AvailabilityRule[]; exceptions: AvailabilityException[];
};
export type AppointmentIntent = {
  id: string; patientAccountId: string; bookingActorAccountId: string; bookingTenantId: string | null; serviceExposureId: string | null; provider: ProviderInput; serviceOfferingId: string; serviceOfferingVersionId: string;
  serviceOfferingPriceId: string; currency: string; priceAmountMinor: bigint; providerTimezone: string; requestedLocalAt: string; startsAt: Date; endsAt: Date;
  serviceDurationSeconds: number; bufferBeforeSeconds: number; bufferAfterSeconds: number; holdSeconds: number; state: 'APPOINTMENT_INTENT' | 'SLOT_RESERVED' | 'EXPIRED' | 'CANCELLED';
  idempotencyKey: string; requestFingerprint: string; expiresAt: Date;
};
export type SlotReservation = { id: string; appointmentIntentId: string; serviceOfferingVersionId: string; provider: ProviderInput; startsAt: Date; endsAt: Date; capacityUnits: number; status: 'HELD' | 'RELEASED' | 'EXPIRED'; expiresAt: Date; releasedAt: Date | null; expiredAt: Date | null };

export class AppointmentError extends Error {
  public constructor(public readonly code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'CONFLICT') { super(code === 'UNAUTHORIZED' ? 'Authentication is required.' : code === 'CONFLICT' ? 'The requested appointment operation cannot be completed.' : 'Appointment access is not permitted.'); }
}

export interface AppointmentRepository {
  transaction<T>(operation: (database: PostgresExecutor) => Promise<T>): Promise<T>;
  findByIdempotency(actorAccountId: string, idempotencyKey: string): Promise<AppointmentIntent | null>;
  activePatient(database: PostgresExecutor, accountId: string): Promise<boolean>;
  lockPublishedExposure(database: PostgresExecutor, exposureId: string): Promise<{ id: string; serviceOfferingId: string; provider: ProviderInput } | null>;
  lockBookable(database: PostgresExecutor, offeringId: string, provider: ProviderInput, requestedLocalAt: string): Promise<BookableService | null>;
  createIntent(database: PostgresExecutor, intent: AppointmentIntent): Promise<void>;
  lockIntent(database: PostgresExecutor, intentId: string): Promise<AppointmentIntent | null>;
  activeCapacityUnits(database: PostgresExecutor, versionId: string, startsAt: Date, endsAt: Date): Promise<number>;
  createReservation(database: PostgresExecutor, reservation: SlotReservation): Promise<void>;
  transitionIntent(database: PostgresExecutor, intentId: string, from: AppointmentIntent['state'], to: AppointmentIntent['state'], at: Date): Promise<boolean>;
  lockReservation(database: PostgresExecutor, reservationId: string): Promise<SlotReservation | null>;
  releaseReservation(database: PostgresExecutor, reservationId: string, at: Date): Promise<boolean>;
  expireReservation(database: PostgresExecutor, reservationId: string, at: Date): Promise<boolean>;
  appendAudit(database: PostgresExecutor, event: AuditEventInput): Promise<void>;
}

export class AppointmentService {
  public constructor(private readonly repository: AppointmentRepository, private readonly audit: AuditRepository, private readonly now: () => Date = () => new Date()) {}

  public async create(accountId: string | undefined, input: AppointmentIntentInput): Promise<AppointmentIntent> {
    const actor = this.requireAccount(accountId);
    const fingerprint = requestFingerprint(input);
    const existing = await this.repository.findByIdempotency(actor, input.idempotencyKey);
    if (existing) return this.idempotent(actor, fingerprint, existing);
    try {
      return await this.repository.transaction(async (database) => {
        const retried = await this.repository.findByIdempotency(actor, input.idempotencyKey);
        if (retried) return this.idempotent(actor, fingerprint, retried);
        const now = this.now();
        if (!await this.repository.activePatient(database, actor)) return this.denied(actor, 'PATIENT_PROFILE', actor);
        const exposure = await this.repository.lockPublishedExposure(database, input.serviceExposureId);
        if (!exposure) return this.denied(actor, 'SERVICE_EXPOSURE', input.serviceExposureId);
        const bookable = await this.repository.lockBookable(database, exposure.serviceOfferingId, exposure.provider, input.requestedLocalAt);
        if (!bookable || bookable.serviceOfferingId !== exposure.serviceOfferingId || !sameProvider(bookable.provider, exposure.provider)) return this.denied(actor, 'SERVICE_EXPOSURE', input.serviceExposureId);
        const resolvedStart = localToUtcEarlier(input.requestedLocalAt, bookable.timezone);
        const { startsAt, endsAt } = validateBookable(bookable, input.requestedLocalAt, resolvedStart, now);
        const intent: AppointmentIntent = { id: createIdentifier(), patientAccountId: actor, bookingActorAccountId: actor, bookingTenantId: bookable.bookingTenantId, serviceExposureId: exposure.id, provider: bookable.provider, serviceOfferingId: bookable.serviceOfferingId, serviceOfferingVersionId: bookable.versionId, serviceOfferingPriceId: bookable.priceId, currency: bookable.currency, priceAmountMinor: bookable.priceAmountMinor, providerTimezone: bookable.timezone, requestedLocalAt: input.requestedLocalAt, startsAt, endsAt, serviceDurationSeconds: bookable.durationSeconds, bufferBeforeSeconds: bookable.bufferBeforeSeconds, bufferAfterSeconds: bookable.bufferAfterSeconds, holdSeconds: bookable.holdSeconds, state: 'APPOINTMENT_INTENT', idempotencyKey: input.idempotencyKey, requestFingerprint: fingerprint, expiresAt: new Date(now.getTime() + bookable.holdSeconds * 1_000) };
        await this.repository.createIntent(database, intent);
        await this.repository.appendAudit(database, success('APPOINTMENT_INTENT_CREATED', actor, intent.id));
        return intent;
      });
    } catch (error) {
      if (error instanceof AppointmentError) throw error;
      const raced = await this.repository.findByIdempotency(actor, input.idempotencyKey);
      if (raced) return this.idempotent(actor, fingerprint, raced);
      return this.conflict(actor, 'APPOINTMENT_INTENT', input.serviceExposureId);
    }
  }

  public async reserve(accountId: string | undefined, intentId: string): Promise<SlotReservation> {
    const actor = this.requireAccount(accountId);
    return this.repository.transaction(async (database) => {
      const intent = await this.repository.lockIntent(database, intentId);
      if (!intent || intent.patientAccountId !== actor || intent.bookingActorAccountId !== actor) return this.denied(actor, 'APPOINTMENT_INTENT', intentId);
      if (!await this.repository.activePatient(database, actor)) return this.denied(actor, 'PATIENT_PROFILE', actor);
      const now = this.now();
      if (intent.state !== 'APPOINTMENT_INTENT' || intent.expiresAt <= now) {
        if (intent.state === 'APPOINTMENT_INTENT' && intent.expiresAt <= now) {
          if (await this.repository.transitionIntent(database, intent.id, 'APPOINTMENT_INTENT', 'EXPIRED', now)) {
            await this.repository.appendAudit(database, success('APPOINTMENT_INTENT_EXPIRED', actor, intent.id));
          }
        }
        return this.conflict(actor, 'APPOINTMENT_INTENT', intent.id);
      }
      const bookable = await this.repository.lockBookable(database, intent.serviceOfferingId, intent.provider, intent.requestedLocalAt);
      if (!bookable || bookable.versionId !== intent.serviceOfferingVersionId || bookable.priceId !== intent.serviceOfferingPriceId || bookable.holdSeconds !== intent.holdSeconds) return this.conflict(actor, 'APPOINTMENT_INTENT', intent.id);
      validateBookable(bookable, intent.requestedLocalAt, localToUtcEarlier(intent.requestedLocalAt, bookable.timezone), now);
      const used = await this.repository.activeCapacityUnits(database, intent.serviceOfferingVersionId, intent.startsAt, intent.endsAt);
      if (used + 1 > bookable.capacity) return this.conflict(actor, 'SLOT_RESERVATION', intent.id);
      const reservation: SlotReservation = { id: createIdentifier(), appointmentIntentId: intent.id, serviceOfferingVersionId: intent.serviceOfferingVersionId, provider: intent.provider, startsAt: intent.startsAt, endsAt: intent.endsAt, capacityUnits: 1, status: 'HELD', expiresAt: intent.expiresAt, releasedAt: null, expiredAt: null };
      await this.repository.createReservation(database, reservation);
      if (!await this.repository.transitionIntent(database, intent.id, 'APPOINTMENT_INTENT', 'SLOT_RESERVED', now)) return this.conflict(actor, 'APPOINTMENT_INTENT', intent.id);
      await this.repository.appendAudit(database, success('SLOT_RESERVED', actor, reservation.id));
      return reservation;
    });
  }

  public async release(accountId: string | undefined, reservationId: string): Promise<void> {
    const actor = this.requireAccount(accountId);
    await this.repository.transaction(async (database) => {
      const reservation = await this.repository.lockReservation(database, reservationId);
      const intent = reservation && await this.repository.lockIntent(database, reservation.appointmentIntentId);
      if (!reservation || !intent || intent.patientAccountId !== actor || intent.bookingActorAccountId !== actor) return this.denied(actor, 'SLOT_RESERVATION', reservationId);
      if (!await this.repository.activePatient(database, actor)) return this.denied(actor, 'PATIENT_PROFILE', actor);
      if (reservation.status !== 'HELD') return this.conflict(actor, 'SLOT_RESERVATION', reservationId);
      const now = this.now();
      if (reservation.expiresAt <= now) {
        if (!await this.repository.expireReservation(database, reservationId, now)) return this.conflict(actor, 'SLOT_RESERVATION', reservationId);
        await this.repository.transitionIntent(database, intent.id, 'SLOT_RESERVED', 'EXPIRED', now);
        await this.repository.appendAudit(database, success('SLOT_RESERVATION_EXPIRED', actor, reservationId));
      } else {
        if (!await this.repository.releaseReservation(database, reservationId, now)) return this.conflict(actor, 'SLOT_RESERVATION', reservationId);
        await this.repository.appendAudit(database, success('SLOT_RESERVATION_RELEASED', actor, reservationId));
      }
    });
  }

  /** Internal deterministic cleanup hook for a future worker; it is intentionally not an HTTP route. */
  public async expire(reservationId: string): Promise<boolean> {
    return this.repository.transaction(async (database) => {
      const reservation = await this.repository.lockReservation(database, reservationId);
      const now = this.now();
      if (!reservation || reservation.status !== 'HELD' || reservation.expiresAt > now) return false;
      const intent = await this.repository.lockIntent(database, reservation.appointmentIntentId);
      if (!intent || !await this.repository.expireReservation(database, reservation.id, now)) return false;
      await this.repository.transitionIntent(database, intent.id, 'SLOT_RESERVED', 'EXPIRED', now);
      await this.repository.appendAudit(database, success('SLOT_RESERVATION_EXPIRED', undefined, reservation.id));
      return true;
    });
  }

  private async idempotent(actor: string, requestFingerprint: string, existing: AppointmentIntent): Promise<AppointmentIntent> {
    if (existing.requestFingerprint === requestFingerprint) return existing;
    await this.audit.append({ category: 'SECURITY', eventType: 'APPOINTMENT_INTENT_IDEMPOTENCY_CONFLICT', actorAccountId: actor, targetType: 'APPOINTMENT_INTENT', targetId: existing.id, outcome: 'DENIED' });
    throw new AppointmentError('CONFLICT');
  }
  private requireAccount(accountId: string | undefined): string { if (!accountId) throw new AppointmentError('UNAUTHORIZED'); return accountId; }
  private async denied(accountId: string, targetType: string, targetId: string): Promise<never> { await this.audit.append({ category: 'AUTHORIZATION', eventType: 'APPOINTMENT_ACCESS_DENIED', actorAccountId: accountId, targetType, targetId, outcome: 'DENIED' }); throw new AppointmentError('FORBIDDEN'); }
  private async conflict(accountId: string, targetType: string, targetId: string): Promise<never> { await this.audit.append({ category: 'SECURITY', eventType: 'APPOINTMENT_OPERATION_CONFLICT', actorAccountId: accountId, targetType, targetId, outcome: 'DENIED' }); throw new AppointmentError('CONFLICT'); }
}

function validateBookable(bookable: BookableService, local: string, requestedAt: Date, now: Date) {
  if (requestedAt.getTime() < now.getTime() + bookable.bookingLeadSeconds * 1_000 || requestedAt.getTime() > now.getTime() + bookable.bookingHorizonSeconds * 1_000) throw new AppointmentError('CONFLICT');
  const startsAt = new Date(requestedAt.getTime() - bookable.bufferBeforeSeconds * 1_000); const endsAt = new Date(requestedAt.getTime() + (bookable.durationSeconds + bookable.bufferAfterSeconds) * 1_000);
  if (!available(bookable, local, startsAt, endsAt)) throw new AppointmentError('CONFLICT'); return { startsAt, endsAt };
}
function available(bookable: BookableService, local: string, startsAt: Date, endsAt: Date) {
  const weekday = localWeekday(local); const seconds = localSeconds(local); const endSeconds = seconds + bookable.durationSeconds + bookable.bufferAfterSeconds;
  const startSeconds = seconds - bookable.bufferBeforeSeconds;
  if (startSeconds < 0 || endSeconds > 86_400) return false;
  const recurring = bookable.rules.some((rule) => activeRule(rule, startsAt, weekday) && rule.windows.some((window) => window.kind === 'WORKING' && window.weekday === weekday && window.startSeconds <= startSeconds && window.endSeconds >= endSeconds));
  const oneOff = bookable.exceptions.some((item) => item.status === 'ACTIVE' && item.kind === 'ONE_OFF' && item.start <= startsAt && item.end >= endsAt);
  if (!recurring && !oneOff) return false;
  if (bookable.rules.some((rule) => activeRule(rule, startsAt, weekday) && rule.windows.some((window) => window.kind === 'BREAK' && window.weekday === weekday && window.startSeconds < endSeconds && startSeconds < window.endSeconds))) return false;
  return !bookable.exceptions.some((item) => item.status === 'ACTIVE' && ['HOLIDAY', 'LEAVE', 'BLOCKED'].includes(item.kind) && item.start < endsAt && startsAt < item.end);
}
function activeRule(rule: AvailabilityRule, at: Date, weekday: number) { return rule.effectiveFrom <= at && (!rule.effectiveTo || rule.effectiveTo > at) && rule.canonicalRecurrence.split('BYDAY=')[1]?.split(',').includes(['', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'][weekday]); }
function localWeekday(local: string) { const jsWeekday = new Date(`${local.slice(0, 10)}T00:00:00Z`).getUTCDay(); return jsWeekday === 0 ? 7 : jsWeekday; }
function localSeconds(local: string) { return Number(local.slice(11, 13)) * 3_600 + Number(local.slice(14, 16)) * 60 + Number(local.slice(17, 19)); }
function success(eventType: string, actorAccountId: string | undefined, targetId: string): AuditEventInput { return { category: 'BUSINESS', eventType, actorAccountId, targetType: 'APPOINTMENT_RESERVATION', targetId, outcome: 'SUCCESS' }; }
function requestFingerprint(input: AppointmentIntentInput) { return createHash('sha256').update(JSON.stringify({ serviceExposureId: input.serviceExposureId, requestedLocalAt: input.requestedLocalAt })).digest('base64url'); }
function sameProvider(left: ProviderInput, right: ProviderInput) { return left.kind === right.kind && (left.kind === 'DOCTOR' ? left.doctorProfileId === (right as Extract<ProviderInput, { kind: 'DOCTOR' }>).doctorProfileId : left.clinicId === (right as Extract<ProviderInput, { kind: 'CLINIC' }>).clinicId); }
