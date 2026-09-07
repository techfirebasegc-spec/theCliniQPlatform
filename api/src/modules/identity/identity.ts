import { createIdentifier } from '../../shared/identifiers/uuid.js';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

export type FirebaseIdentityProvider = 'firebase_google' | 'firebase_phone';

export interface VerifiedFirebaseIdentity {
  provider: FirebaseIdentityProvider;
  subject: string;
  verifiedAt: Date;
}

export interface FirebaseIdentityVerifier {
  verify(idToken: string): Promise<VerifiedFirebaseIdentity>;
}

export class FirebaseAdminIdentityVerifier implements FirebaseIdentityVerifier {
  public constructor(private readonly projectId: string) {}

  public async verify(idToken: string): Promise<VerifiedFirebaseIdentity> {
    const app = getApps()[0] ?? initializeApp({ credential: applicationDefault(), projectId: this.projectId });
    const token = await getAuth(app).verifyIdToken(idToken, true);
    const signInProvider = token.firebase.sign_in_provider;
    const provider = signInProvider === 'google.com' ? 'firebase_google' : signInProvider === 'phone' ? 'firebase_phone' : null;
    if (provider === null) {
      throw new Error('UNSUPPORTED_FIREBASE_PROVIDER');
    }
    return { provider, subject: token.uid, verifiedAt: new Date() };
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
