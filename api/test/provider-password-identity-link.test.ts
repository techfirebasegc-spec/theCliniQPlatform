import { describe, expect, it } from 'vitest';
import { FirebaseIdentityVerificationError, type AccountIdentityRecord, type VerifiedFirebaseIdentity } from '../src/modules/identity/identity.js';
import { ProviderPasswordIdentityLinkError, ProviderPasswordIdentityLinkService, type ProviderPasswordIdentityLinkRepository } from '../src/modules/sessions/provider-password-identity-link.js';

const passwordIdentity: VerifiedFirebaseIdentity = { provider: 'firebase_password', subject: 'password-uid', verifiedAt: new Date('2026-10-01T00:00:00Z'), email: 'doctor@example.test', emailVerified: true };

class Repository implements ProviderPasswordIdentityLinkRepository {
  public existing: AccountIdentityRecord | null = null;
  public linked: { accountId: string; identity: VerifiedFirebaseIdentity } | null = null;
  public authenticated: string[] = [];
  public async findByProviderSubject(): Promise<AccountIdentityRecord | null> { return this.existing; }
  public async linkIdentityToAccount(accountId: string, identity: VerifiedFirebaseIdentity): Promise<AccountIdentityRecord> { this.linked = { accountId, identity }; return { accountId, identityId: 'password-identity', accountStatus: 'ACTIVE' }; }
  public async markAuthenticated(identityId: string): Promise<void> { this.authenticated.push(identityId); }
}

function service(options: { identity?: VerifiedFirebaseIdentity; verifyFails?: boolean; existing?: AccountIdentityRecord | null } = {}) {
  const repository = new Repository();
  repository.existing = options.existing ?? null;
  const events: unknown[] = [];
  const value = new ProviderPasswordIdentityLinkService(repository, { verify: async () => { if (options.verifyFails) throw new FirebaseIdentityVerificationError(); return options.identity ?? passwordIdentity; } }, { append: async (event) => { events.push(event); } });
  return { repository, events, value };
}

describe('Provider password identity linking', () => {
  it('links a verified password Firebase identity to the account established by the Provider session', async () => {
    const item = service();
    await expect(item.value.link('doctor-account', 'token')).resolves.toEqual({ linked: true });
    expect(item.repository.linked).toEqual({ accountId: 'doctor-account', identity: passwordIdentity });
    expect(item.repository.authenticated).toEqual(['password-identity']);
    expect(item.events).toContainEqual(expect.objectContaining({ eventType: 'PROVIDER_PASSWORD_IDENTITY_LINKED', actorAccountId: 'doctor-account', targetType: 'AUTHENTICATION_IDENTITY' }));
  });

  it('is idempotent only for an identity already linked to the same Provider account', async () => {
    const item = service({ existing: { accountId: 'doctor-account', identityId: 'password-identity', accountStatus: 'ACTIVE' } });
    await expect(item.value.link('doctor-account', 'token')).resolves.toEqual({ linked: false });
    expect(item.repository.linked).toBeNull();
    expect(item.events).toEqual([]);
  });

  it('denies a password identity linked to another account without relinking it', async () => {
    const item = service({ existing: { accountId: 'another-account', identityId: 'other-identity', accountStatus: 'ACTIVE' } });
    await expect(item.value.link('doctor-account', 'token')).rejects.toMatchObject({ code: 'FORBIDDEN' } satisfies Partial<ProviderPasswordIdentityLinkError>);
    expect(item.repository.linked).toBeNull();
  });

  it.each([
    ['a Google token', { ...passwordIdentity, provider: 'firebase_google' as const }],
    ['an unverified password token', { ...passwordIdentity, emailVerified: false }],
  ])('denies %s', async (_name, identity) => {
    const item = service({ identity });
    await expect(item.value.link('doctor-account', 'token')).rejects.toMatchObject({ code: 'FORBIDDEN' } satisfies Partial<ProviderPasswordIdentityLinkError>);
  });

  it('denies an invalid Firebase token and an absent Provider session account', async () => {
    await expect(service({ verifyFails: true }).value.link('doctor-account', 'token')).rejects.toMatchObject({ code: 'UNAUTHORIZED' } satisfies Partial<ProviderPasswordIdentityLinkError>);
    await expect(service().value.link(undefined, 'token')).rejects.toMatchObject({ code: 'UNAUTHORIZED' } satisfies Partial<ProviderPasswordIdentityLinkError>);
  });
});
