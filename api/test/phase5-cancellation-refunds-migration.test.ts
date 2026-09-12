import { describe, expect, it } from 'vitest';
import migration from '../../database/migrations/20260920000000_phase5_cancellation_refunds.js';

describe('theCliniQ Phase 5.5 cancellation/refund migration', () => {
  it('adds scoped policy, immutable cancellation, refund-attempt, and provider protections', () => {
    const sql: string[] = []; migration.up({ sql: (value: string) => sql.push(value) }); const text = sql.join('\n');
    expect(text).toContain('CREATE TABLE refund_policy_scopes'); expect(text).toContain("scope_kind IN ('GLOBAL','PROVIDER','SERVICE','SERVICE_PROVIDER')");
    expect(text).toContain('CREATE TABLE appointment_cancellation_decisions'); expect(text).toContain('appointment_id uuid NOT NULL UNIQUE');
    expect(text).toContain('CREATE TABLE refund_attempts'); expect(text).toContain('CREATE TABLE appointment_cancellation_financial_consequences');
    expect(text).toContain('appointment_cancellation_decisions_immutable'); expect(text).toContain('refunds_integrity'); expect(text).toContain("NEW.status IN ('CONFIRMED','PAYMENT_FAILED','EXPIRED','CANCELLED')");
    expect(text).toContain('appointment_cancellation_financial_context_integrity');
    expect(text).toContain('refund_cancellation_financial_integrity');
    expect(text).toContain('cancellation_consequence_financial_integrity');
    expect(text).toContain('refund_provider_references_immutable');
    expect(text).toContain('refunds_provider_reference_integrity'); expect(text).toContain('provider_references_refund_integrity');
    expect(text).toContain('cancellation decision payment context is ambiguous');
    expect(text).toContain("refund policy contains an unsupported payment state");
  });
  it('fails rollback safely when Phase 5.5 evidence exists', () => {
    const sql: string[] = []; migration.down({ sql: (value: string) => sql.push(value) }); expect(sql.join('\n')).toContain('cannot roll back Phase 5.5 while cancellation or refund evidence exists');
  });
});
