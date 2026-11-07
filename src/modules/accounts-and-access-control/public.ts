/**
 * Accounts & Access Control — owner: Teammate A (Area 2). Must-stay-on set.
 * Identities, roles, the hierarchy Chair > Member > Inspector > Attendant, session binding to a site, and the
 * personal-data store with logged joins and erasure (ADR-06 Rule F). Needs AuditTrail.
 */
import type { AuditTrail } from '../audit-log/public';
import type { Clock } from '../../shared/clock';
import type { Actor, DistrictId, PersonId, Role, SiteId, ZoneId } from '../../shared/identifiers';
import type { Result } from '../../shared/result';
import {
  InMemoryAccessFactsStore,
  InMemoryCommitteePasswordStore,
  InMemoryPeopleStore,
  InMemoryPersonalDataStore,
  InMemorySignInChallengeStore,
} from './internal/adapters/in-memory-stores';
import { AuthorizationService } from './internal/authorization-service';
import { SIGN_IN_POLICY as POLICY } from './internal/domain/one-time-code';
import { SCOPE_RULES } from './internal/domain/scope-rules';
import { PersonalDataService } from './internal/personal-data-service';
import type { AccessFactsStore, CommitteePasswordStore, PeopleStore, PersonalDataStore, SignInChallengeStore } from './internal/ports';
import { SignInService } from './internal/sign-in-service';

export interface Scope {
  readonly siteId?: SiteId;
  readonly zoneId?: ZoneId;
  readonly districtId?: DistrictId;
}

export type AccountStatus = 'active' | 'suspended' | 'revoked';

/** One answer of the scope rules, with the reason, for tracing a refusal. */
export interface AccessDecision {
  readonly operation: string;
  readonly allowed: boolean;
  readonly reason: string;
}

export type BindSessionRefusal = 'only an attendant clocks in' | 'account or licence not live' | 'not assigned to this site';

/**
 * Asked by the entry point on every request and by modules for scope (task A3). Every answer is read fresh: a licence
 * revoked a moment ago is refused on the very next call, with no new sign-in.
 */
export interface Authorization {
  /** Chair everywhere; member in their district; inspector in their zone; attendant at their one site. */
  may(personId: PersonId, operation: string, scope: Scope): Promise<boolean>;
  explain(personId: PersonId, operation: string, scope: Scope): Promise<AccessDecision>;
  /** "active" only when the account is active and, for an attendant, the licence is valid. */
  liveStatus(personId: PersonId): Promise<AccountStatus>;
  roleOf(personId: PersonId): Promise<Role | undefined>;
  memberDistrictOf(personId: PersonId): Promise<DistrictId | undefined>;
  /** Called by attendance at clock-in, after the site's code was verified; the session then carries its proven site. */
  bindSessionToSite(personId: PersonId, siteId: SiteId): Promise<Result<void, BindSessionRefusal>>;
  unbindSession(personId: PersonId): Promise<void>;
  boundSite(personId: PersonId): Promise<SiteId | undefined>;
}

/** The licence states as this module needs them; the licensing module owns the licences themselves. */
export type LicenceLiveState = 'valid' | 'suspended' | 'revoked';

/**
 * Written by the licensing module, inside the same transaction as its own change, so that this must-stay-on module
 * answers from its own table and never calls the may-fail licensing module (Rule D, fitness function F8).
 */
export interface AccessFacts {
  recordLicenceState(attendantId: PersonId, state: LicenceLiveState): Promise<void>;
  recordAttendantSite(attendantId: PersonId, siteId: SiteId): Promise<void>;
  clearAttendantSite(attendantId: PersonId): Promise<void>;
  recordInspectorZone(inspectorId: PersonId, zoneId: ZoneId): Promise<void>;
  recordMemberDistrict(memberId: PersonId, districtId: DistrictId): Promise<void>;
}

/**
 * Port: where a site or zone sits in the hierarchy. The composition root fills it from the site registry, so this
 * module and sites-and-areas never import each other in a circle.
 */
export interface SiteLocator {
  locateSite(siteId: SiteId): Promise<{ readonly zoneId: ZoneId; readonly districtId: DistrictId } | undefined>;
  locateZone(zoneId: ZoneId): Promise<{ readonly districtId: DistrictId } | undefined>;
}

/** The scope rules in the order they are applied, for review and for the task A3 report. */
export const SCOPE_RULE_DESCRIPTIONS: readonly string[] = SCOPE_RULES.map((rule) => rule.description);

/** The reference of one car in the personal-data store. Other modules hold this, never the plate. */
export type CarRef = string;

/** Who is creating a person: a driver registering themself, or the staff member doing it. */
export type PersonCreator = 'self registration' | PersonId;

export type CreatePersonRefusal = 'not allowed to create this role' | 'invalid phone' | 'invalid name' | 'phone already registered';

export type CarRefusal = 'not a driver' | 'invalid plate';

/** Why a plate is being shown: the driver's receipt, the attendant's cash list, or an inspector's look-up. */
export type PlateReadPurpose = 'receipt' | 'cash list' | 'inspector look-up';

/** One request to see a plate: the car, who is reading, why, and the site of the ticket concerned. */
export interface PlateReadRequest {
  readonly carRef: CarRef;
  readonly reader: PersonId;
  readonly purpose: PlateReadPurpose;
  readonly siteId: SiteId;
}

/** "not resolvable": no such car, or its owner was erased; the ticket keeps the reference all the same. */
export type PlateReadRefusal = 'refused' | 'not resolvable';

/** A car as its own driver sees it. */
export interface OwnCar {
  readonly carRef: CarRef;
  readonly plate: string;
}

export type ErasureRefusal = 'not allowed' | 'unknown person' | 'already erased';

/** What one erasure touched: rows deleted per table, and rows kept but marked erased per table. */
export interface ErasureReport {
  readonly rowsRemoved: Readonly<Record<string, number>>;
  readonly rowsMarked: Readonly<Record<string, number>>;
}

export interface PersonalData {
  createPerson(creator: PersonCreator, role: Role, phone: string, displayName: string): Promise<Result<PersonId, CreatePersonRefusal>>;
  /** Saves a car to a driver and returns its reference; ticketing holds the reference, never the plate (task A4). */
  addCar(driverId: PersonId, plate: string): Promise<Result<CarRef, CarRefusal>>;
  ownCars(driverId: PersonId): Promise<readonly OwnCar[]>;
  /**
   * The logged join (task A4, Rule F): the owner, or a reader whose role fits the purpose and who has scope over the
   * site, gets the plate, and every plate served first writes a "plate read" audit entry naming the reader and the
   * owner (never the plate). Anyone else is refused, and a refusal is not served, so it leaves no entry.
   */
  readPlate(request: PlateReadRequest): Promise<Result<string, PlateReadRefusal>>;
  /**
   * Deletes the person's name, phone, cars and plates (task A5). The reference stays, so tickets keep it and remain
   * whole, but it no longer resolves to anyone. A driver erases themself; the Chair erases anyone but a Chair.
   */
  erase(actor: PersonId, personId: PersonId): Promise<Result<ErasureReport, ErasureRefusal>>;
}

/**
 * "wrong code" also answers an unknown phone, so the sign-in screen never reveals who is registered.
 * "account not live" is a suspended or revoked account, or an attendant without a valid licence.
 */
export type SignInRefusal =
  | 'wrong code'
  | 'locked'
  | 'code expired'
  | 'account not live'
  | 'second step required'
  | 'wrong password'
  | 'password not set';

export type PasswordRefusal = 'not a committee member' | 'not allowed' | 'password too short';

/**
 * Sign-in by phone and one-time code (task A1). The code goes out through the SignInCodeSender port. Members and the
 * Chair need a second step, their password (task A15): with the code alone they are answered "second step required"
 * and the code stays usable for the second step.
 */
export interface SignIn {
  requestSignInCode(phone: string): Promise<void>;
  signIn(phone: string, code: string): Promise<Result<{ token: string }, SignInRefusal>>;
  signInWithSecondStep(phone: string, code: string, password: string): Promise<Result<{ token: string }, SignInRefusal>>;
  setCommitteePassword(actor: PersonId, personId: PersonId, password: string): Promise<Result<void, PasswordRefusal>>;
}

/** Port: delivers a one-time code to a phone. Only an adapter names a messaging provider (Rule B). */
export interface SignInCodeSender {
  send(phone: string, code: string): Promise<void>;
}

/** Port: signs the system's own token for an actor. The composition root fills it with the entry point's signer. */
export interface TokenIssuer {
  issue(actor: Actor): string;
}

/** The sign-in policy: code length and lifetime, wrong codes before a lock-out, and its length. */
export const SIGN_IN_POLICY: Readonly<Record<keyof typeof POLICY, number>> = POLICY;

/** The roles that need the second sign-in step, and the shortest password accepted. */
export { COMMITTEE_ROLES, MINIMUM_PASSWORD_LENGTH } from './internal/domain/password';

/** The fake sender for tests and for development: it records every code instead of sending it. */
export class RecordingSignInCodeSender implements SignInCodeSender {
  private readonly sent: { readonly phone: string; readonly code: string }[] = [];

  async send(phone: string, code: string): Promise<void> {
    this.sent.push({ phone, code });
  }

  lastCodeSentTo(phone: string): string | undefined {
    return this.sent.filter((message) => message.phone === phone).at(-1)?.code;
  }

  count(): number {
    return this.sent.length;
  }
}

export interface AccountsAndAccessControlStores {
  readonly people: PeopleStore;
  readonly personalData: PersonalDataStore;
  readonly accessFacts: AccessFactsStore;
  readonly signInChallenges: SignInChallengeStore;
  readonly committeePasswords: CommitteePasswordStore;
}

export interface AccountsAndAccessControlDependencies {
  readonly stores: AccountsAndAccessControlStores;
  readonly siteLocator: SiteLocator;
  readonly signInCodeSender: SignInCodeSender;
  readonly tokenIssuer: TokenIssuer;
  /** The audit trail outside any request's transaction, for plate reads. */
  readonly audit: AuditTrail;
  readonly clock: Clock;
}

export interface AccountsAndAccessControl {
  readonly authorization: Authorization;
  readonly accessFacts: AccessFacts;
  readonly personalData: PersonalData;
  readonly signIn: SignIn;
  /** The one-time set-up of the first Chair, for the system operator only; no request reaches it. */
  bootstrapChair(phone: string, displayName: string): Promise<Result<PersonId, CreatePersonRefusal>>;
}

/** The composition root builds this module through this one function; nothing else constructs its internals. */
export function createAccountsAndAccessControl(dependencies: AccountsAndAccessControlDependencies): AccountsAndAccessControl {
  const { stores, siteLocator, signInCodeSender, tokenIssuer, audit, clock } = dependencies;
  const authorization = new AuthorizationService({ people: stores.people, accessFacts: stores.accessFacts, siteLocator });
  const personalData = new PersonalDataService({
    people: stores.people,
    personalData: stores.personalData,
    signInChallenges: stores.signInChallenges,
    committeePasswords: stores.committeePasswords,
    accessFacts: stores.accessFacts,
    authorization,
    siteLocator,
    audit,
  });
  const signIn = new SignInService({
    people: stores.people,
    personalData: stores.personalData,
    challenges: stores.signInChallenges,
    passwords: stores.committeePasswords,
    authorization,
    codeSender: signInCodeSender,
    tokenIssuer,
    clock,
  });
  return {
    authorization,
    accessFacts: authorization,
    personalData,
    signIn,
    bootstrapChair: (phone, displayName) => personalData.bootstrapChair(phone, displayName),
  };
}

export function createInMemoryAccountsStores(): AccountsAndAccessControlStores {
  return {
    people: new InMemoryPeopleStore(),
    personalData: new InMemoryPersonalDataStore(),
    accessFacts: new InMemoryAccessFactsStore(),
    signInChallenges: new InMemorySignInChallengeStore(),
    committeePasswords: new InMemoryCommitteePasswordStore(),
  };
}

export { createAccountsOperations } from './internal/operations';
