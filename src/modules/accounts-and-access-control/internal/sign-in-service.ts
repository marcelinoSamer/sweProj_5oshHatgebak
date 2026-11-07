import type { Clock } from '../../../shared/clock';
import type { PersonId } from '../../../shared/identifiers';
import { fail, succeed, type Result } from '../../../shared/result';
import type { Authorization, SignIn, SignInCodeSender, SignInRefusal, TokenIssuer } from '../public';
import { normalisePhone } from './domain/person';
import { codeMatches, hashOfCode, minutesAfter, newOneTimeCode, SIGN_IN_POLICY } from './domain/one-time-code';
import type { PeopleStore, PersonalDataStore, SignInChallenge, SignInChallengeStore } from './ports';

export interface SignInDependencies {
  readonly people: PeopleStore;
  readonly personalData: PersonalDataStore;
  readonly challenges: SignInChallengeStore;
  readonly authorization: Authorization;
  readonly codeSender: SignInCodeSender;
  readonly tokenIssuer: TokenIssuer;
  readonly clock: Clock;
}

/**
 * Sign-in by phone and one-time code (task A1). Three wrong codes lock the person out for fifteen minutes; an unknown
 * phone gets the same answers as a wrong code, so the sign-in screen never reveals who is registered.
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
      return this.recordWrongCode(challenge, now);
    }
    await this.dependencies.challenges.remove(personId);
    return this.issueToken(personId);
  }

  private async recordWrongCode(challenge: SignInChallenge, now: Date): Promise<Result<never, SignInRefusal>> {
    const failedAttempts = challenge.failedAttempts + 1;
    if (failedAttempts < SIGN_IN_POLICY.wrongCodesBeforeLockOut) {
      await this.dependencies.challenges.save({ ...challenge, failedAttempts });
      return fail('wrong code');
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
