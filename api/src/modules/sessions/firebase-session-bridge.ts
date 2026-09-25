import { FirebaseIdentityVerificationError, type AccountIdentityService, type FirebaseIdentityVerifier } from '../identity/identity.js';
import { authenticateSession, createSession, sessionCookieValue, type NewSession, type SessionAuthenticatorRepository, type SessionPolicy } from './session.js';

export class FirebaseSessionBridgeError extends Error {
  public constructor(public readonly code: 'UNAUTHORIZED') {
    super('Authentication is required.');
  }
}

export interface SessionBridgeRepository extends SessionAuthenticatorRepository {
  create(accountId: string, session: NewSession): Promise<void>;
  revoke(sessionId: string, accountId: string, reason: string, at: Date): Promise<void>;
}

export class FirebaseSessionBridge {
  public constructor(
    private readonly identities: Pick<AccountIdentityService, 'resolve'>,
    private readonly verifier: FirebaseIdentityVerifier,
    private readonly sessions: SessionBridgeRepository,
    private readonly policy: SessionPolicy,
  ) {}

  public async exchange(idToken: string): Promise<string> {
    let accountId: string;
    try {
      accountId = (await this.identities.resolve(idToken, this.verifier)).accountId;
    } catch (error) {
      if (isIdentityVerificationError(error)) throw new FirebaseSessionBridgeError('UNAUTHORIZED');
      throw error;
    }
    const session = createSession(accountId, this.policy);
    await this.sessions.create(accountId, session);
    return sessionCookieValue(session);
  }

  public async logout(cookieValue: string | undefined): Promise<void> {
    try {
      const session = await authenticateSession(cookieValue, this.policy, this.sessions);
      await this.sessions.revoke(session.id, session.accountId, 'LOGOUT', new Date());
    } catch (error) {
      if (error instanceof FirebaseSessionBridgeError) throw error;
      throw new FirebaseSessionBridgeError('UNAUTHORIZED');
    }
  }
}

function isIdentityVerificationError(error: unknown): boolean {
  return error instanceof FirebaseIdentityVerificationError;
}
