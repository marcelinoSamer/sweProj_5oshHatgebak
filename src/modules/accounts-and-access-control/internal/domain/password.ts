import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Role } from '../../../../shared/identifiers';

/** The committee's second sign-in step (task A15): members and the Chair need a password as well as the phone code. */
export const COMMITTEE_ROLES: readonly Role[] = ['member', 'chair'];
export const MINIMUM_PASSWORD_LENGTH = 10;

const SALT_BYTES = 16;
const HASH_BYTES = 64;

export interface PasswordHash {
  readonly salt: string;
  readonly hash: string;
}

export function needsSecondStep(role: Role): boolean {
  return COMMITTEE_ROLES.includes(role);
}

/** scrypt from Node's built-in crypto, with a fresh random salt per password; the password itself is never kept. */
export function hashPassword(password: string): PasswordHash {
  const salt = randomBytes(SALT_BYTES).toString('hex');
  return { salt, hash: scryptSync(password, salt, HASH_BYTES).toString('hex') };
}

export function passwordMatches(password: string, stored: PasswordHash): boolean {
  const presented = scryptSync(password, stored.salt, HASH_BYTES);
  const expected = Buffer.from(stored.hash, 'hex');
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}
