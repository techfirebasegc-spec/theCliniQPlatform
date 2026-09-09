import { createIdentifier } from '../../shared/identifiers/uuid.js';
import type { AuditRepository } from '../audit/audit.js';
import type { TenantContextService } from '../memberships/memberships.js';
import type { PostgresExecutor } from '../sessions/postgres-session-repository.js';
import { canonicalizeWeeklyRecurrence, RecurrenceError } from './recurrence.js';
import { localToUtcEarlier, TimezoneError, validateIanaTimezone } from './timezone.js';

export type WindowInput = { kind: 'WORKING' | 'BREAK'; weekday: number; startSeconds: number; endSeconds: number };
export type RuleInput = { recurrence: string; effectiveFrom: Date; effectiveTo?: Date | null; windows: WindowInput[] };
export type ExceptionInput = { kind: 'HOLIDAY' | 'LEAVE' | 'BLOCKED' | 'ONE_OFF'; localStart: string; localEnd: string };
export type AvailabilityInput = { providerTimezone: string; slotDurationSeconds: number; bufferBeforeSeconds: number; bufferAfterSeconds: number; capacity: number; bookingLeadTimeSeconds: number; bookingHorizonSeconds: number; rules: RuleInput[]; exceptions?: ExceptionInput[] };
export type AvailabilityConfiguration = AvailabilityInput & { id: string; serviceOfferingVersionId: string; status: 'ACTIVE' | 'INACTIVE'; exceptions: (ExceptionInput & { derivedStartUtc: Date; derivedEndUtc: Date })[] };
export type AvailabilityOwner = { kind: 'DOCTOR' } | { kind: 'CLINIC'; tenantId: string };

export class AvailabilityError extends Error { public constructor(public readonly code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'CONFLICT') { super(code === 'UNAUTHORIZED' ? 'Authentication is required.' : code === 'CONFLICT' ? 'The availability configuration is invalid.' : 'Availability access is not permitted.'); } }
export interface AvailabilityRepository {
  transaction<T>(operation: (database: PostgresExecutor) => Promise<T>): Promise<T>;
  findVersionOwnerForDoctor(versionId: string, accountId: string): Promise<AvailabilityOwner | null>;
  findVersionOwner(versionId: string): Promise<AvailabilityOwner | null>;
  create(database: PostgresExecutor, configuration: AvailabilityConfiguration, actorAccountId: string): Promise<void>;
  findManaged(versionId: string): Promise<AvailabilityConfiguration | null>;
}

export class AvailabilityService {
  public constructor(private readonly repository: AvailabilityRepository, private readonly context: Pick<TenantContextService, 'require'>, private readonly audit: AuditRepository) {}
  public async create(accountId: string | undefined, versionId: string, input: AvailabilityInput): Promise<AvailabilityConfiguration> {
    const actor = this.requireAccount(accountId); const owner = await this.authorize(actor, versionId); let value: AvailabilityConfiguration;
    try { value = normalize(versionId, input); await this.repository.transaction((database) => this.repository.create(database, value, actor)); }
    catch (error) { return this.failed(actor, versionId, owner.kind === 'CLINIC' ? owner.tenantId : undefined, error); }
    await this.audit.append({ category: 'BUSINESS', eventType: 'AVAILABILITY_CONFIGURATION_CREATED', actorAccountId: actor, tenantId: owner.kind === 'CLINIC' ? owner.tenantId : undefined, targetType: 'AVAILABILITY_CONFIGURATION', targetId: value.id, outcome: 'SUCCESS' });
    return value;
  }
  public async read(accountId: string | undefined, versionId: string): Promise<AvailabilityConfiguration> { const actor = this.requireAccount(accountId); await this.authorize(actor, versionId); const result = await this.repository.findManaged(versionId); if (!result) return this.denied(actor, versionId); return result; }
  private async authorize(accountId: string, versionId: string): Promise<AvailabilityOwner> { const doctor = await this.repository.findVersionOwnerForDoctor(versionId, accountId); if (doctor) return doctor; const owner = await this.repository.findVersionOwner(versionId); if (!owner || owner.kind !== 'CLINIC') return this.denied(accountId, versionId); try { await this.context.require(accountId, owner.tenantId, 'clinic.manage'); return owner; } catch { return this.denied(accountId, versionId, owner.tenantId); } }
  private requireAccount(accountId: string | undefined): string { if (!accountId) throw new AvailabilityError('UNAUTHORIZED'); return accountId; }
  private async denied(accountId: string, targetId: string, tenantId?: string): Promise<never> { await this.audit.append({ category: 'AUTHORIZATION', eventType: 'AVAILABILITY_ACCESS_DENIED', actorAccountId: accountId, tenantId, targetType: 'SERVICE_OFFERING_VERSION', targetId, outcome: 'DENIED' }); throw new AvailabilityError('FORBIDDEN'); }
  private async failed(accountId: string, targetId: string, tenantId: string | undefined, error: unknown): Promise<never> { if (error instanceof AvailabilityError) throw error; const code = error instanceof RecurrenceError || error instanceof TimezoneError || constraint(error) ? 'CONFLICT' : 'FORBIDDEN'; await this.audit.append({ category: 'SECURITY', eventType: 'AVAILABILITY_CONFIGURATION_REJECTED', actorAccountId: accountId, tenantId, targetType: 'SERVICE_OFFERING_VERSION', targetId, outcome: 'DENIED' }); throw new AvailabilityError(code); }
}

function normalize(versionId: string, input: AvailabilityInput): AvailabilityConfiguration {
  validateIanaTimezone(input.providerTimezone); if (!integers(input.slotDurationSeconds, input.bufferBeforeSeconds, input.bufferAfterSeconds, input.capacity, input.bookingLeadTimeSeconds, input.bookingHorizonSeconds) || input.slotDurationSeconds <= 0 || input.bufferBeforeSeconds < 0 || input.bufferAfterSeconds < 0 || input.capacity <= 0 || input.bookingLeadTimeSeconds < 0 || input.bookingHorizonSeconds <= input.bookingLeadTimeSeconds) throw new AvailabilityError('CONFLICT');
  if (!input.rules.length) throw new AvailabilityError('CONFLICT'); const exceptions = (input.exceptions ?? []).map((item) => ({ ...item, derivedStartUtc: localToUtcEarlier(item.localStart, input.providerTimezone), derivedEndUtc: localToUtcEarlier(item.localEnd, input.providerTimezone) }));
  for (const item of exceptions) if (item.derivedEndUtc <= item.derivedStartUtc || (item.kind === 'ONE_OFF' && item.derivedStartUtc <= new Date())) throw new AvailabilityError('CONFLICT');
  for (const rule of input.rules) { canonicalizeWeeklyRecurrence(rule.recurrence); if (!(rule.effectiveFrom instanceof Date) || Number.isNaN(rule.effectiveFrom.getTime()) || (rule.effectiveTo && rule.effectiveTo <= rule.effectiveFrom)) throw new AvailabilityError('CONFLICT'); validateWindows(rule.windows); }
  conflictExceptions(exceptions);
  return { ...input, id: createIdentifier(), serviceOfferingVersionId: versionId, status: 'ACTIVE', exceptions };
}
function integers(...values: number[]) { return values.every(Number.isInteger); }
function validateWindows(windows: WindowInput[]) { if (!windows.length) throw new AvailabilityError('CONFLICT'); for (const window of windows) if (!Number.isInteger(window.weekday) || window.weekday < 1 || window.weekday > 7 || !Number.isInteger(window.startSeconds) || !Number.isInteger(window.endSeconds) || window.startSeconds < 0 || window.endSeconds > 86400 || window.startSeconds >= window.endSeconds) throw new AvailabilityError('CONFLICT'); for (const kind of ['WORKING', 'BREAK'] as const) { const selected = windows.filter((window) => window.kind === kind).sort((a, b) => a.weekday - b.weekday || a.startSeconds - b.startSeconds); for (let index = 1; index < selected.length; index += 1) if (selected[index - 1].weekday === selected[index].weekday && selected[index - 1].endSeconds > selected[index].startSeconds) throw new AvailabilityError('CONFLICT'); } for (const item of windows.filter((window) => window.kind === 'BREAK')) if (!windows.some((window) => window.kind === 'WORKING' && window.weekday === item.weekday && window.startSeconds <= item.startSeconds && window.endSeconds >= item.endSeconds)) throw new AvailabilityError('CONFLICT'); }
function conflictExceptions(items: AvailabilityConfiguration['exceptions']) { for (let left = 0; left < items.length; left += 1) for (let right = left + 1; right < items.length; right += 1) if (items[left].kind === items[right].kind && items[left].derivedStartUtc < items[right].derivedEndUtc && items[right].derivedStartUtc < items[left].derivedEndUtc) throw new AvailabilityError('CONFLICT'); }
function constraint(error: unknown): error is { code: string } { return typeof error === 'object' && error !== null && 'code' in error && ['23505', '23514', '23P01', '23503', 'P0001'].includes(String((error as { code: unknown }).code)); }
