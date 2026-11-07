import { beforeEach, describe, expect, it } from 'vitest';
import { verifyToken } from '../../../entrypoint/auth/token';
import { TEST_TOKEN_SECRET } from '../../../entrypoint/test-helpers';
import type { PersonId } from '../../../shared/identifiers';
import { SIGN_IN_POLICY } from '../public';
import { createAccountsWorld, type AccountsWorld } from './testing/accounts-world';

/** Task A1: create a person with a role; sign in by phone and one-time code (fake sender); issue a token. */
const DRIVER_PHONE = '+201012345678';

let world: AccountsWorld;
let driver: PersonId;

async function signInWithRightCode(phone: string) {
  await world.accounts.signIn.requestSignInCode(phone);
  return world.accounts.signIn.signIn(phone, world.codeSender.lastCodeSentTo(DRIVER_PHONE) ?? 'no code was sent');
}

function wrongCodeFor(phone: string): string {
  const right = world.codeSender.lastCodeSentTo(phone) ?? '000000';
  return right === '000000' ? '111111' : '000000';
}

beforeEach(async () => {
  world = createAccountsWorld();
  const created = await world.accounts.personalData.createPerson('self registration', 'driver', '010 1234 5678', 'Mona Adel');
  if (!created.ok) {
    throw new Error(created.error);
  }
  driver = created.value;
});

describe('A1 the task sheet cases', () => {
  it('signs in with the right code and issues a token naming one person and one role', async () => {
    const outcome = await signInWithRightCode('01012345678');
    if (!outcome.ok) {
      throw new Error(`expected a token, got ${outcome.error}`);
    }
    expect(verifyToken(outcome.value.token, TEST_TOKEN_SECRET)).toEqual({ ok: true, value: { personId: driver, role: 'driver' } });
  });

  it('refuses a wrong code', async () => {
    await world.accounts.signIn.requestSignInCode(DRIVER_PHONE);
    expect(await world.accounts.signIn.signIn(DRIVER_PHONE, wrongCodeFor(DRIVER_PHONE))).toEqual({ ok: false, error: 'wrong code' });
  });

  it('locks the person out for a while after three wrong codes, even against the right code', async () => {
    await world.accounts.signIn.requestSignInCode(DRIVER_PHONE);
    const rightCode = world.codeSender.lastCodeSentTo(DRIVER_PHONE) ?? '';
    const wrongCode = wrongCodeFor(DRIVER_PHONE);
    expect(await world.accounts.signIn.signIn(DRIVER_PHONE, wrongCode)).toEqual({ ok: false, error: 'wrong code' });
    expect(await world.accounts.signIn.signIn(DRIVER_PHONE, wrongCode)).toEqual({ ok: false, error: 'wrong code' });
    expect(await world.accounts.signIn.signIn(DRIVER_PHONE, wrongCode)).toEqual({ ok: false, error: 'locked' });
    expect(await world.accounts.signIn.signIn(DRIVER_PHONE, rightCode)).toEqual({ ok: false, error: 'locked' });

    const codesBefore = world.codeSender.count();
    await world.accounts.signIn.requestSignInCode(DRIVER_PHONE);
    expect(world.codeSender.count()).toBe(codesBefore);

    world.clock.advanceByMilliseconds(SIGN_IN_POLICY.lockOutMinutes * 60_000);
    expect((await signInWithRightCode(DRIVER_PHONE)).ok).toBe(true);
  });
});

describe('A1 the rest of sign-in', () => {
  it('uses each code once', async () => {
    await world.accounts.signIn.requestSignInCode(DRIVER_PHONE);
    const code = world.codeSender.lastCodeSentTo(DRIVER_PHONE) ?? '';
    expect((await world.accounts.signIn.signIn(DRIVER_PHONE, code)).ok).toBe(true);
    expect(await world.accounts.signIn.signIn(DRIVER_PHONE, code)).toEqual({ ok: false, error: 'wrong code' });
  });

  it('refuses a code older than its lifetime by the server clock', async () => {
    await world.accounts.signIn.requestSignInCode(DRIVER_PHONE);
    world.clock.advanceByMilliseconds(SIGN_IN_POLICY.codeLifetimeMinutes * 60_000);
    expect(await world.accounts.signIn.signIn(DRIVER_PHONE, world.codeSender.lastCodeSentTo(DRIVER_PHONE) ?? '')).toEqual({
      ok: false,
      error: 'code expired',
    });
  });

  it('gives an unknown phone the same answer as a wrong code and sends it nothing', async () => {
    await world.accounts.signIn.requestSignInCode('01199999999');
    expect(world.codeSender.count()).toBe(0);
    expect(await world.accounts.signIn.signIn('01199999999', '123456')).toEqual({ ok: false, error: 'wrong code' });
    expect(await world.accounts.signIn.signIn('not a phone', '123456')).toEqual({ ok: false, error: 'wrong code' });
  });

  it('puts a member\'s district in the token', async () => {
    const chair = await world.accounts.bootstrapChair('01000000000', 'The Chair');
    if (!chair.ok) {
      throw new Error(chair.error);
    }
    const member = await world.accounts.personalData.createPerson(chair.value, 'member', '01111111111', 'A Member');
    if (!member.ok) {
      throw new Error(member.error);
    }
    await world.accounts.accessFacts.recordMemberDistrict(member.value, 'district-1');
    await world.accounts.signIn.requestSignInCode('01111111111');
    const outcome = await world.accounts.signIn.signIn('01111111111', world.codeSender.lastCodeSentTo('+201111111111') ?? '');
    if (!outcome.ok) {
      throw new Error(outcome.error);
    }
    expect(verifyToken(outcome.value.token, TEST_TOKEN_SECRET)).toEqual({
      ok: true,
      value: { personId: member.value, role: 'member', districtId: 'district-1' },
    });
  });

  it('refuses an attendant whose licence is not valid, and a suspended account', async () => {
    const chair = await world.accounts.bootstrapChair('01000000000', 'The Chair');
    if (!chair.ok) {
      throw new Error(chair.error);
    }
    const attendant = await world.accounts.personalData.createPerson(chair.value, 'attendant', '01222222222', 'An Attendant');
    if (!attendant.ok) {
      throw new Error(attendant.error);
    }
    await world.accounts.signIn.requestSignInCode('01222222222');
    expect(await world.accounts.signIn.signIn('01222222222', world.codeSender.lastCodeSentTo('+201222222222') ?? '')).toEqual({
      ok: false,
      error: 'account not live',
    });

    await world.stores.people.setStatus(driver, 'suspended');
    await world.accounts.signIn.requestSignInCode(DRIVER_PHONE);
    expect(await world.accounts.signIn.signIn(DRIVER_PHONE, world.codeSender.lastCodeSentTo(DRIVER_PHONE) ?? '')).toEqual({
      ok: false,
      error: 'account not live',
    });
  });

  it('keeps only the hash of the code', async () => {
    await world.accounts.signIn.requestSignInCode(DRIVER_PHONE);
    const challenge = await world.stores.signInChallenges.find(driver);
    expect(challenge?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(challenge)).not.toContain(world.codeSender.lastCodeSentTo(DRIVER_PHONE));
  });
});

describe('A1 report', () => {
  it('measures the sign-in success rate with the right code', async () => {
    const attempts = 50;
    let successes = 0;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if ((await signInWithRightCode(DRIVER_PHONE)).ok) {
        successes += 1;
      }
    }
    expect(successes).toBe(attempts);
    console.log(
      `A1 report: sign-in success rate ${successes} / ${attempts} (${((100 * successes) / attempts).toFixed(0)} %); ` +
        `lock-out threshold ${SIGN_IN_POLICY.wrongCodesBeforeLockOut} wrong codes, locked for ${SIGN_IN_POLICY.lockOutMinutes} minutes`,
    );
  });
});
