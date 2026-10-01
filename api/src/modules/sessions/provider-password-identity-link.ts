import type { AuditRepository } from '../audit/audit.js';
import { FirebaseIdentityVerificationError, type AccountIdentityRecord, type FirebaseIdentityVerifier, type VerifiedFirebaseIdentity } from '../identity/identity.js';

export class ProviderPasswordIdentityLinkError extends Error {
  public constructor(public readonly code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'CONFLICT') {
    super(code === 'UNAUTHORIZED' ? 'Authentication is required.' : code === 'FORBIDDEN' ? 'This Firebase identity cannot be linked to the current Provider account.' : 'The Firebase identity link could not be completed.');
  }
}

export interface ProviderPasswordIdentityLinkRepository {
  findByProviderSubject(identity: VerifiedFirebaseIdentity): Promise<AccountIdentityRecord | null>;
  linkIdentityToAccount(accountId: string, identity: VerifiedFirebaseIdentity): Promise<AccountIdentityRecord>;
  markAuthenticated(identityId: string, at: Date): Promise<void>;
}

/** Links a password Firebase identity only after an existing Provider session identifies the target account. */
export class ProviderPasswordIdentityLinkService {
  public constructor(private readonly identities: ProviderPasswordIdentityLinkRepository, private readonly verifier: FirebaseIdentityVerifier, private readonly audit: AuditRepository, private readonly now: () => Date = () => new Date()) {}

  public async link(accountId: string | undefined, idToken: string): Promise<{ linked: boolean }> {
    if (!accountId) throw new ProviderPasswordIdentityLinkError('UNAUTHORIZED');
    let identity: VerifiedFirebaseIdentity;
    try {
      identity = await this.verifier.verify(idToken);
    } catch (error) {
      if (error instanceof FirebaseIdentityVerificationError) throw new ProviderPasswordIdentityLinkError('UNAUTHORIZED');
      throw error;
    }
    if (identity.provider !== 'firebase_password' || !identity.email || identity.emailVerified !== true) throw new ProviderPasswordIdentityLinkError('FORBIDDEN');
    const existing = await this.identities.findByProviderSubject(identity);
    if (existing && existing.accountId !== accountId) throw new ProviderPasswordIdentityLinkError('FORBIDDEN');
    if (existing) {
      await this.identities.markAuthenticated(existing.identityId, this.now());
      return { linked: false };
    }
    let linked: AccountIdentityRecord;
    try {
      linked = await this.identities.linkIdentityToAccount(accountId, identity);
    } catch {
      throw new ProviderPasswordIdentityLinkError('CONFLICT');
    }
    if (linked.accountId !== accountId) throw new ProviderPasswordIdentityLinkError('FORBIDDEN');
    await this.identities.markAuthenticated(linked.identityId, this.now());
    await this.audit.append({ category: 'SECURITY', eventType: 'PROVIDER_PASSWORD_IDENTITY_LINKED', actorAccountId: accountId, targetType: 'AUTHENTICATION_IDENTITY', targetId: linked.identityId, outcome: 'SUCCESS' });
    return { linked: true };
  }
}
