import { createHash } from 'node:crypto';
import { createIdentifier } from '../../shared/identifiers/uuid.js';
import type { AuditEventInput, AuditRepository } from '../audit/audit.js';
import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';

export type DelegatedAuthorizationInput = { delegatedClinicId: string; serviceExposureId: string; approvedStartsAt: string; approvedEndsAt: string };
export type DelegatedBookingInput = { authorizationId: string; idempotencyKey: string };
export type DelegatedAuthorization = { id: string; patientAccountId: string; delegatedClinicId: string; delegatedTenantId: string; targetDoctorProfileId: string; serviceExposureId: string; serviceOfferingId: string; approvedStartsAt: Date; approvedEndsAt: Date; expiresAt: Date; status: 'ACTIVE' | 'CONSUMED' | 'REVOKED' | 'EXPIRED' };
export type DelegatedBooking = { appointmentIntentId: string; slotReservationId: string; networkBookingContextId: string };
export class DelegatedBookingError extends Error { public constructor(public readonly code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'CONFLICT') { super(code); } }

export interface DelegatedBookingRepository {
  transaction<T>(operation: (database: PostgresExecutor) => Promise<T>): Promise<T>;
  activePatient(database: PostgresExecutor, accountId: string): Promise<{ profileId: string } | null>;
  createAuthorization(database: PostgresExecutor, value: DelegatedAuthorization & { patientProfileId: string; scopeFingerprint: string; policyVersionId: string }): Promise<void>;
  activePolicy(database: PostgresExecutor): Promise<{ id: string; expirySeconds: number } | null>;
  resolveAuthorizationScope(database: PostgresExecutor, patientAccountId: string, input: DelegatedAuthorizationInput, expiresAt: Date): Promise<DelegatedAuthorization | null>;
  lockAuthorization(database: PostgresExecutor, id: string): Promise<DelegatedAuthorization | null>;
  revokeAuthorization(database: PostgresExecutor, id: string, actorId: string, at: Date): Promise<boolean>;
  lockBookingContext(database: PostgresExecutor, authorization: DelegatedAuthorization, actorId: string): Promise<DelegatedBookingContext | null>;
  findBookingByIdempotency(actorId: string, key: string): Promise<DelegatedBooking | null>;
  createBooking(database: PostgresExecutor, value: DelegatedBookingContext & { intentId: string; reservationId: string; contextId: string; actorId: string; idempotencyKey: string; requestFingerprint: string; expiresAt: Date }): Promise<void>;
  consumeAuthorization(database: PostgresExecutor, authorizationId: string, intentId: string, actorId: string, at: Date): Promise<boolean>;
  createNetworkBookingContext(database: PostgresExecutor, value: DelegatedBookingContext & { intentId: string; contextId: string; actorId: string }): Promise<void>;
  attachContext(database: PostgresExecutor, intentId: string, contextId: string): Promise<boolean>;
  appendAudit(database: PostgresExecutor, event: AuditEventInput): Promise<void>;
}
export type DelegatedBookingContext = { authorization: DelegatedAuthorization; bookingTenantId: string; doctorProfileId: string; serviceOfferingId: string; versionId: string; priceId: string; currency: string; amountMinor: bigint; timezone: string; durationSeconds: number; bufferBeforeSeconds: number; bufferAfterSeconds: number; holdSeconds: number; capacity: number; networkConnectionId: string; networkCapabilityId: string; acceptedProposalId: string; requestedLocalAt: string };

export class DelegatedBookingService {
  public constructor(private readonly repository: DelegatedBookingRepository, private readonly audit: AuditRepository, private readonly now: () => Date = () => new Date()) {}
  public async authorize(accountId: string | undefined, input: DelegatedAuthorizationInput): Promise<DelegatedAuthorization> {
    const actor = requireAccount(accountId); const start = new Date(input.approvedStartsAt); const end = new Date(input.approvedEndsAt);
    if (!validInput(input) || !validDate(start) || !validDate(end) || end <= start) return this.conflict(actor, 'DELEGATED_BOOKING_AUTHORIZATION', input.serviceExposureId);
    return this.repository.transaction(async (db) => {
      const patient = await this.repository.activePatient(db, actor); const policy = await this.repository.activePolicy(db);
      const expiresAt = new Date(this.now().getTime() + (policy?.expirySeconds ?? 0) * 1000);
      const authorization = patient && policy && await this.repository.resolveAuthorizationScope(db, actor, input, expiresAt);
      if (!patient || !policy || !authorization) return this.denied(actor, 'DELEGATED_BOOKING_AUTHORIZATION', input.serviceExposureId);
      const value = { ...authorization, patientProfileId: patient.profileId, scopeFingerprint: fingerprint(input), policyVersionId: policy.id };
      await this.repository.createAuthorization(db, value);
      await this.repository.appendAudit(db, event('DELEGATED_BOOKING_AUTHORIZATION_CREATED', actor, value.id, value.delegatedTenantId));
      return value;
    });
  }
  public async revoke(accountId: string | undefined, authorizationId: string): Promise<void> {
    const actor = requireAccount(accountId); await this.repository.transaction(async (db) => {
      const authorization = await this.repository.lockAuthorization(db, authorizationId);
      if (!authorization || authorization.patientAccountId !== actor || authorization.status !== 'ACTIVE' || !await this.repository.activePatient(db, actor) || !await this.repository.revokeAuthorization(db, authorizationId, actor, this.now())) return this.denied(actor, 'DELEGATED_BOOKING_AUTHORIZATION', authorizationId);
      await this.repository.appendAudit(db, event('DELEGATED_BOOKING_AUTHORIZATION_REVOKED', actor, authorizationId, authorization.delegatedTenantId));
    });
  }
  public async book(accountId: string | undefined, input: DelegatedBookingInput): Promise<DelegatedBooking> {
    const actor = requireAccount(accountId); if (!input.authorizationId || !input.idempotencyKey) return this.conflict(actor, 'DELEGATED_BOOKING', input.authorizationId);
    const existing = await this.repository.findBookingByIdempotency(actor, input.idempotencyKey); if (existing) return existing;
    try { return await this.repository.transaction(async (db) => {
      const replay = await this.repository.findBookingByIdempotency(actor, input.idempotencyKey); if (replay) return replay;
      const authorization = await this.repository.lockAuthorization(db, input.authorizationId);
      if (!authorization || authorization.status !== 'ACTIVE' || authorization.expiresAt <= this.now()) return this.conflict(actor, 'DELEGATED_BOOKING_AUTHORIZATION', input.authorizationId);
      const context = await this.repository.lockBookingContext(db, authorization, actor);
      if (!context) return this.denied(actor, 'DELEGATED_BOOKING_AUTHORIZATION', input.authorizationId);
      const intentId = createIdentifier(); const reservationId = createIdentifier(); const contextId = createIdentifier(); const expiresAt = new Date(this.now().getTime() + context.holdSeconds * 1000);
      await this.repository.createBooking(db, { ...context, intentId, reservationId, contextId, actorId: actor, idempotencyKey: input.idempotencyKey, requestFingerprint: fingerprint(input), expiresAt });
      if (!await this.repository.consumeAuthorization(db, authorization.id, intentId, actor, this.now())) return this.conflict(actor, 'DELEGATED_BOOKING_AUTHORIZATION', authorization.id);
      await this.repository.createNetworkBookingContext(db, { ...context, intentId, contextId, actorId: actor });
      if (!await this.repository.attachContext(db, intentId, contextId)) return this.conflict(actor, 'DELEGATED_BOOKING', intentId);
      await this.repository.appendAudit(db, event('DELEGATED_FIXED_SLOT_BOOKED', actor, intentId, context.bookingTenantId, { authorizationId: authorization.id, reservationId, networkBookingContextId: contextId, patientAccountId: authorization.patientAccountId }));
      return { appointmentIntentId: intentId, slotReservationId: reservationId, networkBookingContextId: contextId };
    }); } catch (error) { if (error instanceof DelegatedBookingError) throw error; const replay = await this.repository.findBookingByIdempotency(actor, input.idempotencyKey); if (replay) return replay; return this.conflict(actor, 'DELEGATED_BOOKING', input.authorizationId); }
  }
  private async denied(actor: string, targetType: string, targetId: string): Promise<never> { await this.audit.append({ category: 'AUTHORIZATION', eventType: 'DELEGATED_BOOKING_ACCESS_DENIED', actorAccountId: actor, targetType, targetId, outcome: 'DENIED' }); throw new DelegatedBookingError('FORBIDDEN'); }
  private async conflict(actor: string, targetType: string, targetId: string): Promise<never> { await this.audit.append({ category: 'SECURITY', eventType: 'DELEGATED_BOOKING_CONFLICT', actorAccountId: actor, targetType, targetId, outcome: 'DENIED' }); throw new DelegatedBookingError('CONFLICT'); }
}
function requireAccount(value: string | undefined) { if (!value) throw new DelegatedBookingError('UNAUTHORIZED'); return value; }
function validDate(value: Date) { return !Number.isNaN(value.getTime()); }
function validInput(value: DelegatedAuthorizationInput) { return !!value.delegatedClinicId && !!value.serviceExposureId && !!value.approvedStartsAt && !!value.approvedEndsAt; }
function fingerprint(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('base64url'); }
function event(eventType: string, actorAccountId: string, targetId: string, tenantId?: string, metadata?: Record<string, string | number | boolean | null>): AuditEventInput { return { category: 'BUSINESS', eventType, actorAccountId, tenantId, targetType: 'DELEGATED_BOOKING_AUTHORIZATION', targetId, outcome: 'SUCCESS', metadata }; }
