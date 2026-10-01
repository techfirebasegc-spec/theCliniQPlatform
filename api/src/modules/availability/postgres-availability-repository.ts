import type { DatabaseHealth } from '../../infrastructure/database.js';
import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';
import { canonicalizeWeeklyRecurrence } from './recurrence.js';
import type { AvailabilityConfiguration, AvailabilityOwner, AvailabilityRepository } from './availability.js';

export class PostgresAvailabilityRepository implements AvailabilityRepository {
  public constructor(private readonly database: DatabaseHealth) {}
  public async transaction<T>(operation: (database: PostgresExecutor) => Promise<T>): Promise<T> { return this.database.transaction(operation); }
  public async findVersionOwnerForDoctor(versionId: string, accountId: string): Promise<AvailabilityOwner | null> { const result = await this.database.query('SELECT 1 FROM service_offering_versions version JOIN service_offerings offering ON offering.id=version.service_offering_id JOIN doctor_profiles doctor ON doctor.id=offering.owner_doctor_profile_id WHERE version.id=$1 AND doctor.account_id=$2', [versionId, accountId]); return result.rows[0] ? { kind: 'DOCTOR' } : null; }
  public async findVersionOwner(versionId: string): Promise<AvailabilityOwner | null> {
    const result = await this.database.query('SELECT clinic.tenant_id, doctor.id AS doctor_profile_id FROM service_offering_versions version JOIN service_offerings offering ON offering.id=version.service_offering_id LEFT JOIN clinics clinic ON clinic.id=offering.owner_clinic_id LEFT JOIN doctor_profiles doctor ON doctor.id=offering.owner_doctor_profile_id WHERE version.id=$1', [versionId]);
    const row = result.rows[0] as { tenant_id: unknown; doctor_profile_id: unknown } | undefined;
    if (!row) return null;
    if (row.doctor_profile_id) return { kind: 'DOCTOR' };
    return row.tenant_id ? { kind: 'CLINIC', tenantId: String(row.tenant_id) } : null;
  }
  public async create(database: PostgresExecutor, value: AvailabilityConfiguration, actor: string): Promise<void> {
    await database.query('SELECT id FROM service_offering_versions WHERE id=$1 FOR UPDATE', [value.serviceOfferingVersionId]);
    await database.query('INSERT INTO availability_configurations (id,service_offering_version_id,provider_timezone,slot_duration_seconds,buffer_before_seconds,buffer_after_seconds,capacity,booking_lead_time_seconds,booking_horizon_seconds,status,created_by_account_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [value.id, value.serviceOfferingVersionId, value.providerTimezone, value.slotDurationSeconds, value.bufferBeforeSeconds, value.bufferAfterSeconds, value.capacity, value.bookingLeadTimeSeconds, value.bookingHorizonSeconds, value.status, actor]);
    for (const rule of value.rules) { const canonical = canonicalizeWeeklyRecurrence(rule.recurrence); const ruleId = crypto.randomUUID(); await database.query('INSERT INTO availability_rules (id,availability_configuration_id,canonical_recurrence,recurrence_identity,effective_from,effective_to,status,created_by_account_id) VALUES ($1,$2,$3,$3,$4,$5,$6,$7)', [ruleId, value.id, canonical.canonical, rule.effectiveFrom, rule.effectiveTo ?? null, 'ACTIVE', actor]); for (const window of [...rule.windows.filter((item) => item.kind === 'WORKING'), ...rule.windows.filter((item) => item.kind === 'BREAK')]) await database.query('INSERT INTO availability_windows (id,availability_rule_id,kind,weekday,start_seconds,end_seconds,created_by_account_id) VALUES ($1,$2,$3,$4,$5,$6,$7)', [crypto.randomUUID(), ruleId, window.kind, window.weekday, window.startSeconds, window.endSeconds, actor]); }
    for (const item of value.exceptions) await database.query('INSERT INTO availability_exceptions (id,availability_configuration_id,kind,local_start,local_end,derived_start_utc,derived_end_utc,status,created_by_account_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [crypto.randomUUID(), value.id, item.kind, item.localStart, item.localEnd, item.derivedStartUtc, item.derivedEndUtc, 'ACTIVE', actor]);
  }
  public async findManaged(versionId: string): Promise<AvailabilityConfiguration | null> {
    const result = await this.database.query('SELECT id, service_offering_version_id, provider_timezone, slot_duration_seconds, buffer_before_seconds, buffer_after_seconds, capacity, booking_lead_time_seconds, booking_horizon_seconds, status FROM availability_configurations WHERE service_offering_version_id=$1', [versionId]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const rules = await this.database.query<Record<string, unknown>>('SELECT rule.id, rule.canonical_recurrence, rule.effective_from, rule.effective_to, aw.kind, aw.weekday, aw.start_seconds, aw.end_seconds FROM availability_rules rule JOIN availability_windows aw ON aw.availability_rule_id=rule.id WHERE rule.availability_configuration_id=$1 AND rule.status=\'ACTIVE\' ORDER BY rule.effective_from, rule.id, aw.kind, aw.weekday, aw.start_seconds', [row.id]);
    const values = new Map<string, AvailabilityConfiguration['rules'][number]>();
    for (const item of rules.rows) {
      const id = String(item.id);
      const rule = values.get(id) ?? { recurrence: String(item.canonical_recurrence), effectiveFrom: new Date(String(item.effective_from)), effectiveTo: item.effective_to ? new Date(String(item.effective_to)) : null, windows: [] };
      rule.windows.push({ kind: item.kind as 'WORKING' | 'BREAK', weekday: Number(item.weekday), startSeconds: Number(item.start_seconds), endSeconds: Number(item.end_seconds) });
      values.set(id, rule);
    }
    return { id: String(row.id), serviceOfferingVersionId: String(row.service_offering_version_id), providerTimezone: String(row.provider_timezone), slotDurationSeconds: Number(row.slot_duration_seconds), bufferBeforeSeconds: Number(row.buffer_before_seconds), bufferAfterSeconds: Number(row.buffer_after_seconds), capacity: Number(row.capacity), bookingLeadTimeSeconds: Number(row.booking_lead_time_seconds), bookingHorizonSeconds: Number(row.booking_horizon_seconds), status: row.status as 'ACTIVE' | 'INACTIVE', rules: [...values.values()], exceptions: [] };
  }
}
