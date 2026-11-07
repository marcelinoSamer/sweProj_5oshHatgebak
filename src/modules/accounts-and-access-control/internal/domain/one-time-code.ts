import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { PersonId } from '../../../../shared/identifiers';

/** The sign-in policy of task A1, in one place for review and for the report. */
export const SIGN_IN_POLICY = {
  codeDigits: 6,
  codeLifetimeMinutes: 5,
  wrongCodesBeforeLockOut: 3,
  lockOutMinutes: 15,
} as const;

export function newOneTimeCode(): string {
  return String(randomInt(0, 10 ** SIGN_IN_POLICY.codeDigits)).padStart(SIGN_IN_POLICY.codeDigits, '0');
}

/** The hash kept in place of the code, salted with the person so equal codes of two people never share a hash. */
export function hashOfCode(personId: PersonId, code: string): string {
  return createHash('sha256').update(`${personId}:${code}`).digest('hex');
}

export function codeMatches(personId: PersonId, presentedCode: string, storedHash: string): boolean {
  const presented = Buffer.from(hashOfCode(personId, presentedCode), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}

export function minutesAfter(moment: Date, minutes: number): Date {
  return new Date(moment.getTime() + minutes * 60_000);
}
