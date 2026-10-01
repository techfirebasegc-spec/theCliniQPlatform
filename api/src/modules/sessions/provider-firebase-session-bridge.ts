import { FirebaseIdentityVerificationError, ownerFirebaseIdentityProviders, type AccountIdentityRepository, type FirebaseIdentityVerifier } from '../identity/identity.js';
import { createSession, sessionCookieValue, type NewSession, type SessionPolicy } from './session.js';

export type ProviderFirebaseSessionBridgeFailure = 'FIREBASE_ID_TOKEN_INVALID' | 'FIREBASE_PROVIDER_UNSUPPORTED' | 'FIREBASE_EMAIL_NOT_VERIFIED' | 'IDENTITY_NOT_LINKED' | 'ACCOUNT_NOT_ACTIVE' | 'PROVIDER_ACCESS_REQUIRED';

export class ProviderFirebaseSessionBridgeError extends Error {
  public readonly code = 'UNAUTHORIZED';
  public constructor(public readonly reason: ProviderFirebaseSessionBridgeFailure = 'FIREBASE_ID_TOKEN_INVALID') {
    super(message(reason));
  }
}
export interface ProviderSessionRepository { create(accountId: string, session: NewSession): Promise<void>; hasActiveProviderAccess(accountId: string): Promise<boolean>; }

export class ProviderFirebaseSessionBridge {
  public constructor(private readonly identities: Pick<AccountIdentityRepository, 'findByProviderSubject'>, private readonly verifier: FirebaseIdentityVerifier, private readonly sessions: ProviderSessionRepository, private readonly policy: SessionPolicy) {}
  public async exchange(idToken: string): Promise<string> {
    try {
      const identity = await this.verifier.verify(idToken);
      if (!ownerFirebaseIdentityProviders.includes(identity.provider)) throw new ProviderFirebaseSessionBridgeError('FIREBASE_PROVIDER_UNSUPPORTED');
      if (!identity.email || identity.emailVerified !== true) throw new ProviderFirebaseSessionBridgeError('FIREBASE_EMAIL_NOT_VERIFIED');
      const account = await this.identities.findByProviderSubject(identity);
      if (!account) throw new ProviderFirebaseSessionBridgeError('IDENTITY_NOT_LINKED');
      if (account.accountStatus !== 'ACTIVE') throw new ProviderFirebaseSessionBridgeError('ACCOUNT_NOT_ACTIVE');
      if (!await this.sessions.hasActiveProviderAccess(account.accountId)) throw new ProviderFirebaseSessionBridgeError('PROVIDER_ACCESS_REQUIRED');
      const session = createSession(account.accountId, this.policy); await this.sessions.create(account.accountId, session); return sessionCookieValue(session);
    } catch (error) { if (error instanceof ProviderFirebaseSessionBridgeError) throw error; if (error instanceof FirebaseIdentityVerificationError) throw new ProviderFirebaseSessionBridgeError('FIREBASE_ID_TOKEN_INVALID'); throw error; }
  }
}

function message(reason: ProviderFirebaseSessionBridgeFailure): string {
  switch (reason) {
    case 'FIREBASE_PROVIDER_UNSUPPORTED': return 'This Firebase sign-in method is not supported for Provider access.';
    case 'FIREBASE_EMAIL_NOT_VERIFIED': return 'Verify your Firebase email address before signing in to Provider Web.';
    case 'IDENTITY_NOT_LINKED': return 'This Firebase sign-in method is not linked to a Provider account. Sign in with your linked method to add it.';
    case 'ACCOUNT_NOT_ACTIVE': return 'This Provider account is not active.';
    case 'PROVIDER_ACCESS_REQUIRED': return 'This account does not have active Provider access.';
    default: return 'The Firebase sign-in token could not be verified.';
  }
}
