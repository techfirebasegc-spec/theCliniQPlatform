import { createIdentifier } from '../../shared/identifiers/uuid.js';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

export type FirebaseIdentityProvider = 'firebase_google' | 'firebase_phone' | 'firebase_password';

export interface VerifiedFirebaseIdentity {
  provider: FirebaseIdentityProvider;
  subject: string;
  verifiedAt: Date;
}

export interface FirebaseIdentityVerifier {
  verify(idToken: string): Promise<VerifiedFirebaseIdentity>;
}

export const sharedFirebaseIdentityProviders: readonly FirebaseIdentityProvider[] = ['firebase_google', 'firebase_phone'];
export const adminFirebaseIdentityProviders: readonly FirebaseIdentityProvider[] = ['firebase_password'];

export class FirebaseIdentityVerificationError extends Error {
  public constructor() {
    super('FIREBASE_ID_TOKEN_INVALID');
  }
}

export function firebaseIdentityProviderFromSignInProvider(signInProvider: unknown): FirebaseIdentityProvider | null {
  if (signInProvider === 'google.com') return 'firebase_google';
  if (signInProvider === 'phone') return 'firebase_phone';
  if (signInProvider === 'password') return 'firebase_password';
  return null;
}

export class FirebaseAdminIdentityVerifier implements FirebaseIdentityVerifier {
  public constructor(private readonly projectId: string) {}

  public async verify(idToken: string): Promise<VerifiedFirebaseIdentity> {
    try {
      const app = getApps()[0] ?? initializeApp({ credential: applicationDefault(), projectId: this.projectId });
      const token = await getAuth(app).verifyIdToken(idToken, true);
      const provider = firebaseIdentityProviderFromSignInProvider(token.firebase.sign_in_provider);
      if (provider === null) throw new FirebaseIdentityVerificationError();
      return { provider, subject: token.uid, verifiedAt: new Date() };
    } catch (error) {
      if (error instanceof FirebaseIdentityVerificationError) throw error;
      throw new FirebaseIdentityVerificationError();
    }
  }
}

export class FirebaseProviderPolicyVerifier implements FirebaseIdentityVerifier {
  public constructor(private readonly verifier: FirebaseIdentityVerifier, private readonly allowedProviders: readonly FirebaseIdentityProvider[]) {}

  public async verify(idToken: string): Promise<VerifiedFirebaseIdentity> {
    const identity = await this.verifier.verify(idToken);
    if (!this.allowedProviders.includes(identity.provider)) throw new FirebaseIdentityVerificationError();
    return identity;
  }
}

export interface AccountIdentityRecord {
  accountId: string;
  identityId: string;
  accountStatus: 'ACTIVE' | 'PENDING_VERIFICATION' | 'SUSPENDED' | 'DEACTIVATED' | 'DELETED_REQUESTED' | 'DELETED';
}

export interface AccountIdentityRepository {
  findByProviderSubject(identity: VerifiedFirebaseIdentity): Promise<AccountIdentityRecord | null>;
  createAccountWithIdentity(identity: VerifiedFirebaseIdentity): Promise<AccountIdentityRecord>;
  markAuthenticated(identityId: string, at: Date): Promise<void>;
}

export class AccountIdentityService {
  public constructor(private readonly repository: AccountIdentityRepository, private readonly now: () => Date = () => new Date()) {}

  public async resolve(idToken: string, verifier: FirebaseIdentityVerifier): Promise<AccountIdentityRecord> {
    const identity = await verifier.verify(idToken);
    const existing = await this.repository.findByProviderSubject(identity);
    const result = existing ?? await this.repository.createAccountWithIdentity(identity);
    if (result.accountStatus !== 'ACTIVE' && result.accountStatus !== 'PENDING_VERIFICATION') {
      throw new Error('ACCOUNT_NOT_ACTIVE');
    }
    await this.repository.markAuthenticated(result.identityId, this.now());
    return result;
  }
}

export function createPendingAccountIdentity(identity: VerifiedFirebaseIdentity): AccountIdentityRecord {
  void identity;
  return { accountId: createIdentifier(), identityId: createIdentifier(), accountStatus: 'PENDING_VERIFICATION' };
}
