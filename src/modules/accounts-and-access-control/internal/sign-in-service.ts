import type { Clock } from '../../../shared/clock';
import type { PersonId } from '../../../shared/identifiers';
import { fail, succeed, type Result } from '../../../shared/result';
import type { Authorization, PasswordRefusal, SignIn, SignInCodeSender, SignInRefusal, TokenIssuer } from '../public';
import { codeMatches, hashOfCode, minutesAfter, newOneTimeCode, SIGN_IN_POLICY } from './domain/one-time-code';
import { hashPassword, MINIMUM_PASSWORD_LENGTH, needsSecondStep, passwordMatches } from './domain/password';
import { normalisePhone } from './domain/person';
import type { CommitteePasswordStore, PeopleStore, PersonalDataStore, SignInChallenge, SignInChallengeStore } from './ports';

export interface SignInDependencies {
  readonly people: PeopleStore;
  readonly personalData: PersonalDataStore;
  readonly challenges: SignInChallengeStore;
  readonly passwords: CommitteePasswordStore;
  readonly authorization: Authorization;
  readonly codeSender: SignInCodeSender;
  readonly tokenIssuer: TokenIssuer;
  readonly clock: Clock;
}

/**
 * Sign-in by phone and one-time code (task A1). Three wrong codes lock the person out for fifteen minutes; an unknown
 * phone gets the same answers as a wrong code, so the sign-in screen never reveals who is registered. Members and the
 * Chair also need their password (task A15); a wrong password counts towards the same lock-out as a wrong code.
 */
export class SignInService implements SignIn {
  constructor(private readonly dependencies: SignInDependencies) {}

  async requestSignInCode(phone: string): Promise<void> {
    const personId = await this.personWithPhone(phone);
    if (personId === undefined) {
      return;
    }
    const now = this.dependencies.clock.now();
    const earlier = await this.dependencies.challenges.find(personId);
    if (earlier !== undefined && isLocked(earlier, now)) {
      return;
    }
    const code = newOneTimeCode();
    await this.dependencies.challenges.save({
      personId,
      codeHash: hashOfCode(personId, code),
      expiresAt: minutesAfter(now, SIGN_IN_POLICY.codeLifetimeMinutes).toISOString(),
      failedAttempts: 0,
    });
    const details = await this.dependencies.personalData.detailsOf(personId);
    if (details !== undefined) {
      await this.dependencies.codeSender.send(details.phone, code);
    }
  }

  async signIn(phone: string, code: string): Promise<Result<{ token: string }, SignInRefusal>> {
    return this.signInWith(phone, code, undefined);
  }

  async signInWithSecondStep(phone: string, code: string, password: string): Promise<Result<{ token: string }, SignInRefusal>> {
    return this.signInWith(phone, code, password);
  }

  /** The person themself sets or changes their password; the Chair sets a member's first one or resets it. */
  async setCommitteePassword(actor: PersonId, personId: PersonId, password: string): Promise<Result<void, PasswordRefusal>> {
    const person = await this.dependencies.people.find(personId);
    if (person === undefined || !needsSecondStep(person.role)) {
      return fail('not a committee member');
    }
    const actorRole = await this.dependencies.authorization.roleOf(actor);
    const chairResettingMember = actorRole === 'chair' && person.role === 'member';
    if (actor !== personId && !chairResettingMember) {
      return fail('not allowed');
    }
    if (password.length < MINIMUM_PASSWORD_LENGTH) {
      return fail('password too short');
    }
    await this.dependencies.passwords.save(personId, hashPassword(password));
    return succeed(undefined);
  }

  private async signInWith(phone: string, code: string, password: string | undefined): Promise<Result<{ token: string }, SignInRefusal>> {
    const personId = await this.personWithPhone(phone);
    const challenge = personId === undefined ? undefined : await this.dependencies.challenges.find(personId);
    if (personId === undefined || challenge === undefined) {
      return fail('wrong code');
    }
    const now = this.dependencies.clock.now();
    if (isLocked(challenge, now)) {
      return fail('locked');
    }
    if (new Date(challenge.expiresAt) <= now) {
      return fail('code expired');
    }
    if (!codeMatches(personId, code, challenge.codeHash)) {
      return this.recordFailedAttempt(challenge, now, 'wrong code');
    }
    const secondStep = await this.checkSecondStep(personId, password);
    if (secondStep !== undefined) {
      return secondStep === 'wrong password' ? this.recordFailedAttempt(challenge, now, 'wrong password') : fail(secondStep);
    }
    await this.dependencies.challenges.remove(personId);
    return this.issueToken(personId);
  }

  /** undefined when no second step is needed or the password is right; the code stays usable otherwise. */
  private async checkSecondStep(personId: PersonId, password: string | undefined): Promise<SignInRefusal | undefined> {
    const person = await this.dependencies.people.find(personId);
    if (person === undefined || !needsSecondStep(person.role)) {
      return undefined;
    }
    if (password === undefined) {
      return 'second step required';
    }
    const stored = await this.dependencies.passwords.find(personId);
    if (stored === undefined) {
      return 'password not set';
    }
    return passwordMatches(password, stored) ? undefined : 'wrong password';
  }

  private async recordFailedAttempt(
    challenge: SignInChallenge,
    now: Date,
    refusal: 'wrong code' | 'wrong password',
  ): Promise<Result<never, SignInRefusal>> {
    const failedAttempts = challenge.failedAttempts + 1;
    if (failedAttempts < SIGN_IN_POLICY.wrongCodesBeforeLockOut) {
      await this.dependencies.challenges.save({ ...challenge, failedAttempts });
      return fail(refusal);
    }
    await this.dependencies.challenges.save({
      ...challenge,
      failedAttempts,
      lockedUntil: minutesAfter(now, SIGN_IN_POLICY.lockOutMinutes).toISOString(),
    });
    return fail('locked');
  }

  /** The token names one person and one role, plus a member's district; every claim is set here by the server. */
  private async issueToken(personId: PersonId): Promise<Result<{ token: string }, SignInRefusal>> {
    const person = await this.dependencies.people.find(personId);
    if (person === undefined || (await this.dependencies.authorization.liveStatus(personId)) !== 'active') {
      return fail('account not live');
    }
    const districtId = person.role === 'member' ? await this.dependencies.authorization.memberDistrictOf(personId) : undefined;
    const token = this.dependencies.tokenIssuer.issue(
      districtId === undefined ? { personId, role: person.role } : { personId, role: person.role, districtId },
    );
    return succeed({ token });
  }

  private async personWithPhone(phone: string): Promise<PersonId | undefined> {
    const normalised = normalisePhone(phone);
    return normalised.ok ? this.dependencies.personalData.personWithPhone(normalised.value) : undefined;
  }
}

function isLocked(challenge: SignInChallenge, now: Date): boolean {
  return challenge.lockedUntil !== undefined && new Date(challenge.lockedUntil) > now;
}
