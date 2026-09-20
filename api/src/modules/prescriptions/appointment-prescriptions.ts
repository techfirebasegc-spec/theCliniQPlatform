import { createHash } from 'node:crypto';
import { createIdentifier } from '../../shared/identifiers/uuid.js';
import type { AuditEventInput } from '../audit/audit.js';
import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';

export type MedicationItem = { id: string; position: number; medicineName: string; strength: string; dosage: string; frequency: string; duration: string; route: string | null; quantity: string | null; instructions: string | null };
export type Prescription = { id: string; appointmentId: string; patientProfileId: string; doctorProfileId: string; status: 'DRAFT' | 'ISSUED'; createdByAccountId: string; createRequestFingerprint: string; createdAt: Date; updatedAt: Date; draftVersion: number; issuedAt: Date | null; issuedByAccountId: string | null; finalSnapshot: Record<string, unknown> | null; finalSnapshotHash: string | null; items: MedicationItem[] };
export type PrescriptionAccess = { appointmentId: string; status: string; patientProfileId: string; doctorProfileId: string };
export type PrescriptionItemInput = Omit<MedicationItem, 'id'>;
export type CreatePrescriptionInput = { idempotencyKey: string; items?: PrescriptionItemInput[] };
export type UpdatePrescriptionInput = { expectedDraftVersion: number; items: PrescriptionItemInput[] };

export class PrescriptionError extends Error { public constructor(public readonly code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT') { super(code); } }

export interface PrescriptionRepository {
  transaction<T>(operation: (database: PostgresExecutor) => Promise<T>): Promise<T>;
  lockAccess(database: PostgresExecutor, appointmentId: string): Promise<PrescriptionAccess | null>;
  access(appointmentId: string): Promise<PrescriptionAccess | null>;
  ownsPatient(database: PostgresExecutor, accountId: string, profileId: string): Promise<boolean>;
  ownsDoctor(database: PostgresExecutor, accountId: string, profileId: string): Promise<boolean>;
  find(database: PostgresExecutor, appointmentId: string): Promise<Prescription | null>;
  findByCreateKey(database: PostgresExecutor, accountId: string, key: string): Promise<Prescription | null>;
  findByIssueKey(database: PostgresExecutor, accountId: string, key: string): Promise<Prescription | null>;
  create(database: PostgresExecutor, value: Prescription & { createIdempotencyKey: string; createRequestFingerprint: string }): Promise<void>;
  replaceItems(database: PostgresExecutor, prescriptionId: string, items: PrescriptionItemInput[]): Promise<void>;
  updateDraft(database: PostgresExecutor, prescriptionId: string, expectedVersion: number): Promise<boolean>;
  issue(database: PostgresExecutor, value: { id: string; expectedVersion: number; issuedAt: Date; issuedByAccountId: string; issueIdempotencyKey: string; issueRequestFingerprint: string; snapshot: Record<string, unknown>; hash: string }): Promise<boolean>;
  appendAudit(database: PostgresExecutor, event: AuditEventInput): Promise<void>;
}

export class AppointmentPrescriptionService {
  public constructor(private readonly repository: PrescriptionRepository) {}

  public async create(accountId: string | undefined, appointmentId: string, input: CreatePrescriptionInput) {
    const items = normalizeItems(input.items ?? []); const fingerprint = digest({ appointmentId, items });
    try { return await this.repository.transaction(async (db) => {
      const access = await this.requireDoctor(db, accountId, appointmentId); this.requireWritable(access);
      const prior = await this.repository.findByCreateKey(db, accountId!, input.idempotencyKey);
      if (prior) { if (prior.appointmentId !== appointmentId || prior.createRequestFingerprint !== fingerprint) throw new PrescriptionError('CONFLICT'); return { prescription: prior, replayed: true }; }
      if (await this.repository.find(db, appointmentId)) throw new PrescriptionError('CONFLICT');
      const now = new Date(); const prescription: Prescription = { id: createIdentifier(), appointmentId, patientProfileId: access.patientProfileId, doctorProfileId: access.doctorProfileId, status: 'DRAFT', createdByAccountId: accountId!, createRequestFingerprint: fingerprint, createdAt: now, updatedAt: now, draftVersion: 1, issuedAt: null, issuedByAccountId: null, finalSnapshot: null, finalSnapshotHash: null, items: [] };
      await this.repository.create(db, { ...prescription, createIdempotencyKey: input.idempotencyKey, createRequestFingerprint: fingerprint }); await this.repository.replaceItems(db, prescription.id, items);
      const created = await this.repository.find(db, appointmentId); if (!created) throw new PrescriptionError('NOT_FOUND'); await this.audit(db, 'PRESCRIPTION_CREATED', accountId!, prescription.id); return { prescription: created, replayed: false };
    }); } catch (error) {
      if (!prescriptionUniqueConflict(error)) throw error;
      return this.repository.transaction(async (db) => { const prior = await this.repository.findByCreateKey(db, accountId ?? '', input.idempotencyKey); if (prior && prior.appointmentId === appointmentId && prior.createRequestFingerprint === fingerprint) return { prescription: prior, replayed: true }; throw new PrescriptionError('CONFLICT'); });
    }
  }

  public async get(accountId: string | undefined, appointmentId: string): Promise<Prescription> {
    return this.repository.transaction(async (db) => { const access = await this.requireParticipant(db, accountId, appointmentId); const prescription = await this.repository.find(db, appointmentId); if (!prescription) throw new PrescriptionError('NOT_FOUND'); const doctor = await this.repository.ownsDoctor(db, accountId!, access.doctorProfileId); if (!doctor && await this.repository.ownsPatient(db, accountId!, access.patientProfileId) && prescription.status !== 'ISSUED') { await this.audit(db, 'PRESCRIPTION_ACCESS_DENIED', accountId!, prescription.id, 'DENIED'); throw new PrescriptionError('FORBIDDEN'); } return prescription; });
  }

  public async update(accountId: string | undefined, appointmentId: string, input: UpdatePrescriptionInput): Promise<Prescription> {
    const items = normalizeItems(input.items);
    return this.repository.transaction(async (db) => { const access = await this.requireDoctor(db, accountId, appointmentId); this.requireWritable(access); const prescription = await this.repository.find(db, appointmentId); if (!prescription) throw new PrescriptionError('NOT_FOUND'); if (prescription.status !== 'DRAFT' || !(await this.repository.updateDraft(db, prescription.id, input.expectedDraftVersion))) throw new PrescriptionError('CONFLICT'); await this.repository.replaceItems(db, prescription.id, items); const updated = await this.repository.find(db, appointmentId); if (!updated) throw new PrescriptionError('NOT_FOUND'); await this.audit(db, 'PRESCRIPTION_DRAFT_UPDATED', accountId!, updated.id); return updated; });
  }

  public async issue(accountId: string | undefined, appointmentId: string, idempotencyKey: string): Promise<{ prescription: Prescription; replayed: boolean }> {
    try { return await this.repository.transaction(async (db) => { const access = await this.requireDoctor(db, accountId, appointmentId); this.requireWritable(access); const fingerprint = digest({ appointmentId }); const prior = await this.repository.findByIssueKey(db, accountId!, idempotencyKey); if (prior) { if (prior.appointmentId !== appointmentId) throw new PrescriptionError('CONFLICT'); return { prescription: prior, replayed: true }; }
      const prescription = await this.repository.find(db, appointmentId); if (!prescription) throw new PrescriptionError('NOT_FOUND'); if (prescription.status !== 'DRAFT' || prescription.items.length === 0) throw new PrescriptionError('CONFLICT'); const issuedAt = new Date(); const snapshot = snapshotOf(prescription, issuedAt, accountId!); const hash = digest(snapshot); if (!(await this.repository.issue(db, { id: prescription.id, expectedVersion: prescription.draftVersion, issuedAt, issuedByAccountId: accountId!, issueIdempotencyKey: idempotencyKey, issueRequestFingerprint: fingerprint, snapshot, hash }))) throw new PrescriptionError('CONFLICT'); const issued = await this.repository.find(db, appointmentId); if (!issued) throw new PrescriptionError('NOT_FOUND'); await this.audit(db, 'PRESCRIPTION_ISSUED', accountId!, issued.id); return { prescription: issued, replayed: false };
    }); } catch (error) {
      if (!prescriptionUniqueConflict(error)) throw error;
      return this.repository.transaction(async (db) => { const prior = await this.repository.findByIssueKey(db, accountId ?? '', idempotencyKey); if (prior && prior.appointmentId === appointmentId) return { prescription: prior, replayed: true }; throw new PrescriptionError('CONFLICT'); });
    }
  }

  private async requireParticipant(db: PostgresExecutor, accountId: string | undefined, appointmentId: string) { if (!accountId) throw new PrescriptionError('UNAUTHORIZED'); const access = await this.repository.lockAccess(db, appointmentId); if (!access || !((await this.repository.ownsPatient(db, accountId, access.patientProfileId)) || (await this.repository.ownsDoctor(db, accountId, access.doctorProfileId)))) { if (accountId) await this.audit(db, 'PRESCRIPTION_ACCESS_DENIED', accountId, appointmentId, 'DENIED'); throw new PrescriptionError('FORBIDDEN'); } return access; }
  private async requireDoctor(db: PostgresExecutor, accountId: string | undefined, appointmentId: string) { const access = await this.requireParticipant(db, accountId, appointmentId); if (!(await this.repository.ownsDoctor(db, accountId!, access.doctorProfileId))) { await this.audit(db, 'PRESCRIPTION_ACCESS_DENIED', accountId!, appointmentId, 'DENIED'); throw new PrescriptionError('FORBIDDEN'); } return access; }
  private requireWritable(access: PrescriptionAccess) { if (!['IN_PROGRESS', 'COMPLETED'].includes(access.status)) throw new PrescriptionError('CONFLICT'); }
  private audit(db: PostgresExecutor, eventType: string, actorAccountId: string, targetId: string, outcome: 'SUCCESS' | 'DENIED' = 'SUCCESS') { return this.repository.appendAudit(db, { category: outcome === 'SUCCESS' ? 'BUSINESS' : 'AUTHORIZATION', eventType, actorAccountId, targetType: 'PRESCRIPTION', targetId, outcome }); }
}

function normalizeItems(items: PrescriptionItemInput[]) { const seen = new Set<number>(); return items.map((item) => { if (!Number.isInteger(item.position) || item.position < 1 || seen.has(item.position) || !item.medicineName.trim() || !item.strength.trim() || !item.dosage.trim() || !item.frequency.trim() || !item.duration.trim()) throw new PrescriptionError('CONFLICT'); seen.add(item.position); return { ...item, route: item.route?.trim() || null, quantity: item.quantity?.trim() || null, instructions: item.instructions?.trim() || null, medicineName: item.medicineName.trim(), strength: item.strength.trim(), dosage: item.dosage.trim(), frequency: item.frequency.trim(), duration: item.duration.trim() }; }); }
function snapshotOf(prescription: Prescription, issuedAt: Date, issuedByAccountId: string) { return { appointmentId: prescription.appointmentId, doctorProfileId: prescription.doctorProfileId, issuedAt: issuedAt.toISOString(), issuedByAccountId, items: [...prescription.items].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)).map((item) => ({ ...item })), patientProfileId: prescription.patientProfileId, prescriptionId: prescription.id, schemaVersion: 1, status: 'ISSUED' }; }
function digest(value: unknown) { return createHash('sha256').update(canonical(value)).digest('hex'); }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if (value && typeof value === 'object') { const object = value as Record<string, unknown>; return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`; } return JSON.stringify(value); }
function prescriptionUniqueConflict(error: unknown) { const value = error as { code?: unknown; constraint?: unknown }; return value?.code === '23505' && typeof value.constraint === 'string' && ['prescriptions_appointment_id_key', 'prescriptions_created_by_account_id_create_idempotency_key_key', 'prescriptions_issue_idempotency_unique'].includes(value.constraint); }
