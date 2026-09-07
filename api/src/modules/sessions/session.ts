import { createHash, randomBytes } from 'node:crypto';
import { createIdentifier } from '../../shared/identifiers/uuid.js';

export interface SessionPolicy {
  idleTtlSeconds: number;
  absoluteTtlSeconds: number;
}

export interface NewSession {
  id: string;
  rawSecret: string;
  secretHash: string;
  createdAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

export function createSession(accountId: string, policy: SessionPolicy, now: Date = new Date()): NewSession {
  void accountId;
  if (policy.idleTtlSeconds <= 0 || policy.absoluteTtlSeconds < policy.idleTtlSeconds) {
    throw new Error('INVALID_SESSION_POLICY');
  }
  const rawSecret = randomBytes(32).toString('base64url');
  return {
    id: createIdentifier(),
    rawSecret,
    secretHash: createHash('sha256').update(rawSecret).digest('base64url'),
    createdAt: now,
    idleExpiresAt: new Date(now.getTime() + policy.idleTtlSeconds * 1000),
    absoluteExpiresAt: new Date(now.getTime() + policy.absoluteTtlSeconds * 1000),
  };
}

export function sessionCookieValue(session: NewSession): string {
  return `${session.id}.${session.rawSecret}`;
}

export function hashSessionSecret(rawSecret: string): string {
  return createHash('sha256').update(rawSecret).digest('base64url');
}

export interface StoredSession {
  id: string;
  accountId: string;
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'REPLACED' | 'SUSPICIOUS';
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

export interface SessionAuthenticatorRepository {
  findBySecretHash(secretHash: string): Promise<StoredSession | null>;
  touch(sessionId: string, at: Date, idleExpiresAt: Date): Promise<{ updated: boolean }>;
}

export async function authenticateSession(value: string | undefined, policy: SessionPolicy, repository: SessionAuthenticatorRepository, now: Date = new Date()): Promise<StoredSession> {
  const [sessionId, rawSecret, ...extra] = value?.split('.') ?? [];
  if (!sessionId || !rawSecret || extra.length > 0) throw new Error('UNAUTHORIZED');
  const session = await repository.findBySecretHash(hashSessionSecret(rawSecret));
  if (!session || session.id !== sessionId || session.status !== 'ACTIVE' || session.idleExpiresAt <= now || session.absoluteExpiresAt <= now) {
    throw new Error('UNAUTHORIZED');
  }
  const nextIdleExpiry = new Date(Math.min(now.getTime() + policy.idleTtlSeconds * 1000, session.absoluteExpiresAt.getTime()));
  const touch = await repository.touch(session.id, now, nextIdleExpiry);
  if (!touch.updated) throw new Error('UNAUTHORIZED');
  return session;
}

export const sessionCookieOptions = {
  httpOnly: true,
  path: '/',
  sameSite: 'lax' as const,
  secure: true,
};

export const sessionCookieName = 'cliniq_session';
