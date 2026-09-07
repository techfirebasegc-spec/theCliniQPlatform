import { randomUUID } from 'node:crypto';

/**
 * Node.js currently provides a cryptographically secure UUIDv4 generator.
 * UUIDv7 is the preferred Phase 2 format and can replace this isolated
 * implementation once an approved runtime implementation is available.
 */
export function createIdentifier(): string {
  return randomUUID();
}
