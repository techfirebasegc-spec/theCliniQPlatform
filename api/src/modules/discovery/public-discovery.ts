import { localToUtcEarlier } from '../availability/timezone.js';
import type { AvailabilityException, AvailabilityRule, BookableService } from '../appointments/appointments.js';

export type PublicDoctor = { id: string; displayName: string | null };
export type PublicService = { id: string; doctorProfileId: string; name: string; description: string | null; currency: string; amountMinor: string };
export type PublicAvailability = { date: string; timezone: string; slots: { localStart: string; startsAt: Date; endsAt: Date; remainingCapacity: number }[] };

export class PublicDiscoveryError extends Error {
  public constructor(public readonly code: 'NOT_FOUND' | 'CONFLICT') { super(code === 'NOT_FOUND' ? 'The requested public resource was not found.' : 'The public discovery request is invalid.'); }
}

export interface PublicDiscoveryRepository {
  listDoctors(query: string | undefined): Promise<PublicDoctor[]>;
  findDoctor(doctorProfileId: string): Promise<PublicDoctor | null>;
  listServices(filter: { doctorProfileId?: string; query?: string }): Promise<PublicService[]>;
  findCandidateServices(exposureId: string): Promise<BookableService[]>;
  findBookableService(exposureId: string, requestedLocalAt: string): Promise<BookableService | null>;
  activeCapacityUnits(versionId: string, startsAt: Date, endsAt: Date): Promise<number>;
}

/** Read-only public projection. Booking remains the sole reservation authority. */
export class PublicDiscoveryService {
  public constructor(private readonly repository: PublicDiscoveryRepository, private readonly now: () => Date = () => new Date()) {}

  public doctors(query?: string): Promise<PublicDoctor[]> { return this.repository.listDoctors(normalizeQuery(query)); }
  public async doctor(doctorProfileId: string): Promise<{ doctor: PublicDoctor; services: PublicService[] }> {
    const doctor = await this.repository.findDoctor(requiredId(doctorProfileId));
    if (!doctor) throw new PublicDiscoveryError('NOT_FOUND');
    return { doctor, services: await this.repository.listServices({ doctorProfileId: doctor.id }) };
  }
  public services(filter: { doctorProfileId?: string; query?: string }): Promise<PublicService[]> {
    return this.repository.listServices({ doctorProfileId: filter.doctorProfileId ? requiredId(filter.doctorProfileId) : undefined, query: normalizeQuery(filter.query) });
  }
  public async availability(exposureId: string, date: string): Promise<PublicAvailability> {
    validateDate(date); const id = requiredId(exposureId); const candidates = await this.repository.findCandidateServices(id);
    if (!candidates.length) throw new PublicDiscoveryError('NOT_FOUND');
    const slots = await availableSlots(id, candidates, date, this.repository, this.now());
    return { date, timezone: candidates[0].timezone, slots };
  }
}

function requiredId(value: string): string { if (typeof value !== 'string' || value.trim().length === 0) throw new PublicDiscoveryError('NOT_FOUND'); return value; }
function normalizeQuery(value: string | undefined): string | undefined { if (value === undefined) return undefined; const normalized = value.trim(); if (normalized.length > 100) throw new PublicDiscoveryError('CONFLICT'); return normalized || undefined; }
function validateDate(value: string): void { if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(new Date(`${value}T00:00:00Z`).getTime()) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new PublicDiscoveryError('CONFLICT'); }

async function availableSlots(exposureId: string, services: BookableService[], date: string, repository: PublicDiscoveryRepository, now: Date): Promise<PublicAvailability['slots']> {
  const slots: PublicAvailability['slots'] = [];
  const candidates = new Set(services.flatMap((service) => candidateStarts(service, date)));
  for (const localStart of [...candidates].sort()) {
    const service = await repository.findBookableService(exposureId, localStart);
    if (!service) continue;
    let requestedAt: Date;
    try { requestedAt = localToUtcEarlier(localStart, service.timezone); } catch { continue; }
    if (requestedAt.getTime() < now.getTime() + service.bookingLeadSeconds * 1_000 || requestedAt.getTime() > now.getTime() + service.bookingHorizonSeconds * 1_000) continue;
    const startsAt = new Date(requestedAt.getTime() - service.bufferBeforeSeconds * 1_000);
    const endsAt = new Date(requestedAt.getTime() + (service.durationSeconds + service.bufferAfterSeconds) * 1_000);
    if (!bookable(service, localStart, startsAt, endsAt)) continue;
    const remainingCapacity = service.capacity - await repository.activeCapacityUnits(service.versionId, startsAt, endsAt);
    if (remainingCapacity > 0) slots.push({ localStart, startsAt, endsAt, remainingCapacity });
  }
  return slots;
}

function candidateStarts(service: BookableService, date: string): string[] {
  const starts = new Set<string>(); const weekday = localWeekday(`${date}T00:00:00`);
  for (const rule of service.rules) for (const window of rule.windows) {
    if (window.kind !== 'WORKING' || window.weekday !== weekday) continue;
    for (let second = window.startSeconds; second + service.durationSeconds + service.bufferAfterSeconds <= window.endSeconds; second += service.slotDurationSeconds) {
      const candidate = local(date, second); let at: Date; try { at = localToUtcEarlier(candidate, service.timezone); } catch { continue; }
      if (activeRule(rule, at, weekday)) starts.add(candidate);
    }
  }
  for (const exception of service.exceptions) {
    if (exception.kind !== 'ONE_OFF' || exception.status !== 'ACTIVE') continue;
    const range = localRange(exception, service.timezone); if (!range || range.date !== date) continue;
    for (let second = range.startSeconds; second + service.durationSeconds + service.bufferAfterSeconds <= range.endSeconds; second += service.slotDurationSeconds) starts.add(local(date, second));
  }
  return [...starts];
}

function bookable(service: BookableService, localStart: string, startsAt: Date, endsAt: Date): boolean {
  const weekday = localWeekday(localStart); const seconds = localSeconds(localStart);
  const startSeconds = seconds - service.bufferBeforeSeconds; const endSeconds = seconds + service.durationSeconds + service.bufferAfterSeconds;
  const recurring = service.rules.some((rule) => activeRule(rule, startsAt, weekday) && rule.windows.some((window) => window.kind === 'WORKING' && window.weekday === weekday && window.startSeconds <= startSeconds && window.endSeconds >= endSeconds));
  const oneOff = service.exceptions.some((item) => item.status === 'ACTIVE' && item.kind === 'ONE_OFF' && item.start <= startsAt && item.end >= endsAt);
  if (!recurring && !oneOff) return false;
  if (service.rules.some((rule) => activeRule(rule, startsAt, weekday) && rule.windows.some((window) => window.kind === 'BREAK' && window.weekday === weekday && window.startSeconds < endSeconds && startSeconds < window.endSeconds))) return false;
  return !service.exceptions.some((item) => item.status === 'ACTIVE' && ['HOLIDAY', 'LEAVE', 'BLOCKED'].includes(item.kind) && item.start < endsAt && startsAt < item.end);
}
function activeRule(rule: AvailabilityRule, at: Date, weekday: number): boolean { return rule.effectiveFrom <= at && (!rule.effectiveTo || rule.effectiveTo > at) && rule.canonicalRecurrence.split('BYDAY=')[1]?.split(',').includes(['', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'][weekday]) === true; }
function localWeekday(localStart: string): number { const day = new Date(`${localStart.slice(0, 10)}T00:00:00Z`).getUTCDay(); return day === 0 ? 7 : day; }
function localSeconds(localStart: string): number { return Number(localStart.slice(11, 13)) * 3_600 + Number(localStart.slice(14, 16)) * 60 + Number(localStart.slice(17, 19)); }
function local(date: string, seconds: number): string { const hours = String(Math.floor(seconds / 3_600)).padStart(2, '0'); const minutes = String(Math.floor(seconds % 3_600 / 60)).padStart(2, '0'); const remaining = String(seconds % 60).padStart(2, '0'); return `${date}T${hours}:${minutes}:${remaining}`; }
function localRange(exception: AvailabilityException, timezone: string): { date: string; startSeconds: number; endSeconds: number } | null { const parts = (value: Date) => { const values = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(value); const field = (type: string) => values.find((part) => part.type === type)?.value; return { date: `${field('year')}-${field('month')}-${field('day')}`, seconds: Number(field('hour')) * 3_600 + Number(field('minute')) * 60 + Number(field('second')) }; }; const start = parts(exception.start), end = parts(exception.end); return start.date === end.date ? { date: start.date, startSeconds: start.seconds, endSeconds: end.seconds } : null; }

export type { AvailabilityException };
