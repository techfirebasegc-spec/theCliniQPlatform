import type { PlatformAdminEntitlementService } from '../admin-access/admin-entitlements.js';
import { FirebaseIdentityVerificationError, type AccountIdentityRepository, type FirebaseIdentityVerifier, type VerifiedFirebaseIdentity } from '../identity/identity.js';
import { createSession, sessionCookieValue, type NewSession, type SessionPolicy } from './session.js';

export class AdminFirebaseSessionBridgeError extends Error {
  public constructor(public readonly code: 'UNAUTHORIZED') {
    super('Authentication is required.');
  }
}

export interface AdminSessionBridgeRepository {
  create(accountId: string, session: NewSession): Promise<void>;
}

export class AdminFirebaseSessionBridge {
  public constructor(
    private readonly identities: Pick<AccountIdentityRepository, 'findByProviderSubject'>,
    private readonly verifier: FirebaseIdentityVerifier,
    private readonly entitlements: Pick<PlatformAdminEntitlementService, 'hasActiveEntitlement'>,
    private readonly sessions: AdminSessionBridgeRepository,
    private readonly policy: SessionPolicy,
  ) {}

  public async exchange(idToken: string): Promise<string> {
    let identity: VerifiedFirebaseIdentity;
    try {
      identity = await this.verifier.verify(idToken);
    } catch (error) {
      if (error instanceof FirebaseIdentityVerificationError) throw new AdminFirebaseSessionBridgeError('UNAUTHORIZED');
      throw error;
    }
    if (identity.provider !== 'firebase_password') throw new AdminFirebaseSessionBridgeError('UNAUTHORIZED');

    const account = await this.identities.findByProviderSubject(identity);
    if (!account || account.accountStatus !== 'ACTIVE') throw new AdminFirebaseSessionBridgeError('UNAUTHORIZED');
    if (!await this.entitlements.hasActiveEntitlement(account.accountId)) throw new AdminFirebaseSessionBridgeError('UNAUTHORIZED');

    const session = createSession(account.accountId, this.policy);
    await this.sessions.create(account.accountId, session);
    return sessionCookieValue(session);
  }
}
