import { describe, expect, it } from 'vitest';
import { AppointmentLifecycleError, AppointmentLifecycleService, type AppointmentEventWrite, type AppointmentLifecycleRepository, type LifecycleAppointment } from '../src/modules/appointments/appointment-lifecycle.js';
import type { AuditEventInput } from '../src/modules/audit/audit.js';
import type { AppointmentStatus } from '../src/modules/appointments/appointment-foundation.js';

class FakeLifecycleRepository implements AppointmentLifecycleRepository {
  public appointment: LifecycleAppointment | null;
  public events: AppointmentEventWrite[] = [];
  public audits: AuditEventInput[] = [];
  public failEvent = false;

  public constructor(status: AppointmentStatus | null) {
    this.appointment = status ? { id: 'appointment-1', status } : null;
  }

  public async transaction<T>(operation: (database: { query: never }) => Promise<T>): Promise<T> {
    const before = this.appointment ? { ...this.appointment } : null;
    const eventCount = this.events.length;
    const auditCount = this.audits.length;
    try { return await operation({ query: undefined as never }); }
    catch (error) { this.appointment = before; this.events.splice(eventCount); this.audits.splice(auditCount); throw error; }
  }
  public async lockAppointment(): Promise<LifecycleAppointment | null> { return this.appointment ? { ...this.appointment } : null; }
  public async transitionAppointment(_database: unknown, id: string, from: AppointmentStatus, to: AppointmentStatus): Promise<boolean> {
    if (!this.appointment || this.appointment.id !== id || this.appointment.status !== from) return false;
    this.appointment.status = to;
    return true;
  }
  public async appendEvent(_database: unknown, event: AppointmentEventWrite): Promise<void> {
    if (this.failEvent) throw new Error('event write failed');
    this.events.push(event);
  }
  public async appendAudit(_database: unknown, event: AuditEventInput): Promise<string> {
    this.audits.push(event);
    return `audit-${this.audits.length}`;
  }
}

function request(action: 'CONFIRM' | 'PAYMENT_FAIL' | 'EXPIRE' | 'START' | 'COMPLETE' | 'CANCEL', expectedStatus: AppointmentStatus) {
  return { appointmentId: 'appointment-1', action, expectedStatus, actorAccountId: 'actor-1', reason: 'approved test reason', context: { source: 'test' } };
}

describe('theCliniQ Phase 5 Step 5.2 appointment lifecycle service', () => {
  it.each([
    ['PAYMENT_PENDING', 'CONFIRM', 'CONFIRMED'],
    ['PAYMENT_PENDING', 'PAYMENT_FAIL', 'PAYMENT_FAILED'],
    ['PAYMENT_PENDING', 'EXPIRE', 'EXPIRED'],
    ['CONFIRMED', 'START', 'IN_PROGRESS'],
    ['CONFIRMED', 'CANCEL', 'CANCELLED'],
    ['IN_PROGRESS', 'COMPLETE', 'COMPLETED'],
    ['IN_PROGRESS', 'CANCEL', 'CANCELLED'],
  ] as const)('writes one immutable event for %s -> %s', async (from, action, to) => {
    const repository = new FakeLifecycleRepository(from);
    const result = await new AppointmentLifecycleService(repository).transition(request(action, from));
    expect(result).toMatchObject({ previousStatus: from, resultingStatus: to });
    expect(repository.appointment?.status).toBe(to);
    expect(repository.events).toHaveLength(1);
    expect(repository.events[0]).toMatchObject({ previousStatus: from, resultingStatus: to, actorAccountId: 'actor-1', context: { source: 'test' }, auditEventId: 'audit-1' });
    expect(repository.audits).toHaveLength(1);
  });

  it.each([
    ['PAYMENT_PENDING', 'START'], ['PAYMENT_PENDING', 'COMPLETE'], ['PAYMENT_PENDING', 'CANCEL'],
    ['CONFIRMED', 'COMPLETE'], ['CONFIRMED', 'CONFIRM'], ['IN_PROGRESS', 'CONFIRM'], ['IN_PROGRESS', 'EXPIRE'],
  ] as const)('rejects forbidden %s -> %s without an event', async (from, action) => {
    const repository = new FakeLifecycleRepository(from);
    await expect(new AppointmentLifecycleService(repository).transition(request(action, from))).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(repository.events).toHaveLength(0);
  });

  it.each(['COMPLETED', 'CANCELLED', 'EXPIRED', 'PAYMENT_FAILED'] as const)('rejects every terminal appointment', async (status) => {
    const repository = new FakeLifecycleRepository(status);
    await expect(new AppointmentLifecycleService(repository).transition(request('CONFIRM', status))).rejects.toMatchObject({ code: 'TERMINAL_APPOINTMENT' });
    expect(repository.events).toHaveLength(0);
  });

  it('rolls state and audit back when event insertion fails', async () => {
    const repository = new FakeLifecycleRepository('PAYMENT_PENDING');
    repository.failEvent = true;
    await expect(new AppointmentLifecycleService(repository).transition(request('CONFIRM', 'PAYMENT_PENDING'))).rejects.toMatchObject({ code: 'EVENT_CONFLICT' });
    expect(repository.appointment?.status).toBe('PAYMENT_PENDING');
    expect(repository.events).toHaveLength(0);
    expect(repository.audits).toHaveLength(0);
  });

  it('rejects stale callers without an extra event', async () => {
    const repository = new FakeLifecycleRepository('PAYMENT_PENDING');
    const service = new AppointmentLifecycleService(repository);
    await service.transition(request('CONFIRM', 'PAYMENT_PENDING'));
    await expect(service.transition(request('CONFIRM', 'PAYMENT_PENDING'))).rejects.toMatchObject({ code: 'STALE_TRANSITION' });
    expect(repository.events).toHaveLength(1);
  });

  it('reports missing appointments deterministically', async () => {
    await expect(new AppointmentLifecycleService(new FakeLifecycleRepository(null)).transition(request('CONFIRM', 'PAYMENT_PENDING'))).rejects.toBeInstanceOf(AppointmentLifecycleError);
  });
});
