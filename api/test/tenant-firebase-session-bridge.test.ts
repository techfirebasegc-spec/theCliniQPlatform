import { describe, expect, it } from 'vitest';
import { TenantFirebaseSessionBridge, TenantFirebaseSessionBridgeError } from '../src/modules/sessions/tenant-firebase-session-bridge.js';

const policy = { idleTtlSeconds: 60, absoluteTtlSeconds: 120 };
function bridge(options: { provider?: 'firebase_google' | 'firebase_password'; emailVerified?: boolean; activeAccount?: boolean; activeOwner?: boolean } = {}) {
  const created: string[] = [];
  return { created, value: new TenantFirebaseSessionBridge(
    { findByProviderSubject: async () => options.activeAccount === false ? null : { accountId: 'owner', identityId: 'identity', accountStatus: 'ACTIVE' as const } },
    { verify: async () => ({ provider: options.provider ?? 'firebase_google', subject: 'uid', verifiedAt: new Date(), email: 'owner@example.com', emailVerified: options.emailVerified ?? true }) },
    { create: async (accountId) => { created.push(accountId); }, hasActiveOwnerMembership: async () => options.activeOwner ?? true }, policy,
  ) };
}
describe('tenant Firebase session bridge', () => {
  it.each(['firebase_google', 'firebase_password'] as const)('creates a session for an accepted %s owner', async (provider) => { const item = bridge({ provider }); await expect(item.value.exchange('token')).resolves.toContain('.'); expect(item.created).toEqual(['owner']); });
  it('rejects unverified, inactive, or non-owner identities without creating a session', async () => {
    for (const options of [{ emailVerified: false }, { activeAccount: false }, { activeOwner: false }]) { const item = bridge(options); await expect(item.value.exchange('token')).rejects.toBeInstanceOf(TenantFirebaseSessionBridgeError); expect(item.created).toEqual([]); }
  });
});
