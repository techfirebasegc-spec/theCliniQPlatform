import {
  accountStatuses,
  auditCategories,
  auditOutcomes,
  isIsoTimestamp,
  isOneOf,
  isPhase2Identifier,
  networkConnectionCapabilities,
} from '@cliniq/contracts';
import { createIdentifier } from '../src/shared/identifiers/uuid.js';
import { describe, expect, it } from 'vitest';

describe('Phase 2 shared contracts', () => {
  it('limits active network capabilities to DISCOVER and CONTACT', () => {
    expect(networkConnectionCapabilities).toEqual(['DISCOVER', 'CONTACT']);
    expect(isOneOf('DISCOVER', networkConnectionCapabilities)).toBe(true);
    expect(isOneOf('REFER', networkConnectionCapabilities)).toBe(false);
  });

  it('validates supported identifiers and timestamps', () => {
    expect(isPhase2Identifier('018f2e67-941b-7a95-a0d2-25d14d8e3c5a')).toBe(true);
    expect(isPhase2Identifier('not-an-identifier')).toBe(false);
    expect(isIsoTimestamp('2026-09-07T12:30:00.000Z')).toBe(true);
    expect(isIsoTimestamp('2026-09-07')).toBe(false);
  });

  it('uses the approved UUIDv4 fallback until UUIDv7 runtime support is approved', () => {
    expect(isPhase2Identifier(createIdentifier())).toBe(true);
  });

  it('exposes only approved lifecycle vocabularies', () => {
    expect(accountStatuses).toContain('ACTIVE');
    expect(auditCategories).toEqual(['SECURITY', 'AUTHORIZATION', 'BUSINESS']);
    expect(auditOutcomes).toEqual(['SUCCESS', 'DENIED', 'FAILURE']);
  });
});
