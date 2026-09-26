import {
  accountStatuses,
  authenticationIdentityProviders,
  auditCategories,
  auditOutcomes,
  isIsoTimestamp,
  isOneOf,
  isPhase2Identifier,
  networkConnectionCapabilities,
} from '@cliniq/contracts';
import { adminFirebaseIdentityProviders, firebaseIdentityProviderFromSignInProvider, sharedFirebaseIdentityProviders } from '../src/modules/identity/identity.js';
import { readFileSync } from 'node:fs';
import { createIdentifier } from '../src/shared/identifiers/uuid.js';
import { describe, expect, it } from 'vitest';

describe('Phase 2 shared contracts', () => {
  it('exposes the approved symmetric and directional network capability vocabulary', () => {
    expect(networkConnectionCapabilities).toEqual(['DISCOVER', 'CONTACT', 'BOOK', 'REFER']);
    expect(isOneOf('DISCOVER', networkConnectionCapabilities)).toBe(true);
    expect(isOneOf('REFER', networkConnectionCapabilities)).toBe(true);
    expect(isOneOf('PAYMENT', networkConnectionCapabilities)).toBe(false);
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

  it('supports Firebase password identities without changing existing providers', () => {
    expect(authenticationIdentityProviders).toEqual(['firebase_google', 'firebase_phone', 'firebase_password']);
    expect(firebaseIdentityProviderFromSignInProvider('google.com')).toBe('firebase_google');
    expect(firebaseIdentityProviderFromSignInProvider('phone')).toBe('firebase_phone');
    expect(firebaseIdentityProviderFromSignInProvider('password')).toBe('firebase_password');
    expect(firebaseIdentityProviderFromSignInProvider('github.com')).toBeNull();
    expect(sharedFirebaseIdentityProviders).toEqual(['firebase_google', 'firebase_phone']);
    expect(adminFirebaseIdentityProviders).toEqual(['firebase_password']);
  });

  it('migrates the provider constraint and creates the account-scoped admin entitlement table', () => {
    const migration = readFileSync(new URL('../../database/migrations/20260929000000_admin_password_identity_entitlements.js', import.meta.url), 'utf8');
    expect(migration).toContain("provider IN ('firebase_google', 'firebase_phone', 'firebase_password')");
    expect(migration).toContain("createTable('platform_admin_entitlements'");
    expect(migration).toContain("status IN ('ACTIVE', 'REVOKED')");
  });
});
