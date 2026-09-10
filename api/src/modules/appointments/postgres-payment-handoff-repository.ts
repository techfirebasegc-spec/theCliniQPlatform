import type { DatabaseHealth } from '../../infrastructure/database.js';
import { createIdentifier } from '../../shared/identifiers/uuid.js';
import type { AuditEventInput } from '../audit/audit.js';
import type { CommercialRuleVersion, CommercialRuleType } from '../financial/commercial.js';
import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';
import type { AppointmentIntent, ProviderInput, SlotReservation } from './appointments.js';
import type { PaymentHandoffRepository } from './payment-handoffs.js';

export class PostgresPaymentHandoffRepository implements PaymentHandoffRepository {
  public constructor(private readonly database: DatabaseHealth) {}

  public transaction<T>(operation: (database: PostgresExecutor) => Promise<T>) { return this.database.transaction(operation); }

  public async lockIntent(database: PostgresExecutor, id: string) {
    return intent((await database.query<Record<string, unknown>>('SELECT appointment_intents.*,appointment_intents.requested_local_at::text AS requested_local_at_text FROM appointment_intents WHERE id=$1 FOR UPDATE', [id])).rows[0]);
  }

  public async lockReservationForIntent(database: PostgresExecutor, intentId: string) {
    return reservation((await database.query<Record<string, unknown>>('SELECT * FROM slot_reservations WHERE appointment_intent_id=$1 FOR UPDATE', [intentId])).rows[0]);
  }

  public async lockHandoff(database: PostgresExecutor, intentId: string) {
    const row = (await database.query<Record<string, unknown>>(`
      SELECT handoff.id,handoff.appointment_intent_id,handoff.slot_reservation_id,handoff.financial_allocation_snapshot_id,
        handoff.payment_intent_id,handoff.booking_actor_account_id,handoff.idempotency_key,handoff.request_fingerprint,
        allocation.currency,allocation.gross_amount_minor
      FROM appointment_financial_handoffs handoff
      JOIN financial_allocation_snapshots allocation ON allocation.id=handoff.financial_allocation_snapshot_id
      WHERE handoff.appointment_intent_id=$1
      FOR UPDATE OF handoff
    `, [intentId])).rows[0];
    return row ? {
      id: String(row.id), appointmentIntentId: String(row.appointment_intent_id), slotReservationId: String(row.slot_reservation_id),
      financialAllocationSnapshotId: String(row.financial_allocation_snapshot_id), paymentIntentId: String(row.payment_intent_id),
      bookingActorAccountId: String(row.booking_actor_account_id), idempotencyKey: String(row.idempotency_key), requestFingerprint: String(row.request_fingerprint),
      currency: String(row.currency), amountMinor: BigInt(String(row.gross_amount_minor)), state: 'PAYMENT_PENDING' as const,
    } : null;
  }

  public async activePatient(database: PostgresExecutor, accountId: string) {
    return (await database.query('SELECT 1 FROM patient_profiles WHERE account_id=$1 AND status=\'ACTIVE\'', [accountId])).rowCount === 1;
  }

  public async revalidateDirectBooking(database: PostgresExecutor, value: AppointmentIntent) {
    if (!value.serviceExposureId) return false;
    const result = await database.query(`
      SELECT 1
      FROM service_exposures exposure
      JOIN service_offerings offering ON offering.id=exposure.service_offering_id
      JOIN service_offering_versions version ON version.id=$2 AND version.service_offering_id=offering.id
      JOIN service_offering_prices price ON price.id=$3 AND price.service_offering_version_id=version.id
      WHERE exposure.id=$1 AND exposure.status='PUBLISHED' AND offering.status='ACTIVE' AND version.status='ACTIVE'
        AND exposure.service_offering_id=$4
        AND exposure.provider_doctor_profile_id IS NOT DISTINCT FROM $5::uuid
        AND exposure.provider_clinic_id IS NOT DISTINCT FROM $6::uuid
        AND offering.owner_doctor_profile_id IS NOT DISTINCT FROM $5::uuid
        AND offering.owner_clinic_id IS NOT DISTINCT FROM $6::uuid
        AND price.currency=$7 AND price.amount_minor=$8
      FOR UPDATE OF exposure,offering,version,price
    `, [value.serviceExposureId, value.serviceOfferingVersionId, value.serviceOfferingPriceId, value.serviceOfferingId, value.provider.kind === 'DOCTOR' ? value.provider.doctorProfileId : null, value.provider.kind === 'CLINIC' ? value.provider.clinicId : null, value.currency, value.priceAmountMinor.toString()]);
    return result.rowCount === 1;
  }

  public async reservationIsCurrent(database: PostgresExecutor, reservationId: string) {
    return (await database.query('SELECT 1 FROM slot_reservations WHERE id=$1 AND status=\'HELD\' AND expires_at > clock_timestamp()', [reservationId])).rowCount === 1;
  }

  public async expireReservation(database: PostgresExecutor, reservationId: string) {
    const result = await database.query("UPDATE slot_reservations SET status='EXPIRED',expired_at=clock_timestamp() WHERE id=$1 AND status='HELD' AND expires_at <= clock_timestamp()", [reservationId]);
    return result.rowCount === 1;
  }

  public async transitionIntent(database: PostgresExecutor, id: string, from: AppointmentIntent['state'], to: AppointmentIntent['state']) {
    const expiration = to === 'EXPIRED' ? ',expired_at=clock_timestamp()' : '';
    return (await database.query(`UPDATE appointment_intents SET state=$3${expiration} WHERE id=$1 AND state=$2`, [id, from, to])).rowCount === 1;
  }

  public async selectCommercialRules(database: PostgresExecutor) {
    const now = (await database.query<{ now: Date }>('SELECT clock_timestamp() AS now', [])).rows[0]?.now;
    if (!now) throw new Error('Unable to select commercial-rule time.');
    const versions = await database.query<Record<string, unknown>>(`
      SELECT rule.id AS rule_id,version.id AS version_id,rule.rule_type,version.priority,version.effective_from,
        version.effective_until,version.policy_data
      FROM commercial_rules rule
      JOIN commercial_rule_versions version ON version.commercial_rule_id=rule.id
      WHERE rule.status='ACTIVE' AND version.status='APPROVED'
        AND version.effective_from <= $1
        AND (version.effective_until IS NULL OR version.effective_until > $1)
      ORDER BY rule.id,version.id
      FOR UPDATE OF rule,version
    `, [now]);
    const versionIds = versions.rows.map((row) => String(row.version_id));
    const scopes = versionIds.length === 0 ? [] : (await database.query<Record<string, unknown>>(`
      SELECT id,commercial_rule_version_id,scope_kind,scope_reference_id,scope_value
      FROM commercial_rule_scopes
      WHERE commercial_rule_version_id = ANY($1::uuid[])
      ORDER BY commercial_rule_version_id,id
      FOR UPDATE
    `, [versionIds])).rows;
    const scopesByVersion = new Map<string, { kind: string; value?: string }[]>();
    for (const scope of scopes) {
      const id = String(scope.commercial_rule_version_id);
      const values = scopesByVersion.get(id) ?? [];
      values.push({ kind: String(scope.scope_kind), value: scope.scope_reference_id ? String(scope.scope_reference_id) : scope.scope_value ? String(scope.scope_value) : undefined });
      scopesByVersion.set(id, values);
    }
    await database.query(`
      SELECT id FROM refund_policy_versions
      WHERE status='APPROVED' AND effective_from <= $1
        AND (effective_until IS NULL OR effective_until > $1)
      ORDER BY id FOR UPDATE
    `, [now]);
    await database.query(`
      SELECT id FROM settlement_policy_versions
      WHERE status='APPROVED' AND effective_from <= $1
        AND (effective_until IS NULL OR effective_until > $1)
      ORDER BY id FOR UPDATE
    `, [now]);
    return { at: new Date(now), rules: versions.rows.map((row) => rule(row, scopesByVersion.get(String(row.version_id)) ?? [])) };
  }

  public async createAllocation(database: PostgresExecutor, value: { id: string; intent: AppointmentIntent; reservation: SlotReservation; actorAccountId: string; grossAmountMinor: bigint; currency: string; platformCommissionMinor: bigint; providerPayableMinor: bigint; selectedRuleVersionId: string; calculationBasis: string }) {
    const input = bookingInput(value.intent, value.reservation);
    await database.query(`INSERT INTO financial_allocation_snapshots
      (id,status,currency,gross_amount_minor,calculation_basis,input_data,selected_rule_versions,created_by_account_id)
      VALUES ($1,'FINAL',$2,$3,$4,$5::jsonb,jsonb_build_array($6::text),$7)`, [value.id, value.currency, value.grossAmountMinor.toString(), value.calculationBasis, JSON.stringify(input), value.selectedRuleVersionId, value.actorAccountId]);
    await database.query(`INSERT INTO financial_allocation_components
      (id,allocation_snapshot_id,component_type,amount_minor,currency,rule_version_id)
      VALUES ($1,$2,'GROSS',$3,$4,NULL),($5,$2,'PLATFORM_COMMISSION',$6,$4,$7),($8,$2,'PROVIDER_PAYABLE',$9,$4,$7)`, [createIdentifier(), value.id, value.grossAmountMinor.toString(), value.currency, createIdentifier(), value.platformCommissionMinor.toString(), value.selectedRuleVersionId, createIdentifier(), value.providerPayableMinor.toString()]);
  }

  public async createPaymentIntent(database: PostgresExecutor, value: { id: string; providerKey: string; idempotencyKey: string; allocationSnapshotId: string; currency: string; amountMinor: bigint; actorAccountId: string }) {
    await database.query(`INSERT INTO payment_intents
      (id,provider_key,status,currency,amount_minor,allocation_snapshot_id,idempotency_key,created_by_account_id)
      VALUES ($1,$2,'CREATED',$3,$4,$5,$6,$7)`, [value.id, value.providerKey, value.currency, value.amountMinor.toString(), value.allocationSnapshotId, value.idempotencyKey, value.actorAccountId]);
  }

  public async createHandoff(database: PostgresExecutor, value: { id: string; intentId: string; reservationId: string; allocationSnapshotId: string; paymentIntentId: string; actorAccountId: string; idempotencyKey: string; requestFingerprint: string }) {
    await database.query(`INSERT INTO appointment_financial_handoffs
      (id,appointment_intent_id,slot_reservation_id,financial_allocation_snapshot_id,payment_intent_id,booking_actor_account_id,idempotency_key,request_fingerprint)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [value.id, value.intentId, value.reservationId, value.allocationSnapshotId, value.paymentIntentId, value.actorAccountId, value.idempotencyKey, value.requestFingerprint]);
  }

  public async appendAudit(database: PostgresExecutor, event: AuditEventInput) {
    await database.query('INSERT INTO audit_events (id,category,event_type,actor_account_id,tenant_id,target_type,target_id,outcome,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [createIdentifier(), event.category, event.eventType, event.actorAccountId ?? null, event.tenantId ?? null, event.targetType, event.targetId ?? null, event.outcome, event.metadata ?? {}]);
  }
}

function rule(row: Record<string, unknown>, scopes: { kind: string; value?: string }[]): CommercialRuleVersion {
  const policy = object(row.policy_data);
  return {
    id: String(row.version_id), ruleType: row.rule_type as CommercialRuleType, priority: Number(row.priority), effectiveFrom: new Date(String(row.effective_from)), effectiveUntil: row.effective_until ? new Date(String(row.effective_until)) : undefined,
    scopes: scopes.map((scope) => ({ kind: scope.kind as CommercialRuleVersion['scopes'][number]['kind'], value: scope.value })),
    policy: { fixedAmountMinor: integer(policy.fixedAmountMinor), percentageBasisPoints: integer(policy.percentageBasisPoints), tiers: Array.isArray(policy.tiers) ? policy.tiers.map((tier) => { const item = object(tier); return { upToMinor: requiredInteger(item.upToMinor), fixedAmountMinor: integer(item.fixedAmountMinor), percentageBasisPoints: integer(item.percentageBasisPoints) }; }) : undefined },
  };
}

function object(value: unknown): Record<string, unknown> { if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>; throw new Error('Invalid commercial rule policy.'); }
function integer(value: unknown): bigint | undefined { return value === undefined || value === null ? undefined : requiredInteger(value); }
function requiredInteger(value: unknown): bigint { if ((typeof value !== 'string' && typeof value !== 'number') || !/^-?\d+$/.test(String(value))) throw new Error('Invalid commercial rule policy.'); return BigInt(value); }
function bookingInput(intent: AppointmentIntent, reservation: SlotReservation) {
  return {
    appointmentIntentId: intent.id, slotReservationId: reservation.id, serviceExposureId: intent.serviceExposureId,
    serviceOfferingId: intent.serviceOfferingId, serviceOfferingVersionId: intent.serviceOfferingVersionId, serviceOfferingPriceId: intent.serviceOfferingPriceId,
    patientAccountId: intent.patientAccountId, bookingActorAccountId: intent.bookingActorAccountId, bookingTenantId: intent.bookingTenantId,
    providerDoctorProfileId: intent.provider.kind === 'DOCTOR' ? intent.provider.doctorProfileId : null,
    providerClinicId: intent.provider.kind === 'CLINIC' ? intent.provider.clinicId : null,
    bookingRelationship: intent.bookingRelationship, currency: intent.currency, grossAmountMinor: intent.priceAmountMinor.toString(),
    requestedLocalAt: intent.requestedLocalAt, startsAt: intent.startsAt.toISOString(), endsAt: intent.endsAt.toISOString(), expiresAt: reservation.expiresAt.toISOString(),
  };
}

function intent(row: Record<string, unknown> | undefined): AppointmentIntent | null {
  if (!row) return null;
  return { id: String(row.id), patientAccountId: String(row.patient_account_id), bookingActorAccountId: String(row.booking_actor_account_id), bookingTenantId: row.booking_tenant_id ? String(row.booking_tenant_id) : null, serviceExposureId: row.service_exposure_id ? String(row.service_exposure_id) : null, provider: provider(row), serviceOfferingId: String(row.service_offering_id), serviceOfferingVersionId: String(row.service_offering_version_id), serviceOfferingPriceId: String(row.service_offering_price_id), currency: String(row.currency), priceAmountMinor: BigInt(String(row.price_amount_minor)), providerTimezone: String(row.provider_timezone), requestedLocalAt: formatLocal(row.requested_local_at_text ?? row.requested_local_at), startsAt: new Date(String(row.starts_at)), endsAt: new Date(String(row.ends_at)), serviceDurationSeconds: Number(row.service_duration_seconds), bufferBeforeSeconds: Number(row.buffer_before_seconds), bufferAfterSeconds: Number(row.buffer_after_seconds), holdSeconds: Number(row.hold_seconds), bookingRelationship: String(row.booking_relationship) as AppointmentIntent['bookingRelationship'], state: row.state as AppointmentIntent['state'], idempotencyKey: String(row.idempotency_key), requestFingerprint: String(row.request_fingerprint), expiresAt: new Date(String(row.expires_at)) };
}

function reservation(row: Record<string, unknown> | undefined): SlotReservation | null {
  if (!row) return null;
  return { id: String(row.id), appointmentIntentId: String(row.appointment_intent_id), serviceOfferingVersionId: String(row.service_offering_version_id), provider: provider(row), startsAt: new Date(String(row.starts_at)), endsAt: new Date(String(row.ends_at)), capacityUnits: Number(row.capacity_units), status: row.status as SlotReservation['status'], expiresAt: new Date(String(row.expires_at)), releasedAt: row.released_at ? new Date(String(row.released_at)) : null, expiredAt: row.expired_at ? new Date(String(row.expired_at)) : null };
}

function provider(row: Record<string, unknown>): ProviderInput { return row.provider_doctor_profile_id ? { kind: 'DOCTOR', doctorProfileId: String(row.provider_doctor_profile_id) } : { kind: 'CLINIC', clinicId: String(row.provider_clinic_id) }; }
function formatLocal(value: unknown) { return String(value).replace(' ', 'T').replace(/\.\d+$/, '').slice(0, 19); }
