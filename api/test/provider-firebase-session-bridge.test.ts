import { describe, expect, it } from 'vitest';
import { ProviderFirebaseSessionBridge } from '../src/modules/sessions/provider-firebase-session-bridge.js';

const policy = { idleTtlSeconds: 60, absoluteTtlSeconds: 120 };

function bridge(options: { provider?: 'firebase_google' | 'firebase_password'; linked?: boolean; accountStatus?: 'ACTIVE' | 'INACTIVE'; providerAccess?: boolean } = {}) {
  const created: string[] = [];
  return { created, value: new ProviderFirebaseSessionBridge(
    { findByProviderSubject: async () => options.linked === false ? null : { accountId: 'provider', identityId: 'identity', accountStatus: options.accountStatus ?? 'ACTIVE' } },
    { verify: async () => ({ provider: options.provider ?? 'firebase_password', subject: 'uid', verifiedAt: new Date(), email: 'provider@example.com', emailVerified: true }) },
    { create: async (accountId) => { created.push(accountId); }, hasActiveProviderAccess: async () => options.providerAccess ?? true },
    policy,
  ) };
}

describe('provider Firebase session bridge', () => {
  it.each(['firebase_password', 'firebase_google'] as const)('creates a session for a linked active %s provider', async (provider) => {
    const item = bridge({ provider });
    await expect(item.value.exchange('token')).resolves.toContain('.');
    expect(item.created).toEqual(['provider']);
  });

  it.each([
    ['an unlinked Firebase identity', { linked: false }, 'IDENTITY_NOT_LINKED'],
    ['an inactive account', { accountStatus: 'INACTIVE' as const }, 'ACCOUNT_NOT_ACTIVE'],
    ['an inactive clinic membership or ineligible doctor profile', { providerAccess: false }, 'PROVIDER_ACCESS_REQUIRED'],
    ['a Platform Admin entitlement without provider access', { providerAccess: false }, 'PROVIDER_ACCESS_REQUIRED'],
  ])('denies %s without creating a provider session', async (_name, options, reason) => {
    const item = bridge(options);
    await expect(item.value.exchange('token')).rejects.toMatchObject({ reason });
    expect(item.created).toEqual([]);
  });
});
