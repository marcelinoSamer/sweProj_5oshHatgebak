import { beforeEach, describe, expect, it } from 'vitest';
import type { PersonId, Role } from '../../../shared/identifiers';
import { COMMITTEE_ROLES, MINIMUM_PASSWORD_LENGTH } from '../public';
import { createAccountsWorld, type AccountsWorld } from './testing/accounts-world';

/** Task A15: a second step (password plus code) for members and the Chair only. */
const PASSWORD = 'correct horse battery staple';
const PHONES: Readonly<Record<Role, string>> = {
  chair: '+201000000000',
  member: '+201111111111',
  inspector: '+201222222222',
  attendant: '+201533333333',
  driver: '+201044444444',
};

let world: AccountsWorld;
let people: Record<Role, PersonId>;

async function created(outcome: Promise<{ ok: true; value: PersonId } | { ok: false; error: string }>): Promise<PersonId> {
  const result = await outcome;
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.value;
}

async function codeFor(role: Role): Promise<string> {
  await world.accounts.signIn.requestSignInCode(PHONES[role]);
  return world.codeSender.lastCodeSentTo(PHONES[role]) ?? 'no code was sent';
}

beforeEach(async () => {
  world = createAccountsWorld();
  const chair = await created(world.accounts.bootstrapChair(PHONES.chair, 'The Chair'));
  people = {
    chair,
    member: await created(world.accounts.personalData.createPerson(chair, 'member', PHONES.member, 'A Member')),
    inspector: await created(world.accounts.personalData.createPerson(chair, 'inspector', PHONES.inspector, 'An Inspector')),
    attendant: await created(world.accounts.personalData.createPerson(chair, 'attendant', PHONES.attendant, 'An Attendant')),
    driver: await created(world.accounts.personalData.createPerson('self registration', 'driver', PHONES.driver, 'A Driver')),
  };
  await world.accounts.accessFacts.recordLicenceState(people.attendant, 'valid');
  await world.accounts.signIn.setCommitteePassword(people.chair, people.chair, PASSWORD);
  await world.accounts.signIn.setCommitteePassword(people.member, people.member, PASSWORD);
});

describe('A15 the task sheet cases', () => {
  it('answers a member with the phone code only "second step required"', async () => {
    expect(await world.accounts.signIn.signIn(PHONES.member, await codeFor('member'))).toEqual({ ok: false, error: 'second step required' });
  });

  it('leaves the attendant unaffected: the phone code alone signs them in', async () => {
    expect((await world.accounts.signIn.signIn(PHONES.attendant, await codeFor('attendant'))).ok).toBe(true);
  });
});

describe('A15 the rest of the second step', () => {
  it('signs a member in with the code and the password, and the code stays usable after "second step required"', async () => {
    const code = await codeFor('member');
    await world.accounts.signIn.signIn(PHONES.member, code);
    expect((await world.accounts.signIn.signInWithSecondStep(PHONES.member, code, PASSWORD)).ok).toBe(true);
  });

  it('counts a wrong password towards the same lock-out as a wrong code', async () => {
    const code = await codeFor('member');
    expect(await world.accounts.signIn.signInWithSecondStep(PHONES.member, code, 'not the password')).toEqual({ ok: false, error: 'wrong password' });
    expect(await world.accounts.signIn.signInWithSecondStep(PHONES.member, '000000', PASSWORD)).toMatchObject({ ok: false });
    expect(await world.accounts.signIn.signInWithSecondStep(PHONES.member, code, 'still not the password')).toEqual({ ok: false, error: 'locked' });
    expect(await world.accounts.signIn.signInWithSecondStep(PHONES.member, code, PASSWORD)).toEqual({ ok: false, error: 'locked' });
  });

  it('refuses a member who has no password yet, until the Chair sets a first one', async () => {
    const newMember = await created(world.accounts.personalData.createPerson(people.chair, 'member', '+201555555555', 'New Member'));
    await world.accounts.signIn.requestSignInCode('+201555555555');
    const code = world.codeSender.lastCodeSentTo('+201555555555') ?? '';
    expect(await world.accounts.signIn.signInWithSecondStep('+201555555555', code, PASSWORD)).toEqual({ ok: false, error: 'password not set' });
    expect(await world.accounts.signIn.setCommitteePassword(people.chair, newMember, PASSWORD)).toEqual({ ok: true, value: undefined });
    expect((await world.accounts.signIn.signInWithSecondStep('+201555555555', code, PASSWORD)).ok).toBe(true);
  });

  it('lets only the person, or the Chair for a member, set a password, and keeps only its salted hash', async () => {
    expect(await world.accounts.signIn.setCommitteePassword(people.member, people.chair, PASSWORD)).toEqual({ ok: false, error: 'not allowed' });
    expect(await world.accounts.signIn.setCommitteePassword(people.chair, people.attendant, PASSWORD)).toEqual({ ok: false, error: 'not a committee member' });
    expect(await world.accounts.signIn.setCommitteePassword(people.member, people.member, 'short')).toEqual({ ok: false, error: 'password too short' });
    const stored = await world.stores.committeePasswords.find(people.member);
    expect(stored?.hash).toMatch(/^[0-9a-f]{128}$/);
    expect(JSON.stringify(stored)).not.toContain(PASSWORD);
  });
});

describe('A15 report', () => {
  it('prints pass or fail per role', async () => {
    const results: string[] = [];
    for (const role of ['chair', 'member', 'inspector', 'attendant', 'driver'] as const) {
      const codeOnly = await world.accounts.signIn.signIn(PHONES[role], await codeFor(role));
      const needsSecondStep = COMMITTEE_ROLES.includes(role);
      const asExpected = needsSecondStep ? !codeOnly.ok && codeOnly.error === 'second step required' : codeOnly.ok;
      expect(asExpected).toBe(true);
      results.push(`${role} ${asExpected ? 'pass' : 'fail'}`);
    }
    console.log(`A15 report: ${results.join('; ')} (second step for ${COMMITTEE_ROLES.join(' and ')}; passwords of at least ${MINIMUM_PASSWORD_LENGTH} characters)`);
  });
});
