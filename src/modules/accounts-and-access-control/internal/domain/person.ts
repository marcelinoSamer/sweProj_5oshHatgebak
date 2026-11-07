import type { PersonId, Role } from '../../../../shared/identifiers';
import { fail, succeed, type Result } from '../../../../shared/result';
import type { AccountStatus, CreatePersonRefusal, PersonCreator } from '../../public';

/**
 * A person as the rest of the system sees them: a reference, one role and an account status. No name, phone or plate
 * lives here; those are in the personal-data store (ADR-06, Rule F).
 */
export interface Person {
  readonly personId: PersonId;
  readonly role: Role;
  readonly status: AccountStatus;
  /** True once the person's personal data has been erased (task A5); the reference itself stays. */
  readonly erased: boolean;
}

const MAXIMUM_DISPLAY_NAME_LENGTH = 100;

/** Plates in version one are English letters and digits (no Arabic-language processing yet), up to ten of them. */
const PLATE = /^[A-Z0-9]{1,10}$/;

/** Egyptian mobile numbers: 010, 011, 012 or 015 followed by eight digits, with or without the +20 country code. */
const EGYPTIAN_MOBILE = /^(?:\+20|0020|0)?(1[0125]\d{8})$/;

/** Who may create whom, following the hierarchy Chair > Member > Inspector > Attendant. */
const ROLES_EACH_CREATOR_MAY_CREATE: Readonly<Record<Role, readonly Role[]>> = {
  chair: ['member', 'inspector', 'attendant'],
  member: ['inspector', 'attendant'],
  inspector: [],
  attendant: [],
  driver: [],
};

/** Normalises a phone number to the international form +201XXXXXXXXX, or refuses it. */
export function normalisePhone(phone: string): Result<string, 'invalid phone'> {
  const digitsOnly = phone.replace(/[\s-]/g, '');
  const match = EGYPTIAN_MOBILE.exec(digitsOnly);
  return match?.[1] === undefined ? fail('invalid phone') : succeed(`+20${match[1]}`);
}

/** Upper case with spaces and dashes removed, so "abc 123" and "ABC-123" are the same plate. */
export function normalisePlate(plate: string): Result<string, 'invalid plate'> {
  const compact = plate.toUpperCase().replace(/[\s-]/g, '');
  return PLATE.test(compact) ? succeed(compact) : fail('invalid plate');
}

export function normaliseDisplayName(displayName: string): Result<string, 'invalid name'> {
  const trimmed = displayName.trim().replace(/\s+/g, ' ');
  return trimmed === '' || trimmed.length > MAXIMUM_DISPLAY_NAME_LENGTH ? fail('invalid name') : succeed(trimmed);
}

/**
 * A driver registers themself; staff are created by someone above them. The Chair is created only by the system's
 * one-time set-up, never through this rule.
 */
export function mayCreate(creator: PersonCreator, creatorRole: Role | undefined, role: Role): Result<void, CreatePersonRefusal> {
  if (creator === 'self registration') {
    return role === 'driver' ? succeed(undefined) : fail('not allowed to create this role');
  }
  if (creatorRole === undefined) {
    return fail('not allowed to create this role');
  }
  return ROLES_EACH_CREATOR_MAY_CREATE[creatorRole].includes(role) ? succeed(undefined) : fail('not allowed to create this role');
}
