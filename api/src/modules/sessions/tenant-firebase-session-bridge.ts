import { FirebaseIdentityVerificationError, ownerFirebaseIdentityProviders, type AccountIdentityRepository, type FirebaseIdentityVerifier } from '../identity/identity.js';
import { createSession, sessionCookieValue, type NewSession, type SessionPolicy } from './session.js';

export class TenantFirebaseSessionBridgeError extends Error { public constructor() { super('Authentication is required.'); } }
export interface TenantSessionRepository { create(accountId: string, session: NewSession): Promise<void>; hasActiveOwnerMembership(accountId: string): Promise<boolean>; }

export class TenantFirebaseSessionBridge {
  public constructor(private readonly identities: Pick<AccountIdentityRepository, 'findByProviderSubject'>, private readonly verifier: FirebaseIdentityVerifier, private readonly sessions: TenantSessionRepository, private readonly policy: SessionPolicy) {}
  public async exchange(idToken: string): Promise<string> {
    try {
      const identity = await this.verifier.verify(idToken);
      if (!ownerFirebaseIdentityProviders.includes(identity.provider) || !identity.email || identity.emailVerified !== true) throw new TenantFirebaseSessionBridgeError();
      const account = await this.identities.findByProviderSubject(identity);
      if (!account || account.accountStatus !== 'ACTIVE' || !await this.sessions.hasActiveOwnerMembership(account.accountId)) throw new TenantFirebaseSessionBridgeError();
      const session = createSession(account.accountId, this.policy);
      await this.sessions.create(account.accountId, session);
      return sessionCookieValue(session);
    } catch (error) {
      if (error instanceof TenantFirebaseSessionBridgeError || error instanceof FirebaseIdentityVerificationError) throw new TenantFirebaseSessionBridgeError();
      throw error;
    }
  }
}
